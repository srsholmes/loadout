import { access, readFile, writeFile, rm } from "node:fs/promises";
import type { PluginBackend, EmitPayload, PluginLogger, CallPlugin } from "@loadout/types";
import { runFull, runStreaming } from "@loadout/exec";
import { readPluginStorage, mutatePluginStorage } from "@loadout/plugin-storage";
import { isApex, isOneXPlayer } from "@loadout/devices";
import {
  getStatus as computeStatus,
  recover as runRecover,
  type XhciDeps,
  type XhciStatus,
  type RecoverResult,
} from "./lib/xhci";
import { RumbleControl, type RumbleInfo } from "./lib/rumble-control";
import {
  getHidOxpStatus,
  removeHidOxpBlacklist,
  type HidOxpDeps,
  type HidOxpStatus,
} from "./lib/hid-oxp";
import {
  getStatus as fingerprintStatus,
  apply as applyFingerprint,
  revert as revertFingerprint,
  shouldHeal,
  type FingerprintDeps,
  type FingerprintStatus,
  type FingerprintResult,
} from "./lib/fingerprint";
import { startWakeListener, type StopHandle } from "@loadout/wake";

const PLUGIN_ID = "apex";

/** Persisted per-plugin settings (in ~/.config/loadout/plugins/apex.json). */
interface ApexSettings {
  /** Run the gamepad recovery automatically whenever the device resumes. */
  autoRecoverOnWake?: boolean;
  /** Global rumble level the user chose. Re-applied on load, because the
   *  driver's own cache resets to maximum on every module load. */
  rumbleIntensity?: number;
  /**
   * Whether the user wants the fingerprint wake block on.
   *
   * Deliberately stored here rather than inferred from `/etc`: a SteamOS A/B
   * update regenerates that tree and deletes both the udev rule and the grub
   * line, which is precisely the evidence the old code used to decide the
   * block was wanted. `$HOME` survives those updates, so this is the only
   * record that can outlive one. Absent = never chose.
   */
  fingerprintBlock?: boolean;
}

/** What a startup self-heal did, surfaced once so the UI can say so. */
export interface FingerprintHealNotice {
  /** The block was re-applied. */
  restored: boolean;
  /** A reboot is still needed to bring the GPIO karg layer up. */
  rebootRequired: boolean;
  /**
   * The kernel arg the user has to add by hand, on a distro whose bootloader
   * we don't manage. Previously dropped on the floor — the notice reported
   * "reboot to finish re-applying it" when nothing had been staged and a
   * reboot could never help, discarding the one actionable thing we had.
   */
  manualKarg?: string;
  /** Set when the re-apply itself failed. */
  error?: string;
}

/** Shape returned when this isn't OneXPlayer hardware at all. */
const UNAVAILABLE_RUMBLE: RumbleInfo = {
  available: false,
  devicePath: null,
  min: 0,
  max: 5,
  intensity: null,
  source: null,
};

/**
 * How long to wait after a resume before checking the gamepad. The kernel
 * re-enumerates USB during resume; checking too early can read the pad as
 * briefly-absent and trigger a needless rebind. recover() then polls, so
 * this only needs to clear the initial settle.
 */
const RESUME_SETTLE_MS = 2_000;

/**
 * Apex — OneXPlayer Apex device fixes.
 *
 * Currently a single fix: recover the internal gamepad after the xHCI
 * USB host controller dies on resume from sleep (see ./lib/xhci.ts).
 * Exposed as a button in the UI that unbinds/rebinds the controller so
 * the gamepad re-enumerates.
 *
 * The whole plugin is DMI-gated: on non-Apex hardware `onLoad` flips
 * `unsupported` and every RPC short-circuits, so the UI renders an
 * inert "not on Apex" banner and the recovery button is never offered.
 */

