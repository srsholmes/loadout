import { describe, expect, it } from "bun:test";
import { adaptLibrary, phase1Providers } from "./adapt";
import type { GameInfo } from "@loadout/types";
import { UNKNOWN } from "./rules";

function info(overrides: Partial<GameInfo> & { appId: string; name: string }): GameInfo {
  return {
    sizeOnDisk: 0,
    headerUrl: `https://example.test/${overrides.appId}/h.jpg`,
    capsuleUrl: `https://example.test/${overrides.appId}/c.jpg`,
    localHeaderUrl: `https://example.test/${overrides.appId}/h.jpg`,
    localCapsuleUrl: `https://example.test/${overrides.appId}/c.jpg`,
    source: "steam",
    tags: [],
    ...overrides,
  };
}

const GB = 1024 ** 3;

describe("adaptLibrary — honest sentinels", () => {
  it("marks every field Phase 1 cannot answer as unknown, not zero", () => {
    // The whole point: returning 0 for an unknown release date would make
    // every release-date rule treat the library as released in 1970, and the
    // bug would only surface once Phase 2 made the field real.
    const [game] = adaptLibrary([info({ appId: "1", name: "X", sizeOnDisk: 5 * GB })]);
    expect(game!.releaseDate).toBe(UNKNOWN);
    expect(game!.purchasedAt).toBe(UNKNOWN);
    expect(game!.lastPlayed).toBe(UNKNOWN);
    expect(game!.playtimeMinutes).toBe(UNKNOWN);
    expect(game!.reviewPercentage).toBe(UNKNOWN);
    expect(game!.metacritic).toBe(UNKNOWN);
  });

  it("leaves catalogue lists empty rather than inventing entries", () => {
    const [game] = adaptLibrary([info({ appId: "1", name: "X" })]);
    expect(game!.genres).toEqual([]);
    expect(game!.developers).toEqual([]);
    expect(game!.publishers).toEqual([]);
    expect(game!.storeTags).toEqual([]);
  });

  it("reports unknown compatibility rather than guessing 'unsupported'", () => {
    const [game] = adaptLibrary([info({ appId: "1", name: "X" })]);
    expect(game!.deckCompat).toBe("unknown");
    expect(game!.steamOsCompat).toBe("unknown");
  });

  it("leaves every feature flag false", () => {
    const [game] = adaptLibrary([info({ appId: "1", name: "X" })]);
    expect(Object.values(game!.features).every((v) => v === false)).toBe(true);
  });
});

describe("adaptLibrary — what it does know", () => {
  it("carries id, name, artwork and collections straight across", () => {
    const [game] = adaptLibrary([
      info({ appId: "620", name: "Portal 2", tags: ["favorite", "uc-classics"] }),
    ]);
    expect(game!.appId).toBe("620");
    expect(game!.name).toBe("Portal 2");
    expect(game!.collections).toEqual(["favorite", "uc-classics"]);
    expect(game!.headerUrl).toContain("620");
  });

  it("copies collections rather than aliasing the input array", () => {
    const source = info({ appId: "1", name: "X", tags: ["a"] });
    const [game] = adaptLibrary([source]);
    game!.collections.push("mutated");
    expect(source.tags).toEqual(["a"]);
  });

  it("falls back to the name for sortAs, since appinfo isn't available", () => {
    const [game] = adaptLibrary([info({ appId: "1", name: "The Witcher 3" })]);
    expect(game!.sortAs).toBe("The Witcher 3");
  });

  it("treats everything it sees as installed", () => {
    // game-library scans appmanifest files, so it only ever reports
    // installed apps.
    const [game] = adaptLibrary([info({ appId: "1", name: "X" })]);
    expect(game!.installed).toBe(true);
  });

  it("does not pretend to know about ownership beyond what's installed", () => {
    // Phase 1 has no ownership source at all; `owned` mirroring `installed`
    // is the honest reading, and phase1Providers says so.
    const [game] = adaptLibrary([info({ appId: "1", name: "X" })]);
    expect(game!.owned).toBe(game!.installed);
    expect(phase1Providers(false).appstore.ownsFields).toContain("owned");
  });
});

describe("adaptLibrary — sources and kinds", () => {
  it("maps a shortcut to source and kind 'shortcut'", () => {
    const [game] = adaptLibrary([
      info({ appId: "340282366", name: "Super Mario 64", source: "shortcut" }),
    ]);
    expect(game!.source).toBe("shortcut");
    expect(game!.kind).toBe("shortcut");
  });

  it("reads a Steam app as 'game' rather than guessing demo or soundtrack", () => {
    // Distinguishing those needs appinfo; guessing would be worse than
    // admitting we don't know.
    const [game] = adaptLibrary([info({ appId: "480", name: "Spacewar Demo" })]);
    expect(game!.kind).toBe("game");
  });
});

