import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameEntry, PersistedState } from "./types";

// Sandbox all on-disk paths into a per-test scratch space so the
// install pipeline writes nowhere real.
let sandbox = "";
// When set, `configDir()` points at an unwritable location (a path
// whose parent is a regular file) so the final state persist throws —
// exercising the "shortcut already created, later step fails" path
// without re-mocking the state module (which would break the real
// load/save helpers the test itself relies on).
let breakConfigDir = false;
mock.module("./platform", () => ({
  configDir: () =>
    breakConfigDir ? join(sandbox, "afile", "nested") : join(sandbox, "config"),
  gamesDir: () => join(sandbox, "games"),
  currentPlatform: () => "linux",
  getPlatformValue: (assets: Record<string, string>) => assets.linux,
  getEffectivePlatformValue: (assets: Record<string, string | null>) =>
    assets.linux != null
      ? { value: assets.linux, platform: "linux" }
      : assets.windows
        ? { value: assets.windows, platform: "windows" }
        : undefined,
  dataDir: () => sandbox,
  tempDir: () => join(sandbox, "tmp"),
  modCacheDir: (gameId: string, modId: string) =>
    join(sandbox, "cache", "mods", gameId, modId),
}));

// Drive the download step: by default it drops a fake archive file.
let downloadProducer: (dest: string) => Promise<void> = async (dest) => {
  await writeFile(dest, "fake archive bytes");
};
mock.module("./github", () => ({
  downloadFile: async (
    _url: string,
    dest: string,
    onProgress?: (downloaded: number, total: number) => void,
  ) => {
    onProgress?.(50, 100);
    await downloadProducer(dest);
    onProgress?.(100, 100);
  },
  githubToken: async () => undefined,
  // pipeline.ts imports githubFetch (FIX 1) for release lookups; these
  // install tests drive prebuilt URLs and never hit it, but the import
  // must still resolve under the whole-module mock.
  githubFetch: async (url: string, init: RequestInit) => fetch(url, init),
}));

// Drive the extract step: by default it fails so we can exercise the
// "failure after download, before completion" cleanup path. Tests
// that want a successful install swap in a producer that populates
// the partial dir.
let extractProducer: (dest: string) => Promise<void> = async () => {
  throw new Error("simulated extraction failure");
};
mock.module("./pipeline-archive", () => ({
  extractArchive: async (_archive: string, dest: string) => {
    await extractProducer(dest);
  },
  // `pipeline-archive` re-exports these from `./github`; keep them so
  // transitive importers (installer-host) don't lose the symbols.
  downloadFile: async () => {},
  githubToken: async () => undefined,
}));

// Steam shortcut: track add/remove so tests can assert no orphan.
let steamAdds: number;
let steamRemovals: number[];
let addToSteamImpl: () => Promise<{ appId: number; gameId64: string }>;
mock.module("./steam-shortcut", () => ({
  addToSteam: async () => addToSteamImpl(),
  removeFromSteam: async (appId: number) => {
    steamRemovals.push(appId);
  },
}));

// Artwork is best-effort; stub it to a no-op so it never touches SGDB.
mock.module("./artwork", () => ({
  applyArtwork: async () => ({ written: 0 }),
  getCatalogArtUrl: async () => null,
  getDetailHeroUrl: async () => null,
}));

function makeEntry(overrides?: Partial<GameEntry>): GameEntry {
  return {
    id: "test-game",
    name: "Test Game",
    project: "Test",
    platform: "n64",
    repo: "test/repo",
    description: "A test game",
    installType: "prebuilt",
    releaseAssets: { linux: "test-*-linux.zip" },
    launchCommand: { linux: "{installDir}/test" },
    latestVersion: "v1.0.0",
    latestAssetUrl: { linux: "https://example.com/test-linux.zip" },
    tags: ["test"],
    ...overrides,
  };
}

