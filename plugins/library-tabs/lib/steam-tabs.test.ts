/**
 * The runtime only ever executes inside Steam, so these tests *run it* against
 * a fake `appStore` and a fake JSX factory. Asserting on the generated text
 * would prove the string was built, not that the tabs appear.
 */

import { describe, expect, it } from "bun:test";
import {
  RUNTIME_GLOBAL,
  TABS_FIND,
  buildTabsRuntime,
  setTabsExpression,
  steamTabId,
  tabsReplacement,
} from "./steam-tabs";

interface FakeApp {
  appid: number;
  display_name: string;
}

interface Runtime {
  data: unknown[];
  setTabs: (next: unknown) => number;
  collectionFor: (tab: { id: string; title: string; appIds: string[] }) => {
    id: string;
    displayName: string;
    visibleApps: FakeApp[];
    allApps: FakeApp[];
    bIsEditable: boolean;
    bIsDynamic: boolean;
  };
  extend: (
    tabs: unknown[],
    jsx: { jsx: (v: unknown, p: unknown) => unknown },
    view: unknown,
    shared: unknown,
  ) => Array<{ id: string; title: string; content?: unknown }>;
}

/** Install the runtime in a throwaway global, with a fake Steam appStore. */
function install(opts: { known?: number[] } = {}) {
  const known = new Set(opts.known ?? [10, 20, 30]);
  const g: Record<string, unknown> = {
    appStore: {
      GetAppOverviewByAppID: (id: number) =>
        known.has(id) ? ({ appid: id, display_name: `App ${id}` } as FakeApp) : null,
    },
    console: { warn() {} },
  };
  // `globalThis` inside the runtime resolves to our fake.
  new Function("globalThis", `return ${buildTabsRuntime()}`)(g);
  return { g, rt: g[RUNTIME_GLOBAL] as Runtime };
}

const JSX = { jsx: (view: unknown, props: unknown) => ({ view, props }) };
const VIEW = { name: "SteamCollectionView" };
const SHARED = { coverSize: 4 };

function steamTabs() {
  return [
    { id: "AllGames", title: "#LibraryTab_AllGames" },
    { id: "Collections", title: "#LibraryTab_Collections" },
  ];
}

describe("the patch itself", () => {
  it("targets a find string that exists verbatim in Steam's module", () => {
    // Measured from the shipped bundle. If Steam reformats this expression the
    // patch stops applying — which is the safe direction, but somebody has to
    // notice, and this test is where they will.
    expect(TABS_FIND).toBe("return[p.filter(e=>e),k!=F]");
  });

  it("preserves Steam's own return shape", () => {
    // The useMemo returns a 2-tuple; returning anything else breaks
    // destructuring at the call site and takes the library with it.
    const replacement = tabsReplacement();
    expect(replacement.startsWith("return[")).toBe(true);
    expect(replacement.endsWith(",k!=F]")).toBe(true);
    expect(replacement).toContain(".filter(e=>e)");
  });

  it("falls back to Steam's array when the runtime isn't installed", () => {
    // The patch lands at Steam start; the runtime arrives later over CDP.
    // Between the two, and forever if the plugin is disabled, this must be a
    // no-op rather than an exception inside a useMemo.
    const p = steamTabs();
    const k = 1;
    const F = 2;
    const run = new Function("p", "i", "Gc", "d", "k", "F", "globalThis", tabsReplacement());
    const [tabs, flag] = run(p, JSX, VIEW, SHARED, k, F, {}) as [unknown[], boolean];
    expect(tabs).toEqual(p);
    expect(flag).toBe(true);
  });
});

