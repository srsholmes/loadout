/**
 * The patcher's output is a string of JavaScript that only ever runs inside
 * Steam. So these tests *run it* — against a fake `window` carrying a fake
 * `webpackChunksteamui` — rather than asserting on the text of the script.
 * Asserting on the text is how a patcher passes its tests while silently
 * patching nothing, which is exactly the failure this file was written after.
 */

import { describe, expect, it } from "bun:test";
import { MAX_MODULE_SOURCE, buildWebpackPatcherScript } from "./webpack-patcher";
import type { WebpackPatchEntry } from "./webpack-patcher";

interface FakeChunk {
  0: string[];
  1: Record<string, unknown>;
}

/** Run the generated script against a fake webpack chunk array. */
function runPatcher(args: {
  patches: WebpackPatchEntry[];
  modules: Record<string, (...a: unknown[]) => unknown>;
}) {
  const { patches, modules } = args;
  const chunk = [["chunk"], modules] as unknown as FakeChunk;
  const chunks: FakeChunk[] = [chunk];

  const win: Record<string, unknown> = { webpackChunksteamui: chunks };
  const script = buildWebpackPatcherScript(patches);

  // `window` and `globalThis` both resolve to the fake, so `$self` lookups and
  // the installed-guard behave as they do in Steam.
  const run = new Function("window", "globalThis", "console", script);
  run(win, win, { log() {}, warn() {}, error() {} });

  return { modules: chunk[1], win, chunks };
}

function patch(overrides: Partial<WebpackPatchEntry["patch"]> = {}): WebpackPatchEntry {
  return {
    pluginId: "collections",
    patch: {
      find: "MARKER_FIND",
      replacement: { match: "return TABS", replace: "return TABS.concat(EXTRA)" },
      ...overrides,
    },
  };
}

describe("webpack patcher — module size ceiling", () => {
  it("patches Steam's library module, which is far larger than the old ceiling", () => {
    // The regression that prompted this file. Steam's library module — the one
    // holding the tab bar, and the only reason a UI patcher exists — measured
    // 646,312 chars on the 2026-07 client. The ceiling was 200,000, so the
    // module was skipped before the find pattern was ever consulted: the patch
    // matched nothing and reported nothing.
    const padding = "/*".concat("x".repeat(646_312), "*/");
    const factory = new Function(
      "module",
      `${padding}; var MARKER_FIND = 1; var TABS = [1]; var EXTRA = [2]; return TABS;`,
    ) as (...a: unknown[]) => unknown;

    expect(Function.prototype.toString.call(factory).length).toBeGreaterThan(200_000);

    const { modules } = runPatcher({ patches: [patch()], modules: { "97220": factory } });
    expect(modules["97220"]).not.toBe(factory);
    expect((modules["97220"] as () => unknown)()).toEqual([1, 2]);
  });

  it("still skips a module too large to be worth scanning", () => {
    const huge = new Function(
      "module",
      `/*${"x".repeat(MAX_MODULE_SOURCE + 1000)}*/; var MARKER_FIND = 1; return TABS;`,
    ) as (...a: unknown[]) => unknown;

    const { modules } = runPatcher({ patches: [patch()], modules: { big: huge } });
    expect(modules.big).toBe(huge);
  });
});

describe("webpack patcher — matching", () => {
  it("rewrites a module whose source matches the find pattern", () => {
    const factory = new Function(
      "module",
      "var MARKER_FIND = 1; var TABS = ['a']; var EXTRA = ['b']; return TABS;",
    ) as (...a: unknown[]) => unknown;

    const { modules } = runPatcher({ patches: [patch()], modules: { m: factory } });
    expect((modules.m as () => unknown)()).toEqual(["a", "b"]);
  });

  it("leaves a module the find pattern doesn't name alone", () => {
    // A patcher that rewrites the wrong module is worse than one that does
    // nothing — it corrupts a component nobody is looking at.
    const other = new Function("module", "var TABS = ['a']; return TABS;") as (
      ...a: unknown[]
    ) => unknown;

    const { modules } = runPatcher({ patches: [patch()], modules: { other } });
    expect(modules.other).toBe(other);
  });

  it("requires every entry of an array find to be present", () => {
    const factory = new Function(
      "module",
      "var MARKER_FIND = 1; var TABS = ['a']; var EXTRA=['b']; return TABS;",
    ) as (...a: unknown[]) => unknown;

    const { modules } = runPatcher({
      patches: [patch({ find: ["MARKER_FIND", "NOT_PRESENT"] })],
      modules: { m: factory },
    });
    expect(modules.m).toBe(factory);
  });

  it("does not rewrite a module when the replacement matched nothing", () => {
    // Finding the right module but failing the replacement must leave Steam's
    // own code intact rather than rebuilding it from an unchanged string.
    const factory = new Function(
      "module",
      "var MARKER_FIND = 1; return 'untouched';",
    ) as (...a: unknown[]) => unknown;

    const { modules } = runPatcher({ patches: [patch()], modules: { m: factory } });
    expect(modules.m).toBe(factory);
  });
});

