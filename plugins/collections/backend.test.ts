// Real-disk I/O against a per-test temp XDG_CONFIG_HOME. See
// lib/backups.test.ts for why fs is not mocked.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMethod } from "@loadout/types";
import type { GameInfo } from "@loadout/types";
import type { SteamLibraryEntry } from "@loadout/steam-cdp";

/**
 * `getSnapshot` reads Steam's live library over CDP. Without this stub these
 * tests pass or fail depending on whether Steam happens to be running on the
 * machine — on a dev Deck they were reaching the real client and getting 4356
 * games where the fixture supplies one. Default is "Steam unreachable", which
 * exercises the degradation path; `steamEntries` opts a test into the merge.
 */
let steamEntries: SteamLibraryEntry[] | null = null;

mock.module("@loadout/steam-cdp", () => ({
  withSteamClient: async (fn: (client: unknown) => unknown) => {
    if (steamEntries === null) throw new Error("Steam is not running (test stub)");
    return fn({});
  },
  readSteamLibrary: async () => ({
    entries: steamEntries ?? [],
    installedCount: (steamEntries ?? []).filter((e) => e.installed).length,
    resolvedTagCount: 0,
  }),
}));

const { default: CollectionsBackend } = await import("./backend");
import { COLLECTIONS_SCHEMA_VERSION, defaultConfig } from "./lib/config";
import { UNKNOWN } from "./lib/rules";
import { encodeShareString, exportTabs } from "./lib/share";
import type { Tab } from "./lib/types";

let tempDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  steamEntries = null;
  prevXdg = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "collections-backend-"));
  process.env.XDG_CONFIG_HOME = tempDir;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tempDir, { recursive: true, force: true });
});

function gameInfo(appId: string, name: string, extra: Partial<GameInfo> = {}): GameInfo {
  return {
    appId,
    name,
    sizeOnDisk: 1024 ** 3,
    headerUrl: `https://example.test/${appId}/h.jpg`,
    capsuleUrl: `https://example.test/${appId}/c.jpg`,
    localHeaderUrl: `https://example.test/${appId}/h.jpg`,
    localCapsuleUrl: `https://example.test/${appId}/c.jpg`,
    source: "steam",
    tags: [],
    ...extra,
  };
}

interface Harness {
  backend: CollectionsBackend;
  events: Array<{ event: string; data: unknown }>;
  calls: Array<{ plugin: string; method: string }>;
}

/**
 * A loaded backend with `callPlugin` stubbed. `overrides` lets a test make a
 * dependency fail or vanish, which is the interesting case for most of this.
 */
async function harness(
  overrides: Record<string, () => Promise<unknown>> = {},
): Promise<Harness> {
  const backend = new CollectionsBackend();
  const events: Harness["events"] = [];
  const calls: Harness["calls"] = [];

  backend.emit = (payload) => events.push({ event: payload.event, data: payload.data });
  backend.callPlugin = (async (plugin: string, method: string) => {
    calls.push({ plugin, method });
    const key = `${plugin}.${method}`;
    if (key in overrides) return overrides[key]!();
    if (key === "__core:game-library.getGames") {
      return [gameInfo("620", "Portal 2", { tags: ["favorite"] })];
    }
    if (key === "playtime.getSteamPlaytime") {
      return [{ appId: "620", gameName: "Portal 2", totalMs: 90 * 60_000 }];
    }
    throw new Error(`unexpected call ${key}`);
  }) as CollectionsBackend["callPlugin"];

  await backend.onLoad();
  return { backend, events, calls };
}