function baseState(): PersistedState {
  return {
    version: 1,
    installPath: join(sandbox, "games"),
    games: {},
    romPaths: {},
    settings: { autoAddToSteam: true, updateCheckInterval: 86400 },
  };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "recomp-install-spec-"));
  await mkdir(join(sandbox, "config"), { recursive: true });
  await mkdir(join(sandbox, "games"), { recursive: true });
  // A regular file where `breakConfigDir` points its parent dir, so a
  // forced state write (mkdir under a file) throws.
  await writeFile(join(sandbox, "afile"), "x");
  steamAdds = 0;
  steamRemovals = [];
  breakConfigDir = false;
  addToSteamImpl = async () => {
    steamAdds += 1;
    return { appId: 4242, gameId64: "9999999999" };
  };
  downloadProducer = async (dest) => {
    await writeFile(dest, "fake archive bytes");
  };
  extractProducer = async () => {
    throw new Error("simulated extraction failure");
  };
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("installGame — failure mid-pipeline (FIX 1)", () => {
  it("persists no installed record, leaves no shortcut, and cleans the partial dir when extraction fails", async () => {
    const { installGame } = await import("./pipeline");
    const { loadState } = await import("./state");
    const entry = makeEntry();
    const state = baseState();

    // extractProducer throws by default — failure after download,
    // before completion.
    await expect(
      installGame(entry, state, undefined, () => {}),
    ).rejects.toThrow(/extraction failure/);

    // No installed-game record persisted.
    const persisted = await loadState();
    expect(persisted.games[entry.id]).toBeUndefined();

    // No Steam shortcut should have been written at all (we never
    // got far enough), and none orphaned.
    expect(steamAdds).toBe(0);

    // Partial dir must be cleaned up.
    const installDir = join(sandbox, "games", entry.id);
    expect(existsSync(`${installDir}.partial`)).toBe(false);
    expect(existsSync(installDir)).toBe(false);
  });

  it("removes an already-created Steam shortcut if a later step fails", async () => {
    const { installGame } = await import("./pipeline");
    const { loadState } = await import("./state");
    const entry = makeEntry();
    const state = baseState();

    // Make extraction succeed (populate the staged dir)...
    extractProducer = async (dest) => {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "test"), "#!/bin/sh\n");
    };
    // ...the shortcut gets written...
    addToSteamImpl = async () => {
      steamAdds += 1;
      return { appId: 7777, gameId64: "8888888888" };
    };
    // ...but the state persist (the final step) blows up.
    breakConfigDir = true;

    await expect(
      installGame(entry, state, undefined, () => {}),
    ).rejects.toThrow();

    // The shortcut that was created must be torn down.
    expect(steamAdds).toBe(1);
    expect(steamRemovals).toContain(7777);

    // No record persisted, partial dir cleaned.
    breakConfigDir = false;
    const persisted = await loadState();
    expect(persisted.games[entry.id]).toBeUndefined();
    const installDir = join(sandbox, "games", entry.id);
    expect(existsSync(`${installDir}.partial`)).toBe(false);
  });

  it("persists the record and shortcut on full success", async () => {
    const { installGame } = await import("./pipeline");
    const { loadState } = await import("./state");
    const entry = makeEntry();
    const state = baseState();

    extractProducer = async (dest) => {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "test"), "#!/bin/sh\n");
    };

    await installGame(entry, state, undefined, () => {});

    const persisted = await loadState();
    expect(persisted.games[entry.id]).toBeDefined();
    expect(persisted.games[entry.id]!.addedToSteam).toBe(true);
    expect(steamAdds).toBe(1);
    expect(steamRemovals).toEqual([]);
    const installDir = join(sandbox, "games", entry.id);
    expect(existsSync(installDir)).toBe(true);
    expect(existsSync(`${installDir}.partial`)).toBe(false);
  });
});

describe("uninstallGame — orphan cleanup (FIX 2)", () => {
  it("clears romPaths[id] and installedMods so a later install doesn't reuse the stale ROM path", async () => {
    const { installGame, uninstallGame } = await import("./pipeline");
    const { loadState, setRomPath, recordInstalledMod } = await import(
      "./state"
    );
    const entry = makeEntry({
      installType: "rom_extract",
      romInfo: {
        description: "Provide a ROM",
        validChecksums: [],
        extractionCommand: "",
        placeRomAs: "rom.z64",
      },
    });

    // Seed a saved ROM path + install the game.
    let state = baseState();
    const romFile = join(sandbox, "my-rom.z64");
    await writeFile(romFile, "rom bytes");
    state = await setRomPath(state, entry.id, romFile);

    extractProducer = async (dest) => {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, "test"), "#!/bin/sh\n");
    };
    state = await installGame(entry, state, romFile, () => {});
    // Record a mod so we can prove it's cleared on uninstall.
    state = await recordInstalledMod(state, entry.id, "some-mod", {
      installedAt: "2026-01-01T00:00:00Z",
      source: "manual-import",
    });

    let persisted = await loadState();
    expect(persisted.romPaths?.[entry.id]).toBe(romFile);
    expect(persisted.games[entry.id]?.installedMods?.["some-mod"]).toBeDefined();

    // Uninstall.
    state = await uninstallGame(entry.id, state);

    persisted = await loadState();
    expect(persisted.games[entry.id]).toBeUndefined();
    // romPaths entry gone — a later install must NOT silently reuse it.
    expect(persisted.romPaths?.[entry.id]).toBeUndefined();
  });
});
