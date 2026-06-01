import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { PersistedState, InstalledGame } from "./types";

// In-process scratch store for @loadout/plugin-storage so the suite's
// `loadState` / `saveState` cycles don't write through to the dev's
// real `~/.config/loadout/plugins/store-bridge.json`. Cleared in
// `beforeEach`.
const pluginStorageStore = new Map<string, unknown>();
mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: async <T>(id: string): Promise<Partial<T>> =>
    (pluginStorageStore.get(id) as Partial<T> | undefined) ?? {},
  writePluginStorage: async <T>(id: string, data: T): Promise<void> => {
    pluginStorageStore.set(id, data);
  },
  pluginStoragePath: (id: string) => `/tmp/spec/${id}.json`,
  loadoutConfigDir: () => "/tmp/spec",
}));

const PLUGIN_ID = "store-bridge";

/** Seed the fake plugin-storage with a raw on-disk shape. */
async function writeRaw(state: unknown): Promise<void> {
  pluginStorageStore.set(PLUGIN_ID, state);
}

/** Read back the persisted shape after a saveState. */
async function readRaw(): Promise<PersistedState> {
  return pluginStorageStore.get(PLUGIN_ID) as PersistedState;
}

beforeEach(() => {
  pluginStorageStore.clear();
});

function makeInstalled(overrides?: Partial<InstalledGame>): InstalledGame {
  return {
    id: "fortnite",
    title: "Fortnite",
    installedAt: "2026-01-01T00:00:00Z",
    installDir: "/tmp/games/fortnite",
    source: "installed",
    addedToSteam: false,
    ...overrides,
  };
}

describe("state — load / defaults", () => {
  it("returns defaults when no file exists", async () => {
    const { loadState } = await import("./state");
    const state = await loadState();
    expect(state.version).toBe(1);
    expect(state.settings.enabledStores).toEqual(["epic"]);
    expect(state.settings.scanPaths).toEqual([]);
    expect(state.stores.epic).toBeDefined();
    expect(state.stores.epic?.authStatus).toBe("unknown");
  });

  it("merges partial settings over defaults", async () => {
    await writeRaw({
      version: 1,
      stores: {},
      settings: { scanPaths: ["/mnt/games"] },
    });
    const { loadState } = await import("./state");
    const state = await loadState();
    expect(state.settings.scanPaths).toEqual(["/mnt/games"]);
    // missing keys still get defaults
    expect(state.settings.enabledStores).toEqual(["epic"]);
  });

  it("normalises a partial store slice — missing library/installed default to {}", async () => {
    await writeRaw({
      version: 1,
      stores: { epic: { authStatus: "authed" } },
      settings: {},
    });
    const { loadState } = await import("./state");
    const state = await loadState();
    expect(state.stores.epic?.authStatus).toBe("authed");
    expect(state.stores.epic?.library).toEqual({});
    expect(state.stores.epic?.installed).toEqual({});
  });

  it("falls back to defaults on missing state (plugin-storage returns {})", async () => {
    // No write seeded — read returns `{}` from the fake plugin-storage.
    const { loadState } = await import("./state");
    const state = await loadState();
    expect(state.version).toBe(1);
    expect(state.stores.epic).toBeDefined();
  });

  it("updateSettings normalises pinnedVersion (defence in depth)", async () => {
    const { loadState, updateSettings } = await import("./state");
    let state = await loadState();
    // Multi-line + control chars + extra whitespace should be
    // stripped; cap at 64 chars.
    const raw = `\n\tv0.20.34  !@#$%^&*() ${"x".repeat(200)}`;
    state = await updateSettings(state, {
      driverOverrides: { epic: { pinnedVersion: raw } },
    });
    const cleaned = state.settings.driverOverrides?.epic?.pinnedVersion ?? "";
    expect(cleaned.length).toBeLessThanOrEqual(64);
    expect(cleaned).toMatch(/^v0\.20\.34/);
    expect(cleaned).not.toMatch(/[^A-Za-z0-9._-]/);
  });
});

describe("state — write helpers", () => {
  it("updateInstalledGame namespaces under the right store", async () => {
    const { loadState, updateInstalledGame } = await import("./state");
    const base = await loadState();
    const next = await updateInstalledGame(base, "epic", "fortnite", makeInstalled());
    expect(next.stores.epic?.installed.fortnite?.title).toBe("Fortnite");
    const disk = await readRaw();
    expect(disk.stores.epic?.installed.fortnite?.title).toBe("Fortnite");
  });

  it("removeInstalledGame drops the entry without touching other stores", async () => {
    const { loadState, updateInstalledGame, removeInstalledGame } = await import("./state");
    let state = await loadState();
    state = await updateInstalledGame(state, "epic", "a", makeInstalled({ id: "a", title: "A" }));
    state = await updateInstalledGame(state, "epic", "b", makeInstalled({ id: "b", title: "B" }));
    state = await removeInstalledGame(state, "epic", "a");
    expect(state.stores.epic?.installed.a).toBeUndefined();
    expect(state.stores.epic?.installed.b?.title).toBe("B");
  });

  it("updateSettings only touches the settings slice", async () => {
    const { loadState, updateSettings } = await import("./state");
    let state = await loadState();
    state = await updateSettings(state, {
      driverOverrides: { epic: { binary: "/opt/legendary" } },
    });
    expect(state.settings.driverOverrides?.epic?.binary).toBe("/opt/legendary");
    expect(state.settings.enabledStores).toEqual(["epic"]); // unchanged
  });

  it("addScanPath dedupes, removeScanPath strips", async () => {
    const { loadState, addScanPath, removeScanPath } = await import("./state");
    let state = await loadState();
    state = await addScanPath(state, "/data/games");
    state = await addScanPath(state, "/data/games"); // dupe — no-op
    state = await addScanPath(state, "/mnt/ext");
    expect(state.settings.scanPaths).toEqual(["/data/games", "/mnt/ext"]);
    state = await removeScanPath(state, "/data/games");
    expect(state.settings.scanPaths).toEqual(["/mnt/ext"]);
  });

  it("updateStoreLibrary stamps libraryCacheFetchedAt", async () => {
    const { loadState, updateStoreLibrary } = await import("./state");
    const state = await loadState();
    const before = Date.now();
    const next = await updateStoreLibrary(state, "epic", {
      fortnite: { id: "fortnite", title: "Fortnite" },
    });
    expect(next.stores.epic?.library.fortnite?.title).toBe("Fortnite");
    expect(next.stores.epic?.libraryCacheFetchedAt).toBeGreaterThanOrEqual(before);
  });

  it("updateAuthStatus flips just the auth flag for the right store", async () => {
    const { loadState, updateAuthStatus } = await import("./state");
    const state = await loadState();
    const next = await updateAuthStatus(state, "epic", "authed");
    expect(next.stores.epic?.authStatus).toBe("authed");
  });
});
