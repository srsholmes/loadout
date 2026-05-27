/**
 * InputPlumber backend — drives the bundled install script.
 *
 * Lifecycle:
 *   - `onLoad` starts a 5s status broadcast loop so the UI auto-refreshes
 *     after the daemon comes up post-install.
 *   - `startInstall` runs the script under sudo with at most one in
 *     flight, streaming `install-log` chunks and framing the run with
 *     `install-state` events.
 *
 * The script is idempotent — `startInstall` does the right thing whether
 * InputPlumber is missing, half-installed, or fully running. The TS-side
 * status probe in `src/install.ts` short-circuits the UI's "Install"
 * button when the daemon is already there.
 */

import type { PluginBackend, EmitPayload } from "@loadout/types";
import * as installer from "./src/install";

// Periodic status broadcast cadence. State is stable across a session
// (only mutates when the user installs / starts / stops InputPlumber
// via this plugin's own UI), so a frequent poll just churns sudo +
// floods the journal. Mutation methods call `broadcastStatus()`
// directly via `invalidateStatusCache()` for immediate feedback.
const STATUS_INTERVAL_MS = 30_000;

/** TTL for the cached installer.getStatus() result. ~2x the poll
 *  interval so back-to-back polls share one sudo probe pass; mutation
 *  methods invalidate explicitly to force a fresh read. */
const STATUS_CACHE_TTL_MS = 60_000;

export interface InstallStartResult {
  started: boolean;
  error?: string;
}

export default class InputPlumberBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private statusTimer?: ReturnType<typeof setInterval>;
  private installRunning = false;
  private installCancel: { cancel: () => void } | null = null;

  // Cached installer.getStatus() result. Each probe call hits sudo
  // (which inputplumber, inputplumber --version, systemctl is-active,
  // systemctl is-enabled, fs.access on the install script) — four-plus
  // pkexec authentications per status read. Caching here means
  // back-to-back getStatus() calls (the periodic broadcast + a UI
  // RPC opening the plugin panel within the same window) share one
  // probe pass. Mutation methods invalidate.
  private statusCache: { value: installer.InstallStatus; expires: number } | null = null;
  private statusInflight: Promise<installer.InstallStatus> | null = null;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async onLoad(): Promise<void> {
    console.log("[input-plumber] Plugin loading");
    this.statusTimer = setInterval(() => {
      void this.broadcastStatus();
    }, STATUS_INTERVAL_MS);
    void this.broadcastStatus();
    console.log("[input-plumber] Plugin loaded");
  }

  async onUnload(): Promise<void> {
    if (this.statusTimer !== undefined) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    console.log("[input-plumber] Plugin unloaded");
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  async getStatus(): Promise<installer.InstallStatus> {
    const now = Date.now();
    if (this.statusCache && this.statusCache.expires > now) {
      return this.statusCache.value;
    }
    // Coalesce concurrent callers onto the same probe so a UI RPC
    // landing while the periodic broadcast is mid-probe doesn't
    // double-fire sudo.
    if (this.statusInflight) return this.statusInflight;
    this.statusInflight = (async () => {
      try {
        const value = await installer.getStatus();
        this.statusCache = { value, expires: Date.now() + STATUS_CACHE_TTL_MS };
        return value;
      } finally {
        this.statusInflight = null;
      }
    })();
    return this.statusInflight;
  }

  /** Drop the cached status so the next getStatus() call re-probes.
   *  Mutation methods (startInstall, etc.) call this so the UI sees
   *  fresh state immediately after a user action. */
  private invalidateStatusCache(): void {
    this.statusCache = null;
  }

  private async broadcastStatus(): Promise<void> {
    try {
      const status = await this.getStatus();
      this.emit?.({ event: "input-plumber-status", data: status });
    } catch (err) {
      console.error("[input-plumber] broadcastStatus failed:", err);
    }
  }

  // -----------------------------------------------------------------------
  // Install
  // -----------------------------------------------------------------------

  isInstallRunning(): { running: boolean } {
    return { running: this.installRunning };
  }

  async startInstall(): Promise<InstallStartResult> {
    if (this.installRunning) {
      return { started: false, error: "install already in progress" };
    }
    this.installRunning = true;
    const cancel: { cancel: () => void } = { cancel: () => {} };
    this.installCancel = cancel;

    this.emit?.({ event: "install-state", data: { running: true } });
    this.emit?.({
      event: "install-log",
      data: { kind: "status", text: "── Starting install ──\n" },
    });

    void installer
      .install({
        cancellation: cancel,
        onLog: (text, stream) => {
          this.emit?.({ event: "install-log", data: { kind: stream, text } });
        },
      })
      .then((result) => {
        this.emit?.({
          event: "install-log",
          data: {
            kind: "status",
            text: result.success
              ? `── install complete (${result.durationSeconds}s) ──\n`
              : `── install failed: ${result.error ?? "unknown"} ──\n`,
          },
        });
        this.emit?.({
          event: "install-state",
          data: { running: false, result },
        });
      })
      .catch((err) => {
        const text = err instanceof Error ? err.message : String(err);
        this.emit?.({
          event: "install-log",
          data: { kind: "status", text: `── install threw: ${text} ──\n` },
        });
        this.emit?.({
          event: "install-state",
          data: {
            running: false,
            result: {
              success: false,
              exitCode: -1,
              timedOut: false,
              durationSeconds: 0,
              error: text,
            },
          },
        });
      })
      .finally(() => {
        this.installRunning = false;
        this.installCancel = null;
        // Install completed (success or failure) — bust the cache so
        // the next broadcast re-probes and the UI sees the new state.
        this.invalidateStatusCache();
        void this.broadcastStatus();
      });

    return { started: true };
  }

  cancelInstall(): { cancelled: boolean; error?: string } {
    if (!this.installCancel) {
      return { cancelled: false, error: "no install in progress" };
    }
    this.installCancel.cancel();
    return { cancelled: true };
  }
}
