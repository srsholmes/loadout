/**
 * Shared fixture library for every library-tabs spec.
 *
 * One fixture, used everywhere, so the counts asserted across specs are
 * stable and a reviewer can check them by reading this file rather than
 * reverse-engineering an inline literal. When a spec asserts "4 games
 * match", that number should be verifiable here in a few seconds.
 *
 * Deliberately covers the awkward cases:
 * - every numeric sentinel state: known, `0` (provably never), `-1` (unknown)
 * - both `source` values, including a shortcut with `sizeOnDisk: 0`
 * - a game in three collections, and a game in none
 * - installed-but-not-owned (a shortcut) and owned-but-not-installed
 * - multi-genre and no-genre games, for grouping
 * - a title needing case-insensitive and regex matching
 */

import type { GameMetadata, GameFeatures } from "@loadout/types";
import { emptyFeatures } from "@loadout/types";

/** Epoch seconds for a readable date, so assertions can be written by hand. */
export function epoch(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 1000);
}

function features(overrides: Partial<GameFeatures> = {}): GameFeatures {
  return { ...emptyFeatures(), ...overrides };
}

/** Build a record with sensible "known nothing" defaults. */
export function game(overrides: Partial<GameMetadata> & { appId: string; name: string }): GameMetadata {
  return {
    sortAs: overrides.name,
    kind: "game",
    source: "steam",
    installed: false,
    owned: true,
    sizeOnDisk: -1,
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
    features: features(),
    headerUrl: `https://example.test/${overrides.appId}/header.jpg`,
    capsuleUrl: `https://example.test/${overrides.appId}/capsule.jpg`,
    contributors: ["manifest"],
    ...overrides,
  };
}

const GB = 1024 ** 3;

/**
 * The fixture. Ten records — small enough to reason about, wide enough to
 * exercise every branch.
 */
