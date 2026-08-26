/**
 * InputPlumber backend — drives the bundled install script.
 *
 * Lifecycle:
 *   - `onLoad` starts a 30s status broadcast loop so the UI auto-refreshes
 *     after the daemon comes up post-install.
 *   - `startInstall` runs the script with at most one in flight, streaming
 *     `install-log` chunks and framing the run with `install-state` events.
 *
 * The script is idempotent — `startInstall` does the right thing whether
 * InputPlumber is missing, half-installed, or fully running. The TS-side
 * status probe in `lib/install.ts` short-circuits the UI's "Install"
 * button when the daemon is already there.
 */

import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { readDmi } from "@loadout/devices";
import * as installer from "./lib/install";
import * as wake from "./lib/wake-trigger";
import * as ipdbus from "./lib/ipdbus";
import {
  DEVICES_D,
  NOT_APPLICABLE,
  UPSTREAM_DEVICES_DIR,
  configPath,
  findDeviceConfig,
  isSupersededByUpstream,
  type DeviceConfigStatus,
} from "./lib/device-config";
import type {
  InstallStartResult,
  WakeStatus,
  WakeOpResult,
  WakeCaptureResult,
} from "./shared";

export type { InstallStartResult };

// Periodic status broadcast cadence. State is stable across a session
// (only mutates when the user installs / starts / stops InputPlumber
// via this plugin's own UI), so a frequent poll just churns subprocess
// + floods the journal. Mutation methods call `broadcastStatus()`
// directly via `invalidateStatusCache()` for immediate feedback.
const STATUS_INTERVAL_MS = 30_000;

/** TTL for the cached installer.getStatus() result. ~2x the poll
 *  interval so back-to-back polls share one probe pass; mutation
 *  methods invalidate explicitly to force a fresh read. */
const STATUS_CACHE_TTL_MS = 60_000;