describe("the manifest and the runtime agree", () => {
  it("declares exactly the patch this module describes", async () => {
    // The find/replace lives in package.json because that is where the
    // injector reads it, but the strings are only meaningful alongside the
    // runtime here. Drift between the two is invisible until the tab bar
    // silently stops gaining tabs, so it is pinned.
    const pkg = (await Bun.file(
      new URL("../package.json", import.meta.url).pathname,
    ).json()) as {
      plugin: {
        patches: Array<{ find: string; replacement: { match: string; replace: string } }>;
      };
    };

    expect(pkg.plugin.patches).toHaveLength(1);
    const [patch] = pkg.plugin.patches;
    expect(patch!.find).toBe(TABS_FIND);
    expect(patch!.replacement.match).toBe(TABS_FIND);
    expect(patch!.replacement.replace).toBe(tabsReplacement());
  });

  it("does not mark the patch optional", async () => {
    // An optional patch fails silently. This one failing means the plugin's
    // headline feature is absent, which warrants the warning.
    const pkg = (await Bun.file(
      new URL("../package.json", import.meta.url).pathname,
    ).json()) as { plugin: { patches: Array<{ optional?: boolean }> } };
    expect(pkg.plugin.patches[0]!.optional).toBeUndefined();
  });
});

describe("runtime — installation", () => {
  it("installs once and is idempotent", () => {
    const { g } = install();
    const again = new Function("globalThis", `return ${buildTabsRuntime()}`)(g);
    expect(again).toBe("already-installed");
  });

  it("starts with no tabs, so a fresh install changes nothing", () => {
    const { rt } = install();
    expect(rt.data).toEqual([]);
    expect(rt.extend(steamTabs(), JSX, VIEW, SHARED)).toEqual(steamTabs());
  });
});

describe("runtime — building a collection Steam can render", () => {
  it("resolves appIds to Steam's own app overviews", () => {
    const { rt } = install();
    const c = rt.collectionFor({ id: "loadout-x", title: "Backlog", appIds: ["10", "20"] });
    expect(c.visibleApps.map((a) => a.appid)).toEqual([10, 20]);
    expect(c.allApps).toEqual(c.visibleApps);
    expect(c.displayName).toBe("Backlog");
  });

  it("drops ids Steam doesn't know rather than passing null through", () => {
    // A null in visibleApps blanks a tile in Steam's grid. Uninstalled
    // shortcuts and removed games make this routine, not exotic.
    const { rt } = install({ known: [10] });
    const c = rt.collectionFor({ id: "x", title: "T", appIds: ["10", "999", "888"] });
    expect(c.visibleApps.map((a) => a.appid)).toEqual([10]);
  });

  it("presents as non-editable, since rules own the membership", () => {
    // Offering drag-and-drop would let the user make an edit that the next
    // evaluation silently discards.
    const { rt } = install();
    const c = rt.collectionFor({ id: "x", title: "T", appIds: ["10"] });
    expect(c.bIsEditable).toBe(false);
    expect(c.bIsDynamic).toBe(true);
  });

  it("survives an appStore that isn't ready", () => {
    const g: Record<string, unknown> = { console: { warn() {} } };
    new Function("globalThis", `return ${buildTabsRuntime()}`)(g);
    const rt = g[RUNTIME_GLOBAL] as Runtime;
    expect(rt.collectionFor({ id: "x", title: "T", appIds: ["10"] }).visibleApps).toEqual([]);
  });
});