export const LIBRARY: GameMetadata[] = [
  // Installed, heavily played, verified, in three collections.
  game({
    appId: "620",
    name: "Portal 2",
    sortAs: "Portal 2",
    installed: true,
    sizeOnDisk: 12 * GB,
    installPath: "/home/deck/.local/share/Steam/steamapps/common/Portal 2",
    releaseDate: epoch("2011-04-19"),
    purchasedAt: epoch("2012-01-05"),
    lastPlayed: epoch("2026-07-01"),
    playtimeMinutes: 1800,
    deckCompat: "verified",
    steamOsCompat: "compatible",
    reviewPercentage: 98,
    metacritic: 95,
    developers: ["Valve"],
    publishers: ["Valve"],
    genres: ["Action", "Puzzle"],
    storeTags: ["Puzzle", "Co-op", "First-Person"],
    collections: ["favorite", "uc-classics", "uc-finished"],
    features: features({ singlePlayer: true, coop: true, cloudSaves: true, achievements: true }),
  }),
  // Installed, never played (provably) — the "backlog" case.
  game({
    appId: "1091500",
    name: "Cyberpunk 2077",
    installed: true,
    sizeOnDisk: 70 * GB,
    installPath: "/run/media/mmcblk0p1/steamapps/common/Cyberpunk 2077",
    releaseDate: epoch("2020-12-10"),
    purchasedAt: epoch("2025-11-20"),
    lastPlayed: 0,
    playtimeMinutes: 0,
    deckCompat: "playable",
    steamOsCompat: "compatible",
    reviewPercentage: 79,
    metacritic: 86,
    developers: ["CD Projekt Red"],
    publishers: ["CD Projekt"],
    genres: ["RPG", "Action"],
    storeTags: ["Open World", "Cyberpunk", "RPG"],
    collections: ["uc-backlog"],
    features: features({ singlePlayer: true, cloudSaves: true, achievements: true }),
  }),
  // Owned, not installed, short game.
  game({
    appId: "504230",
    name: "Celeste",
    installed: false,
    releaseDate: epoch("2018-01-25"),
    purchasedAt: epoch("2019-06-14"),
    lastPlayed: epoch("2024-02-11"),
    playtimeMinutes: 420,
    deckCompat: "verified",
    reviewPercentage: 96,
    metacritic: 94,
    developers: ["Extremely OK Games"],
    publishers: ["Extremely OK Games"],
    genres: ["Platformer"],
    storeTags: ["Platformer", "Difficult", "Pixel Graphics"],
    collections: ["favorite", "uc-finished"],
    features: features({ singlePlayer: true, achievements: true }),
  }),
  // Non-Steam shortcut: no size, no store metadata, its own tags.
  game({
    appId: "3405691582",
    name: "Super Mario 64",
    source: "shortcut",
    kind: "shortcut",
    owned: false,
    installed: true,
    sizeOnDisk: 0,
    installPath: "/home/deck/Emulation/roms/n64",
    lastPlayed: epoch("2026-06-15"),
    playtimeMinutes: 240,
    collections: ["Nintendo 64", "Emulation"],
  }),
  // Owned, not installed, unknown almost everything — the sentinel case.
  game({
    appId: "999999",
    name: "Some Obscure Indie",
    installed: false,
  }),
  // A demo.
  game({
    appId: "480",
    name: "Spacewar Demo",
    kind: "demo",
    installed: true,
    sizeOnDisk: 1 * GB,
    installPath: "/home/deck/.local/share/Steam/steamapps/common/Spacewar",
    releaseDate: epoch("2005-01-01"),
    lastPlayed: 0,
    playtimeMinutes: 0,
    deckCompat: "unsupported",
    developers: ["Valve"],
    genres: ["Action"],
  }),
  // Coming soon, unreleased.
  game({
    appId: "2000001",
    name: "Hollow Knight Silksong",
    comingSoon: true,
    installed: false,
    purchasedAt: epoch("2026-03-01"),
    lastPlayed: 0,
    playtimeMinutes: 0,
    developers: ["Team Cherry"],
    genres: ["Metroidvania", "Platformer"],
    storeTags: ["Metroidvania", "Difficult"],
  }),
  // Family-shared and streamable — installed elsewhere, not here.
  game({
    appId: "1245620",
    name: "Elden Ring",
    installed: false,
    familyShared: true,
    streamable: true,
    releaseDate: epoch("2022-02-25"),
    purchasedAt: epoch("2023-08-08"),
    lastPlayed: epoch("2023-09-01"),
    playtimeMinutes: 6000,
    deckCompat: "verified",
    reviewPercentage: 92,
    metacritic: 96,
    developers: ["FromSoftware"],
    publishers: ["Bandai Namco"],
    genres: ["RPG", "Action"],
    storeTags: ["Souls-like", "Open World", "RPG"],
    collections: ["favorite"],
    features: features({ singlePlayer: true, multiPlayer: true, cloudSaves: true }),
  }),
  // A soundtrack — the thing that clutters libraries and that people
  // filter out first.
  game({
    appId: "1091501",
    name: "Cyberpunk 2077 Soundtrack",
    kind: "music",
    installed: true,
    sizeOnDisk: 2 * GB,
    installPath: "/home/deck/.local/share/Steam/steamapps/music",
    lastPlayed: -1,
    playtimeMinutes: -1,
    developers: ["CD Projekt Red"],
  }),
  // Lower-case name, for case-sensitivity assertions.
  game({
    appId: "413150",
    name: "stardew valley",
    sortAs: "stardew valley",
    installed: true,
    sizeOnDisk: 1 * GB,
    installPath: "/run/media/mmcblk0p1/steamapps/common/Stardew Valley",
    releaseDate: epoch("2016-02-26"),
    purchasedAt: epoch("2016-03-01"),
    lastPlayed: epoch("2026-07-20"),
    playtimeMinutes: 12000,
    deckCompat: "verified",
    steamOsCompat: "compatible",
    reviewPercentage: 98,
    metacritic: 89,
    developers: ["ConcernedApe"],
    publishers: ["ConcernedApe"],
    genres: ["RPG", "Simulation"],
    storeTags: ["Farming Sim", "Pixel Graphics", "Relaxing"],
    collections: ["favorite", "uc-classics"],
    features: features({ singlePlayer: true, coop: true, multiPlayer: true }),
  }),
];

/** Handy appId constants so specs read as prose rather than magic strings. */
export const IDS = {
  portal2: "620",
  cyberpunk: "1091500",
  celeste: "504230",
  mario64: "3405691582",
  obscure: "999999",
  demo: "480",
  silksong: "2000001",
  eldenRing: "1245620",
  soundtrack: "1091501",
  stardew: "413150",
} as const;

/** Sorted appIds of a result set — the shape most assertions want. */
export function ids(games: readonly { appId: string }[]): string[] {
  return games.map((g) => g.appId);
}
