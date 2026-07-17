import { readFile, writeFile, rm, mkdir, access, readdir, readlink } from "node:fs/promises";
import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { runFull, runStreaming } from "@loadout/exec";
import { readPluginStorage, writePluginStorage, mutatePluginStorage } from "@loadout/plugin-storage";
import { startWakeListener, type StopHandle } from "@loadout/wake";
import {
  enable as enablePowerSave,
  disable as disablePowerSave,
  getStatus as computeStatus,
  reassertRuntime,
  type PowerSaveDeps,
  type PowerSaveStatus,
} from "./lib/powersave";
import {
  recover,
  detectDriverInfo,
  getWifiDevice,
  readRfkill,
  nmRadioEnabled,
  initialWatchdogState,
  evaluateWatchdog,
  recordRecoveryOutcome,
  DEFAULT_WATCHDOG,
  type RecoveryDeps,
  type RecoveryResult,
  type DriverInfo,
  type WatchdogSample,
  type WatchdogState,
} from "./lib/recovery";

const PLUGIN_ID = "wifi";

/** How often the auto-recover watchdog samples the radio state. */
const WATCHDOG_INTERVAL_MS = 12_000;

type RecoverySource = "manual" | "watchdog";

/** Persisted per-plugin settings (in ~/.config/loadout/plugins/wifi.json). */
interface WifiSettings {
  /** Keep WiFi power saving disabled (and re-assert it on every wake). */
  powerSaveDisabled?: boolean;
  /** Watch the radio and reload the driver automatically when it crashes. */
  autoRecover?: boolean;
  /** Captured while the radio is healthy, so recovery still works after the
   *  interface has vanished entirely (driver unloaded/crashed). */
  lastKnownDriver?: DriverInfo;
}

/**
 * WiFi — stop the radio dropping out by disabling power saving.
 *
 * On SteamOS/Bazzite/CachyOS handhelds the WiFi link can park itself in
 * power-save and never cleanly recover, so the connection drops until a
 * reboot. The toggle writes a NetworkManager drop-in (+ an iwd quirk where
 * iwd is installed), applies `power_save off` at runtime immediately, and —
 * because power-save re-enables itself after resume — re-asserts it on every
 * wake via the shared `@loadout/wake` logind listener. See ./lib/powersave.ts.
 *
 * Not hardware-gated: the fix is generic, so it's offered on any device.
 */
