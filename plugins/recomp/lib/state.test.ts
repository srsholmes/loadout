import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedState, InstalledGame } from "./types";

// `homedir()` is read once at process start and isn't sensitive to
// later `process.env.HOME` mutations, so we mock the platform module
// instead. `sandboxConfigDir` is reassigned in `beforeEach`; the
// mock factory closes over the binding so each test gets a fresh
// dir on disk.
let sandboxConfigDir: string = "";
mock.module("./platform", () => ({
  configDir: () => sandboxConfigDir,
  gamesDir: () => join(sandboxConfigDir, "games"),
  currentPlatform: () => "linux",
  getPlatformValue: () => undefined,
  getEffectivePlatformValue: () => undefined,
  dataDir: () => sandboxConfigDir,
  tempDir: () => join(sandboxConfigDir, "tmp"),
}));

let tempConfigDir: string;

beforeEach(async () => {
  tempConfigDir = await mkdtemp(join(tmpdir(), "recomp-state-test-"));
  sandboxConfigDir = tempConfigDir;
});

afterEach(async () => {
  await rm(tempConfigDir, { recursive: true, force: true });
});

function sandboxedStatePath(): string {
  return join(sandboxConfigDir, "state.json");
}

function statePath(): string {
  return join(tempConfigDir, "state.json");
}

async function writeState(state: PersistedState): Promise<void> {
  await Bun.write(statePath(), JSON.stringify(state, null, 2));
}

async function readState(): Promise<PersistedState> {
  const raw = await readFile(statePath(), "utf-8");
  return JSON.parse(raw);
}

function makeDefaultState(): PersistedState {
  return {
    version: 1,
    installPath: "/tmp/test-games",
    games: {},
    settings: {
      autoAddToSteam: true,
      updateCheckInterval: 86400,
    },
  };
}

function makeInstalledGame(overrides?: Partial<InstalledGame>): InstalledGame {
  return {
    installedVersion: "v1.0.0",
    installedAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    installDir: "/tmp/test-games/test-game",
    addedToSteam: false,
    ...overrides,
  };
}