describe("RPC surface", () => {
  it("exposes the intended methods", () => {
    const backend = new CollectionsBackend();
    for (const method of [
      "getConfig",
      "setConfig",
      "setTabs",
      "reorderTabs",
      "createTabFromTemplate",
      "deleteTab",
      "getSnapshot",
      "listBackups",
      "createBackup",
      "restoreBackupFile",
      "exportTab",
      "exportAllTabs",
      "importShareCode",
    ]) {
      expect(resolveMethod({ instance: backend, name: method })).toBeInstanceOf(Function);
    }
  });

  it("keeps lifecycle hooks and private helpers off the RPC surface", () => {
    const backend = new CollectionsBackend();
    for (const blocked of [
      "onLoad",
      "onUnload",
      "_fetchGames",
      "_fetchPlaytime",
      "_applyLoad",
      "_assertWritable",
      "_broadcast",
      "constructor",
      "toString",
    ]) {
      expect(resolveMethod({ instance: backend, name: blocked })).toBeUndefined();
    }
  });
});

describe("onLoad / getConfig", () => {
  it("seeds defaults on a first run", async () => {
    const { backend } = await harness();
    const { config, readOnly } = await backend.getConfig();
    expect(config.schemaVersion).toBe(COLLECTIONS_SCHEMA_VERSION);
    expect(config.tabs.length).toBeGreaterThan(0);
    expect(readOnly).toBe(false);
  });

  it("hands over load warnings once, then clears them", async () => {
    // Warnings describe a load event, not a persistent state; re-showing them
    // on every poll would nag.
    const { backend } = await harness();
    await backend.getConfig();
    expect((await backend.getConfig()).warnings).toEqual([]);
  });
});

describe("setConfig", () => {
  it("persists and broadcasts", async () => {
    const { backend, events } = await harness();
    const { config } = await backend.getConfig();
    const renamed = {
      ...config,
      tabs: [{ ...config.tabs[0]!, label: "Renamed" }, ...config.tabs.slice(1)],
    };

    await backend.setConfig(renamed);
    expect((await backend.getConfig()).config.tabs[0]!.label).toBe("Renamed");
    expect(events.map((e) => e.event)).toContain("configChanged");
  });

  it("survives a reload", async () => {
    const { backend } = await harness();
    const { config } = await backend.getConfig();
    await backend.setConfig({ ...config, defaultTabId: "installed" });

    const second = new CollectionsBackend();
    await second.onLoad();
    expect((await second.getConfig()).config.defaultTabId).toBe("installed");
  });

  it("rejects an invalid config rather than persisting it", async () => {
    const { backend } = await harness();
    const invalid = { ...defaultConfig(), tabs: [{ label: "no id" }] } as never;
    await expect(backend.setConfig(invalid)).rejects.toThrow(/Refusing to save invalid/);
    // And the good config is still in place.
    expect((await backend.getConfig()).config.tabs.length).toBeGreaterThan(0);
  });

  it("surfaces a storage failure as a rejection, not a silent loss", async () => {
    const { backend } = await harness();
    const { config } = await backend.getConfig();
    // Point the config dir at a path that cannot be created.
    process.env.XDG_CONFIG_HOME = "/dev/null/nope";
    await expect(backend.setConfig(config)).rejects.toThrow();
    process.env.XDG_CONFIG_HOME = tempDir;
  });
});

describe("reorderTabs", () => {
  it("applies the given order", async () => {
    const { backend } = await harness();
    const { config } = await backend.getConfig();
    const reversed = [...config.tabOrder].reverse();
    const next = await backend.reorderTabs(reversed);
    expect(next.tabOrder).toEqual(reversed);
  });

  it("appends tabs the caller forgot, so a stale UI can't hide one", async () => {
    const { backend } = await harness();
    const { config } = await backend.getConfig();
    const next = await backend.reorderTabs([config.tabOrder[1]!]);
    expect(next.tabOrder).toHaveLength(config.tabs.length);
    expect(next.tabOrder[0]).toBe(config.tabOrder[1]);
  });

  it("ignores unknown ids", async () => {
    const { backend } = await harness();
    const next = await backend.reorderTabs(["ghost"]);
    expect(next.tabOrder).not.toContain("ghost");
  });
});

