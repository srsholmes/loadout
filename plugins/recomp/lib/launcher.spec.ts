import { describe, it, expect, mock } from "bun:test";
import type { GameEntry, InstalledGame } from "./types";

// Replace `withSteamClient` with a stub so the test exercises the
// dispatch path without actually opening a CDP socket. Each call
// invokes the user fn with a tiny SteamClient stand-in whose
// `executeSteamURL` records its argument.
const executeUrls: string[] = [];
mock.module("@loadout/steam-cdp", () => ({
  withSteamClient: <T,>(fn: (sc: { url: { executeSteamURL: (u: string) => Promise<void> } }) => Promise<T>) =>
    fn({ url: { executeSteamURL: async (u: string) => { executeUrls.push(u); } } }),
  SteamClientUnreachableError: class extends Error {},
}));

function makeGameEntry(overrides?: Partial<GameEntry>): GameEntry {
  return {
    id: "test-game",
    name: "Test Game",
    project: "Test Project",
    platform: "n64",
    repo: "test/repo",
    description: "A test game",
    installType: "prebuilt",
    releaseAssets: { linux: "test-*-linux.zip" },
    launchCommand: { linux: "{installDir}/test-game" },
    tags: ["test"],
    ...overrides,
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

describe("launchGame", () => {
  it("throws when the game is not yet added to Steam", async () => {
    const { launchGame } = await import("./launcher");
    const installed = makeInstalledGame({ addedToSteam: false });
    await expect(launchGame(makeGameEntry(), installed)).rejects.toThrow(
      "not yet registered with Steam",
    );
  });

  it("throws when added to Steam but missing the gameId64", async () => {
    const { launchGame } = await import("./launcher");
    const installed = makeInstalledGame({
      addedToSteam: true,
      // steamGameId64 deliberately absent — covers a corrupted-state
      // edge case where the flag flipped but the id never persisted.
    });
    await expect(launchGame(makeGameEntry(), installed)).rejects.toThrow(
      "not yet registered with Steam",
    );
  });

  it("dispatches steam://rungameid via SteamClient.URL.ExecuteSteamURL", async () => {
    executeUrls.length = 0;
    const { launchGame } = await import("./launcher");
    await launchGame(
      makeGameEntry(),
      makeInstalledGame({
        addedToSteam: true,
        steamAppId: 2789012345,
        steamGameId64: "11978773253787877377",
      }),
    );
    expect(executeUrls).toEqual(["steam://rungameid/11978773253787877377"]);
  });
});
