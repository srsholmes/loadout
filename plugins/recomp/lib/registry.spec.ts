import { describe, it, expect } from "bun:test";
import { loadBundledRegistry, validateModEntry } from "./registry";
import type { ModEntry } from "./types";

describe("loadBundledRegistry", () => {
  it("returns a non-empty list of games", () => {
    const games = loadBundledRegistry();
    expect(Array.isArray(games)).toBe(true);
    expect(games.length).toBeGreaterThan(0);
  });

  it("includes dusklight (the posterchild one-click install)", () => {
    const games = loadBundledRegistry();
    const dusklight = games.find((g) => g.id === "dusklight");
    expect(dusklight).toBeDefined();
    expect(dusklight!.installType).toBe("prebuilt");
    expect(dusklight!.releaseAssets.linux).toContain(".AppImage");
    expect(dusklight!.launchCommand.linux).toContain(".AppImage");
  });

  it("every entry has the registry-required fields", () => {
    const games = loadBundledRegistry();
    for (const g of games) {
      expect(typeof g.id).toBe("string");
      expect(g.id.length).toBeGreaterThan(0);
      expect(typeof g.name).toBe("string");
      expect(typeof g.platform).toBe("string");
      expect(typeof g.installType).toBe("string");
      expect(g.releaseAssets).toBeTruthy();
      expect(g.launchCommand).toBeTruthy();
    }
  });

  it("ids are unique across the bundle", () => {
    const games = loadBundledRegistry();
    const ids = new Set<string>();
    for (const g of games) {
      expect(ids.has(g.id)).toBe(false);
      ids.add(g.id);
    }
  });

  it("surfaces dusklight's mods catalog from games.json", () => {
    const games = loadBundledRegistry();
    const dusklight = games.find((g) => g.id === "dusklight");
    expect(dusklight?.mods?.length ?? 0).toBeGreaterThan(0);
    // Spot-check a few entries that v0.1 ships.
    expect(dusklight!.mods!.some((m) => m.id === "tphd-definitive")).toBe(true);
    expect(dusklight!.mods!.some((m) => m.id === "henriko-4k")).toBe(true);
    expect(dusklight!.mods!.some((m) => m.id === "personal-reshade")).toBe(true);
  });
});

describe("validateModEntry", () => {
  function base(): ModEntry {
    return {
      id: "x",
      name: "X",
      description: "",
      source: { kind: "direct-url", url: "https://x" },
      installSubdir: "textures/",
    };
  }

  it("accepts a valid direct-url entry with installSubdir", () => {
    expect(validateModEntry("g", base())).toBeNull();
  });

  it("rejects a manual-import entry without externalUrl", () => {
    const m: ModEntry = {
      ...base(),
      source: { kind: "manual-import" },
    };
    const err = validateModEntry("g", m);
    expect(err).toMatch(/manual-import.*externalUrl/);
  });

  it("rejects an entry with neither setupModule nor installSubdir", () => {
    const m: ModEntry = {
      ...base(),
      installSubdir: undefined,
    };
    expect(validateModEntry("g", m)).toMatch(/neither setupModule nor installSubdir/);
  });

  it("rejects an entry with a missing setupModule file", () => {
    const m: ModEntry = {
      ...base(),
      installSubdir: undefined,
      setupModule: "does-not-exist.ts",
    };
    expect(validateModEntry("g", m)).toMatch(/setupModule.*doesn't exist/);
  });
});