describe("webpack patcher — surviving a bad patch", () => {
  it("keeps the original factory when the patched source won't compile", () => {
    // The safety property that makes source patching preferable to patching
    // React's dispatcher: a broken patch degrades to stock Steam instead of
    // taking the library page down mid-render.
    const factory = new Function(
      "module",
      "var MARKER_FIND = 1; var TABS = ['a']; return TABS;",
    ) as (...a: unknown[]) => unknown;

    const { modules } = runPatcher({
      patches: [patch({ replacement: { match: "return TABS", replace: "return TABS(((" } })],
      modules: { m: factory },
    });
    expect((modules.m as () => unknown)()).toEqual(["a"]);
  });

  it("reports which patches never matched, rather than failing silently", () => {
    const { win } = runPatcher({ patches: [patch({ find: "NEVER" })], modules: {} });
    expect(win.__LOADOUT_APPLIED_PATCHES).toEqual({});
    expect(win.__LOADOUT_PATCH_LOG).toEqual([]);
  });

  it("records what it did apply, so a live client can be inspected", () => {
    const factory = new Function(
      "module",
      "var MARKER_FIND = 1; var TABS = ['a']; var EXTRA=['b']; return TABS;",
    ) as (...a: unknown[]) => unknown;

    const { win } = runPatcher({ patches: [patch()], modules: { m: factory } });
    expect(win.__LOADOUT_APPLIED_PATCHES).toEqual({ "collections:0": true });
    expect((win.__LOADOUT_PATCH_LOG as unknown[]).length).toBe(1);
  });
});

describe("webpack patcher — re-injection", () => {
  it("adopts a new patch set instead of bailing out", () => {
    // Steam's page outlives the daemon, so this script gets injected into the
    // same page again on every daemon restart. The old guard returned early,
    // which meant a just-fixed patch appeared to do nothing at all.
    const factory = new Function(
      "module",
      "var MARKER_FIND = 1; var TABS = ['a']; var EXTRA = ['b']; return TABS;",
    ) as (...a: unknown[]) => unknown;

    const chunk = [["c"], { m: factory }] as unknown as FakeChunk;
    const chunks: FakeChunk[] = [chunk];
    const win: Record<string, unknown> = { webpackChunksteamui: chunks };
    const console_ = { log() {}, warn() {}, error() {} };

    // First injection: a patch that matches nothing.
    new Function("window", "globalThis", "console", buildWebpackPatcherScript([patch({ find: "NOPE" })]))(
      win,
      win,
      console_,
    );
    expect(chunk[1].m).toBe(factory);

    // Second injection, same page, with a patch that does match.
    new Function("window", "globalThis", "console", buildWebpackPatcherScript([patch()]))(
      win,
      win,
      console_,
    );
    expect(chunk[1].m).not.toBe(factory);
    expect((chunk[1].m as () => unknown)()).toEqual(["a", "b"]);
  });

  it("does not double-wrap push across injections", () => {
    // Two layers of interception would scan every chunk twice forever.
    const win: Record<string, unknown> = { webpackChunksteamui: [] as FakeChunk[] };
    const console_ = { log() {}, warn() {}, error() {} };
    const script = buildWebpackPatcherScript([patch()]);

    new Function("window", "globalThis", "console", script)(win, win, console_);
    const afterFirst = (win.webpackChunksteamui as FakeChunk[]).push;
    new Function("window", "globalThis", "console", script)(win, win, console_);
    expect((win.webpackChunksteamui as FakeChunk[]).push).toBe(afterFirst);
  });

  it("re-arms the unmatched-patch report for the reloaded set", () => {
    // The reload path exists so a just-fixed patch takes effect on daemon
    // restart. If the 15s report is armed only when the hook is installed, the
    // reloaded set never gets one — so the developer editing a patch is back to
    // silence, which is the exact failure this whole path is about.
    const win: Record<string, unknown> = { webpackChunksteamui: [] as FakeChunk[] };
    const warnings: string[] = [];
    const console_ = {
      log() {},
      warn: (...a: unknown[]) => warnings.push(a.join(" ")),
      error() {},
    };

    // Capture the armed callbacks instead of waiting 15 real seconds.
    const armed: Array<() => void> = [];
    const fakeSetTimeout = (fn: () => void) => {
      armed.push(fn);
      return armed.length;
    };
    const run = (script: string) =>
      new Function("window", "globalThis", "console", "setTimeout", "clearTimeout", script)(
        win,
        win,
        console_,
        fakeSetTimeout,
        () => {},
      );

    run(buildWebpackPatcherScript([{ ...patch({ find: "NEVER_A" }), pluginId: "first-plugin" }]));
    run(buildWebpackPatcherScript([{ ...patch({ find: "NEVER_B" }), pluginId: "second-plugin" }]));

    expect(armed.length).toBeGreaterThan(1);

    // Fire the most recently armed report: it must name the reloaded plugin.
    armed[armed.length - 1]!();
    expect(warnings.some((w) => w.includes("second-plugin"))).toBe(true);
  });

  it("declines rather than double-hooking when an older build is already installed", () => {
    // Builds before `reload` existed set this global to a bare `true`, and
    // their push hook is still live in the page. Falling through would leave
    // two interceptors applying two different patch sets to every chunk.
    const chunks: FakeChunk[] = [];
    const win: Record<string, unknown> = {
      webpackChunksteamui: chunks,
      __LOADOUT_WEBPACK_PATCHER: true,
    };
    const warnings: string[] = [];
    const console_ = {
      log() {},
      warn: (...a: unknown[]) => warnings.push(a.join(" ")),
      error() {},
    };

    const pristinePush = chunks.push;
    new Function("window", "globalThis", "console", buildWebpackPatcherScript([patch()]))(
      win,
      win,
      console_,
    );

    expect(chunks.push).toBe(pristinePush);
    expect(warnings.some((w) => w.includes("Restart Steam"))).toBe(true);
  });
});

