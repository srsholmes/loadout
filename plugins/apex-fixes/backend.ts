/**
 * Apex Fixes backend.
 *
 * Thin orchestrator over four per-fix modules in `lib/`. Each module
 * owns its own `getStatus() / apply() / revert()` surface. This file
 * wires them into the plugin lifecycle + RPC dispatch:
 *
 *   - onLoad: DMI guard → run the two self-heal paths (oxpec.ensure,
 *     xhci.checkAndRecover) that are safe to apply transiently on
 *     every plugin boot. Never touches persistent state automatically.
 *   - Every 10s while loaded: emit("apex-status", ...) so the UI
 *     reflects external drift (user running rpm-ostree, etc.).
 *   - onUnload: stop the emit timer. Does NOT rmmod oxpec — fan-control
 *     depends on it, and the whole point of this plugin is to replace
 *     the Decky behaviour that unloaded oxpec on every shutdown.
 *
 * RPC:
 *   getStatus()              → ApexStatus
 *   applyFix(key)            → ApplyOutcome
 *   revertFix(key)           → ApplyOutcome
 *   rebindXhciNow()          → RebindResult
 *   reloadStatus()           → ApexStatus  (alias for getStatus, convenience)
 */

import type { PluginBackend, EmitPayload } from "@loadout/types";
import { isApexDmi, readDmi } from "./lib/dmi";
import * as oxpec from "./lib/oxpec";
import * as lightSleep from "./lib/light-sleep";
import * as sleepEnable from "./lib/sleep-enable";
import * as xhci from "./lib/xhci-recovery";

export type FixKey = "oxpec" | "lightSleep" | "sleepEnable" | "xhciRecovery";

export interface FixSummary {
  key: FixKey;
  /** Human-readable state chip. */
  state: "applied" | "not_applied" | "partial" | "n_a";
  rebootRequired: boolean;
  /** One-line diagnostic for the card. */
  details: string;
}

export interface ApexStatus {
  /** DMI product name — "ONEXPLAYER APEX" when on-device. */
  deviceModel: string;
  /** DMI-gated kill switch. When false, every apply/revert is a no-op. */
  isApex: boolean;
  fixes: Record<FixKey, FixSummary>;
}

export interface ApplyOutcome {
  success: boolean;
  steps: string[];
  error?: string;
  rebootRequired?: boolean;
}

const ALL_FIX_KEYS: FixKey[] = ["oxpec", "lightSleep", "sleepEnable", "xhciRecovery"];

// Periodic status broadcast cadence. The four sub-fix probes each
// shell out 1-3 sudo-gated commands (lsusb / systemctl is-active /
// is-enabled / etc.) — a 10s poll was flooding the journal with
// ~12+ sudo entries every tick. State is stable across a session
// except when the user applies / reverts a fix, and those code paths
// invalidate the cache + broadcast immediately, so the UI stays
// responsive without a tight poll.
const STATUS_INTERVAL_MS = 30_000;

/** TTL for the cached ApexStatus result. ~2x the poll so back-to-back
 *  calls (UI panel opening while a poll is mid-flight) share one
 *  probe pass. Mutation methods (`applyFix`, `revertFix`) invalidate
 *  explicitly. */
const STATUS_CACHE_TTL_MS = 60_000;

