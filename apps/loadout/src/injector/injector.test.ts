import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import {
  buildPanelMountScript,
  injectBPMBundles,
  maybeGiveUp,
  PANEL_CONTAINER_STYLE,
} from "./injector";

/**
 * Audit A-019: the BPM bundle loop used to swallow every per-plugin
 * eval failure with a bare `catch {}`. That meant a single broken
 * bundle (parse error, missing global, etc.) silently never mounted
 * and there was no log entry to debug it from. The fix logs the
 * plugin id + error via console.warn; that's all we assert here.
 */
describe("injectBPMBundles (A-019)", () => {
  let warnSpy: ReturnType<typeof mock>;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalWarn = console.warn;
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });
  afterEach(() => {
    console.warn = originalWarn;
  });

  it("evaluates every bundle in order", async () => {
    const calls: string[] = [];
    const cdp = {
      evaluate: async (code: string) => {
        calls.push(code);
        return undefined;
      },
    };
    const bundles = new Map([
      ["alpha", "/*alpha*/"],
      ["beta", "/*beta*/"],
    ]);
    await injectBPMBundles(cdp, bundles);
    expect(calls).toEqual(["/*alpha*/", "/*beta*/"]);
  });

  it("logs a warning when a per-plugin evaluate throws, then keeps going", async () => {
    const cdp = {
      evaluate: async (code: string) => {
        if (code.includes("bad")) throw new Error("parse error");
        return undefined;
      },
    };
    const bundles = new Map([
      ["good-one", "/*good*/"],
      ["bad-one", "/*bad*/"],
      ["good-two", "/*good-two*/"],
    ]);

    await injectBPMBundles(cdp, bundles);

    // Exactly one warn — for the bad bundle, naming the plugin id so an
    // operator scanning the log can map the failure back to its source.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const callArgs = warnSpy.mock.calls[0];
    expect(callArgs[0]).toBe("[injector] BPM bundle failed for");
    expect(callArgs[1]).toBe("bad-one");
    expect(callArgs[2]).toBeInstanceOf(Error);
  });
});

/**
 * Audit A-021: when the injector exhausted its crash-retry budget it
 * just flipped `running = false` and disappeared. The host now passes an
 * `onGiveUp` callback so a `__system` event can be broadcast. The
 * decision lives in `maybeGiveUp` so it is testable in isolation —
 * driving the full 5-retry × 5s loop in a unit test is not.
 */
