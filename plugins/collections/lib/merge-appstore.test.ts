import { describe, expect, it } from "bun:test";
import type { SteamLibraryEntry } from "@loadout/steam-cdp";
import type { GameMetadata } from "@loadout/types";
import { emptyFeatures } from "@loadout/types";
import { mergeSteamLibrary } from "./merge-appstore";

/** A manifest-derived record: real size and art, everything else a sentinel. */
function manifest(appId: string, extra: Partial<GameMetadata> = {}): GameMetadata {
  return {
    appId,
    name: `Manifest ${appId}`,
    sortAs: `manifest ${appId}`,
    kind: "game",
    source: "steam",
    installed: true,
    owned: true,
    sizeOnDisk: 1024 ** 3,
    installPath: null,
    releaseDate: -1,
    purchasedAt: -1,
    lastPlayed: -1,
    playtimeMinutes: -1,
    deckCompat: "unknown",
    steamOsCompat: "unknown",
    reviewPercentage: -1,
    metacritic: -1,
    comingSoon: false,
    familyShared: false,
    streamable: false,
    developers: [],
    publishers: [],
    franchises: [],
    genres: [],
    storeTags: [],
    collections: [],
    features: emptyFeatures(),
    headerUrl: `local://${appId}/header`,
    capsuleUrl: `local://${appId}/capsule`,
    contributors: ["manifest"],
    ...extra,
  };
}