describe("createTabFromTemplate / deleteTab", () => {
  it("creates an editable tab from a template", async () => {
    const { backend } = await harness();
    const next = await backend.createTabFromTemplate("backlog");
    const created = next.tabs.find((t) => t.id === "backlog")!;
    expect(created).toBeDefined();
    expect(created.builtin).toBeUndefined();
    expect(next.tabOrder).toContain("backlog");
  });

  it("gives a second instance a unique id", async () => {
    const { backend } = await harness();
    await backend.createTabFromTemplate("backlog");
    const next = await backend.createTabFromTemplate("backlog");
    expect(next.tabs.filter((t) => t.id.startsWith("backlog"))).toHaveLength(2);
  });

  it("rejects an unknown template", async () => {
    const { backend } = await harness();
    await expect(backend.createTabFromTemplate("nope")).rejects.toThrow(/Unknown template/);
  });

  it("deletes a custom tab and prunes it from profiles and defaultTabId", async () => {
    const { backend } = await harness();
    await backend.createTabFromTemplate("backlog");
    const { config } = await backend.getConfig();
    await backend.setConfig({
      ...config,
      defaultTabId: "backlog",
      profiles: [{ id: "p", label: "P", appIds: [], tabIds: ["backlog", "all"] }],
    });

    const next = await backend.deleteTab("backlog");
    expect(next.tabs.some((t) => t.id === "backlog")).toBe(false);
    expect(next.defaultTabId).toBeNull();
    expect(next.profiles[0]!.tabIds).toEqual(["all"]);
  });

  it("refuses to delete a builtin, which can only be hidden", async () => {
    // Otherwise a user loses a tab this build defines with no way back.
    const { backend } = await harness();
    await expect(backend.deleteTab("installed")).rejects.toThrow(/hidden but not deleted/);
  });

  it("is a no-op for an unknown tab", async () => {
    const { backend } = await harness();
    const before = (await backend.getConfig()).config.tabs.length;
    const next = await backend.deleteTab("ghost");
    expect(next.tabs).toHaveLength(before);
  });
});

