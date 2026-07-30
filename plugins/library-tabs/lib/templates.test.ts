import { describe, expect, it } from "bun:test";
import { BUILTIN_TAB_IDS, builtinTabs, findTemplate, templates } from "./templates";
import { evaluateTab } from "./evaluate";
import { buildEvalGames } from "./facts";
import { isRuleComplete, leafRules } from "./rules";
import { summarizeTab } from "./summarize";
import { IDS, LIBRARY, epoch, ids } from "../test/fixtures/library";

const evalLibrary = buildEvalGames(LIBRARY);

/** Fixed clock so relative-date templates are deterministic. */
const NOW = epoch("2026-07-30");

describe("builtinTabs", () => {
  const tabs = builtinTabs();

  it("ships the documented set, in strip order", () => {
    expect(tabs.map((t) => t.id)).toEqual([
      "all",
      "installed",
      "recent",
      "never-played",
      "non-steam",
    ]);
  });

  it("keeps BUILTIN_TAB_IDS in sync with the tabs themselves", () => {
    expect([...BUILTIN_TAB_IDS].sort()).toEqual(tabs.map((t) => t.id).sort());
  });

  it("marks every one as builtin, so none can be deleted or edited", () => {
    for (const tab of tabs) {
      expect(tab.builtin).toBe(tab.id as typeof tab.builtin);
    }
  });

  it("gives every tab a unique id and a non-empty label", () => {
    expect(new Set(tabs.map((t) => t.id)).size).toBe(tabs.length);
    for (const tab of tabs) expect(tab.label.length).toBeGreaterThan(0);
  });

  it("gives every rule a unique id within its tab", () => {
    for (const tab of tabs) {
      const leafIds = leafRules(tab.root).map((r) => r.id);
      expect(new Set(leafIds).size).toBe(leafIds.length);
    }
  });

  it("evaluates without throwing, and none is unexpectedly empty", () => {
    for (const tab of tabs) {
      const result = evaluateTab(tab, evalLibrary);
      // Every builtin should find something in a fixture this varied.
      expect(result.matched.length).toBeGreaterThan(0);
    }
  });

  it("summarises every builtin without emitting placeholder text", () => {
    for (const tab of tabs) {
      const text = summarizeTab(tab);
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("…");
    }
  });

  it("All matches the whole library via a vacuously-true empty group", () => {
    const all = tabs.find((t) => t.id === "all")!;
    expect(all.root.children).toHaveLength(0);
    expect(evaluateTab(all, evalLibrary).matched).toHaveLength(LIBRARY.length);
  });

  it("Installed matches exactly the installed games", () => {
    const tab = tabs.find((t) => t.id === "installed")!;
    expect(evaluateTab(tab, evalLibrary).matched).toHaveLength(
      LIBRARY.filter((g) => g.installed).length,
    );
  });

  it("Never played means installed AND provably never launched", () => {
    const tab = tabs.find((t) => t.id === "never-played")!;
    const result = evaluateTab(tab, evalLibrary);
    // Cyberpunk (installed, lastPlayed 0) and the demo qualify. The
    // soundtrack is installed but its lastPlayed is unknown, not 0, so it
    // must NOT be claimed as never-played.
    expect(ids(result.matched)).toContain(IDS.cyberpunk);
    expect(ids(result.matched)).toContain(IDS.demo);
    expect(ids(result.matched)).not.toContain(IDS.soundtrack);
  });

  it("Recently played excludes never-played and caps at 30, newest first", () => {
    const tab = tabs.find((t) => t.id === "recent")!;
    expect(tab.limit).toBe(30);
    expect(tab.sort[0]).toEqual({ field: "lastPlayed", dir: "desc" });
    const result = evaluateTab(tab, evalLibrary);
    expect(ids(result.matched)[0]).toBe(IDS.stardew); // most recent
    expect(ids(result.matched)).not.toContain(IDS.cyberpunk); // never played
  });

  it("Non-Steam auto-hides, so it vanishes on a library with no shortcuts", () => {
    const tab = tabs.find((t) => t.id === "non-steam")!;
    expect(tab.autoHide).toBe(true);
    expect(ids(evaluateTab(tab, evalLibrary).matched)).toEqual([IDS.mario64]);
  });

  it("returns a fresh array each call, so callers cannot corrupt the defaults", () => {
    const a = builtinTabs();
    a[0]!.label = "mutated";
    expect(builtinTabs()[0]!.label).toBe("All");
  });
});