describe("runtime — extending Steam's tab bar", () => {
  it("appends our tabs after Steam's", () => {
    // Appending, not splicing: someone who knows where AllGames sits should
    // still find it there.
    const { rt } = install();
    rt.setTabs([{ id: "loadout-backlog", title: "Backlog", appIds: ["10"] }]);
    const out = rt.extend(steamTabs(), JSX, VIEW, SHARED);
    expect(out.map((t) => t.id)).toEqual(["AllGames", "Collections", "loadout-backlog"]);
  });

  it("renders through Steam's own collection view", () => {
    // The reason the tiles look native, and the reason no React of ours ever
    // has to enter Steam's context.
    const { rt } = install();
    rt.setTabs([{ id: "loadout-b", title: "Backlog", appIds: ["10", "20"] }]);
    const out = rt.extend(steamTabs(), JSX, VIEW, SHARED);
    const content = out[2]!.content as { view: unknown; props: Record<string, unknown> };
    expect(content.view).toBe(VIEW);
    expect(content.props.coverSize).toBe(4);
    expect((content.props.collection as { visibleApps: FakeApp[] }).visibleApps).toHaveLength(2);
  });

  it("uses the tab's own name, not a localisation token", () => {
    // Steam renders an unknown "#"-prefixed title as the raw token. User tab
    // names have no token, so they must pass through untouched.
    const { rt } = install();
    rt.setTabs([{ id: "loadout-b", title: "Backlog", appIds: [] }]);
    expect(rt.extend(steamTabs(), JSX, VIEW, SHARED)[2]!.title).toBe("Backlog");
  });

  it("never shadows a Steam tab that already has that id", () => {
    // Steam picks the active tab by id and falls back to rgTabs[0]. A
    // duplicate id would quietly change what the library opens on.
    const { rt } = install();
    rt.setTabs([{ id: "AllGames", title: "Mine", appIds: ["10"] }]);
    const out = rt.extend(steamTabs(), JSX, VIEW, SHARED);
    expect(out).toHaveLength(2);
    expect(out[0]!.title).toBe("#LibraryTab_AllGames");
  });

  it("returns Steam's array untouched when the payload is malformed", () => {
    // A tab bar that renders without ours is a disappointment. One that throws
    // inside a useMemo is an unusable library.
    const { rt } = install();
    rt.setTabs([null, { title: "no id" }, { id: "ok", title: "Ok", appIds: ["10"] }]);
    const out = rt.extend(steamTabs(), JSX, VIEW, SHARED);
    expect(out.map((t) => t.id)).toEqual(["AllGames", "Collections", "ok"]);
  });

  it("survives a JSX factory that throws", () => {
    const { rt } = install();
    rt.setTabs([{ id: "loadout-b", title: "B", appIds: ["10"] }]);
    const boom = {
      jsx: () => {
        throw new Error("render exploded");
      },
    };
    expect(rt.extend(steamTabs(), boom, VIEW, SHARED)).toEqual(steamTabs());
  });

  it("replaces tabs wholesale, so a deleted tab disappears", () => {
    const { rt } = install();
    rt.setTabs([{ id: "a", title: "A", appIds: [] }, { id: "b", title: "B", appIds: [] }]);
    expect(rt.extend(steamTabs(), JSX, VIEW, SHARED)).toHaveLength(4);
    rt.setTabs([{ id: "a", title: "A", appIds: [] }]);
    expect(rt.extend(steamTabs(), JSX, VIEW, SHARED).map((t) => t.id)).toEqual([
      "AllGames",
      "Collections",
      "a",
    ]);
  });

  it("ignores a non-array payload rather than wedging", () => {
    const { rt } = install();
    expect(rt.setTabs("nonsense")).toBe(0);
    expect(rt.extend(steamTabs(), JSX, VIEW, SHARED)).toEqual(steamTabs());
  });
});

describe("pushing tabs over CDP", () => {
  it("reports -1 when the runtime isn't there, so the caller can reinstall", () => {
    const run = new Function(
      "globalThis",
      `return ${setTabsExpression([{ id: "a", title: "A", appIds: [] }])}`,
    );
    expect(run({})).toBe(-1);
  });

  it("returns how many tabs landed", () => {
    const { g } = install();
    const run = new Function(
      "globalThis",
      `return ${setTabsExpression([
        { id: "a", title: "A", appIds: ["10"] },
        { id: "b", title: "B", appIds: [] },
      ])}`,
    );
    expect(run(g)).toBe(2);
  });

  it("survives a tab name containing quotes and backslashes", () => {
    // Tab names are user input and end up inside a JS expression string.
    const { g } = install();
    const nasty = 'He said "hi" \\ then `left`';
    const run = new Function(
      "globalThis",
      `return ${setTabsExpression([{ id: "a", title: nasty, appIds: [] }])}`,
    );
    expect(run(g)).toBe(1);
    expect((g[RUNTIME_GLOBAL] as Runtime).data).toEqual([
      { id: "a", title: nasty, appIds: [] },
    ]);
  });
});

describe("steamTabId", () => {
  it("namespaces ids away from Steam's", () => {
    expect(steamTabId("backlog")).toBe("loadout-backlog");
    expect(steamTabId("AllGames")).toBe("loadout-AllGames");
  });
});
