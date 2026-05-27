import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";

// Mock @loadout/steam-paths
const FAKE_STEAMAPPS = "/home/testuser/.local/share/Steam/steamapps";
const mockGetLibraryPaths = mock(() => Promise.resolve([FAKE_STEAMAPPS]));
mock.module("@loadout/steam-paths", () => ({
  getSteamAppsDir: () => FAKE_STEAMAPPS,
  getLibraryPaths: mockGetLibraryPaths,
}));

// Mock node:fs/promises
const mockReaddir = mock(() => Promise.resolve([] as string[]));
const mockReadFile = mock(() => Promise.resolve(""));
mock.module("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
}));

import GameBrowserBackend from "./backend";

describe("GameBrowserBackend", () => {
  let backend: GameBrowserBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(() => {
    backend = new GameBrowserBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
    mockReaddir.mockClear();
    mockReadFile.mockClear();
    mockGetLibraryPaths.mockClear();
  });

  // ---------------------------------------------------------------------------
  // VDF/ACF parsing (parseVdfValue is private, tested via scanLibrary)
  // ---------------------------------------------------------------------------

  describe("scanLibrary via onLoad()", () => {
    it("parses appmanifest ACF files correctly", async () => {
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS]),
      );

      mockReaddir.mockImplementation(() =>
        Promise.resolve([
          "appmanifest_730.acf",
          "appmanifest_570.acf",
          "common",
          "libraryfolders.vdf",
        ]),
      );

      mockReadFile.mockImplementation((_path: string) => {
        const path = _path as string;
        if (path.includes("appmanifest_730")) {
          return Promise.resolve(
            [
              '"AppState"',
              '{',
              '\t"appid"\t\t"730"',
              '\t"name"\t\t"Counter-Strike 2"',
              '\t"SizeOnDisk"\t\t"35000000000"',
              '\t"StateFlags"\t\t"4"',
              '}',
            ].join("\n"),
          );
        }
        if (path.includes("appmanifest_570")) {
          return Promise.resolve(
            [
              '"AppState"',
              '{',
              '\t"appid"\t\t"570"',
              '\t"name"\t\t"Dota 2"',
              '\t"SizeOnDisk"\t\t"60000000000"',
              '\t"StateFlags"\t\t"4"',
              '}',
            ].join("\n"),
          );
        }
        return Promise.resolve("");
      });

      await backend.onLoad();
      const games = await backend.getGames();

      expect(games).toHaveLength(2);

      // Should be sorted alphabetically
      expect(games[0].name).toBe("Counter-Strike 2");
      expect(games[0].appId).toBe("730");
      expect(games[0].sizeOnDisk).toBe(35000000000);

      expect(games[1].name).toBe("Dota 2");
      expect(games[1].appId).toBe("570");
    });

    it("generates correct CDN URLs", async () => {
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS]),
      );
      mockReaddir.mockImplementation(() =>
        Promise.resolve(["appmanifest_400.acf"]),
      );
      mockReadFile.mockImplementation(() =>
        Promise.resolve(
          [
            '"AppState"',
            '{',
            '\t"appid"\t\t"400"',
            '\t"name"\t\t"Portal"',
            '\t"SizeOnDisk"\t\t"4000000000"',
            '}',
          ].join("\n"),
        ),
      );

      await backend.onLoad();
      const games = await backend.getGames();

      expect(games[0].headerUrl).toBe(
        "https://cdn.cloudflare.steamstatic.com/steam/apps/400/header.jpg",
      );
      expect(games[0].capsuleUrl).toBe(
        "https://cdn.cloudflare.steamstatic.com/steam/apps/400/library_600x900.jpg",
      );
    });

    it("returns empty list when no appmanifest files found", async () => {
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS]),
      );
      mockReaddir.mockImplementation(() =>
        Promise.resolve(["common", "libraryfolders.vdf"]),
      );

      await backend.onLoad();
      const games = await backend.getGames();
      expect(games).toEqual([]);
    });

    it("skips non-ACF files", async () => {
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS]),
      );
      mockReaddir.mockImplementation(() =>
        Promise.resolve([
          "appmanifest_730.acf",
          "workshop_730.acf",
          "something_else.txt",
          "appmanifest_123.acf.bak",
        ]),
      );
      mockReadFile.mockImplementation(() =>
        Promise.resolve(
          '"AppState"\n{\n\t"appid"\t\t"730"\n\t"name"\t\t"CS2"\n\t"SizeOnDisk"\t\t"1000"\n}',
        ),
      );

      await backend.onLoad();
      const games = await backend.getGames();
      // Only appmanifest_730.acf matches the pattern
      expect(games).toHaveLength(1);
    });

    it("skips manifests with missing appid or name", async () => {
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS]),
      );
      mockReaddir.mockImplementation(() =>
        Promise.resolve([
          "appmanifest_1.acf",
          "appmanifest_2.acf",
        ]),
      );

      mockReadFile.mockImplementation((_path: string) => {
        const path = _path as string;
        if (path.includes("appmanifest_1")) {
          // Missing name
          return Promise.resolve('"AppState"\n{\n\t"appid"\t\t"1"\n}');
        }
        if (path.includes("appmanifest_2")) {
          // Missing appid
          return Promise.resolve('"AppState"\n{\n\t"name"\t\t"Test"\n}');
        }
        return Promise.resolve("");
      });

      await backend.onLoad();
      const games = await backend.getGames();
      expect(games).toEqual([]);
    });

    it("handles SizeOnDisk defaulting to 0 when missing", async () => {
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS]),
      );
      mockReaddir.mockImplementation(() =>
        Promise.resolve(["appmanifest_400.acf"]),
      );
      mockReadFile.mockImplementation(() =>
        Promise.resolve(
          '"AppState"\n{\n\t"appid"\t\t"400"\n\t"name"\t\t"Portal"\n}',
        ),
      );

      await backend.onLoad();
      const games = await backend.getGames();
      expect(games[0].sizeOnDisk).toBe(0);
    });

    it("handles unreadable manifest files gracefully", async () => {
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS]),
      );
      mockReaddir.mockImplementation(() =>
        Promise.resolve([
          "appmanifest_400.acf",
          "appmanifest_730.acf",
        ]),
      );

      mockReadFile.mockImplementation((_path: string) => {
        const path = _path as string;
        if (path.includes("appmanifest_400")) {
          return Promise.reject(new Error("EACCES"));
        }
        return Promise.resolve(
          '"AppState"\n{\n\t"appid"\t\t"730"\n\t"name"\t\t"CS2"\n\t"SizeOnDisk"\t\t"1000"\n}',
        );
      });

      await backend.onLoad();
      const games = await backend.getGames();
      // Only 730 should be listed, 400 was unreadable
      expect(games).toHaveLength(1);
      expect(games[0].appId).toBe("730");
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple library paths
  // ---------------------------------------------------------------------------

  describe("multiple Steam library paths", () => {
    it("scans games from multiple library folders", async () => {
      const secondLib = "/mnt/games/steamapps";
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS, secondLib]),
      );

      mockReaddir.mockImplementation((dir: string) => {
        if (dir === FAKE_STEAMAPPS) {
          return Promise.resolve(["appmanifest_730.acf"]);
        }
        if (dir === secondLib) {
          return Promise.resolve(["appmanifest_400.acf"]);
        }
        return Promise.resolve([]);
      });

      mockReadFile.mockImplementation((_path: string) => {
        const path = _path as string;
        if (path.includes("appmanifest_730")) {
          return Promise.resolve(
            '"AppState"\n{\n\t"appid"\t\t"730"\n\t"name"\t\t"CS2"\n\t"SizeOnDisk"\t\t"1000"\n}',
          );
        }
        if (path.includes("appmanifest_400")) {
          return Promise.resolve(
            '"AppState"\n{\n\t"appid"\t\t"400"\n\t"name"\t\t"Portal"\n\t"SizeOnDisk"\t\t"2000"\n}',
          );
        }
        return Promise.resolve("");
      });

      await backend.onLoad();
      const games = await backend.getGames();
      expect(games).toHaveLength(2);

      // Should be sorted alphabetically: CS2, then Portal
      expect(games[0].name).toBe("CS2");
      expect(games[1].name).toBe("Portal");
    });

    it("handles failed readdir on one library path", async () => {
      const badLib = "/mnt/broken/steamapps";
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS, badLib]),
      );

      mockReaddir.mockImplementation((dir: string) => {
        if (dir === FAKE_STEAMAPPS) {
          return Promise.resolve(["appmanifest_730.acf"]);
        }
        // Second library fails
        return Promise.reject(new Error("ENOENT"));
      });

      mockReadFile.mockImplementation(() =>
        Promise.resolve(
          '"AppState"\n{\n\t"appid"\t\t"730"\n\t"name"\t\t"CS2"\n\t"SizeOnDisk"\t\t"1000"\n}',
        ),
      );

      await backend.onLoad();
      const games = await backend.getGames();
      expect(games).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // rescan
  // ---------------------------------------------------------------------------

  describe("rescan()", () => {
    it("re-scans and emits libraryUpdated event", async () => {
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS]),
      );
      mockReaddir.mockImplementation(() =>
        Promise.resolve(["appmanifest_730.acf"]),
      );
      mockReadFile.mockImplementation(() =>
        Promise.resolve(
          '"AppState"\n{\n\t"appid"\t\t"730"\n\t"name"\t\t"CS2"\n\t"SizeOnDisk"\t\t"1000"\n}',
        ),
      );

      const games = await backend.rescan();
      expect(games).toHaveLength(1);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].event).toBe("libraryUpdated");
      expect(emittedEvents[0].data).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Alphabetical sorting (case-insensitive)
  // ---------------------------------------------------------------------------

  describe("alphabetical sorting", () => {
    it("sorts games case-insensitively", async () => {
      mockGetLibraryPaths.mockImplementation(() =>
        Promise.resolve([FAKE_STEAMAPPS]),
      );
      mockReaddir.mockImplementation(() =>
        Promise.resolve([
          "appmanifest_1.acf",
          "appmanifest_2.acf",
          "appmanifest_3.acf",
        ]),
      );

      mockReadFile.mockImplementation((_path: string) => {
        const path = _path as string;
        if (path.includes("appmanifest_1")) {
          return Promise.resolve(
            '"AppState"\n{\n\t"appid"\t\t"1"\n\t"name"\t\t"zelda"\n\t"SizeOnDisk"\t\t"1000"\n}',
          );
        }
        if (path.includes("appmanifest_2")) {
          return Promise.resolve(
            '"AppState"\n{\n\t"appid"\t\t"2"\n\t"name"\t\t"Apex Legends"\n\t"SizeOnDisk"\t\t"2000"\n}',
          );
        }
        if (path.includes("appmanifest_3")) {
          return Promise.resolve(
            '"AppState"\n{\n\t"appid"\t\t"3"\n\t"name"\t\t"baldurs gate"\n\t"SizeOnDisk"\t\t"3000"\n}',
          );
        }
        return Promise.resolve("");
      });

      await backend.onLoad();
      const games = await backend.getGames();
      expect(games[0].name).toBe("Apex Legends");
      expect(games[1].name).toBe("baldurs gate");
      expect(games[2].name).toBe("zelda");
    });
  });
});