describe("webpack patcher — $self", () => {
  it("resolves for a kebab-case plugin id", () => {
    // Dot notation made `globalThis.__LOADOUT_PLUGIN_input-plumber` a
    // subtraction, so every hyphenated plugin got a patch that compiled and
    // then threw. Nearly every plugin id in this repo is hyphenated, so the
    // id here must contain a hyphen or the test proves nothing.
    const factory = new Function(
      "module",
      "var MARKER_FIND = 1; var TABS = ['a']; return TABS;",
    ) as (...a: unknown[]) => unknown;

    const { modules } = runPatcher({
      patches: [
        {
          pluginId: "input-plumber",
          patch: {
            find: "MARKER_FIND",
            replacement: { match: "return TABS", replace: "return $self.extend(TABS)" },
          },
        },
      ],
      modules: { m: factory },
    });

    // The rebuilt factory is created by `new Function` inside the patcher, so
    // it resolves the real global scope — as it does in Steam.
    const key = "__LOADOUT_PLUGIN_input-plumber";
    (globalThis as Record<string, unknown>)[key] = {
      extend: (t: string[]) => [...t, "injected"],
    };
    try {
      expect((modules.m as () => unknown)()).toEqual(["a", "injected"]);
    } finally {
      delete (globalThis as Record<string, unknown>)[key];
    }
  });

  it("degrades to an empty object when the plugin global is absent", () => {
    // The bundle-eval loop that populated these was removed as dead code, so
    // a missing global is the normal case, not an exceptional one. It must
    // not take Steam's library down.
    const factory = new Function(
      "module",
      "var MARKER_FIND = 1; var TABS = ['a']; return TABS;",
    ) as (...a: unknown[]) => unknown;

    const { modules } = runPatcher({
      patches: [
        patch({
          replacement: {
            match: "return TABS",
            replace: "return ($self.extend || function(t){return t})(TABS)",
          },
        }),
      ],
      modules: { m: factory },
    });
    expect((modules.m as () => unknown)()).toEqual(["a"]);
  });
});

describe("webpack patcher — no patches", () => {
  it("does not hook webpack at all when nothing needs patching", () => {
    // Most sessions register no patches. Wrapping `push` regardless would put
    // us on the hot path of every chunk load for nothing.
    const { chunks } = runPatcher({ patches: [], modules: {} });
    expect(chunks.push).toBe(Array.prototype.push);
  });

  it("hooks push when there is something to patch", () => {
    const { chunks } = runPatcher({ patches: [patch()], modules: {} });
    expect(chunks.push).not.toBe(Array.prototype.push);
  });

  it("patches a chunk that arrives after the hook is installed", () => {
    // Steam loads its library chunk lazily, so the chunks present at install
    // time are not the interesting ones.
    const { chunks } = runPatcher({ patches: [patch()], modules: {} });
    const late = new Function(
      "module",
      "var MARKER_FIND = 1; var TABS = ['a']; var EXTRA=['b']; return TABS;",
    ) as (...a: unknown[]) => unknown;
    const lateChunk = [["late"], { late }] as unknown as FakeChunk;

    chunks.push(lateChunk);
    expect((lateChunk[1].late as () => unknown)()).toEqual(["a", "b"]);
  });
});
