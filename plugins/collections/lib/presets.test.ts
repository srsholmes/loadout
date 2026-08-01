import { describe, expect, it } from "bun:test";
import { presets, metadataNeedsMet, unmetNeeds, NEED_LABELS, type MetadataNeed } from "./presets";
import { buildEvalGames } from "./facts";
import { evaluateCollection } from "./evaluate";
import { LIBRARY } from "../test/fixtures/library";

const NOW = 1_760_000_000;
const games = buildEvalGames(LIBRARY);
const met = metadataNeedsMet(LIBRARY);

/** Presets the fixture library can actually answer. */
const offerable = presets(NOW).filter((p) => unmetNeeds(p, met).length === 0);

describe("every preset", () => {
  it("builds a collection whose ids derive from the one it is given", () => {
    // The caller passes the id the backend assigned, so two collections built
    // from the same preset don't end up sharing rule ids — which is what makes
    // editing one of them hit the other.
    for (const preset of presets(NOW)) {
      const built = preset.build("abc123");
      expect(built.id).toBe("abc123");
      expect(built.root.id).toBe("abc123-root");
      for (const rule of built.root.children) expect(rule.id.startsWith("abc123-")).toBe(true);
    }
  });

  it("carries a name, which is also the Steam collection's", () => {
    for (const preset of presets(NOW)) {
      expect(preset.build("x").label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it("has a unique id and label", () => {
    const all = presets(NOW);
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    expect(new Set(all.map((p) => p.build("x").label)).size).toBe(all.length);
  });

  it("evaluates without throwing, and at least one preset matches something", () => {
    // `matched.length <= games.length` was true by construction. What is worth
    // asserting is that the fixture library can actually satisfy these presets
    // — a gallery where every offerable entry comes back empty is the failure
    // the pricing exists to prevent.
    let matchedSomething = 0;
    for (const preset of offerable) {
      const result = evaluateCollection(preset.build(preset.id), games, { now: NOW * 1000 });
      expect(result.matched.length).toBeLessThanOrEqual(games.length);
      if (result.matched.length > 0) matchedSomething += 1;
    }
    expect(offerable.length).toBeGreaterThan(0);
    expect(matchedSomething).toBeGreaterThan(0);
  });

  it("declares every source it reads", () => {
    // A preset that quietly depends on a missing source is offered, comes back
    // empty, and reads as a broken plugin rather than as absent data.
    //
    // The old version looped over the needs the presets themselves declare and
    // checked each had a label — a set derived from the data under test, so it
    // could not fail. This compares the declarations against the rule kinds
    // actually in each tree, which is the invariant that matters.
    const NEED_FOR_KIND: Partial<Record<Rule["kind"], MetadataNeed>> = {
      playtime: "playHistory",
      lastPlayed: "playHistory",
      sizeOnDisk: "sizeOnDisk",
      reviewScore: "reviewScore",
      metacritic: "metacritic",
      deckCompat: "deckCompat",
      purchaseDate: "purchaseDate",
      storeTags: "storeTags",
      hltbMain: "hltb",
    };

    for (const preset of presets(NOW)) {
      const declared = new Set(preset.needs);
      for (const need of declared) expect(NEED_LABELS[need]).toBeTruthy();

      const used = preset
        .build(preset.id)
        .root.children.map((r) => NEED_FOR_KIND[r.kind])
        .filter((n): n is MetadataNeed => n !== undefined);
      for (const need of used) {
        // Fails loudly if a preset gains a rule whose source it never declared.
        expect(declared.has(need)).toBe(true);
      }
    }
  });

  it("is deterministic — the same `now` builds the same tree", () => {
    const a = JSON.stringify(presets(NOW).map((p) => p.build(p.id)));
    const b = JSON.stringify(presets(NOW).map((p) => p.build(p.id)));
    expect(a).toBe(b);
  });

  it("resolves relative dates at build time rather than drifting", () => {
    // A collection called "played this month" that silently re-scopes itself
    // is a different collection every time you look at it.
    const early = JSON.stringify(presets(NOW).map((p) => p.build(p.id)));
    const later = JSON.stringify(presets(NOW + 86_400).map((p) => p.build(p.id)));
    expect(early).not.toBe(later);
  });
});

describe("what the library can answer", () => {
  it("counts a source as present when any game has it, not all of them", () => {
    // Every real library has hundreds of titles with no Metacritic score.
    // Requiring full coverage would grey out a preset that works fine on the
    // ones that do.
    const mostlyBlank = [
      ...LIBRARY.map((g) => ({ ...g, metacritic: -1 })).slice(1),
      { ...LIBRARY[0]!, metacritic: 90 },
    ];
    expect(metadataNeedsMet(mostlyBlank).has("metacritic")).toBe(true);
  });

  it("treats never-played as a real answer, not a missing source", () => {
    // 0 means "never", which proves play history is present; -1 means unknown.
    expect(metadataNeedsMet([{ playtimeMinutes: 0, lastPlayed: 0 }]).has("playHistory")).toBe(true);
    expect(metadataNeedsMet([{ playtimeMinutes: -1, lastPlayed: -1 }]).has("playHistory")).toBe(
      false,
    );
  });

  it("doesn't count Deck compatibility as known when every game says 'unknown'", () => {
    // `deckCompat` is non-nullable and the no-AppStore fallback hard-codes
    // "unknown", so a presence test was true on a library that knows nothing —
    // "Deck Verified" was offered, priced, and came back empty.
    const blank = LIBRARY.map((g) => ({ ...g, deckCompat: "unknown" }));
    expect(metadataNeedsMet(blank).has("deckCompat")).toBe(false);
    expect(metadataNeedsMet(LIBRARY).has("deckCompat")).toBe(true);
  });

  it("only offers HowLongToBeat when its plugin is supplying the fact", () => {
    expect(metadataNeedsMet(LIBRARY).has("hltb")).toBe(false);
    expect(metadataNeedsMet(LIBRARY, new Set(["hltbMain" as const])).has("hltb")).toBe(true);
  });

  it("names what is missing in the user's terms", () => {
    const short = presets(NOW).find((p) => p.id === "short-games")!;
    expect(unmetNeeds(short, met).map((n) => NEED_LABELS[n])).toEqual(["HowLongToBeat times"]);
  });
});

describe("the presets that read play history", () => {
  const built = (id: string) => presets(NOW).find((p) => p.id === id)!.build(id);
  const matched = (id: string) =>
    evaluateCollection(built(id), games, { now: NOW * 1000 }).matched.map((g) => g.appId);

  it("keeps never-played games out of 'barely started'", () => {
    // Without the lower bound every unplayed game qualifies, and the
    // collection stops being about games you gave up on.
    //
    // Built here rather than taken from the shared fixture: that library has
    // no game with a handful of minutes on it, so "barely started" matched
    // nothing and the loop below ran zero times — the assertion was vacuous.
    const template = LIBRARY[0]!;
    const withPlaytime = (appId: string, playtimeMinutes: number, lastPlayed: number) => ({
      ...template,
      appId,
      name: `Game ${appId}`,
      sortAs: `game ${appId}`,
      playtimeMinutes,
      lastPlayed,
    });
    const tiny = buildEvalGames([
      withPlaytime("gave-up", 5, NOW - 86_400),
      withPlaytime("never", 0, 0),
      withPlaytime("sunk-in", 600, NOW - 86_400),
    ]);
    const inTiny = (id: string) =>
      new Set(
        evaluateCollection(built(id), tiny, { now: NOW * 1000 }).matched.map((g) => g.appId),
      );

    const barely = inTiny("barely-started");
    const never = inTiny("never-played");
    expect(barely).toEqual(new Set(["gave-up"]));
    expect(never).toEqual(new Set(["never"]));
  });

  it("keeps 'recently played' and 'dive back in' disjoint", () => {
    // One is the last month, the other is older than three — a game in both
    // would mean the date bounds overlap.
    const recent = new Set(matched("recently-played"));
    for (const appId of matched("dive-back-in")) expect(recent.has(appId)).toBe(false);
  });

  it("finds the backlog inside the never-played set", () => {
    const never = new Set(matched("never-played"));
    for (const appId of matched("backlog")) expect(never.has(appId)).toBe(true);
  });
});
