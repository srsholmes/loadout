import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPlugins, loadPlugins } from "./plugin-manager";

/**
 * Discovery is separate from instantiation so a disabled plugin's code is
 * never imported/run. These use frontend-only plugins (no backend.ts) so
 * we exercise the skip/registry logic without invoking Bun.build.
 */

let pluginsDir: string;

function writePlugin(id: string, opts: { app?: boolean } = {}): void {
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0", plugin: { id, name: id } }),
  );
  if (opts.app) writeFileSync(join(dir, "app.tsx"), "export default () => null;");
}

beforeEach(() => {
  pluginsDir = mkdtempSync(join(tmpdir(), "plugin-discovery-"));
});

afterEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
});

describe("discoverPlugins", () => {
  it("returns a manifest entry for every valid plugin dir", async () => {
    writePlugin("alpha", { app: true });
    writePlugin("beta");
    const discovered = await discoverPlugins(pluginsDir);
    const ids = discovered.map((d) => d.meta.id).sort();
    expect(ids).toEqual(["alpha", "beta"]);
    expect(discovered.find((d) => d.meta.id === "alpha")?.hasApp).toBe(true);
    expect(discovered.find((d) => d.meta.id === "beta")?.hasApp).toBe(false);
  });
});

describe("loadPlugins with a disabled set", () => {
  it("skips disabled plugins entirely but still registers them", async () => {
    writePlugin("alpha", { app: true });
    writePlugin("beta", { app: true });
    const discovered = await discoverPlugins(pluginsDir);

    const { loaded, registry } = await loadPlugins({
      discovered,
      broadcast: () => {},
      disabledIds: new Set(["beta"]),
    });

    // Enabled plugin is instantiated; disabled one is not in the loaded map.
    expect(loaded.has("alpha")).toBe(true);
    expect(loaded.has("beta")).toBe(false);

    // Both appear in the registry with the right status, so the UI can
    // still list and re-enable the disabled one.
    expect(registry.get("alpha")?.status).toBe("loaded");
    expect(registry.get("beta")?.status).toBe("disabled");
  });

  it("loads everything when nothing is disabled", async () => {
    writePlugin("alpha", { app: true });
    const discovered = await discoverPlugins(pluginsDir);
    const { loaded } = await loadPlugins({ discovered, broadcast: () => {} });
    expect(loaded.has("alpha")).toBe(true);
  });
});