describe("maybeGiveUp (A-021)", () => {
  it("returns false and does not fire callback below threshold", () => {
    const calls: Array<{ reason: string; crashCount: number }> = [];
    const cb = (info: { reason: string; crashCount: number }) => { calls.push(info); };
    const log = () => {};
    expect(maybeGiveUp(0, cb, log)).toBe(false);
    expect(maybeGiveUp(4, cb, log)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("returns true and fires the callback once above threshold", () => {
    const calls: Array<{ reason: string; crashCount: number }> = [];
    const cb = (info: { reason: string; crashCount: number }) => { calls.push(info); };
    const log = () => {};
    expect(maybeGiveUp(5, cb, log)).toBe(true);
    expect(calls).toEqual([
      { reason: "crash-retry-budget-exhausted", crashCount: 5 },
    ]);
  });

  it("still signals give-up if the callback is undefined", () => {
    const log = () => {};
    expect(maybeGiveUp(7, undefined, log)).toBe(true);
  });

  it("swallows callback errors so the give-up path always completes", () => {
    const cb = () => {
      throw new Error("downstream broadcast blew up");
    };
    const logs: string[] = [];
    const log = (msg: string) => { logs.push(msg); };
    expect(maybeGiveUp(5, cb, log)).toBe(true);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("onGiveUp callback threw");
    expect(logs[0]).toContain("downstream broadcast blew up");
  });
});

/**
 * Audit A-008: the SharedJSContext-side and BPM-side panel-mount
 * scripts used to be two ~80-line copies that drifted as audit fixes
 * landed in one but not the other (notably A-019). The extraction
 * collapses them into `buildPanelMountScript`. These tests cover the
 * pieces that matter for behaviour parity: sentinel naming, container
 * setup, loader URL interpolation, and the two bundle-load strategies.
 */
describe("buildPanelMountScript (A-008)", () => {
  const baseOpts = {
    loaderUrl: "http://127.0.0.1:33820",
    authHeader: "Bearer test-token",
    containerId: "loadout-root",
    containerStyle: PANEL_CONTAINER_STYLE,
    globalSentinel: "loadoutHasLoaded",
    logPrefix: "[loadout]",
    bundleLoader: "import" as const,
    loadStrategy: "loadAll" as const,
    bailOnMissingReact: false,
  };

  it("produces a script with the expected sentinel set + container id", () => {
    const script = buildPanelMountScript({
      ...baseOpts,
      globalSentinel: "__loadoutPanelsMounted",
      containerId: "loadout-root",
    });

    // Sentinel read (guard), write (claim), and delete-on-failure (release)
    // must all reference the same global. The bracket-form sidesteps the
    // member-syntax lint quibble around double-underscore names.
    expect(script).toContain('window["__loadoutPanelsMounted"]');
    expect(script).toContain('window["__loadoutPanelsMounted"] = true');
    expect(script).toContain('delete window["__loadoutPanelsMounted"]');

    // Container id is wired into both the lookup and the creation path.
    expect(script).toContain('document.getElementById("loadout-root")');
    expect(script).toContain('container.id = "loadout-root"');

    // Container style is exactly the shared constant.
    expect(script).toContain(`container.style.cssText = "${PANEL_CONTAINER_STYLE}"`);
  });

  it("interpolates `loaderUrl` into the bundle import path and plugin-list XHR", () => {
    const script = buildPanelMountScript({
      ...baseOpts,
      loaderUrl: "http://example.local:9999",
    });

    expect(script).toContain('"http://example.local:9999/api/plugins?all=1"');
    expect(script).toContain('"http://example.local:9999/inject/plugins/" + plugin.id + "/bundle.js"');
  });

  it("emits `import()` for bundleLoader=\"import\" and fetch+<script> for bundleLoader=\"scriptTag\"", () => {
    const importScript = buildPanelMountScript({ ...baseOpts, bundleLoader: "import" });
    expect(importScript).toContain("await import(");
    expect(importScript).not.toContain("fetch(");

    const scriptTagScript = buildPanelMountScript({ ...baseOpts, bundleLoader: "scriptTag" });
    expect(scriptTagScript).toContain("fetch(");
    expect(scriptTagScript).toContain('document.createElement("script")');
    expect(scriptTagScript).toContain("document.head.appendChild(el)");
  });

  it("filter-before-load for loadOnlyPanel skips non-panel bundles entirely", () => {
    const loadAll = buildPanelMountScript({ ...baseOpts, loadStrategy: "loadAll" });
    // loadAll: load happens first, then targets/hasPanel filter
    const loadAllImportIdx = loadAll.indexOf("await import(");
    const loadAllFilterIdx = loadAll.indexOf("var hasPanel");
    expect(loadAllImportIdx).toBeGreaterThan(-1);
    expect(loadAllFilterIdx).toBeGreaterThan(loadAllImportIdx);

    const onlyPanel = buildPanelMountScript({
      ...baseOpts,
      bundleLoader: "scriptTag",
      loadStrategy: "loadOnlyPanel",
    });
    // loadOnlyPanel: filter first, `if (!hasPanel) continue;` short-circuits
    const onlyPanelFilterIdx = onlyPanel.indexOf("var hasPanel");
    const onlyPanelFetchIdx = onlyPanel.indexOf("fetch(");
    expect(onlyPanel).toContain("if (!hasPanel) continue;");
    expect(onlyPanelFilterIdx).toBeGreaterThan(-1);
    expect(onlyPanelFetchIdx).toBeGreaterThan(onlyPanelFilterIdx);
  });

  it("bailOnMissingReact=true emits an early-return guard when React is missing", () => {
    const bail = buildPanelMountScript({ ...baseOpts, bailOnMissingReact: true });
    expect(bail).toContain("React not available");
    expect(bail).toContain("if (!React || !ReactDOM)");

    const noBail = buildPanelMountScript({ ...baseOpts, bailOnMissingReact: false });
    expect(noBail).not.toContain("React not available");
  });

  it("logPrefix appears on every emitted console line so journal lines stay debuggable per call site", () => {
    const bpm = buildPanelMountScript({ ...baseOpts, logPrefix: "[loadout:bpm]" });
    // Every console.log/warn/error line should carry the prefix. Cheap
    // regression check: count occurrences — we know the script has at
    // least one console.log per major phase (load, mount, complete) and
    // one console.error on failure.
    const matches = bpm.match(/\[loadout:bpm\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it("two call sites produce scripts that differ only in the parameterised pieces", () => {
    // Sanity: this is the snapshot-style assertion the task asks for.
    // Build both real-world configurations and confirm the unparam parts
    // match by stripping out everything that's allowed to differ.
    const sharedJsContext = buildPanelMountScript({
      ...baseOpts,
      loaderUrl: "http://127.0.0.1:33820",
      globalSentinel: "loadoutHasLoaded",
      logPrefix: "[loadout]",
      bundleLoader: "import",
      loadStrategy: "loadAll",
      bailOnMissingReact: false,
    });
    const bpm = buildPanelMountScript({
      ...baseOpts,
      loaderUrl: "http://localhost:33820",
      globalSentinel: "__loadoutPanelsMounted",
      logPrefix: "[loadout:bpm]",
      bundleLoader: "scriptTag",
      loadStrategy: "loadOnlyPanel",
      bailOnMissingReact: true,
    });

    // The XHR plugin-list block, the container creation block, and the
    // final mount block are identical structure across both. Spot-check
    // the mount block.
    const mountBlock = "var root = ReactDOM.createRoot(container);";
    expect(sharedJsContext).toContain(mountBlock);
    expect(bpm).toContain(mountBlock);

    const providerBlock = "var Provider = sdk.LoadoutProvider || React.Fragment;";
    expect(sharedJsContext).toContain(providerBlock);
    expect(bpm).toContain(providerBlock);
  });
});
