/**
 * The one property that matters most about the mirror: **what a tab shows on
 * screen and what its Steam collection contains are the same set of games.**
 *
 * Everything else in the mirror is machinery in service of this. A drift here
 * is the worst possible failure mode, because both halves look right in
 * isolation — the tab renders the games it matched, the collection renders the
 * games it holds — and the user only finds out when they go looking for a game
 * in Steam and it isn't there.
 *
 * So this runs the whole loop against an in-memory Steam: evaluate → plan →
 * apply → read back, for every built-in tab and every template, and asserts
 * the collection equals `evaluateTab().matched`. No CDP, so it runs in CI.
 */

import { describe, expect, it } from "bun:test";
import { buildEvalGames } from "./facts";
import { evaluateTab } from "./evaluate";
import { planMirror, type SteamCollection } from "./mirror";
import { applyMirrorPlan, type MirrorOps } from "./mirror-apply";
import { builtinTabs, templates } from "./templates";
import type { MirrorLedger, Tab } from "./types";
import { LIBRARY } from "../test/fixtures/library";

const NOW = 1_800_000_000_000;
const EVAL_GAMES = buildEvalGames(LIBRARY);

/**
 * A Steam that lives in a Map. Enforces the invariants the real one does —
 * ids are opaque and unique, names are not identifiers — so a plan that only
 * works because it matched on a name fails here.
 */
function fakeSteam() {
  const collections = new Map<string, SteamCollection>();
  let seq = 0;

  const ops: MirrorOps = {
    async create({ name, appIds }) {
      const id = `uc-${++seq}`;
      collections.set(id, { id, name, appIds: [...appIds], isDynamic: false, isEditable: true });
      return { collectionId: id, name };
    },
    async setApps({ collectionId, appIds }) {
      const existing = collections.get(collectionId);
      if (!existing) throw new Error(`no collection ${collectionId}`);
      collections.set(collectionId, { ...existing, appIds: [...appIds] });
    },
    async rename({ collectionId, name }) {
      const existing = collections.get(collectionId);
      if (!existing) throw new Error(`no collection ${collectionId}`);
      collections.set(collectionId, { ...existing, name });
    },
    async remove({ collectionId }) {
      collections.delete(collectionId);
    },
  };

  return {
    ops,
    list: () => [...collections.values()],
    byName: (name: string) => [...collections.values()].find((c) => c.name === name),
  };
}

/** Evaluate → plan → apply, once. Returns the new ledger. */
async function sync(args: {
  tabs: Tab[];
  ledger: MirrorLedger;
  steam: ReturnType<typeof fakeSteam>;
}): Promise<MirrorLedger> {
  const { tabs, ledger, steam } = args;
  const evaluated = new Map<string, string[]>();
  for (const tab of tabs) {
    if (!tab.mirror.enabled) continue;
    evaluated.set(
      tab.id,
      evaluateTab(tab, EVAL_GAMES, { now: NOW }).matched.map((g) => g.appId),
    );
  }
  const plan = planMirror({
    tabs,
    evaluated,
    ledger,
    steamCollections: steam.list(),
  });
  const result = await applyMirrorPlan({ plan, ledger, ops: steam.ops, now: NOW });
  expect(result.failures).toEqual([]);
  return result.ledger;
}

function mirrored(tab: Tab): Tab {
  return { ...tab, mirror: { enabled: true, collectionName: tab.label } };
}

const ALL_TABS: Tab[] = [
  ...builtinTabs(),
  ...templates(NOW).map((t) => t.build(`tpl-${t.id}`)),
];

describe("mirror agreement — every tab, end to end", () => {
  for (const raw of ALL_TABS) {
    it(`"${raw.label}" mirrors exactly what it displays`, async () => {
      const tab = mirrored(raw);
      const steam = fakeSteam();
      await sync({ tabs: [tab], ledger: { version: 1, entries: [] }, steam });

      const onScreen = evaluateTab(tab, EVAL_GAMES, { now: NOW }).matched.map((g) => g.appId);
      const inSteam = steam.byName(tab.label)?.appIds ?? null;

      expect(inSteam).not.toBeNull();
      expect([...inSteam!].sort()).toEqual([...onScreen].sort());
    });
  }

  it("mirrors every tab in one sync without them interfering", async () => {
    const tabs = ALL_TABS.map(mirrored);
    const steam = fakeSteam();
    await sync({ tabs, ledger: { version: 1, entries: [] }, steam });

    // Every tab got its own collection — no two shared one, and none was lost.
    expect(steam.list()).toHaveLength(tabs.length);
    for (const tab of tabs) {
      const onScreen = evaluateTab(tab, EVAL_GAMES, { now: NOW }).matched.map((g) => g.appId);
      expect([...(steam.byName(tab.label)?.appIds ?? [])].sort()).toEqual([...onScreen].sort());
    }
  });
});

