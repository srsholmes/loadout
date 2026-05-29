import type { PluginBackend, EmitPayload } from "@loadout/types";
import { run, spawn } from "@loadout/exec";
import {
  parseInstalled,
  parseUpdates,
  isValidAppId,
  type InstalledApp,
  type UpdateInfo,
} from "./lib/parse";

/**
 * Flatpak Manager plugin backend.
 *
 * Uses the `flatpak` CLI to list, update, and manage Flatpak applications.
 * Emits progress events during update operations.
 *
 * Pure parsers (`parseInstalled`, `parseUpdates`, `isValidAppId`) live in
 * `lib/parse.ts` so they can be unit-tested without mocking the subprocess
 * layer; this file owns only the I/O + RPC plumbing.
 */
export default class FlatpakManagerBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  async onLoad(): Promise<void> {
    console.log("[flatpak-manager] Plugin loaded");
  }

  async onUnload(): Promise<void> {
    console.log("[flatpak-manager] Plugin unloaded");
  }

  /** List all installed Flatpak applications. */
  async getInstalled(): Promise<InstalledApp[]> {
    const { stdout } = await run([
      "flatpak",
      "list",
      "--app",
      "--columns=name,application,version,size,origin",
    ]);
    return parseInstalled(stdout);
  }

  /** Check for available updates. */
  async checkUpdates(): Promise<UpdateInfo[]> {
    const { stdout } = await run([
      "flatpak",
      "remote-ls",
      "--updates",
      "--columns=name,application,version",
    ]);
    return parseUpdates(stdout);
  }

  /** Update all Flatpak applications. Emits progress events as output streams. */
  async updateAll(): Promise<string> {
    this.emit?.({ event: "updateStarted", data: { type: "all" } });

    const proc = spawn(["flatpak", "update", "-y"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const reader = proc.stdout.getReader();
    const chunks: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = new TextDecoder().decode(value);
        chunks.push(text);
        this.emit?.({ event: "updateProgress", data: { output: text } });
      }
    } catch {
      // Stream ended
    }

    await proc.exited;
    const fullOutput = chunks.join("");

    this.emit?.({ event: "updateComplete", data: { type: "all" } });
    return fullOutput;
  }

  /** Update a single Flatpak application by app ID. */
  async updateApp(appId: string): Promise<string> {
    if (!isValidAppId(appId)) {
      throw new Error(`Invalid Flatpak app ID: ${appId}`);
    }
    this.emit?.({ event: "updateStarted", data: { type: "single", appId } });

    const { stdout } = await run(["flatpak", "update", "-y", appId]);

    this.emit?.({ event: "updateComplete", data: { type: "single", appId } });
    return stdout;
  }

  /** Get detailed info about a Flatpak application. */
  async getAppInfo(appId: string): Promise<string> {
    if (!isValidAppId(appId)) {
      throw new Error(`Invalid Flatpak app ID: ${appId}`);
    }
    const { stdout } = await run(["flatpak", "info", appId]);
    return stdout;
  }

  /** Remove unused Flatpak runtimes and extensions. */
  async removeUnused(): Promise<{ removed: string[] }> {
    const { stdout } = await run(["flatpak", "uninstall", "--unused", "-y"]);
    if (!stdout) return { removed: [] };

    const removed = stdout
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => l.trim());

    return { removed };
  }
}