function steam(appId: string, extra: Partial<SteamLibraryEntry> = {}): SteamLibraryEntry {
  return {
    appId,
    name: `Steam ${appId}`,
    sortAs: `steam ${appId}`,
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

describe("mergeSteamLibrary — adding what the manifest cannot see", () => {
  it("adds owned-but-not-installed games", () => {
    const result = mergeSteamLibrary([manifest("620")], [steam("620"), steam("999")]);
    expect(result.games.map((g) => g.appId).sort()).toEqual(["620", "999"]);
    expect(result.addedFromSteam).toBe(1);
    expect(result.enriched).toBe(1);
  });

  it("gives an added Steam game CDN artwork, since no local art exists for it", () => {
    const [game] = mergeSteamLibrary([], [steam("999")]).games;
    expect(game!.headerUrl).toContain("/steam/apps/999/header.jpg");
    expect(game!.capsuleUrl).toContain("/steam/apps/999/library_600x900.jpg");
  });

  it("gives an added shortcut no artwork rather than a URL that 404s", () => {
    // Steam's CDN has nothing for an appId Steam never issued, so a CDN URL
    // for a ROM is a guaranteed broken tile. Empty lets GameCard show its own
    // placeholder, which is the honest answer.
    const [game] = mergeSteamLibrary([], [steam("999", { kind: "rom" })]).games;
    expect(game!.headerUrl).toBe("");
    expect(game!.capsuleUrl).toBe("");
  });

  it("marks an added game as sourced from the appstore alone", () => {
    const [game] = mergeSteamLibrary([], [steam("999")]).games;
    expect(game!.contributors).toEqual(["appstore"]);
  });

  it("keeps a manifest-only game that Steam never mentions", () => {
    // A non-Steam shortcut can be on disk without appearing in Steam's stores.
    const result = mergeSteamLibrary([manifest("777")], []);
    expect(result.games.map((g) => g.appId)).toEqual(["777"]);
    expect(result.addedFromSteam).toBe(0);
  });
});

describe("mergeSteamLibrary — field precedence", () => {
  it("prefers the manifest's measured size over Steam's", () => {
    // Steam populates size_on_disk for ~3% of a library; the manifest read it
    // from an actual .acf.
    const [game] = mergeSteamLibrary(
      [manifest("620", { sizeOnDisk: 5000 })],
      [steam("620", { sizeOnDisk: 9 })],
    ).games;
    expect(game!.sizeOnDisk).toBe(5000);
  });

  it("takes Steam's size when the manifest has none", () => {
    const [game] = mergeSteamLibrary(
      [manifest("620", { sizeOnDisk: -1 })],
      [steam("620", { sizeOnDisk: 9 })],
    ).games;
    expect(game!.sizeOnDisk).toBe(9);
  });

  it("prefers the playtime plugin's number, which counts non-Steam sessions", () => {
    const [game] = mergeSteamLibrary(
      [manifest("620", { playtimeMinutes: 90 })],
      [steam("620", { playtimeMinutes: 12 })],
    ).games;
    expect(game!.playtimeMinutes).toBe(90);
  });

  it("takes Steam's playtime when the plugin had no answer", () => {
    const [game] = mergeSteamLibrary(
      [manifest("620", { playtimeMinutes: -1 })],
      [steam("620", { playtimeMinutes: 12 })],
    ).games;
    expect(game!.playtimeMinutes).toBe(12);
  });

  it("lets Steam win on everything the manifest cannot know", () => {
    const [game] = mergeSteamLibrary(
      [manifest("620")],
      [
        steam("620", {
          reviewPercentage: 94,
          releaseDate: 1_700_000_000,
          purchasedAt: 1_600_000_000,
          lastPlayed: 1_650_000_000,
          deckCompat: 3,
          steamOsCompat: 2,
          storeTags: ["Roguelike"],
          installed: false,
        }),
      ],
    ).games;
    expect(game).toMatchObject({
      reviewPercentage: 94,
      releaseDate: 1_700_000_000,
      purchasedAt: 1_600_000_000,
      lastPlayed: 1_650_000_000,
      deckCompat: "verified",
      steamOsCompat: "compatible",
      storeTags: ["Roguelike"],
      // Steam's local-install collection is the authority, even against a
      // manifest record that exists — a leftover .acf does not mean installed.
      installed: false,
    });
  });

  it("unions collections rather than letting either side win", () => {
    const [game] = mergeSteamLibrary(
      [manifest("620", { collections: ["favorite"] })],
      [steam("620", { collections: ["uc-123", "favorite"] })],
    ).games;
    expect([...game!.collections].sort()).toEqual(["favorite", "uc-123"]);
  });

  it("records both providers as contributors for an enriched game", () => {
    const [game] = mergeSteamLibrary([manifest("620")], [steam("620")]).games;
    expect([...game!.contributors].sort()).toEqual(["appstore", "manifest"]);
  });
});

describe("mergeSteamLibrary — decoding", () => {
  it("maps Steam's numeric compat categories onto the named ones", () => {
    const cases: Array<[number, string]> = [
      [0, "unknown"],
      [1, "unsupported"],
      [2, "playable"],
      [3, "verified"],
    ];
    for (const [value, expected] of cases) {
      const [game] = mergeSteamLibrary([], [steam("1", { deckCompat: value })]).games;
      expect(game!.deckCompat).toBe(expected as GameMetadata["deckCompat"]);
    }
  });

  it("falls back to unknown for a category Steam adds later", () => {
    const [game] = mergeSteamLibrary([], [steam("1", { deckCompat: 99 })]).games;
    expect(game!.deckCompat).toBe("unknown");
  });

  it("classifies a ROM as a shortcut source, not a Steam one", () => {
    // Emulator entries are non-Steam shortcuts; filing them as `steam` would
    // put 1878 ROMs into every Steam-only tab on a real device.
    const [game] = mergeSteamLibrary(
      [],
      [steam("999", { kind: "rom", romPlatform: "Nintendo 64" })],
    ).games;
    expect(game!.kind).toBe("rom");
    expect(game!.source).toBe("shortcut");
  });

  it("narrows an unrecognised kind rather than trusting it", () => {
    const [game] = mergeSteamLibrary([], [steam("1", { kind: "nonsense" })]).games;
    expect(game!.kind).toBe("unknown");
  });
});