export default class ApexFixesBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private statusTimer?: ReturnType<typeof setInterval>;
  private isApex = false;
  private deviceModel = "";

  // Cached ApexStatus. Each call fans out 4-12 sudo probes across the
  // four sub-fix modules (oxpec / lightSleep / sleepEnable / xhci) —
  // caching here means the periodic broadcast + a UI panel-open RPC
  // landing in the same window share one probe pass instead of
  // double-firing pkexec. See `getStatus()` / `invalidateStatusCache()`.
  private statusCache: { value: ApexStatus; expires: number } | null = null;
  private statusInflight: Promise<ApexStatus> | null = null;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async onLoad(): Promise<void> {
    console.log("[apex-fixes] Plugin loading");

    const dmi = await readDmi();
    this.isApex = isApexDmi(dmi);
    this.deviceModel = dmi.productName || "unknown";

    if (!this.isApex) {
      console.log(
        `[apex-fixes] DMI does not match APEX (vendor="${dmi.sysVendor}", product="${dmi.productName}") — plugin is a no-op on this hardware`,
      );
      return;
    }

    console.log(`[apex-fixes] APEX detected (${this.deviceModel})`);

    // Self-heal path 1: load oxpec transiently if not already loaded.
    // fan-control's retry scanner will pick the hwmon node up within 30s.
    try {
      const res = await oxpec.ensure();
      if (res.success && !res.alreadyLoaded) {
        console.log(`[apex-fixes] oxpec loaded (${res.method})`);
      } else if (!res.success) {
        console.warn(`[apex-fixes] oxpec.ensure failed: ${res.error}`);
      }
    } catch (err) {
      console.error("[apex-fixes] oxpec.ensure threw:", err);
    }

    // Self-heal path 2: check gamepad presence, rebind xHCI once if missing.
    try {
      const res = await xhci.checkAndRecover();
      if (res.attempts > 0) {
        console.log(
          `[apex-fixes] xhci self-heal: ${res.gamepadPresent ? "recovered" : "failed"} after ${res.attempts} attempts`,
        );
      }
    } catch (err) {
      console.error("[apex-fixes] xhci.checkAndRecover threw:", err);
    }

    // Periodic status emit — catches external drift (kargs rolled back
    // by rpm-ostree upgrade, service disabled from another tool, etc.).
    // 30s cadence + the TTL cache below means user-driven mutations still
    // get instant UI feedback (mutation methods invalidate + re-broadcast),
    // and the journal stays readable in steady state.
    this.statusTimer = setInterval(() => {
      void this.broadcastStatus();
    }, STATUS_INTERVAL_MS);

    // Emit initial state so the UI doesn't have to wait 10s.
    this.invalidateStatusCache();
    void this.broadcastStatus();

    console.log("[apex-fixes] Plugin loaded");
  }

  async onUnload(): Promise<void> {
    if (this.statusTimer !== undefined) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    // Deliberately NOT reverting or unloading anything here. oxpec stays
    // loaded (fan-control needs it); persistent fixes stay in place.
    console.log("[apex-fixes] Plugin unloaded — system state preserved");
  }

  private async broadcastStatus(): Promise<void> {
    try {
      const status = await this.getStatus();
      this.emit?.({ event: "apex-status", data: status });
    } catch (err) {
      console.error("[apex-fixes] broadcastStatus failed:", err);
    }
  }

  // -----------------------------------------------------------------------
  // RPC surface
  // -----------------------------------------------------------------------

  async getStatus(): Promise<ApexStatus> {
    const now = Date.now();
    if (this.statusCache && this.statusCache.expires > now) {
      return this.statusCache.value;
    }
    // Coalesce concurrent callers so the UI panel-open RPC arriving
    // mid-broadcast doesn't double-fire all 12 sudo probes.
    if (this.statusInflight) return this.statusInflight;
    this.statusInflight = (async () => {
      try {
        const value = await this.computeStatus();
        this.statusCache = { value, expires: Date.now() + STATUS_CACHE_TTL_MS };
        return value;
      } finally {
        this.statusInflight = null;
      }
    })();
    return this.statusInflight;
  }

  /** Drop the cached status so the next getStatus() call re-probes.
   *  Called by mutation methods (applyFix, revertFix) so the UI sees
   *  fresh state immediately after user action. */
  private invalidateStatusCache(): void {
    this.statusCache = null;
  }

  private async computeStatus(): Promise<ApexStatus> {
    if (!this.isApex) {
      return {
        deviceModel: this.deviceModel,
        isApex: false,
        fixes: Object.fromEntries(
          ALL_FIX_KEYS.map(
            (k) =>
              [
                k,
                {
                  key: k,
                  state: "n_a" as const,
                  rebootRequired: false,
                  details: "non-APEX hardware",
                } satisfies FixSummary,
              ] as const,
          ),
        ) as Record<FixKey, FixSummary>,
      };
    }

    const [oxpecStatus, lightSleepStatus, sleepEnableStatus, xhciStatus] =
      await Promise.all([
        oxpec.getStatus(),
        lightSleep.getStatus(),
        sleepEnable.getStatus(),
        xhci.getStatus(),
      ]);

    const fixes: Record<FixKey, FixSummary> = {
      oxpec: {
        key: "oxpec",
        state:
          oxpecStatus.moduleLoaded && oxpecStatus.serviceEnabled
            ? "applied"
            : oxpecStatus.moduleLoaded
              ? "partial"
              : "not_applied",
        rebootRequired: false,
        details: oxpecStatus.summary,
      },
      lightSleep: {
        key: "lightSleep",
        state: lightSleepStatus.applied
          ? "applied"
          : lightSleepStatus.desiredPresent.length > 0 ||
              lightSleepStatus.problematicFound.length > 0
            ? "partial"
            : "not_applied",
        rebootRequired: !lightSleepStatus.applied,
        details: lightSleepStatus.summary,
      },
      sleepEnable: {
        key: "sleepEnable",
        state: sleepEnableStatus.applied
          ? "applied"
          : sleepEnableStatus.fwScriptNeutralized ||
              sleepEnableStatus.fingerprintRuleInstalled
            ? "partial"
            : "not_applied",
        rebootRequired: false,
        details: sleepEnableStatus.summary,
      },
      xhciRecovery: {
        key: "xhciRecovery",
        state: xhciStatus.applied
          ? "applied"
          : xhciStatus.scriptExists || xhciStatus.serviceActive
            ? "partial"
            : "not_applied",
        rebootRequired: false,
        details: xhciStatus.summary,
      },
    };

    return {
      deviceModel: this.deviceModel,
      isApex: true,
      fixes,
    };
  }

  async applyFix(key: FixKey): Promise<ApplyOutcome> {
    if (!this.isApex) {
      return { success: false, steps: [], error: "non-APEX hardware" };
    }

    let result: ApplyOutcome;
    switch (key) {
      case "oxpec": {
        const r = await oxpec.apply();
        result = {
          success: r.success,
          steps: r.steps,
          error: r.error,
          rebootRequired: false,
        };
        break;
      }
      case "lightSleep": {
        const r = await lightSleep.apply();
        result = {
          success: r.success,
          steps: r.steps,
          error: r.error,
          rebootRequired: r.rebootRequired,
        };
        break;
      }
      case "sleepEnable": {
        const r = await sleepEnable.apply();
        result = {
          success: r.success,
          steps: r.steps,
          error: r.error,
          rebootRequired: false,
        };
        break;
      }
      case "xhciRecovery": {
        const r = await xhci.apply();
        result = {
          success: r.success,
          steps: r.steps,
          error: r.error,
          rebootRequired: false,
        };
        break;
      }
      default: {
        const _exhaustive: never = key;
        void _exhaustive;
        return { success: false, steps: [], error: `unknown fix: ${key}` };
      }
    }

    this.invalidateStatusCache();
    void this.broadcastStatus();
    return result;
  }

  async revertFix(key: FixKey): Promise<ApplyOutcome> {
    if (!this.isApex) {
      return { success: false, steps: [], error: "non-APEX hardware" };
    }

    let result: ApplyOutcome;
    switch (key) {
      case "oxpec": {
        const r = await oxpec.revert();
        result = { success: r.success, steps: r.steps, error: r.error };
        break;
      }
      case "lightSleep": {
        const r = await lightSleep.revert();
        result = {
          success: r.success,
          steps: r.steps,
          error: r.error,
          rebootRequired: r.rebootRequired,
        };
        break;
      }
      case "sleepEnable": {
        const r = await sleepEnable.revert();
        result = { success: r.success, steps: r.steps, error: r.error };
        break;
      }
      case "xhciRecovery": {
        const r = await xhci.revert();
        result = { success: r.success, steps: r.steps, error: r.error };
        break;
      }
      default: {
        const _exhaustive: never = key;
        void _exhaustive;
        return { success: false, steps: [], error: `unknown fix: ${key}` };
      }
    }

    this.invalidateStatusCache();
    void this.broadcastStatus();
    return result;
  }

  async rebindXhciNow(): Promise<xhci.RebindResult> {
    if (!this.isApex) {
      return {
        success: false,
        gamepadPresent: false,
        attempts: 0,
        error: "non-APEX hardware",
      };
    }
    const r = await xhci.rebindNow();
    this.invalidateStatusCache();
    void this.broadcastStatus();
    return r;
  }

  async reloadStatus(): Promise<ApexStatus> {
    return this.getStatus();
  }
}