describe("getSnapshot", () => {
  /** A Steam entry with everything the merge reads. */
  function steamEntry(
    appId: string,
    extra: Partial<SteamLibraryEntry> = {},
  ): SteamLibraryEntry {
    return {
      appId,
      name: `App ${appId}`,
      sortAs: `app ${appId}`,
      kind: "game",
      installed: false,
      owned: true,
      streamable: false,
      sizeOnDisk: -1,
      lastPlayed: -1,
      playtimeMinutes: -1,
      deckCompat: 0,
      steamOsCompat: 0,
      reviewPercentage: -1,
      metacritic: -1,
      releaseDate: -1,
      purchasedAt: -1,
      comingSoon: false,
      familyShared: false,
      storeTags: [],
      collections: [],
      romPlatform: null,
      ...extra,
    };
  }

  it("adds owned-but-not-installed games Steam knows about", async () => {
    // The whole point of the appstore provider: the manifest scan only sees
    // installed games, so an uninstalled purchase was invisible entirely.
    steamEntries = [steamEntry("620"), steamEntry("999", { deckCompat: 3 })];
    const { backend } = await harness();
    const snapshot = await backend.getSnapshot();

    expect(snapshot.games.map((g) => g.appId).sort()).toEqual(["620", "999"]);
    expect(snapshot.games.find((g) => g.appId === "999")!.deckCompat).toBe("verified");
    expect(snapshot.providers.appstore.status).toBe("ok");
  });

  it("keeps the manifest's measured size over Steam's guess", async () => {
    // Steam populates size_on_disk for ~3% of a library; the manifest measured
    // it from an actual .acf, so it wins where both have an answer.
    steamEntries = [steamEntry("620", { sizeOnDisk: 5 })];
    const { backend } = await harness();
    const snapshot = await backend.getSnapshot();
    expect(snapshot.games.find((g) => g.appId === "620")!.sizeOnDisk).toBe(1024 ** 3);
  });

  it("falls back to the manifest-only snapshot when Steam is unreachable", async () => {
    steamEntries = null;
    const { backend } = await harness();
    const snapshot = await backend.getSnapshot();
    // A smaller honest library beats an error, and the provider state says so.
    expect(snapshot.games).toHaveLength(1);
    expect(snapshot.providers.appstore.status).not.toBe("ok");
  });

  it("adapts the library and reports provider health", async () => {
    const { backend } = await harness();
    const snapshot = await backend.getSnapshot();
    expect(snapshot.games).toHaveLength(1);
    expect(snapshot.games[0]!.name).toBe("Portal 2");
    expect(snapshot.games[0]!.collections).toEqual(["favorite"]);
    expect(snapshot.providers.manifest.status).toBe("ok");
  });

  it("folds in play time when the plugin answers", async () => {
    const { backend } = await harness();
    const snapshot = await backend.getSnapshot();
    expect(snapshot.games[0]!.playtimeMinutes).toBe(90);
    expect(snapshot.providers.appstore.status).toBe("stale");
  });

  it("degrades to unknown play time when the plugin is disabled", async () => {
    // `null` (nobody can tell us) must not be confused with `[]` (you have
    // played nothing) — that confusion is what makes a play-time rule
    // silently match nothing.
    const { backend } = await harness({
      "playtime.getSteamPlaytime": () => Promise.reject(new Error("plugin disabled")),
    });
    const snapshot = await backend.getSnapshot();
    expect(snapshot.games[0]!.playtimeMinutes).toBe(UNKNOWN);
    expect(snapshot.providers.appstore.status).toBe("unavailable");
    expect(snapshot.providers.appstore.reason).toBeDefined();
  });

  it("distinguishes an empty playtime list from an absent plugin", async () => {
    const { backend } = await harness({
      "playtime.getSteamPlaytime": () => Promise.resolve([]),
    });
    const snapshot = await backend.getSnapshot();
    // The plugin answered, so appstore is stale rather than unavailable…
    expect(snapshot.providers.appstore.status).toBe("stale");
    // …but this game still has no recorded time.
    expect(snapshot.games[0]!.playtimeMinutes).toBe(UNKNOWN);
  });

  it("returns an empty library rather than throwing when the scan fails", async () => {
    const { backend } = await harness({
      "__core:game-library.getGames": () => Promise.reject(new Error("no steam")),
    });
    const snapshot = await backend.getSnapshot();
    expect(snapshot.games).toEqual([]);
    expect(snapshot.providers.manifest.status).toBe("ok");
  });

  it("tolerates a non-array response from the library service", async () => {
    const { backend } = await harness({
      "__core:game-library.getGames": () => Promise.resolve(null),
    });
    expect((await backend.getSnapshot()).games).toEqual([]);
  });
});

describe("backups", () => {
  it("creates and lists a manual backup", async () => {
    const { backend } = await harness();
    const info = await backend.createBackup();
    expect(info.reason).toBe("manual");
    expect((await backend.listBackups()).some((b) => b.file === info.file)).toBe(true);
  });

  it("restores a backup and broadcasts the change", async () => {
    const { backend, events } = await harness();
    const { config } = await backend.getConfig();
    const backup = await backend.createBackup();

    await backend.setConfig({
      ...config,
      tabs: [{ ...config.tabs[0]!, label: "Changed" }, ...config.tabs.slice(1)],
    });
    events.length = 0;

    const restored = await backend.restoreBackupFile(backup.file);
    expect(restored.tabs[0]!.label).toBe(config.tabs[0]!.label);
    expect(events.map((e) => e.event)).toContain("configChanged");
  });

  it("rejects a bogus backup filename with a user-facing message", async () => {
    const { backend } = await harness();
    await expect(backend.restoreBackupFile("../../etc/passwd")).rejects.toThrow(
      /isn't a Collections backup file/,
    );
  });
});