describe("templates", () => {
  const list = templates(NOW);

  it("gives every template a unique id, label, description and icon", () => {
    expect(new Set(list.map((t) => t.id)).size).toBe(list.length);
    for (const t of list) {
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
    }
  });

  it("leads with backlog suppression, the actual job-to-be-done", () => {
    // Ordering here is a product decision, not alphabetical: the recurring
    // request is "hide everything I could install so I only see what I have".
    expect(list[0]!.id).toBe("backlog");
    expect(list[1]!.id).toBe("short-games");
  });

  it("ends with the blank template, so it never crowds out the useful ones", () => {
    expect(list.at(-1)!.id).toBe("blank");
  });

  it("builds a valid, fully-specified tab from every template", () => {
    for (const t of list) {
      const tab = t.build(`tpl-${t.id}`);
      expect(tab.id).toBe(`tpl-${t.id}`);
      expect(tab.label.length).toBeGreaterThan(0);
      // Templates must not produce a half-built rule the user has to repair.
      // The blank template is the deliberate exception.
      if (t.id !== "blank") {
        expect(isRuleComplete(tab.root)).toBe(true);
      }
      // And none is a builtin — templates create editable tabs.
      expect(tab.builtin).toBeUndefined();
    }
  });

  it("evaluates every template against the fixture without throwing", () => {
    for (const t of list) {
      const tab = t.build(`tpl-${t.id}`);
      expect(() => evaluateTab(tab, evalLibrary, { trace: true })).not.toThrow();
    }
  });

  it("gives every rule in a template a unique id", () => {
    for (const t of list) {
      const tab = t.build(`tpl-${t.id}`);
      const leafIds = leafRules(tab.root).map((r) => r.id);
      expect(new Set(leafIds).size).toBe(leafIds.length);
    }
  });

  it("summarises every template without leaking placeholder text", () => {
    for (const t of list) {
      const tab = t.build(`tpl-${t.id}`);
      const text = summarizeTab(tab);
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("[object Object]");
      // "…" marks an unfinished rule; only `blank` may show it.
      if (t.id !== "blank") expect(text).not.toContain("…");
    }
  });

  it("declares `needs` for every template that depends on later-phase data", () => {
    // The gallery greys these and explains why, rather than handing the user
    // a tab that renders empty for reasons they can't see.
    const needsByLater = ["short-games", "deck-verified", "friends-playing", "couch-coop"];
    for (const id of needsByLater) {
      expect(templates(NOW).find((t) => t.id === id)!.needs).toBeDefined();
    }
  });

  it("does not declare `needs` for templates that work on Phase 1 data alone", () => {
    // `backlog` and `pick-up-again` used to be on this list. They are not:
    // both filter on `lastPlayed`, which no provider populates, so they were
    // guaranteed empty *and* not greyed out — a template that looks ready and
    // silently produces nothing. Caught by the corpus non-degeneracy suite.
    for (const id of ["space-hogs", "emulation", "blank"]) {
      expect(templates(NOW).find((t) => t.id === id)!.needs).toBeUndefined();
    }
  });

  it("declares `needs` for every template that filters on unpopulated data", () => {
    // `blockedReason` in app.tsx greys a template out only when it declares
    // `needs`, so an undeclared dependency is invisible to the user.
    for (const [id, needs] of [
      ["backlog", ["lastPlayed"]],
      ["pick-up-again", ["lastPlayed", "playtime"]],
    ] as const) {
      expect(templates(NOW).find((t) => t.id === id)!.needs).toEqual([...needs]);
    }
  });
});

describe("templates — determinism", () => {
  it("stores an absolute bound at creation time, not a relative one", () => {
    // A tab built today must not silently drift as the clock moves; the user
    // edits the date afterwards if they want it to.
    const a = templates(NOW).find((t) => t.id === "pick-up-again")!.build("x");
    const b = templates(NOW).find((t) => t.id === "pick-up-again")!.build("x");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("uses the injected clock rather than reading Date.now", () => {
    const early = templates(epoch("2020-01-01")).find((t) => t.id === "recently-added")!.build("x");
    const late = templates(epoch("2026-01-01")).find((t) => t.id === "recently-added")!.build("x");
    expect(JSON.stringify(early)).not.toBe(JSON.stringify(late));
  });
});

describe("templates — behaviour of specific templates", () => {
  it("Backlog finds installed-but-never-started games", () => {
    const tab = templates(NOW).find((t) => t.id === "backlog")!.build("x");
    const result = evaluateTab(tab, evalLibrary);
    expect(ids(result.matched)).toContain(IDS.cyberpunk);
    expect(ids(result.matched)).not.toContain(IDS.portal2); // played
  });

  it("Space hogs sorts biggest first and only counts installed games", () => {
    const tab = templates(NOW).find((t) => t.id === "space-hogs")!.build("x");
    const result = evaluateTab(tab, evalLibrary);
    // Only Cyberpunk (70 GB) clears the 20 GB bar; Portal 2 is 12 GB.
    expect(ids(result.matched)).toEqual([IDS.cyberpunk]);
  });

  it("Emulation groups shortcuts by platform collection", () => {
    // The payoff of sub-tabs on the most-requested TabMaster feature.
    const tab = templates(NOW).find((t) => t.id === "emulation")!.build("x");
    expect(tab.group.kind).toBe("field");
    const result = evaluateTab(tab, evalLibrary);
    expect(result.groups.map((g) => g.label)).toContain("Nintendo 64");
  });

  it("Hide the clutter inverts appKind rather than listing every good type", () => {
    const tab = templates(NOW).find((t) => t.id === "declutter")!.build("x");
    const result = evaluateTab(tab, evalLibrary);
    expect(ids(result.matched)).not.toContain(IDS.soundtrack);
    expect(ids(result.matched)).not.toContain(IDS.demo);
    expect(ids(result.matched)).toContain(IDS.portal2);
  });

  it("Blank produces an empty, editable tab that shows everything", () => {
    const tab = templates(NOW).find((t) => t.id === "blank")!.build("x");
    expect(tab.root.children).toHaveLength(0);
    expect(evaluateTab(tab, evalLibrary).matched).toHaveLength(LIBRARY.length);
  });
});

describe("findTemplate", () => {
  it("finds by id", () => {
    expect(findTemplate("backlog", NOW)?.label).toBe("Installed & unplayed");
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(findTemplate("nope", NOW)).toBeUndefined();
  });
});
