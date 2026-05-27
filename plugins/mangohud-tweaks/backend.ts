import type { PluginBackend, EmitPayload } from "@loadout/types";
import { run } from "@loadout/exec";
import { homedir } from "os";
import { join } from "path";
import { mkdir } from "node:fs/promises";

const CONFIG_PATH = join(homedir(), ".config", "MangoHud", "MangoHud.conf");

interface Preset {
  name: string;
  label: string;
  config: Record<string, string>;
}

const PRESETS: Preset[] = [
  {
    name: "minimal",
    label: "Minimal",
    config: { fps: "1", fps_only: "1" },
  },
  {
    name: "standard",
    label: "Standard",
    config: { fps: "1", gpu_stats: "1", cpu_stats: "1", ram: "1", vram: "1" },
  },
  {
    name: "full",
    label: "Full",
    config: {
      fps: "1",
      gpu_stats: "1",
      cpu_stats: "1",
      cpu_temp: "1",
      gpu_temp: "1",
      ram: "1",
      vram: "1",
      frame_timing: "1",
      battery: "1",
      gamemode: "1",
    },
  },
  {
    name: "battery",
    label: "Battery",
    config: { fps: "1", battery: "1", battery_watt: "1", gpu_power: "1" },
  },
  {
    name: "off",
    label: "Off",
    config: { no_display: "1" },
  },
];

/**
 * MangoHud Tweaks plugin backend.
 *
 * Reads and writes MangoHud configuration from ~/.config/MangoHud/MangoHud.conf.
 * Provides preset management and toggle-based configuration.
 *
 * Inspired by the MangoPeel Decky-Loader plugin
 * (https://github.com/Gawah/MangoPeel, BSD-3-Clause). No source code from
 * MangoPeel was copied; this is an independent implementation. See NOTICE.
 */
export default class MangoHudTweaksBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  async onLoad(): Promise<void> {
    console.log("[mangohud-tweaks] Plugin loaded");
  }

  async onUnload(): Promise<void> {
    console.log("[mangohud-tweaks] Plugin unloaded");
  }

  /** Check if MangoHud is installed on the system. */
  async isInstalled(): Promise<boolean> {
    try {
      const { stdout } = await run(["which", "mangohud"]);
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  /** Read and parse MangoHud.conf into a key-value record. */
  async getConfig(): Promise<Record<string, string>> {
    try {
      const file = Bun.file(CONFIG_PATH);
      const exists = await file.exists();
      if (!exists) return {};

      const text = await file.text();
      const config: Record<string, string> = {};

      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex !== -1) {
          const key = trimmed.substring(0, eqIndex).trim();
          const value = trimmed.substring(eqIndex + 1).trim();
          config[key] = value;
        }
      }

      return config;
    } catch {
      return {};
    }
  }

  /** Write key-value pairs back to MangoHud.conf, preserving comment lines. */
  async setConfig(config: Record<string, string>): Promise<void> {
    const dir = join(homedir(), ".config", "MangoHud");
    await mkdir(dir, { recursive: true });

    // Read existing comments fresh (avoid race condition with cached state)
    let commentLines: string[] = [];
    try {
      const file = Bun.file(CONFIG_PATH);
      if (await file.exists()) {
        const text = await file.text();
        commentLines = text.split("\n").filter(line => {
          const t = line.trim();
          return !t || t.startsWith("#");
        });
      }
    } catch { /* no existing file */ }

    const lines: string[] = [...commentLines];
    for (const [key, value] of Object.entries(config)) {
      lines.push(`${key}=${value}`);
    }

    await Bun.write(CONFIG_PATH, lines.join("\n") + "\n");
    this.emit?.({ event: "configChanged", data: config });
  }

  /** Return the list of built-in presets. */
  async getPresets(): Promise<Preset[]> {
    return PRESETS;
  }

  /** Overwrite the config file with a preset's values. */
  async applyPreset(name: string): Promise<{ success: boolean; error?: string }> {
    const preset = PRESETS.find((p) => p.name === name);
    if (!preset) {
      return { success: false, error: `Unknown preset: ${name}` };
    }

    // When applying a preset, start fresh (clear old config, keep comments)
    await this.setConfig(preset.config);
    return { success: true };
  }

  /** Delete the config file so MangoHud uses its defaults. */
  async resetConfig(): Promise<void> {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(CONFIG_PATH);
    } catch {
      // File may not exist
    }
    this.emit?.({
      event: "configChanged",
      data: {},
    });
  }
}