describe("sharing", () => {
  function customTab(id: string, label: string): Tab {
    const base = defaultConfig().tabs[0]!;
    return { ...base, id, label, builtin: undefined, mirror: { enabled: false, collectionName: label } };
  }

  it("exports a single tab as a decodable code", async () => {
    const { backend } = await harness();
    await backend.createTabFromTemplate("backlog");
    const code = await backend.exportTab("backlog");
    expect(code.length).toBeGreaterThan(10);
    expect(code).not.toMatch(/[+/=]/); // base64url
  });

  it("refuses to export a tab that no longer exists", async () => {
    const { backend } = await harness();
    await expect(backend.exportTab("ghost")).rejects.toThrow(/no longer exists/);
  });

  it("exports only custom tabs in bulk", async () => {
    // Exporting builtins would only produce tabs the importer must reject.
    const { backend } = await harness();
    await expect(backend.exportAllTabs()).rejects.toThrow(/no custom tabs/);
    await backend.createTabFromTemplate("backlog");
    await expect(backend.exportAllTabs()).resolves.toBeString();
  });

  it("imports additively and reports what it did", async () => {
    const { backend } = await harness();
    const before = (await backend.getConfig()).config.tabs.length;
    const code = encodeShareString(exportTabs([customTab("shared", "Shared")]));

    const result = await backend.importShareCode(code);
    expect(result.added).toEqual(["shared"]);
    expect(result.config.tabs).toHaveLength(before + 1);
  });

  it("takes a pre-import backup, so an unwanted import is one click from undone", async () => {
    const { backend } = await harness();
    const code = encodeShareString(exportTabs([customTab("shared", "Shared")]));
    await backend.importShareCode(code);
    expect((await backend.listBackups()).some((b) => b.reason === "pre-import")).toBe(true);
  });

  it("forces mirroring off on imported tabs", async () => {
    const { backend } = await harness();
    const hostile: Tab = {
      ...customTab("shared", "Shared"),
      mirror: { enabled: true, collectionName: "Theirs" },
    };
    const result = await backend.importShareCode(encodeShareString(exportTabs([hostile])));
    expect(result.config.tabs.find((t) => t.id === "shared")!.mirror.enabled).toBe(false);
  });

  it("rejects a malformed code with a message written for a person", async () => {
    const { backend } = await harness();
    await expect(backend.importShareCode("!!!nonsense!!!")).rejects.toThrow(/truncated/);
  });
});

describe("read-only mode", () => {
  /** Seed a config from a newer schema, then load it. */
  async function futureBackend(): Promise<CollectionsBackend> {
    const seeder = new CollectionsBackend();
    await seeder.onLoad();
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { pluginStoragePath } = await import("@loadout/plugin-storage");
    const path = pluginStoragePath("collections");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ ...defaultConfig(), schemaVersion: COLLECTIONS_SCHEMA_VERSION + 5 }),
    );

    const backend = new CollectionsBackend();
    await backend.onLoad();
    return backend;
  }

  it("is flagged, with an explanation", async () => {
    const backend = await futureBackend();
    const { readOnly, warnings } = await backend.getConfig();
    expect(readOnly).toBe(true);
    expect(warnings[0]).toContain("newer version of Loadout");
  });

  it("refuses every write, telling the user what to do", async () => {
    const backend = await futureBackend();
    const { config } = await backend.getConfig();
    for (const attempt of [
      () => backend.setConfig(config),
      () => backend.deleteTab("all"),
      () => backend.importShareCode("whatever"),
      () => backend.restoreBackupFile("x.json"),
    ]) {
      await expect(attempt()).rejects.toThrow(/newer version of Loadout|Update Loadout/);
    }
  });

  it("still serves the library, so the plugin renders read-only", async () => {
    const backend = await futureBackend();
    backend.callPlugin = (async (plugin: string, method: string) => {
      if (`${plugin}.${method}` === "__core:game-library.getGames") {
        return [gameInfo("620", "Portal 2")];
      }
      throw new Error("nope");
    }) as CollectionsBackend["callPlugin"];
    expect((await backend.getSnapshot()).games).toHaveLength(1);
  });
});
