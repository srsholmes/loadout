import type { PluginBackend, EmitPayload } from "@loadout/types";
import { run, spawn } from "@loadout/exec";

/** Validate Flatpak app ID format to prevent flag injection. */
function isValidAppId(appId: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(appId);
}

interface InstalledApp {
  name: string;
  appId: string;
  version: string;
  size: string;
  origin: string;
}

interface UpdateInfo {
  name: string;
  appId: string;
  newVersion: string;
}

/**
 * Flatpak Manager plugin backend.
 *
 * Uses the flatpak CLI to list, update, and manage Flatpak applications.
 * Emits progress events during update operations.
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
    const { stdout: output } = await run([
      "flatpak",
      "list",
      "--app",
      "--columns=name,application,version,size,origin",
    ]);
    if (!output) return [];

    const lines = output.split("\n").filter((l) => l.trim().length > 0);
    const apps: InstalledApp[] = [];

    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length < 5) continue;

      apps.push({
        name: parts[0].trim(),
        appId: parts[1].trim(),
        version: parts[2].trim(),
        size: parts[3].trim(),
        origin: parts[4].trim(),
      });
    }

    return apps;
  }

  /** Check for available updates. */
  async checkUpdates(): Promise<UpdateInfo[]> {
    const { stdout: output } = await run([
      "flatpak",
      "remote-ls",
      "--updates",
      "--columns=name,application,version",
    ]);
    if (!output) return [];

    const lines = output.split("\n").filter((l) => l.trim().length > 0);
    const updates: UpdateInfo[] = [];

    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;

      updates.push({
        name: parts[0].trim(),
        appId: parts[1].trim(),
        newVersion: parts[2].trim(),
      });
    }

    return updates;
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
    const { stdout: output } = await run(["flatpak", "uninstall", "--unused", "-y"]);
    if (!output) return { removed: [] };

    // Parse removed items from output
    const removed = output
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => l.trim());

    return { removed };
  }
}
