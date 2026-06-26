import { access, readFile, writeFile, rm } from "node:fs/promises";
import type { PluginBackend, EmitPayload, PluginLogger, CallPlugin } from "@loadout/types";
import { runFull, runStreaming } from "@loadout/exec";
import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";
import { isApex } from "@loadout/devices";
import {
  getStatus as computeStatus,
  recover as runRecover,
  type XhciDeps,
  type XhciStatus,
  type RecoverResult,
} from "./lib/xhci";
import {
  getHidOxpStatus,
  setHidOxpBlacklist,
  type HidOxpDeps,
  type HidOxpStatus,
} from "./lib/hid-oxp";
import {
  getStatus as fingerprintStatus,
  apply as applyFingerprint,
  revert as revertFingerprint,
  type FingerprintDeps,
  type FingerprintStatus,
  type FingerprintResult,
} from "./lib/fingerprint";
import { startWakeListener, type StopHandle } from "./lib/wake-listener";

const PLUGIN_ID = "apex";

/** Persisted per-plugin settings (in ~/.config/loadout/plugins/apex.json). */
interface ApexSettings {
  /** Run the gamepad recovery automatically whenever the device resumes. */
  autoRecoverOnWake?: boolean;
}

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

  // IO dependencies for the hid-oxp blacklist. The backend runs as root, so
  // it writes /etc/modprobe.d directly; readFile/removeFile swallow ENOENT so
  // "absent" is a normal, non-throwing state.
  private get hidOxpDeps(): HidOxpDeps {
    return {
      readFile: async (path) => {
        try {
          return await readFile(path, "utf8");
        } catch {
          return null;
        }
      },
      writeFile: (path, content) => writeFile(path, content, "utf8"),
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
          return m ? m[1].replace(/["']/g, "").trim() : "";
        } catch {
          return "";
        }
      },
      log: (m) => this.log?.info(`[apex] ${m}`),
    };
  }

  async onLoad(): Promise<void> {
    this.unsupported = !(await isApex());
    if (this.unsupported) {
      this.log?.info("[apex] Non-Apex hardware — plugin inert (recovery disabled).");
      return;
    }
    this.log?.info("[apex] OneXPlayer Apex detected — recovery available.");

    // Restore the auto-recover-on-wake listener if it was left enabled.
    const settings = await readPluginStorage<ApexSettings>(PLUGIN_ID);
    if (settings.autoRecoverOnWake) {
      this.startWake();
    }
  }

  async onUnload(): Promise<void> {
    this.stopWake();
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
      computeStatus(this.deps),
      getHidOxpStatus(this.hidOxpDeps),
      fingerprintStatus(this.fpDeps),
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
  async setFingerprintBlock(
    enabled: boolean,
  ): Promise<FingerprintResult & { unsupported?: boolean }> {
    if (this.unsupported) {
      return { success: false, rebootRequired: false, steps: [], unsupported: true, error: "Not running on Apex hardware." };
    }
    const result = enabled ? await applyFingerprint(this.fpDeps) : await revertFingerprint(this.fpDeps);
    this.emit?.({ event: "statusChanged", data: undefined });
    return result;
  }

  /**
   * Enable/disable the hid-oxp driver blacklist — the OneXPlayer HID driver
   * implicated in the xHCI controller dying on wake. Writes/removes a
   * modprobe.d drop-in; takes effect on the next reboot (the returned status
   * flags `rebootRequired` while the change is staged). See ./lib/hid-oxp.ts.
   */
  async setHidOxpBlacklist(
    enabled: boolean,
  ): Promise<{ success: boolean; unsupported?: boolean; error?: string; hidOxp?: HidOxpStatus }> {
    if (this.unsupported) {
      return { success: false, unsupported: true, error: "Not running on Apex hardware." };
    }
    try {
      const hidOxp = await setHidOxpBlacklist(this.hidOxpDeps, !!enabled);
      this.emit?.({ event: "statusChanged", data: undefined });
      return { success: true, hidOxp };
    } catch (e) {
      this.log?.warn(`[apex] setHidOxpBlacklist failed: ${e}`);
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
      return { success: false, unsupported: true, error: "Not running on Apex hardware." };
    }
    try {
      const existing = await readPluginStorage<ApexSettings>(PLUGIN_ID);
      await writePluginStorage<ApexSettings>(PLUGIN_ID, {
        ...existing,
        autoRecoverOnWake: enabled,
      });
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
        error: "Not running on Apex hardware.",
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
      const result = await runRecover(this.deps);
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
