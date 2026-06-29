import { readFile, writeFile, rm, access, readdir } from "node:fs/promises";
import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { runFull, runStreaming } from "@loadout/exec";
import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";
import { startWakeListener, type StopHandle } from "@loadout/wake";
import {
  enable as enablePowerSave,
  disable as disablePowerSave,
  getStatus as computeStatus,
  reassertRuntime,
  type PowerSaveDeps,
  type PowerSaveStatus,
} from "./lib/powersave";

const PLUGIN_ID = "wifi";

/** Persisted per-plugin settings (in ~/.config/loadout/plugins/wifi.json). */
interface WifiSettings {
  /** Keep WiFi power saving disabled (and re-assert it on every wake). */
  powerSaveDisabled?: boolean;
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

  async onLoad(): Promise<void> {
    const settings = await readPluginStorage<WifiSettings>(PLUGIN_ID);
    if (settings.powerSaveDisabled) this.startWake();
  }

  async onUnload(): Promise<void> {
    this.stopWake();
  }

  // ---------- RPC ----------

  /** Snapshot WiFi power-save state for the UI. */
  async getStatus(): Promise<PowerSaveStatus & { powerSaveDisabled: boolean; listenerRunning: boolean }> {
    const [status, settings] = await Promise.all([
      computeStatus(this.deps),
      readPluginStorage<WifiSettings>(PLUGIN_ID),
    ]);
    return {
      ...status,
      powerSaveDisabled: !!settings.powerSaveDisabled,
      listenerRunning: this.wakeStop !== null,
    };
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
}
