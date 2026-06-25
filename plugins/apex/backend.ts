import { access, readFile, writeFile, rm } from "node:fs/promises";
import type { PluginBackend, EmitPayload, PluginLogger, CallPlugin } from "@loadout/types";
import { runFull } from "@loadout/exec";
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
    } else {
      this.log?.info("[apex] OneXPlayer Apex detected — recovery available.");
    }
  }

  // ---------- RPC ----------

  /** Snapshot the controller/gamepad state for the UI. */
  async getStatus(): Promise<{
    unsupported: boolean;
    status?: XhciStatus;
    hidOxp?: HidOxpStatus;
    fingerprint?: FingerprintStatus;
  }> {
    if (this.unsupported) return { unsupported: true };
    const [status, hidOxp, fingerprint] = await Promise.all([
      computeStatus(this.deps),
      getHidOxpStatus(this.hidOxpDeps),
      fingerprintStatus(this.fpDeps),
    ]);
    return { unsupported: false, status, hidOxp, fingerprint };
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
}
