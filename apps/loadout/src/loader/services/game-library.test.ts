import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type { GameInfo, GameLibraryChangedEvent } from "@loadout/types";

// Mock the underlying scan helpers. The service should treat
// `@loadout/game-library` as an opaque scan function — only the
// caching and broadcast wiring lives in the loader.
let mockGames: GameInfo[] = [];
let scanCalls = 0;
mock.module("@loadout/game-library", () => ({
  scanLibrary: async () => {
    scanCalls += 1;
    return mockGames.map((g) => ({ ...g }));
  },
  getCollectionsFromGames: (games: GameInfo[]) => {
    const counts = new Map<string, number>();
    for (const g of games) {
      for (const t of g.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  },
}));

import {
  GameLibraryService,
  GAME_LIBRARY_SERVICE_ID,
} from "./game-library";

function game(appId: string, name: string, tags: string[] = []): GameInfo {
  return {
    appId,
    name,
    sizeOnDisk: 0,
    headerUrl: "",
    capsuleUrl: "",
    localHeaderUrl: "",
    localCapsuleUrl: "",
    source: "steam",
    tags,
  };
}

describe("GameLibraryService", () => {
  let service: GameLibraryService;
  let events: GameLibraryChangedEvent[];

  beforeEach(() => {
    mockGames = [];
    scanCalls = 0;
    service = new GameLibraryService();
    events = [];
    service.emit = ({ event, data }) => {
      if (event === "libraryChanged")
        events.push(data as GameLibraryChangedEvent);
    };
  });

  afterEach(() => {
    mockGames = [];
  });

  test("exports the canonical service id", () => {
    expect(GAME_LIBRARY_SERVICE_ID).toBe("__core:game-library");
  });

  test("getGames starts with an empty cache and triggers a scan on first call", async () => {
    expect(scanCalls).toBe(0);
    const games = await service.getGames();
    expect(games).toEqual([]);
    expect(scanCalls).toBe(1);
  });

  test("getGames returns cached results without re-scanning on repeat calls", async () => {
    mockGames = [game("1", "Alpha")];
    await service.getGames();
    await service.getGames();
    expect(scanCalls).toBe(1);
  });

  test("rescan populates the cache and broadcasts when the library transitions from empty to populated", async () => {
    mockGames = [game("1", "Alpha", ["fav"])];
    const result = await service.rescan();
    expect(result).toHaveLength(1);
    expect(result[0].appId).toBe("1");
    expect(events).toHaveLength(1);
    expect(events[0].games).toHaveLength(1);
    expect(events[0].collections).toEqual([{ id: "fav", count: 1 }]);
  });

  test("rescan with identical data does NOT broadcast (signature unchanged)", async () => {
    mockGames = [game("1", "Alpha"), game("2", "Beta")];
    await service.rescan();
    expect(events).toHaveLength(1);

    // Same games, same order — signature unchanged, no re-broadcast.
    await service.rescan();
    expect(events).toHaveLength(1);
  });

  test("rescan with a new appId DOES broadcast", async () => {
    mockGames = [game("1", "Alpha")];
    await service.rescan();
    expect(events).toHaveLength(1);

    mockGames = [game("1", "Alpha"), game("2", "Beta")];
    await service.rescan();
    expect(events).toHaveLength(2);
    expect(events[1].games.map((g) => g.appId).sort()).toEqual(["1", "2"]);
  });

  test("rescan with the same membership in a different order is still a no-op broadcast", async () => {
    mockGames = [game("1", "Alpha"), game("2", "Beta")];
    await service.rescan();
    expect(events).toHaveLength(1);

    // Mock returns the same set; scanLibrary in production already
    // sorts alphabetically. Signature is membership-based, so a
    // shuffled-but-identical set is treated as no-change.
    mockGames = [game("2", "Beta"), game("1", "Alpha")];
    await service.rescan();
    expect(events).toHaveLength(1);
  });

  test("getCollections derives counts from the cached library", async () => {
    mockGames = [
      game("1", "Alpha", ["fav", "rpg"]),
      game("2", "Beta", ["fav"]),
    ];
    await service.getGames(); // prime cache
    const collections = await service.getCollections();
    expect(collections).toEqual([
      { id: "fav", count: 2 },
      { id: "rpg", count: 1 },
    ]);
  });

  test("emit is optional — methods don't throw without it", async () => {
    mockGames = [game("1", "Alpha")];
    const s = new GameLibraryService();
    await s.getGames();
    await s.rescan();
    expect(await s.getCollections()).toEqual([]);
  });

  test("rescan returns a defensive copy — callers can't mutate the cache", async () => {
    mockGames = [game("1", "Alpha", ["fav"])];
    const a = await service.rescan();
    a[0].tags.push("hacked");
    const b = await service.getGames();
    expect(b[0].tags).toEqual(["fav"]);
  });
});