describe("state module", () => {
  describe("loadState", () => {
    it("returns default state when no file exists", async () => {
      const { loadState } = await import("./state");
      const state = await loadState();
      expect(state.version).toBe(1);
      expect(state.settings.autoAddToSteam).toBe(true);
      expect(state.settings.updateCheckInterval).toBe(86400);
      expect(typeof state.installPath).toBe("string");
    });
  });

  describe("state data structure", () => {
    it("default state has correct shape", () => {
      const state = makeDefaultState();
      expect(state.version).toBe(1);
      expect(state.games).toEqual({});
      expect(state.settings.autoAddToSteam).toBe(true);
    });

    it("installed game has correct shape", () => {
      const game = makeInstalledGame();
      expect(game.installedVersion).toBe("v1.0.0");
      expect(game.addedToSteam).toBe(false);
      expect(game.romPath).toBeUndefined();
    });

    it("installed game with steam shortcut fields", () => {
      const game = makeInstalledGame({
        addedToSteam: true,
        steamAppId: 2789012345,
        steamGameId64: "12345678901234567890",
      });
      expect(game.addedToSteam).toBe(true);
      expect(game.steamAppId).toBe(2789012345);
      expect(game.steamGameId64).toBe("12345678901234567890");
    });
  });

  describe("state mutations (pure logic)", () => {
    it("adds installed game to state", () => {
      const state = makeDefaultState();
      const game = makeInstalledGame();
      const updated: PersistedState = {
        ...state,
        games: { ...state.games, "test-game": game },
      };
      expect(updated.games["test-game"]).toEqual(game);
      expect(Object.keys(updated.games)).toHaveLength(1);
    });

    it("removes installed game from state", () => {
      const state: PersistedState = {
        ...makeDefaultState(),
        games: {
          "game-a": makeInstalledGame(),
          "game-b": makeInstalledGame({ installedVersion: "v2.0.0" }),
        },
      };
      const { "game-a": _, ...rest } = state.games;
      const updated: PersistedState = { ...state, games: rest };
      expect(Object.keys(updated.games)).toHaveLength(1);
      expect(updated.games["game-b"]).toBeDefined();
      expect(updated.games["game-a"]).toBeUndefined();
    });

    it("updates settings partially", () => {
      const state = makeDefaultState();
      const updated: PersistedState = {
        ...state,
        settings: { ...state.settings, romDirectory: "/roms" },
      };
      expect(updated.settings.romDirectory).toBe("/roms");
      expect(updated.settings.autoAddToSteam).toBe(true);
    });
  });

  describe("JSON serialization", () => {
    it("state roundtrips through JSON", () => {
      const state: PersistedState = {
        ...makeDefaultState(),
        games: {
          "zelda64": makeInstalledGame({ romPath: "/roms/mm.z64" }),
        },
        settings: {
          autoAddToSteam: false,
          updateCheckInterval: 3600,
          romDirectory: "/roms",
        },
      };

      const json = JSON.stringify(state);
      const parsed = JSON.parse(json) as PersistedState;

      expect(parsed.version).toBe(1);
      expect(parsed.games["zelda64"]!.romPath).toBe("/roms/mm.z64");
      expect(parsed.settings.romDirectory).toBe("/roms");
    });

    it("handles minimal JSON", () => {
      const minimal = JSON.parse(
        '{"version":1,"installPath":"/tmp","games":{},"settings":{"autoAddToSteam":true,"updateCheckInterval":86400}}',
      );
      expect(minimal.version).toBe(1);
      expect(minimal.settings.romDirectory).toBeUndefined();
    });
  });

  describe("atomic write to temp directory", () => {
    it("writes and reads state correctly", async () => {
      const state = makeDefaultState();
      state.games["test"] = makeInstalledGame();

      await writeState(state);
      const loaded = await readState();

      expect(loaded.version).toBe(1);
      expect(loaded.games["test"]!.installedVersion).toBe("v1.0.0");
    });
  });

  describe("recordInstalledMod / removeInstalledMod", () => {
    it("stamps a mod entry under games[gameId].installedMods[modId]", async () => {
      const { updateInstalledGame, recordInstalledMod, loadState } =
        await import("./state");
      let state = makeDefaultState();
      state = await updateInstalledGame(state, "alba", makeInstalledGame());
      state = await recordInstalledMod(state, "alba", "tphd", {
        installedAt: "2026-05-20T00:00:00Z",
        source: "manual-import",
      });
      expect(state.games.alba?.installedMods?.tphd).toEqual({
        installedAt: "2026-05-20T00:00:00Z",
        source: "manual-import",
      });
      const reloaded = await loadState();
      expect(reloaded.games.alba?.installedMods?.tphd?.installedAt).toBe(
        "2026-05-20T00:00:00Z",
      );
    });

    it("no-ops when the base game isn't installed (caller race guard)", async () => {
      const { recordInstalledMod } = await import("./state");
      const before = makeDefaultState();
      const after = await recordInstalledMod(before, "ghost", "tphd", {
        installedAt: "2026-05-20T00:00:00Z",
        source: "manual-import",
      });
      // Same shape returned; no `ghost` game spuriously created.
      expect(after.games.ghost).toBeUndefined();
    });

    it("removeInstalledGame clears the saved romPaths entry (FIX 2: no orphan ROM path on uninstall)", async () => {
      const { updateInstalledGame, setRomPath, removeInstalledGame, loadState } =
        await import("./state");
      let state = makeDefaultState();
      state = await setRomPath(state, "alba", "/roms/tp.iso");
      state = await updateInstalledGame(
        state,
        "alba",
        makeInstalledGame({ romPath: "/roms/tp.iso" }),
      );
      // Sanity: both present before uninstall.
      let persisted = await loadState();
      expect(persisted.games.alba).toBeDefined();
      expect(persisted.romPaths?.alba).toBe("/roms/tp.iso");

      state = await removeInstalledGame(state, "alba");

      persisted = await loadState();
      expect(persisted.games.alba).toBeUndefined();
      // The stale ROM path must be gone so a later reinstall doesn't
      // silently reuse it without the user re-confirming.
      expect(persisted.romPaths?.alba).toBeUndefined();
    });

    it("removeInstalledGame leaves OTHER games' romPaths intact", async () => {
      const { updateInstalledGame, setRomPath, removeInstalledGame, loadState } =
        await import("./state");
      let state = makeDefaultState();
      state = await setRomPath(state, "alba", "/roms/tp.iso");
      state = await setRomPath(state, "soh", "/roms/oot.z64");
      state = await updateInstalledGame(state, "alba", makeInstalledGame());
      state = await removeInstalledGame(state, "alba");

      const persisted = await loadState();
      expect(persisted.romPaths?.alba).toBeUndefined();
      expect(persisted.romPaths?.soh).toBe("/roms/oot.z64");
    });

    it("removeInstalledMod drops the entry without touching siblings", async () => {
      const {
        updateInstalledGame,
        recordInstalledMod,
        removeInstalledMod,
      } = await import("./state");
      let state = makeDefaultState();
      state = await updateInstalledGame(state, "alba", makeInstalledGame());
      state = await recordInstalledMod(state, "alba", "a", {
        installedAt: "2026-05-20T00:00:00Z",
        source: "direct-url",
      });
      state = await recordInstalledMod(state, "alba", "b", {
        installedAt: "2026-05-20T00:00:00Z",
        source: "direct-url",
      });
      state = await removeInstalledMod(state, "alba", "a");
      expect(state.games.alba?.installedMods?.a).toBeUndefined();
      expect(state.games.alba?.installedMods?.b).toBeDefined();
    });
  });

  describe("concurrent saveState writes", () => {
    it("serializes 5 concurrent updateInstalledGame calls without tearing the file", async () => {
      const { updateInstalledGame } = await import("./state");

      // Build a base state that already contains all 5 game ids so the
      // last writer's snapshot still has every game — this isolates the
      // test to file-tearing rather than the read-modify-write race
      // documented on `saveState`.
      const ids = ["g0", "g1", "g2", "g3", "g4"];
      const base: PersistedState = {
        ...makeDefaultState(),
        games: Object.fromEntries(
          ids.map((id) => [id, makeInstalledGame({ installDir: `/tmp/${id}` })]),
        ),
      };

      // Fire all 5 in parallel, each setting a distinct
      // `installedVersion` on its own game id.
      await Promise.all(
        ids.map((id, i) =>
          updateInstalledGame(base, id, makeInstalledGame({
            installDir: `/tmp/${id}`,
            installedVersion: `v${i}`,
          })),
        ),
      );

      // Final file must parse cleanly (no torn JSON) and contain every
      // game id from the base snapshot. Per-game versions reflect the
      // last write to land, which is fine — the queue guarantees no
      // torn writes, not logical merge.
      const raw = await readFile(sandboxedStatePath(), "utf-8");
      const parsed = JSON.parse(raw) as PersistedState;
      for (const id of ids) {
        expect(parsed.games[id]).toBeDefined();
      }
    });

    it("persists two concurrent updates for DIFFERENT games from the same snapshot (no lost write)", async () => {
      const { updateInstalledGame } = await import("./state");

      // Both callers start from the same empty snapshot and update
      // distinct game ids concurrently. Under a naive read-modify-write
      // (mutate the passed-in `state` arg), the second write's snapshot
      // lacks the first game → its entry is lost. An atomic RMW must
      // persist BOTH.
      const base: PersistedState = makeDefaultState();

      await Promise.all([
        updateInstalledGame(base, "game-a", makeInstalledGame({ installDir: "/tmp/game-a" })),
        updateInstalledGame(base, "game-b", makeInstalledGame({ installDir: "/tmp/game-b" })),
      ]);

      const raw = await readFile(sandboxedStatePath(), "utf-8");
      const parsed = JSON.parse(raw) as PersistedState;
      expect(parsed.games["game-a"]).toBeDefined();
      expect(parsed.games["game-b"]).toBeDefined();
    });

    it("propagates write failures instead of silently swallowing them", async () => {
      const { saveState } = await import("./state");

      // Point the config dir at a path that can't be created (a file
      // exists where the dir should be), forcing mkdir/write to throw.
      // The rejection must surface to the caller, not be swallowed.
      const clash = join(tempConfigDir, "not-a-dir");
      await Bun.write(clash, "x");
      const prev = sandboxConfigDir;
      sandboxConfigDir = join(clash, "nested");
      try {
        await expect(saveState(makeDefaultState())).rejects.toThrow();
      } finally {
        sandboxConfigDir = prev;
      }
    });
  });
});