export default class WifiBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;

  /** Live handle to the resume listener while power-save-off is enabled. */
  private wakeStop: StopHandle | null = null;

  /** Auto-recover watchdog interval while the toggle is on. */
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;

  /** Single-flight guard: button + watchdog share one in-flight recovery. */
  private recoveryInFlight: Promise<RecoveryResult> | null = null;

  private lastRecovery: (RecoveryResult & { at: number; source: RecoverySource }) | null = null;

  private watchdogState: WatchdogState = initialWatchdogState();

  // Filesystem + subprocess access for the pure orchestration. Wired to the
  // real exec/fs here (the backend runs as root, so it writes /etc directly,
  // the same pattern as the apex plugin's modprobe writes); swapped for fakes
  // in tests.
  private get deps(): PowerSaveDeps {
    return {
      run: (cmd, opts) => runFull(cmd, opts),
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, content) => writeFile(path, content, "utf8"),
      removeFile: async (path) => {
        try {
          await rm(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
        }
      },
      mkdirp: async (path) => {
        await mkdir(path, { recursive: true });
      },
      pathExists: async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      listNet: () => readdir("/sys/class/net").catch(() => []),
      isWireless: async (iface) => {
        try {
          await access(`/sys/class/net/${iface}/wireless`);
          return true;
        } catch {
          return false;
        }
      },
      log: (m) => this.log?.info(`[wifi] ${m}`),
    };
  }

  /** Same wiring for the recovery orchestration (see ./lib/recovery.ts). */
  private get recoveryDeps(): RecoveryDeps {
    return {
      run: (cmd, opts) => runFull(cmd, opts),
      readFile: (path) => readFile(path, "utf8"),
      writeFile: (path, content) => writeFile(path, content, "utf8"),
      readlink: (path) => readlink(path),
      listDir: (path) => readdir(path),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      log: (m) => this.log?.info(`[wifi] ${m}`),
    };
  }

  async onLoad(): Promise<void> {
    const settings = await readPluginStorage<WifiSettings>(PLUGIN_ID);
    if (settings.powerSaveDisabled) this.startWake();
    // Capture the driver while the radio is (presumably) healthy, so a later
    // recovery still knows what to reload after the interface vanishes.
    void this.refreshLastKnownDriver().catch((e) =>
      this.log?.warn(`[wifi] driver capture failed: ${e}`),
    );
    if (settings.autoRecover) this.startWatchdog();
  }

  async onUnload(): Promise<void> {
    this.stopWake();
    this.stopWatchdog();
  }

  // ---------- RPC ----------

  /** Snapshot WiFi power-save + recovery state for the UI. */
  async getStatus(): Promise<
    PowerSaveStatus & {
      powerSaveDisabled: boolean;
      listenerRunning: boolean;
      autoRecover: boolean;
      recovering: boolean;
      lastRecovery: (RecoveryResult & { at: number; source: RecoverySource }) | null;
      watchdogSuspended: boolean;
      lastKnownDriver: { driver: string; iface: string } | null;
    }
  > {
    const [status, settings] = await Promise.all([
      computeStatus(this.deps),
      readPluginStorage<WifiSettings>(PLUGIN_ID),
    ]);
    return {
      ...status,
      powerSaveDisabled: !!settings.powerSaveDisabled,
      listenerRunning: this.wakeStop !== null,
      autoRecover: !!settings.autoRecover,
      recovering: this.recoveryInFlight !== null,
      lastRecovery: this.lastRecovery,
      watchdogSuspended: this.watchdogState.suspended,
      lastKnownDriver: settings.lastKnownDriver
        ? { driver: settings.lastKnownDriver.driver, iface: settings.lastKnownDriver.iface }
        : null,
    };
  }

  /**
   * Reload the WiFi driver to recover a crashed radio (escalating to a PCI
   * reset when the reload isn't enough). Safe to call while a watchdog run
   * is already in flight — both share the same result.
   */
  async recoverRadio(): Promise<RecoveryResult> {
    return this.runRecovery("manual");
  }

  /** Enable/disable the auto-recover watchdog. Persists across restarts. */
  async setAutoRecover(enabled: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      await mutatePluginStorage<WifiSettings>(PLUGIN_ID, (current) => ({
        ...current,
        autoRecover: enabled,
      }));
      if (enabled) {
        // A fresh opt-in also clears any prior suspension.
        this.watchdogState = initialWatchdogState();
        this.startWatchdog();
      } else {
        this.stopWatchdog();
      }
      this.emit?.({ event: "statusChanged", data: undefined });
      return { success: true };
    } catch (e) {
      this.log?.warn(`[wifi] setAutoRecover failed: ${e}`);
      return { success: false, error: String(e) };
    }
  }

  /**
   * Disable (or restore) WiFi power saving. Persists the choice, writes/removes
   * the configs, applies at runtime, and starts/stops the resume listener so
   * the setting survives wake.
   */
  async setPowerSaveDisabled(
    enabled: boolean,
  ): Promise<{ success: boolean; iface?: string | null; error?: string }> {
    try {
      const result = enabled
        ? await enablePowerSave(this.deps)
        : await disablePowerSave(this.deps);

      if (!result.success) {
        return { success: false, iface: result.iface, error: result.error };
      }

      const existing = await readPluginStorage<WifiSettings>(PLUGIN_ID);
      await writePluginStorage<WifiSettings>(PLUGIN_ID, {
        ...existing,
        powerSaveDisabled: enabled,
      });

      if (enabled) this.startWake();
      else this.stopWake();

      this.emit?.({ event: "statusChanged", data: undefined });
      return { success: true, iface: result.iface };
    } catch (e) {
      this.log?.warn(`[wifi] setPowerSaveDisabled failed: ${e}`);
      return { success: false, error: String(e) };
    }
  }

  // ---------- re-assert on wake ----------

  /** Start the logind resume listener (idempotent). */
  private startWake(): void {
    if (this.wakeStop) return;
    this.wakeStop = startWakeListener(
      {
        spawn: ({ cmd, onLine, onSpawn }) => {
          // Long-lived; resolves only when the monitor is killed on stop().
          // runStreaming runs inside the command policy, so the `dbus-monitor`
          // permission is checked here.
          void runStreaming(cmd, {
            onLine,
            onSpawn: (proc) => onSpawn({ kill: () => proc.kill() }),
          })
            .catch((e) => this.log?.warn(`[wifi] wake listener exited: ${e}`))
            // Drop the handle if the monitor dies so getStatus().listenerRunning
            // reflects reality.
            .finally(() => {
              this.wakeStop = null;
            });
        },
        log: (m) => this.log?.info(`[wifi] ${m}`),
      },
      () => void this.onResume(),
    );
    this.log?.info("[wifi] power-save-off enabled — re-asserting on every wake.");
  }

  /** Stop the resume listener (idempotent). */
  private stopWake(): void {
    if (!this.wakeStop) return;
    this.wakeStop.stop();
    this.wakeStop = null;
    this.log?.info("[wifi] wake re-assert disabled.");
  }

  /** Fired on resume — re-apply runtime power_save off (configs persist anyway). */
  private async onResume(): Promise<void> {
    try {
      await reassertRuntime(this.deps);
    } catch (e) {
      this.log?.warn(`[wifi] wake re-assert threw: ${e}`);
    }
  }

  // ---------- radio recovery ----------

  /** Run one recovery (single-flight: concurrent callers share the run). */
  private runRecovery(source: RecoverySource): Promise<RecoveryResult> {
    if (this.recoveryInFlight) return this.recoveryInFlight;

    const attempt = async (): Promise<RecoveryResult> => {
      this.emit?.({ event: "recoveryState", data: { phase: "recovering", source } });
      let result: RecoveryResult;
      try {
        const settings = await readPluginStorage<WifiSettings>(PLUGIN_ID);
        result = await recover({
          deps: this.recoveryDeps,
          lastKnown: settings.lastKnownDriver ?? null,
          onStage: (stage) => this.log?.info(`[wifi] recovery: ${stage}`),
        });
      } catch (e) {
        result = {
          ok: false,
          stage: "precheck",
          tier: null,
          driver: null,
          iface: null,
          detail: String(e),
          durationMs: 0,
        };
      }
      this.lastRecovery = { ...result, at: Date.now(), source };
      this.watchdogState = recordRecoveryOutcome({
        state: this.watchdogState,
        ok: result.ok,
        config: DEFAULT_WATCHDOG,
      });
      if (result.ok) await this.refreshLastKnownDriver().catch(() => {});
      this.log?.info(
        `[wifi] recovery ${result.ok ? "succeeded" : "failed"} ` +
          `(${source}, ${result.stage}${result.tier ? `, ${result.tier}` : ""}): ${result.detail}`,
      );
      this.emit?.({
        event: "recoveryState",
        data: { phase: result.ok ? "recovered" : "failed", result },
      });
      this.emit?.({ event: "statusChanged", data: undefined });
      return result;
    };

    const run = attempt().finally(() => {
      this.recoveryInFlight = null;
    });
    this.recoveryInFlight = run;
    return run;
  }

  /** Persist the live driver/PCI info whenever it's readable and changed. */
  private async refreshLastKnownDriver(): Promise<void> {
    const deps = this.recoveryDeps;
    const dev = await getWifiDevice({ deps, quiet: true });
    if (!dev) return;
    const info = await detectDriverInfo({ deps, iface: dev.device });
    if (!info) return;
    const existing = (await readPluginStorage<WifiSettings>(PLUGIN_ID)).lastKnownDriver;
    if (
      existing &&
      existing.driver === info.driver &&
      existing.iface === info.iface &&
      existing.pciAddress === info.pciAddress
    ) {
      return;
    }
    await mutatePluginStorage<WifiSettings>(PLUGIN_ID, (current) => ({
      ...current,
      lastKnownDriver: info,
    }));
    this.log?.info(
      `[wifi] captured wifi driver: ${info.driver} on ${info.iface}` +
        (info.pciAddress ? ` (${info.pciAddress})` : ""),
    );
  }

  /** Start the auto-recover watchdog (idempotent). */
  private startWatchdog(): void {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setInterval(() => void this.watchdogTick(), WATCHDOG_INTERVAL_MS);
    this.log?.info("[wifi] auto-recover watchdog started.");
  }

  /** Stop the auto-recover watchdog (idempotent). */
  private stopWatchdog(): void {
    if (!this.recoveryTimer) return;
    clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.log?.info("[wifi] auto-recover watchdog stopped.");
  }

  /**
   * One watchdog sample: read radio state (quiet — every 12s), feed the
   * pure reducer, and fire a recovery when it says so. The reducer owns
   * all the policy (debounce, cooldown, suspension after repeat failures).
   */
  private async watchdogTick(): Promise<void> {
    if (this.recoveryInFlight) return; // sample again after it settles
    try {
      const deps = this.recoveryDeps;
      const settings = await readPluginStorage<WifiSettings>(PLUGIN_ID);
      const dev = await getWifiDevice({ deps, quiet: true });
      const [rfkill, radioEnabled] = await Promise.all([
        readRfkill({ deps }),
        nmRadioEnabled({ deps, quiet: true }),
      ]);
      const sample: WatchdogSample = {
        wifiPresent: dev !== null,
        state: dev?.state ?? null,
        rfkillBlocked: rfkill.blocked,
        radioEnabled,
        hasKnownDriver: !!settings.lastKnownDriver,
      };
      if (sample.wifiPresent && sample.state !== "unavailable") {
        // Healthy — keep the persisted driver info fresh (handles renames).
        void this.refreshLastKnownDriver().catch(() => {});
      }
      const { next, fire, reason } = evaluateWatchdog({
        state: this.watchdogState,
        sample,
        now: Date.now(),
        config: DEFAULT_WATCHDOG,
      });
      this.watchdogState = next;
      if (fire) {
        this.log?.info(`[wifi] watchdog: radio needs recovery (${reason}) — reloading the driver.`);
        await this.runRecovery("watchdog");
      }
    } catch (e) {
      this.log?.warn(`[wifi] watchdog tick failed: ${e}`);
    }
  }
}