export default class InputPlumberBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;

  private statusTimer?: ReturnType<typeof setInterval>;
  private installRunning = false;
  private installCancel: { cancel: () => void } | null = null;

  // Cached installer.getStatus() result. Each probe call shells out
  // (which inputplumber, inputplumber --version, systemctl is-active,
  // systemctl is-enabled, fs.access on the install script) — five+
  // subprocess invocations per status read. Caching here means
  // back-to-back getStatus() calls (the periodic broadcast + a UI
  // RPC opening the plugin panel within the same window) share one
  // probe pass. Mutation methods invalidate.
  private statusCache: { value: installer.InstallStatus; expires: number } | null = null;
  private statusInflight: Promise<installer.InstallStatus> | null = null;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async onLoad(): Promise<void> {
    this.log?.info("Plugin loading");
    this.statusTimer = setInterval(() => {
      void this.broadcastStatus();
    }, STATUS_INTERVAL_MS);
    void this.broadcastStatus();
    // On Deck hardware, install the hidraw uaccess udev rule BEFORE the
    // overlay user-service starts and opens /dev/hidrawN. SteamOS ships an
    // equivalent rule via steam-jupiter-stable, but Bazzite-Deck and
    // vanilla-Arch-Deck installs don't have that — without this our
    // overlay's first read EACCES'es and the user gets no wake button
    // until they `usermod -aG input` and re-login. The backend runs as
    // root via loadout.service so this is the right place to drop a
    // privileged-write side effect. Fire-and-forget; failures log to the
    // journal and the watcher's EACCES guard is the user-visible
    // fallback. Gated on isSteamDeck() so non-Deck hosts don't churn
    // udev pointlessly.
    void (async () => {
      try {
        if (await wake.isSteamDeck()) await wake.ensureDeckHidrawUaccess();
      } catch (e) {
        this.log?.warn(
          `Deck hidraw uaccess setup threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();
    // Boot persistence: if the user has a wake button bound, re-load its IP
    // profile once the daemon is up. Fire-and-forget — the backend signals
    // `/up` before the overlay user-service starts, and `reloadPersistedProfile`
    // waits internally for IP, so the keyboard exists before the overlay
    // enumerates devices. Non-blocking so a slow/absent IP can't stall onLoad.
    //
    // Retry the reload a few times: on a cold boot IP can be *up* (so the
    // internal waitForIp passes) but the composite device not yet enumerated,
    // which returns "Bound device not connected" and would otherwise drop the
    // binding for the whole session — the wake button silently reverts to its
    // OS default until the user re-binds. Mirrors restartInputPlumber()'s
    // retry. reloadPersistedProfile() returns ok immediately when nothing is
    // bound, so this is a no-op on setups without a wake button.
    void wake
      .reloadPersistedProfileWithRetry({
        onRetry: (attempt, error) =>
          this.log?.info(
            `wake reload: attempt ${attempt} not ready (${error}); retrying`,
          ),
      })
      .then((last) => {
        if (!last.ok && last.error) this.log?.warn(`wake reload: ${last.error}`);
        else
          this.log?.info(
            "wake reload: completed (see [input-plumber] logs for detail)",
          );
      })
      .catch((e) =>
        this.log?.warn(
          `wake reload threw: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    this.log?.info("Plugin loaded");
  }

  async onUnload(): Promise<void> {
    if (this.statusTimer !== undefined) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    this.log?.info("Plugin unloaded");
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
    // double-fire.
    if (this.statusInflight) return this.statusInflight;
    // Race-safety: store the `.finally`-chained promise (not the raw
    // probe) so concurrent callers and the teardown observe the same
    // value. The slot only clears if it still points at *this* probe
    // — that way a fresh caller's reservation can't get clobbered by
    // a stale teardown. The assignment lands before any await so a
    // sync second caller sees the in-flight promise rather than a
    // freshly-null'd field. We assign `p` to `statusInflight` before
    // the `.finally` chain runs (microtask boundary), so the
    // `=== p` identity check inside `.finally` succeeds for the
    // common case.
    const probe = (async () => {
      const value = await installer.getStatus();
      this.statusCache = { value, expires: Date.now() + STATUS_CACHE_TTL_MS };
      return value;
    })();
    const p = probe.finally(() => {
      if (this.statusInflight === p) this.statusInflight = null;
    });
    this.statusInflight = p;
    return p;
  }

  /** Drop the cached status so the next getStatus() call re-probes.
   *  Mutation methods (startInstall, etc.) call this so the UI sees
   *  fresh state immediately after a user action. */
  private _invalidateStatusCache(): void {
    this.statusCache = null;
  }

  private async broadcastStatus(): Promise<void> {
    try {
      const status = await this.getStatus();
      this.emit?.({ event: "input-plumber-status", data: status });
    } catch (err) {
      this.log?.warn(
        `broadcastStatus failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
        this._invalidateStatusCache();
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

  // -----------------------------------------------------------------------
  // Overlay wake button
  // -----------------------------------------------------------------------

  /** Current wake-trigger status: IP availability, whether this is a Deck,
   *  the connected devices' pickable buttons, and the current binding. */
  async getWakeStatus(): Promise<WakeStatus> {
    return wake.getWakeStatus();
  }

  /** Prepare InputPlumber for wake binding (Deck enable + uaccess rule) so the
   *  picker can enumerate buttons. No-op-ish on non-Deck hosts where IP is
   *  already running. */
  async prepareWake(): Promise<WakeStatus> {
    const r = await wake.prepareWake();
    if (!r.ok) this.log?.warn(`prepareWake: ${r.error}`);
    return wake.getWakeStatus();
  }

  /** Bind a physical button (raw capability string) to the overlay wake key.
   *  Idempotent full setup; safe to call again to change the button. */
  async setWakeButton(raw: string): Promise<WakeOpResult> {
    if (typeof raw !== "string" || raw.length === 0) {
      return { ok: false, error: "No button specified." };
    }
    const r = await wake.setWakeButton(raw);
    this.emit?.({ event: "wake-status", data: await wake.getWakeStatus() });
    return r;
  }

  /** Press-to-capture: temporarily map every recommended button to a unique
   *  sentinel key, wait for the user to press one, then bind it for real. */
  async captureWakeButton(timeoutMs?: number): Promise<WakeCaptureResult> {
    const r = await wake.captureWakeButton(typeof timeoutMs === "number" ? timeoutMs : undefined);
    this.emit?.({ event: "wake-status", data: await wake.getWakeStatus() });
    return r;
  }

  /** Disable the wake binding (controller keeps working). */
  async clearWakeButton(): Promise<WakeOpResult> {
    const r = await wake.clearWakeButton();
    this.emit?.({ event: "wake-status", data: await wake.getWakeStatus() });
    return r;
  }

  // ── Device config ────────────────────────────────────────────────────────
  //
  // InputPlumber only builds a CompositeDevice for hardware one of its
  // configs matches. On a handheld it has no config for, every feature this
  // plugin offers is inert — so for the devices we can describe, offer to
  // drop one in. See lib/device-config.ts for why this is a shadowing
  // drop-in rather than a Loadout-branded addition.

  async getDeviceConfigStatus(): Promise<DeviceConfigStatus> {
    const config = findDeviceConfig(await readDmi());
    if (!config) return NOT_APPLICABLE;

    const path = configPath(config);
    // Composite devices are the actual question — "does InputPlumber already
    // drive this machine" — not whether the daemon is merely installed.
    const [installed, composites, upstream] = await Promise.all([
      Bun.file(path)
        .exists()
        .catch(() => false),
      ipdbus.listCompositeDevicePaths().catch(() => [] as string[]),
      readdir(UPSTREAM_DEVICES_DIR).catch(() => [] as string[]),
    ]);

    return {
      applicable: true,
      label: config.label,
      path,
      installed,
      hasCompositeDevices: composites.length > 0,
      superseded: isSupersededByUpstream(config, upstream),
    };
  }

  /** Write the config and restart InputPlumber so it picks it up. */
  async installDeviceConfig(): Promise<{
    success: boolean;
    error?: string;
    status: DeviceConfigStatus;
  }> {
    const config = findDeviceConfig(await readDmi());
    if (!config) {
      return { success: false, error: "No InputPlumber config for this device.", status: NOT_APPLICABLE };
    }
    try {
      await mkdir(DEVICES_D, { recursive: true });
      await writeFile(configPath(config), config.yaml, "utf-8");
      this.log?.info(`[input-plumber] installed device config ${configPath(config)}`);
    } catch (e) {
      this.log?.warn(`[input-plumber] could not write device config: ${e}`);
      return { success: false, error: String(e), status: await this.getDeviceConfigStatus() };
    }

    // The daemon reads configs at startup only.
    const restart = await wake.restartInputPlumber();
    const status = await this.getDeviceConfigStatus();
    this.emit?.({ event: "device-config-status", data: status });
    return restart.ok
      ? { success: true, status }
      : { success: false, error: `Config written, but InputPlumber didn't restart: ${restart.error}`, status };
  }

  /** Remove the config we installed and restart InputPlumber. */
  async removeDeviceConfig(): Promise<{
    success: boolean;
    error?: string;
    status: DeviceConfigStatus;
  }> {
    const config = findDeviceConfig(await readDmi());
    if (!config) {
      return { success: false, error: "No InputPlumber config for this device.", status: NOT_APPLICABLE };
    }
    try {
      await unlink(configPath(config));
      this.log?.info(`[input-plumber] removed device config ${configPath(config)}`);
    } catch (e) {
      // Already gone is the outcome the user asked for, not a failure.
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        this.log?.warn(`[input-plumber] could not remove device config: ${e}`);
        return { success: false, error: String(e), status: await this.getDeviceConfigStatus() };
      }
    }
    const restart = await wake.restartInputPlumber();
    const status = await this.getDeviceConfigStatus();
    this.emit?.({ event: "device-config-status", data: status });
    return restart.ok
      ? { success: true, status }
      : { success: false, error: `Config removed, but InputPlumber didn't restart: ${restart.error}`, status };
  }

  /** Recovery: restart the InputPlumber daemon and re-load the wake profile.
   *  Rebuilds composite devices from scratch to fix stuck states (a controller
   *  not presenting to Steam, deck-uhid emulation confused after churn). */
  async restartInputPlumber(): Promise<WakeOpResult> {
    this.log?.info("Restarting InputPlumber (user-requested recovery)…");
    const r = await wake.restartInputPlumber();
    if (!r.ok) this.log?.warn(`restartInputPlumber: ${r.error}`);
    this.emit?.({ event: "wake-status", data: await wake.getWakeStatus() });
    return r;
  }
}
