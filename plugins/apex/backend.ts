import { access } from "node:fs/promises";
import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { runFull } from "@loadout/exec";
import { isApex } from "./lib/dmi";
import {
  getStatus as computeStatus,
  recover as runRecover,
  type XhciDeps,
  type XhciStatus,
  type RecoverResult,
} from "./lib/xhci";

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
  async getStatus(): Promise<{ unsupported: boolean; status?: XhciStatus }> {
    if (this.unsupported) return { unsupported: true };
    return { unsupported: false, status: await computeStatus(this.deps) };
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
