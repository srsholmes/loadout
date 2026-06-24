import { access, readFile, writeFile, rm } from "node:fs/promises";
import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { runFull, runStreaming } from "@loadout/exec";
import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";
import { isApex } from "./lib/dmi";
import {
  getStatus as computeStatus,
  recover as runRecover,
  type XhciDeps,
  type XhciStatus,
  type RecoverResult,
} from "./lib/xhci";
import { startWakeListener, type StopHandle } from "./lib/wake-listener";
import {
  getStatus as fingerprintStatus,
  apply as applyFingerprint,
  revert as revertFingerprint,
  type FingerprintDeps,
  type FingerprintStatus,
  type FingerprintResult,
} from "./lib/fingerprint";

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

  private unsupported = false;
  /** Serialises recover() so a double-tap can't run two rebinds at once. */
  private recovering = false;
  /** Live handle to the resume listener when auto-recover-on-wake is on. */
  private wakeStop: StopHandle | null = null;

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
    autoRecoverOnWake?: boolean;
    listenerRunning?: boolean;
    fingerprint?: FingerprintStatus;
  }> {
    if (this.unsupported) return { unsupported: true };
    const settings = await readPluginStorage<ApexSettings>(PLUGIN_ID);
    return {
      unsupported: false,
      status: await computeStatus(this.deps),
      autoRecoverOnWake: !!settings.autoRecoverOnWake,
      listenerRunning: this.wakeStop !== null,
      fingerprint: await fingerprintStatus(this.fpDeps),
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
          }).catch((e) => this.log?.warn(`[apex] wake listener exited: ${e}`));
        },
        log: (m) => this.log?.info(`[apex] ${m}`),
      },
      () => void this.onResume(),
    );
    this.log?.info("[apex] auto-recover-on-wake enabled — listening for resume.");
  }

  /** Stop the resume listener (idempotent). */
  private stopWake(): void {
    if (!this.wakeStop) return;
    this.wakeStop.stop();
    this.wakeStop = null;
    this.log?.info("[apex] auto-recover-on-wake disabled.");
  }

  /**
   * Fired on resume. Waits for the bus to settle, then runs the guarded
   * recovery — a no-op if the gamepad survived the sleep, a rebind if not.
   */
  private async onResume(): Promise<void> {
    await new Promise((r) => setTimeout(r, RESUME_SETTLE_MS));
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