export default class ApexBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;
  callPlugin?: CallPlugin;

  private unsupported = false;

  /**
   * True on the board whose hardware constants were measured (the Apex).
   * The fingerprint GPIO kernel arg names a specific pin — `AMDI0030:00@58`
   * — which is board wiring, not a family constant. Applying it blind to a
   * sibling could name the wrong pin, so that one path stays gated while the
   * PME path, which is derived at runtime, runs everywhere.
   */
  private isKnownBoard = false;
  /** Serialises recover() so a double-tap can't run two rebinds at once. */
  private recovering = false;
  /** Live handle to the resume listener when auto-recover-on-wake is on. */
  private wakeStop: StopHandle | null = null;
  /** Pending post-resume settle timer, so stop()/unload can cancel it. */
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  // Hardware-access dependencies handed to the pure xhci orchestration.
  // Wired to the real exec / fs / timers here; swapped for fakes in tests.
  private get deps(): XhciDeps {
    return {
      run: (cmd, opts) => runFull(cmd, opts),
      pathExists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      restartInputPlumber: () => this._restartInputPlumber(),
      log: (m) => this.log?.info(`[apex] ${m}`),
    };
  }

  /**
   * Re-grab the recovered pad via InputPlumber. Delegates to the
   * input-plumber plugin's `restartInputPlumber` (cross-plugin call) so the
   * restart also reloads the wake profile — keeping the QAM→F16 overlay
   * shortcut alive. A raw `systemctl restart inputplumber` would drop that
   * profile, which is exactly the regression this fixes.
   *
   * Falls back to a raw restart only when the input-plumber plugin isn't
   * available (call handle missing, plugin not loaded, or method absent) —
   * in that case there's no wake profile to preserve anyway. A non-ok result
   * *from* input-plumber is NOT a fallback trigger: re-running a raw restart
   * would just drop the profile we were trying to keep.
   */
  private async _restartInputPlumber(): Promise<{ ok: boolean; error?: string }> {
    if (this.callPlugin) {
      try {
        const r = (await this.callPlugin("input-plumber", "restartInputPlumber")) as
          | { ok: boolean; error?: string }
          | undefined;
        return r ?? { ok: true };
      } catch (e) {
        this.log?.warn(
          `[apex] input-plumber restart unavailable (${e}); falling back to raw systemctl restart`,
        );
      }
    }
    // Fallback: no input-plumber plugin to delegate to — restart the daemon
    // directly. reset-failed first to clear any systemd start-limit.
    await runFull(["systemctl", "reset-failed", "inputplumber"], { timeoutMs: 5_000 });
    const res = await runFull(["systemctl", "restart", "inputplumber"], { timeoutMs: 20_000 });
    return res.exitCode === 0
      ? { ok: true }
      : { ok: false, error: res.stderr || `systemctl exited ${res.exitCode}` };
  }

  // IO for clearing the old hid-oxp blacklist. The backend runs as root, so
  // it touches /etc/modprobe.d directly; readFile/removeFile swallow ENOENT
  // so "absent" is a normal, non-throwing state.
  private get hidOxpDeps(): HidOxpDeps {
    return {
      readFile: async (path) => {
        try {
          return await readFile(path, "utf8");
        } catch {
          return null;
        }
      },
      removeFile: async (path) => {
        try {
          await rm(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
        }
      },
      log: (m) => this.log?.info(`[apex] ${m}`),
    };
  }

  // Filesystem + OS access for the fingerprint-wake block. Same injection
  // pattern as `deps`; swapped for fakes in tests.
  private get fpDeps(): FingerprintDeps {
    return {
      run: (cmd, opts) => runFull(cmd, opts),
      pathExists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      readFile: (path) => readFile(path, "utf-8"),
      writeFile: (path, content) => writeFile(path, content),
      removeFile: (path) => rm(path, { force: true }),
      readCmdline: () => readFile("/proc/cmdline", "utf-8"),
      distroId: async () => {
        try {
          const t = await readFile("/etc/os-release", "utf-8");
          const m = t.match(/^ID=(.*)$/m);
          return m?.[1] ? m[1].replace(/["']/g, "").trim() : "";
        } catch {
          return "";
        }
      },
      log: (m) => this.log?.info(`[apex] ${m}`),
    };
  }

  /** Global rumble intensity — a hid-oxp attribute, so OneXPlayer-only. */
  private rumble = new RumbleControl({
    readStored: async () =>
      (await readPluginStorage<ApexSettings>(PLUGIN_ID)).rumbleIntensity,
    writeStored: async (rumbleIntensity) => {
      await mutatePluginStorage<ApexSettings>(PLUGIN_ID, (existing) => ({
        ...existing,
        rumbleIntensity,
      }));
    },
    log: (m) => this.log?.info(`[apex] ${m}`),
    onChange: (info) => this.emit?.({ event: "rumbleChanged", data: info }),
  });

  async onLoad(): Promise<void> {
    // Family-level, not model-level. Every feature below probes for the
    // hardware it actually touches — the fingerprint reader by USB id, the
    // dead xHCI controller from dmesg — so gating the whole plugin on one
    // model hid working features from siblings running the same silicon.
    // A OneXPlayer X2 Mini Pro reported exactly that.
    this.unsupported = !(await isOneXPlayer());
    if (this.unsupported) {
      this.log?.info("[apex] Not a OneXPlayer handheld — plugin inert.");
      return;
    }

    // Whether this is the board whose *wiring* we know. Only the GPIO
    // kernel-arg path depends on it; see setFingerprintBlock.
    this.isKnownBoard = await isApex();
    this.log?.info(
      this.isKnownBoard
        ? "[apex] OneXPlayer Apex detected — all fixes available."
        : "[apex] OneXPlayer handheld detected — board-specific fixes limited.",
    );

    // Restore the auto-recover-on-wake listener if it was left enabled.
    const settings = await readPluginStorage<ApexSettings>(PLUGIN_ID);
    if (settings.autoRecoverOnWake) {
      this.startWake();
    }

    // Independent of the fixes above: this is a setting, not a repair, and it
    // has its own retry scan because hid-oxp can bind after we load.
    await this.rumble.start();

    // Fire-and-forget — see healFingerprintBlock for why this must not be
    // awaited. The promise is kept only so the UI can await it on demand.
    this.healing = this.healFingerprintBlock();
  }

  async onUnload(): Promise<void> {
    this.stopWake();
    this.rumble.stop();
  }

  // ---------- Fingerprint self-heal ----------

  /** In-flight heal, so getFingerprintHealNotice can await it rather than
   *  race it. */
  private healing: Promise<void> | null = null;
  /**
   * Serialises everything that edits the fingerprint block.
   *
   * apply/revert run `steamos-readonly disable` → write grub → `update-grub`
   * (up to 120s) → `steamos-readonly enable`. A startup heal can still be
   * mid-sequence when the user flips the switch, and interleaving the two
   * lets one side's readonly-enable land while the other is writing, or two
   * update-grub runs regenerate grub.cfg concurrently. recover() has had a
   * guard for this reason; this path had none.
   */
  private fpLock: Promise<unknown> = Promise.resolve();

  private serialiseFingerprint<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.fpLock.then(fn, fn);
    // Keep the chain alive regardless of outcome.
    this.fpLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  /** One-shot: read once by the UI, then cleared, so the toast fires once
   *  per backend start rather than on every overlay restart. */
  private healNotice: FingerprintHealNotice | null = null;

  /**
   * Put the wake block back if the user had it on and something removed it.
   *
   * Never awaited by onLoad. `loadPlugins()` walks plugins sequentially with
   * no timeout and the HTTP server does not start until that loop finishes,
   * so blocking here on `lsusb` + `udevadm` + `update-grub` would delay the
   * whole backend boot — and update-grub alone is seconds.
   */
  private async healFingerprintBlock(): Promise<void> {
    try {
      const [settings, status] = await Promise.all([
        readPluginStorage<ApexSettings>(PLUGIN_ID),
        fingerprintStatus(this.fpDeps, this.isKnownBoard),
      ]);
      // Backfill for anyone who turned the block on before this shipped:
      // there is no stored flag yet, so without this the very users the
      // feature exists for would never be healed. A block that is currently
      // in effect is proof enough that they wanted it — and recording it now
      // is the only chance to, before an update erases the evidence.
      let wanted = settings.fingerprintBlock;
      if (wanted === undefined && status.applied) {
        // Decided INSIDE the lock, not from the snapshot above: reading
        // status shells out to lsusb and a sh loop, so seconds can pass, and
        // a user toggling the block off in that window would otherwise have
        // their explicit "off" overwritten with true — then see the block
        // re-applied on the next boot. Exactly what this design exists to
        // prevent.
        await mutatePluginStorage<ApexSettings>(PLUGIN_ID, (existing) => {
          if (existing.fingerprintBlock !== undefined) return existing;
          return { ...existing, fingerprintBlock: true };
        });
        wanted = (await readPluginStorage<ApexSettings>(PLUGIN_ID)).fingerprintBlock;
        if (wanted) {
          this.log?.info("[apex] recorded the existing fingerprint wake block as wanted");
        }
      }

      if (!shouldHeal({ wanted, status })) return;

      this.log?.warn(
        "[apex] fingerprint wake block was enabled but is no longer in effect " +
          "(a system update usually causes this) — re-applying.",
      );
      const res = await this.serialiseFingerprint(() =>
        applyFingerprint(this.fpDeps, { autoKarg: this.isKnownBoard }),
      );
      this.healNotice = {
        restored: res.success,
        rebootRequired: !!res.rebootRequired,
        manualKarg: res.manualKarg,
        error: res.success ? undefined : (res.error ?? "Re-applying the block failed."),
      };
      this.log?.info(
        res.success
          ? `[apex] fingerprint wake block restored${res.rebootRequired ? " (reboot needed for the kernel-arg layer)" : ""}`
          : `[apex] could not restore the fingerprint wake block: ${res.error}`,
      );
      this.emit?.({ event: "statusChanged", data: undefined });
    } catch (e) {
      // Never let a heal failure escape: onLoad ignores throws, but an
      // unhandled rejection here would be invisible.
      this.log?.warn(`[apex] fingerprint self-heal failed: ${e}`);
    }
  }

  /**
   * The heal outcome, or null. Awaits an in-flight heal first — `emit` has no
   * replay, so a heal that finished before the overlay connected would
   * otherwise be missed entirely.
   *
   * Reading does NOT consume it. Clearing here meant the startup toast
   * destroyed the notice before it had been shown: the plugin page's own
   * fetch always got null, so its alert was unreachable, and a webview
   * reload before the user opened the overlay discarded the message for
   * good. The consumer acks once it has actually surfaced it.
   */
  async getFingerprintHealNotice(): Promise<FingerprintHealNotice | null> {
    await this.healing;
    return this.healNotice;
  }

  /** Called once the notice has actually been shown to the user. */
  async ackFingerprintHealNotice(): Promise<void> {
    this.healNotice = null;
  }

  // ---------- RPC ----------

  /** Snapshot the controller/gamepad state for the UI. */
  async getStatus(): Promise<{
    unsupported: boolean;
    status?: XhciStatus;
    hidOxp?: HidOxpStatus;
    fingerprint?: FingerprintStatus;
    autoRecoverOnWake?: boolean;
    listenerRunning?: boolean;
  }> {
    if (this.unsupported) return { unsupported: true };
    const [status, hidOxp, fingerprint, settings] = await Promise.all([
      computeStatus(this.deps, undefined, this.isKnownBoard),
      getHidOxpStatus(this.hidOxpDeps),
      fingerprintStatus(this.fpDeps, this.isKnownBoard),
      readPluginStorage<ApexSettings>(PLUGIN_ID),
    ]);
    return {
      unsupported: false,
      status,
      hidOxp,
      fingerprint,
      autoRecoverOnWake: !!settings.autoRecoverOnWake,
      listenerRunning: this.wakeStop !== null,
    };
  }

  /**
   * Block / unblock the fingerprint reader as a wake source. Closes both
   * wake paths (controller PME at runtime + the GPIO kernel arg); the karg
   * change needs a reboot, signalled via `rebootRequired`.
   */
  // ---------- Rumble ----------

  async getRumbleInfo(): Promise<RumbleInfo> {
    if (this.unsupported) return UNAVAILABLE_RUMBLE;
    return this.rumble.getInfo();
  }

  async setRumbleIntensity(
    value: number,
  ): Promise<{ success: boolean; error?: string; info?: RumbleInfo }> {
    if (this.unsupported) return { success: false, error: "Not running on OneXPlayer hardware." };
    return this.rumble.setIntensity(value);
  }

  async rescanRumble(): Promise<RumbleInfo> {
    // Without this the rescan would readdir the real /sys/bus/hid/devices on
    // a Steam Deck.
    if (this.unsupported) return UNAVAILABLE_RUMBLE;
    return this.rumble.rescan();
  }

  async setFingerprintBlock(
    enabled: boolean,
  ): Promise<FingerprintResult & { unsupported?: boolean }> {
    if (this.unsupported) {
      return { success: false, rebootRequired: false, steps: [], unsupported: true, error: "Not running on OneXPlayer hardware." };
    }
    // autoKarg only on the board whose GPIO pin we measured — see isKnownBoard.
    const result = await this.serialiseFingerprint(() =>
      enabled
        ? applyFingerprint(this.fpDeps, { autoKarg: this.isKnownBoard })
        : revertFingerprint(this.fpDeps, { autoKarg: this.isKnownBoard }),
    );

    // Record the intent even when the apply partly failed: the user asked for
    // it, and a later startup should try again rather than forget they did.
    await mutatePluginStorage<ApexSettings>(PLUGIN_ID, (existing) => ({
      ...existing,
      fingerprintBlock: enabled,
    }));

    this.emit?.({ event: "statusChanged", data: undefined });
    return result;
  }

  /** Reboot the device. Root already, so no polkit involved. */
  async rebootDevice(): Promise<{ success: boolean; error?: string }> {
    // Gated like every sibling RPC: this is a root-privileged power-cycle and
    // should not be reachable on hardware the rest of the plugin is inert on.
    if (this.unsupported) {
      return { success: false, error: "Not running on OneXPlayer hardware." };
    }
    this.log?.info("[apex] rebooting at user request");
    // No timeout: shutdown can take longer than any sane limit, and a timeout
    // returns exitCode -1 — flashing "exit -1" at a user whose device is in
    // fact rebooting correctly.
    const r = await runFull(["systemctl", "reboot"]);
    return r.exitCode === 0
      ? { success: true }
      : { success: false, error: r.stderr.trim() || `exit ${r.exitCode}` };
  }

  /**
   * Remove the old hid-oxp driver blacklist. Removal only — there is
   * deliberately no way to apply it, here or in the UI: it disabled the
   * driver instead of fixing the wake bug (that's "Recover gamepad"), and it
   * takes every control hid-oxp exposes with it. See ./lib/hid-oxp.ts.
   */
  async removeHidOxpBlacklist(): Promise<{
    success: boolean;
    unsupported?: boolean;
    error?: string;
    hidOxp?: HidOxpStatus;
  }> {
    if (this.unsupported) {
      return { success: false, unsupported: true, error: "Not running on OneXPlayer hardware." };
    }
    try {
      const hidOxp = await removeHidOxpBlacklist(this.hidOxpDeps);
      this.emit?.({ event: "statusChanged", data: undefined });
      return { success: true, hidOxp };
    } catch (e) {
      this.log?.warn(`[apex] removeHidOxpBlacklist failed: ${e}`);
      return { success: false, error: String(e) };
    }
  }

  /**
   * Enable/disable running the recovery automatically on resume. Persists
   * the choice and starts/stops the logind wake listener to match.
   */
  async setAutoRecoverOnWake(
    enabled: boolean,
  ): Promise<{ success: boolean; unsupported?: boolean; error?: string }> {
    if (this.unsupported) {
      return { success: false, unsupported: true, error: "Not running on OneXPlayer hardware." };
    }
    try {
      // mutatePluginStorage, not read->spread->write: the rumble level
      // persists into this same file, and the lock is per-plugin — a bare
      // write here never takes it, so one path silently clobbers the other.
      await mutatePluginStorage<ApexSettings>(PLUGIN_ID, (existing) => ({
        ...existing,
        autoRecoverOnWake: enabled,
      }));
      if (enabled) this.startWake();
      else this.stopWake();
      this.emit?.({ event: "statusChanged", data: undefined });
      return { success: true };
    } catch (e) {
      this.log?.warn(`[apex] setAutoRecoverOnWake failed: ${e}`);
      return { success: false, error: String(e) };
    }
  }

  /** Run the rebind recovery. Returns a structured result for the UI. */
  async recover(): Promise<RecoverResult & { unsupported?: boolean }> {
    if (this.unsupported) {
      return {
        success: false,
        controller: "",
        steps: [],
        gamepadPresent: false,
        unsupported: true,
        error: "Not running on OneXPlayer hardware.",
      };
    }
    if (this.recovering) {
      return {
        success: false,
        controller: "",
        steps: [],
        gamepadPresent: false,
        error: "A recovery is already in progress.",
      };
    }

    this.recovering = true;
    try {
      const result = await runRecover(this.deps, { knownBoard: this.isKnownBoard });
      this.emit?.({ event: "statusChanged", data: undefined });
      return result;
    } finally {
      this.recovering = false;
    }
  }

  // ---------- auto-recover-on-wake ----------

  /** Start the logind resume listener (idempotent). */
  private startWake(): void {
    if (this.wakeStop) return;
    this.wakeStop = startWakeListener(
      {
        spawn: ({ cmd, onLine, onSpawn }) => {
          // Long-lived; resolves only when the monitor is killed on stop().
          // enforceCommandPolicy runs synchronously inside runStreaming, so
          // the `dbus-monitor` permission is checked within this scope.
          void runStreaming(cmd, {
            onLine,
            onSpawn: (proc) => onSpawn({ kill: () => proc.kill() }),
          })
            .catch((e) => this.log?.warn(`[apex] wake listener exited: ${e}`))
            // The monitor died (crash, kill, or policy reject). Drop the
            // handle so getStatus().listenerRunning reflects reality instead
            // of reporting a dead listener as healthy.
            .finally(() => {
              this.wakeStop = null;
            });
        },
        log: (m) => this.log?.info(`[apex] ${m}`),
      },
      () => void this.onResume(),
    );
    this.log?.info("[apex] auto-recover-on-wake enabled — listening for resume.");
  }

  /** Stop the resume listener (idempotent). */
  private stopWake(): void {
    // Cancel any in-flight settle so a teardown mid-resume can't fire a
    // rebind after the plugin (or the listener) has been torn down.
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (!this.wakeStop) return;
    this.wakeStop.stop();
    this.wakeStop = null;
    this.log?.info("[apex] auto-recover-on-wake disabled.");
  }

  /**
   * Fired on resume. Waits for the bus to settle, then runs the guarded
   * recovery — a no-op if the gamepad survived the sleep, a rebind if not.
   * The settle is cancellable (resumeTimer) so a stop during the wait aborts
   * cleanly without rebinding.
   */
  private async onResume(): Promise<void> {
    const settled = await new Promise<boolean>((resolve) => {
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        resolve(true);
      }, RESUME_SETTLE_MS);
    });
    // Listener was stopped during the settle window — abort the rebind.
    if (!settled || !this.wakeStop) return;
    try {
      const res = await this.recover();
      if (res.alreadyHealthy) {
        this.log?.info("[apex] wake: gamepad healthy — no rebind needed.");
      } else if (res.success) {
        this.log?.info(`[apex] wake: recovered gamepad (rebound ${res.controller}).`);
      } else {
        this.log?.warn(`[apex] wake: recovery failed — ${res.error ?? "unknown"}.`);
      }
    } catch (e) {
      this.log?.warn(`[apex] wake recovery threw: ${e}`);
    }
  }
}
