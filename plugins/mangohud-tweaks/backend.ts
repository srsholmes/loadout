import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { run } from "@loadout/exec";
import { homedir } from "os";
import { join } from "path";
import { mkdir, unlink } from "node:fs/promises";
import {
  PRESETS,
  type Preset,
  parseConfig,
  extractCommentLines,
  serializeConfig,
  findPreset,
} from "./lib/config";

const CONFIG_PATH = join(homedir(), ".config", "MangoHud", "MangoHud.conf");
const CONFIG_DIR = join(homedir(), ".config", "MangoHud");

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
  log?: PluginLogger;

  async onLoad(): Promise<void> {
    this.log?.info("Plugin loaded");
  }

  async onUnload(): Promise<void> {
    this.log?.info("Plugin unloaded");
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
      return parseConfig(await file.text());
    } catch {
      return {};
    }
  }

  /** Write key-value pairs back to MangoHud.conf, preserving comment lines. */
  async setConfig(config: Record<string, string>): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true });

    // Read existing comments fresh (avoid race condition with cached state)
    let commentLines: string[] = [];
    try {
      const file = Bun.file(CONFIG_PATH);
      if (await file.exists()) {
        commentLines = extractCommentLines(await file.text());
      }
    } catch {
      /* no existing file */
    }

    await Bun.write(CONFIG_PATH, serializeConfig(config, commentLines));
    this.emit?.({ event: "configChanged", data: config });
  }

  /** Return the list of built-in presets. */
  async getPresets(): Promise<Preset[]> {
    return PRESETS;
  }

  /** Overwrite the config file with a preset's values. */
  async applyPreset(name: string): Promise<{ success: boolean; error?: string }> {
    const preset = findPreset(name);
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