describe("adaptLibrary — size", () => {
  it("keeps a real manifest size", () => {
    const [game] = adaptLibrary([info({ appId: "1", name: "X", sizeOnDisk: 12 * GB })]);
    expect(game!.sizeOnDisk).toBe(12 * GB);
  });

  it("treats a Steam app reporting 0 as unknown, not empty", () => {
    // A Steam game genuinely occupying zero bytes doesn't happen; a manifest
    // without the key does.
    const [game] = adaptLibrary([info({ appId: "1", name: "X", sizeOnDisk: 0 })]);
    expect(game!.sizeOnDisk).toBe(UNKNOWN);
  });

  it("treats a shortcut's 0 as a real 0", () => {
    // Steam tracks no size for non-Steam shortcuts, so 0 is the true answer.
    const [game] = adaptLibrary([
      info({ appId: "1", name: "X", source: "shortcut", sizeOnDisk: 0 }),
    ]);
    expect(game!.sizeOnDisk).toBe(0);
  });
});

describe("adaptLibrary — playtime", () => {
  it("converts milliseconds to floored minutes", () => {
    const [game] = adaptLibrary([info({ appId: "620", name: "X" })], {
      playtime: [{ appId: "620", gameName: "X", totalMs: 90 * 60_000 + 30_000 }],
    });
    expect(game!.playtimeMinutes).toBe(90);
  });

  it("records a sub-minute session as 0, not as unknown", () => {
    // 0 means "played, but not measurably" — a real answer, and distinct from
    // -1. The `neverPlayedOnly` rule depends on that distinction.
    const [game] = adaptLibrary([info({ appId: "620", name: "X" })], {
      playtime: [{ appId: "620", gameName: "X", totalMs: 5_000 }],
    });
    expect(game!.playtimeMinutes).toBe(0);
  });

  it("leaves games absent from the playtime data unknown", () => {
    const games = adaptLibrary(
      [info({ appId: "1", name: "A" }), info({ appId: "2", name: "B" })],
      { playtime: [{ appId: "1", gameName: "A", totalMs: 60_000 }] },
    );
    expect(games[0]!.playtimeMinutes).toBe(1);
    expect(games[1]!.playtimeMinutes).toBe(UNKNOWN);
  });

  it("records who contributed", () => {
    const withPlaytime = adaptLibrary([info({ appId: "1", name: "A" })], {
      playtime: [{ appId: "1", gameName: "A", totalMs: 60_000 }],
    });
    expect(withPlaytime[0]!.contributors).toContain("appstore");

    const without = adaptLibrary([info({ appId: "1", name: "A" })]);
    expect(without[0]!.contributors).toEqual(["manifest"]);
  });

  it("applies lastPlayed when a caller can supply it", () => {
    const games = adaptLibrary([info({ appId: "1", name: "A" })], {
      lastPlayed: new Map([["1", 1_700_000_000]]),
    });
    expect(games[0]!.lastPlayed).toBe(1_700_000_000);
  });
});

describe("phase1Providers", () => {
  it("reports manifest as ok — that source really does work", () => {
    expect(phase1Providers(false).manifest.status).toBe("ok");
  });

  it("reports the missing providers as unavailable, with a reason", () => {
    const providers = phase1Providers(false);
    expect(providers.appstore.status).toBe("unavailable");
    expect(providers.appinfo.status).toBe("unavailable");
    // Rendered verbatim next to any rule the provider owns, so the user is
    // told WHY a Deck Verified tab can't be evaluated instead of watching it
    // come back empty.
    expect(providers.appstore.reason!.length).toBeGreaterThan(20);
    expect(providers.appinfo.reason!.length).toBeGreaterThan(20);
  });

  it("upgrades appstore to stale once play time is available", () => {
    const providers = phase1Providers(true);
    expect(providers.appstore.status).toBe("stale");
    expect(providers.appstore.reason).toContain("play time");
  });

  it("writes reasons as sentences a player can understand", () => {
    for (const provider of Object.values(phase1Providers(false))) {
      if (provider.reason === undefined) continue;
      expect(provider.reason).not.toMatch(/undefined|null|Error|appinfo\.vdf/);
      expect(provider.reason.endsWith(".")).toBe(true);
    }
  });

  it("attributes every unavailable field to exactly one provider", () => {
    // Overlapping ownership would make the builder disable a rule twice with
    // two different explanations.
    const providers = phase1Providers(false);
    const appstore = new Set(providers.appstore.ownsFields);
    for (const field of providers.appinfo.ownsFields) {
      expect(appstore.has(field)).toBe(false);
    }
  });

  it("claims the fields the Phase-1 adapter actually populates", () => {
    const manifest = phase1Providers(false).manifest.ownsFields;
    expect(manifest).toContain("installed");
    expect(manifest).toContain("collections");
  });
});