describe("mirror agreement — the cap is respected", () => {
  it("mirrors the capped list, not the full match", async () => {
    // `limit` is applied post-sort in `evaluateTab`. Mirroring `total` instead
    // of `matched` would put games in Steam that the tab deliberately hides —
    // the "30 most recent" tab silently becoming "all of them".
    const base = mirrored(builtinTabs().find((t) => t.id === "all")!);
    const tab: Tab = { ...base, limit: 2, sort: [{ field: "name", direction: "asc" }] };

    const steam = fakeSteam();
    await sync({ tabs: [tab], ledger: { version: 1, entries: [] }, steam });

    const result = evaluateTab(tab, EVAL_GAMES, { now: NOW });
    expect(result.cappedOut).toBeGreaterThan(0);
    expect(steam.byName(tab.label)?.appIds).toHaveLength(2);
    expect([...(steam.byName(tab.label)?.appIds ?? [])].sort()).toEqual(
      result.matched.map((g) => g.appId).sort(),
    );
  });
});

describe("mirror agreement — repeated syncs", () => {
  it("converges: a second sync with nothing changed writes nothing", async () => {
    // Without this the mirror hammers Steam Cloud on every tick forever.
    const tabs = ALL_TABS.map(mirrored);
    const steam = fakeSteam();
    const ledger = await sync({ tabs, ledger: { version: 1, entries: [] }, steam });

    const evaluated = new Map(
      tabs.map((t) => [t.id, evaluateTab(t, EVAL_GAMES, { now: NOW }).matched.map((g) => g.appId)]),
    );
    const second = planMirror({ tabs, evaluated, ledger, steamCollections: steam.list() });

    expect(second.creates).toHaveLength(0);
    expect(second.updates).toHaveLength(0);
    expect(second.renames).toHaveLength(0);
    expect(second.deletes).toHaveLength(0);
    expect(second.drifted).toHaveLength(0);
    expect(second.noops).toHaveLength(tabs.length);
  });

  it("follows a rule change without leaving strays behind", async () => {
    const steam = fakeSteam();
    const wide = mirrored({
      ...builtinTabs().find((t) => t.id === "all")!,
      id: "t",
      label: "T",
      mirror: { enabled: true, collectionName: "T" },
    });
    let ledger = await sync({ tabs: [wide], ledger: { version: 1, entries: [] }, steam });
    const wideCount = steam.byName("T")!.appIds.length;
    expect(wideCount).toBeGreaterThan(1);

    // Narrow the tab to installed games only.
    const narrow: Tab = {
      ...wide,
      root: {
        kind: "group",
        id: "g",
        combinator: "and",
        children: [{ kind: "installed", id: "r", value: true }],
      } as Tab["root"],
    };
    ledger = await sync({ tabs: [narrow], ledger, steam });

    const onScreen = evaluateTab(narrow, EVAL_GAMES, { now: NOW }).matched.map((g) => g.appId);
    expect(onScreen.length).toBeLessThan(wideCount);
    expect([...steam.byName("T")!.appIds].sort()).toEqual([...onScreen].sort());
    // Same collection, not a second one.
    expect(steam.list()).toHaveLength(1);
    expect(ledger.entries[0]!.collectionId).toBe(steam.list()[0]!.id);
  });

  it("removes the collection when the tab stops mirroring", async () => {
    const steam = fakeSteam();
    const tab = mirrored({ ...builtinTabs()[0]!, id: "t", label: "T" });
    let ledger = await sync({ tabs: [tab], ledger: { version: 1, entries: [] }, steam });
    expect(steam.list()).toHaveLength(1);

    ledger = await sync({
      tabs: [{ ...tab, mirror: { enabled: false, collectionName: "T" } }],
      ledger,
      steam,
    });
    expect(steam.list()).toHaveLength(0);
    expect(ledger.entries).toHaveLength(0);
  });

  it("leaves a collection it does not own completely alone", async () => {
    // The user's own collections are not ours to touch, whatever they contain
    // and whatever they are called.
    const steam = fakeSteam();
    const theirs = await steam.ops.create({ name: "My Favourites", appIds: ["1", "2", "3"] });

    const tab = mirrored({ ...builtinTabs()[0]!, id: "t", label: "T" });
    await sync({ tabs: [tab], ledger: { version: 1, entries: [] }, steam });

    const after = steam.list().find((c) => c.id === theirs.collectionId);
    expect(after).toBeDefined();
    expect(after!.name).toBe("My Favourites");
    expect(after!.appIds).toEqual(["1", "2", "3"]);
  });
});
