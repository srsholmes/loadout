/**
 * Steam CEF Injector — connects to Steam's CEF debug port, finds the
 * SharedJSContext tab, and injects the Loadout frontend.
 *
 * Monitors for page reloads and reinjects as needed.
 */

import { CDPClient } from "@loadout/steam-cdp";
import { findSharedJSContext, findBigPictureTab, type CEFTab, type GetTabsOptions } from "./tabs";
import { buildComponentDiscoveryScript } from "./steam-components";
import { buildMenuPatchScript, type MenuPluginEntry } from "./menu-patcher";
import { buildRoutePatchScript, type RouteEntry } from "./route-patcher";
import { buildWebpackPatcherScript, type WebpackPatchEntry } from "./webpack-patcher";
import { buildInspectorScript } from "./inspector";
import { DISCOVER_STEAM_REACT } from "./steam-react";
import { createGameSessionMonitor, type GameSessionMonitor } from "./game-session-monitor";
import { isGamescopeRunning } from "./game-mode";

export interface InjectorOptions {
  /** CEF remote debug port (Steam's default is 8080) */
  debugPort?: number;
  /** Port the Loadout server is running on */
  loaderPort?: number;
  /** Max time to wait for CEF to be available (ms). 0 = wait forever */
  cefTimeout?: number;
  /** Logger function */
  log?: (msg: string) => void;
  /**
   * Optional factory for creating CDP connections. When provided, called
   * instead of creating a direct CDPClient. Lets callers wrap the
   * connection in their own pooling / instrumentation layer; nothing
   * uses it today (the multiplexer that originally needed it was
   * deleted in audit A-027 because it was never wired up).
   */
  cdpFactory?: (wsUrl: string) => Promise<CDPClient>;
  /** Enable dev mode features (React DevTools bridge, element inspector) */
  devMode?: boolean;
  /** Session token for authenticating RPC calls from injected code back to the server */
  sessionToken?: string;
  /** Pre-built inject bundles to push directly via CDP (avoids HTTP mixed-content blocks) */
  injectBundles?: {
    vendor: string;
    sdk: string;
    plugins: Map<string, string>;
  };
  /**
   * In-process launch/exit hooks. Steam's CEF blocks fetch() to localhost
   * (mixed content), so the injected JS-side rpcCall to /api/rpc is
   * unreliable; the binding callback runs in the loader process and is
   * the authoritative dispatch path.
   */
  onGameLaunch?: (appId: number, gameName: string) => void | Promise<void>;
  onGameExit?: (appId: number, gameName: string) => void | Promise<void>;
  /**
   * Called once after the injector exhausts its crash-retry budget and
   * stops trying. Lets the host surface a `__system` event so UI
   * subscribers can show a "Loadout stopped trying to attach"
   * banner instead of failing silently. Audit A-021.
   */
  onGiveUp?: (info: { reason: string; crashCount: number }) => void;
  /**
   * Predicate gating plugin CEF injection on Gaming Mode (issue #111).
   * Plugin bundles, webpack/route/menu patches, panels and overlays are
   * only injected when this returns true; in desktop mode the injector
   * still connects to CEF and runs the game-session monitor, but injects
   * nothing. Defaults to `isGamescopeRunning` (a gamescope process scan);
   * overridable for tests. Guard at the injection level, not per-plugin.
   */
  isGameMode?: () => boolean | Promise<boolean>;
}

const GLOBAL_FLAG = "loadoutHasLoaded";

/**
 * Decide whether the injector has exhausted its crash-retry budget,
 * and emit the `onGiveUp` callback when it has.
 *
 * Extracted from `start()` so the audit A-021 fix (the give-up path
 * used to terminate silently) is unit-testable without driving the
 * full 25s × 5-retry loop. Returns true when the caller should stop.
 *
 * Exported for tests.
 */
export function maybeGiveUp(
  crashCount: number,
  onGiveUp: InjectorOptions["onGiveUp"] | undefined,
  log: (msg: string) => void,
  threshold = 4,
): boolean {
  if (crashCount <= threshold) return false;
  try {
    onGiveUp?.({ reason: "crash-retry-budget-exhausted", crashCount });
  } catch (err) {
    log(`[injector] onGiveUp callback threw: ${err instanceof Error ? err.message : err}`);
  }
  return true;
}

/**
 * Inject every plugin bundle into the BPM tab, logging per-plugin
 * failures instead of swallowing them.
 *
 * Extracted from `mountPanelsInBPM` so the audit A-019 fix (was a bare
 * `catch {}` that hid bundle eval failures forever) is unit-testable
 * without booting the full SteamInjector + CEF.
 *
 * Exported for tests.
 */
export async function injectBPMBundles(
  cdp: { evaluate: (code: string) => Promise<unknown> },
  bundles: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [pluginId, code] of bundles) {
    try {
      await cdp.evaluate(code);
    } catch (err) {
      // Audit A-019: don't swallow — surface which plugin failed so a
      // bad bundle (parse error, missing global) is debuggable from
      // the loader log instead of silently never mounting.
      console.warn("[injector] BPM bundle failed for", pluginId, err);
    }
  }
}

/** Shared CSS for `<div id="loadout-root">`. Audit A-008. */
export const PANEL_CONTAINER_STYLE =
  "position:fixed;bottom:0;right:0;width:400px;max-height:100vh;overflow-y:auto;z-index:999999;pointer-events:auto;";

export interface PanelMountScriptOptions {
  loaderUrl: string;
  authHeader: string;
  containerId: string;
  containerStyle: string;
  /** Per-tab `window` sentinel guarding against double-mount. */
  globalSentinel: string;
  /** Journal log prefix, e.g. `"[loadout]"` or `"[loadout:bpm]"`. */
  logPrefix: string;
  /**
   * `"import"` bypasses the steamloopback.host mixed-content block on
   * the SharedJSContext side; `"scriptTag"` is fine on the BPM tab.
   */
  bundleLoader: "import" | "scriptTag";
  /**
   * `"loadAll"` loads every bundle then filters (initial inject — QAM /
   * route patchers downstream need every global populated). `"loadOnlyPanel"`
   * filters first and skips already-loaded bundles (BPM remount — the
   * SharedJSContext inject already populated `__LOADOUT_PLUGIN_*`).
   */
  loadStrategy: "loadAll" | "loadOnlyPanel";
  /** Early-return with a `console.warn` if `__VENDOR_REACT*` is missing. */
  bailOnMissingReact: boolean;
  pluginGlobalPrefix?: string;
  providerExpr?: string;
}

/**
 * Build the CEF-side JS source string that mounts panel-type plugins
 * into `<div id="loadout-root">`. Audit A-008 collapsed two
 * near-identical inline copies into this helper — see the call sites in
 * `buildInjectionScript` (SharedJSContext) and `mountPanelsInBPM` for
 * the parameter choices each context makes.
 *
 * The return value is meant for `cdp.evaluate(...)`.
 */
export function buildPanelMountScript(opts: PanelMountScriptOptions): string {
  const {
    loaderUrl,
    authHeader,
    containerId,
    containerStyle,
    globalSentinel,
    logPrefix,
    bundleLoader,
    loadStrategy,
    bailOnMissingReact,
    pluginGlobalPrefix = "__LOADOUT_PLUGIN_",
    providerExpr = "sdk.LoadoutProvider || React.Fragment",
  } = opts;

  // Bracket form so double-underscore names don't trip future linters.
  const sentinelRead = `window["${globalSentinel}"]`;
  const sentinelWrite = `window["${globalSentinel}"] = true`;
  const sentinelDelete = `delete window["${globalSentinel}"]`;

  const reactBailBlock = bailOnMissingReact
    ? `
    if (!React || !ReactDOM) {
      console.warn("${logPrefix} React not available — skipping panel mount");
      return;
    }`
    : "";

  // Both forms run inside `for (var i...) try{...}` and leave the
  // plugin global `window[globalKey]` populated when they return.
  const loadBundleStmt =
    bundleLoader === "import"
      ? `await import("${loaderUrl}/inject/plugins/" + plugin.id + "/bundle.js");`
      : `await (async function() {
          var res = await fetch("${loaderUrl}/inject/plugins/" + plugin.id + "/bundle.js");
          if (!res.ok) throw new Error("Failed to load bundle: " + res.status);
          var code = await res.text();
          var el = document.createElement("script");
          el.textContent = code;
          document.head.appendChild(el);
        })();`;

  // `loadAll` loads then filters; `loadOnlyPanel` filters first and
  // skips bundles whose global is already populated (BPM-side reuse).
  const loopBody =
    loadStrategy === "loadAll"
      ? `
      var plugin = pluginsRes[i];
      try {
        ${loadBundleStmt}
        console.log("${logPrefix} Loaded plugin bundle: " + plugin.name);

        var targets = plugin.target ? (Array.isArray(plugin.target) ? plugin.target : [plugin.target]) : [];
        var hasPanel = targets.length === 0 || targets.some(function(t) { return t.type === "panel"; });
        if (hasPanel) {
          var mod = globalThis["${pluginGlobalPrefix}" + plugin.id] || {};
          var Panel = mod.default || mod.Panel;
          if (Panel && React) {
            panels.push(React.createElement(Panel, { key: plugin.id }));
          }
        }
      } catch (err) {
        console.error("${logPrefix} Failed to load plugin " + plugin.id, err);
      }`
      : `
      var plugin = pluginsRes[i];
      var targets = plugin.target ? (Array.isArray(plugin.target) ? plugin.target : [plugin.target]) : [];
      var hasPanel = targets.length === 0 || targets.some(function(t) { return t.type === "panel"; });
      if (!hasPanel) continue;

      try {
        var globalKey = "${pluginGlobalPrefix}" + plugin.id;
        if (!window[globalKey]) {
          ${loadBundleStmt}
        }
        var mod = window[globalKey] || {};
        var Panel = mod.default || mod.Panel;
        if (Panel) {
          panels.push(React.createElement(Panel, { key: plugin.id }));
          console.log("${logPrefix} Loaded panel plugin: " + plugin.name);
        }
      } catch (err) {
        console.error("${logPrefix} Failed to load plugin " + plugin.id, err);
      }`;

  // Final mount block. Identical across call sites.
  const mountBlock = `
    if (panels.length > 0 && React && ReactDOM) {
      var container = document.getElementById("${containerId}");
      if (!container) {
        container = document.createElement("div");
        container.id = "${containerId}";
        container.style.cssText = "${containerStyle}";
        document.body.appendChild(container);
      }

      var root = ReactDOM.createRoot(container);
      var Provider = ${providerExpr};
      root.render(React.createElement(Provider, null, ...panels));
      console.log("${logPrefix} Mounted " + panels.length + " panel plugin(s)");
    }`;

  return `
(async () => {
  try {
    if (${sentinelRead}) {
      console.log("${logPrefix} Already loaded, skipping injection");
      return;
    }
    ${sentinelWrite};
    console.log("${logPrefix} Injecting Loadout...");

    var React = globalThis.__VENDOR_REACT;
    var ReactDOM = globalThis.__VENDOR_REACT_DOM_CLIENT;
    console.log("${logPrefix} Using Steam React: " + !!React);
${reactBailBlock}

    var pluginsRes;
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", "${loaderUrl}/api/plugins?all=1", false);
      if ("${authHeader}") xhr.setRequestHeader("Authorization", "${authHeader}");
      xhr.send();
      pluginsRes = JSON.parse(xhr.responseText);
    } catch(e) {
      console.error("${logPrefix} Failed to fetch plugin list:", e);
      pluginsRes = [];
    }
    console.log("${logPrefix} Found " + pluginsRes.length + " plugin(s)");

    var sdk = globalThis.__LOADOUT_SDK || {};
    var panels = [];

    for (var i = 0; i < pluginsRes.length; i++) {${loopBody}
    }
${mountBlock}
  } catch (err) {
    console.error("${logPrefix} Injection failed:", err);
    ${sentinelDelete};
  }
})();
    `.trim();
}

export class SteamInjector {
  private debugPort: number;
  private loaderPort: number;
  private cefTimeout: number;
  private log: (msg: string) => void;
  private cdpFactory: ((wsUrl: string) => Promise<CDPClient>) | null;
  private cdp: CDPClient | null = null;
  private bpmCdp: CDPClient | null = null;
  private qamCdp: CDPClient | null = null;
  private running = false;
  private crashCount = 0;
  private lastCrashTime = 0;
  private devMode: boolean;
  private sessionToken: string;
  private injectBundles: InjectorOptions["injectBundles"];
  private gameSessionMonitor: GameSessionMonitor | null = null;
  private onGameLaunch?: InjectorOptions["onGameLaunch"];
  private onGameExit?: InjectorOptions["onGameExit"];
  private onGiveUp?: InjectorOptions["onGiveUp"];
  private isGameMode: () => boolean | Promise<boolean>;

  constructor(options: InjectorOptions = {}) {
    this.debugPort = options.debugPort ?? 8080;
    this.loaderPort = options.loaderPort ?? 33820;
    this.cefTimeout = options.cefTimeout ?? 0;
    this.devMode = options.devMode ?? false;
    this.sessionToken = options.sessionToken ?? "";
    this.injectBundles = options.injectBundles;
    this.onGameLaunch = options.onGameLaunch;
    this.onGameExit = options.onGameExit;
    this.onGiveUp = options.onGiveUp;
    this.log = options.log ?? console.log;
    this.cdpFactory = options.cdpFactory ?? null;
    this.isGameMode = options.isGameMode ?? isGamescopeRunning;
  }

  /**
   * Build the JavaScript snippet that gets injected into Steam's SharedJSContext.
   *
   * Target-aware injection:
   * - Plugins with target.type === "panel" (or no target) mount in a fixed overlay div
   * - Plugins with target.type === "qam" are loaded but NOT mounted in the overlay;
   *   they're picked up later by the QAM patcher
   * - All plugin bundles are always loaded so QAM/route patchers can access them
   */
  private buildInjectionScript(): string {
    // SharedJSContext mount. `import()` is mandatory here: Steam's CEF
    // origin (https://steamloopback.host) blocks fetch() to localhost
    // under mixed-content rules but lets dynamic import() through.
    // See `PanelMountScriptOptions.bundleLoader` for the BPM-side delta.
    return buildPanelMountScript({
      loaderUrl: `http://127.0.0.1:${this.loaderPort}`,
      authHeader: this.sessionToken ? `Bearer ${this.sessionToken}` : "",
      containerId: "loadout-root",
      containerStyle: PANEL_CONTAINER_STYLE,
      globalSentinel: GLOBAL_FLAG,
      logPrefix: "[loadout]",
      bundleLoader: "import",
      loadStrategy: "loadAll",
      bailOnMissingReact: false,
    });
  }

  /**
   * Start the injection loop. Connects to CEF, injects, and monitors
   * for page reloads to reinject.
   */
  /**
   * Fetch the session token from the loader's public /api/token endpoint.
   * Required for authenticating subsequent API calls.
   */
  private async acquireSessionToken(): Promise<void> {
    if (this.sessionToken) return;
    try {
      const res = await fetch(`http://localhost:${this.loaderPort}/api/token`);
      const data = await res.json() as { token: string };
      this.sessionToken = data.token;
      this.log("[injector] Acquired session token from loader");
    } catch (err) {
      this.log(`[injector] Failed to acquire session token: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Fetch from the loader API with session token auth. */
  private async fetchApi(path: string): Promise<Response> {
    return fetch(`http://localhost:${this.loaderPort}${path}`, {
      headers: this.sessionToken
        ? { Authorization: `Bearer ${this.sessionToken}` }
        : {},
    });
  }

  async start(): Promise<void> {
    this.running = true;
    this.log("[injector] Starting Loadout injector");
    this.log(`[injector] CEF debug port: ${this.debugPort}, loader port: ${this.loaderPort}`);

    // Acquire auth token before connecting to CEF
    await this.acquireSessionToken();

    while (this.running) {
      try {
        await this.connectAndInject();
      } catch (err) {
        if (!this.running) return;
        this.log(`[injector] Error: ${err instanceof Error ? err.message : err}`);
        this.handleCrash();

        if (maybeGiveUp(this.crashCount, this.onGiveUp, this.log)) {
          this.log("[injector] Too many crashes, stopping injector");
          this.running = false;
          return;
        }

        this.log("[injector] Retrying in 5 seconds...");
        await Bun.sleep(5000);
      }
    }
  }

  private async connectAndInject(): Promise<void> {
    // Step 1: Find the SharedJSContext tab (where the actual GamepadUI app lives)
    // The "Steam Big Picture Mode" tab is just an about:blank window frame —
    // webpackChunksteamui and the React DOM live in SharedJSContext.
    this.log("[injector] Looking for Steam SharedJSContext...");

    const tabOptions: GetTabsOptions = {
      debugPort: this.debugPort,
      timeout: this.cefTimeout || undefined,
      onRetry: (reason) => this.log(`[injector] ${reason}`),
    };

    let tab: CEFTab;
    while (this.running) {
      try {
        tab = await findSharedJSContext(tabOptions);
        break;
      } catch {
        if (!this.running) return;
        this.log("[injector] SharedJSContext not found, retrying in 5s...");
        await Bun.sleep(5000);
      }
    }

    if (!this.running) return;

    this.log(`[injector] Found SharedJSContext: "${tab!.title}" (${tab!.url})`);

    // Step 2: Connect via CDP WebSocket (direct or through multiplexer)
    if (this.cdpFactory) {
      this.cdp = await this.cdpFactory(tab!.webSocketDebuggerUrl);
      this.log("[injector] Connected to CDP via multiplexer");
    } else {
      this.cdp = new CDPClient(tab!.webSocketDebuggerUrl);
      await this.cdp.connect();
      this.log("[injector] Connected to CDP WebSocket");
    }

    // Step 3: Enable Page events for reload detection
    await this.cdp.send("Page.enable");

    // Plugin CEF injection is gated on Gaming Mode (issue #111): the
    // desktop Steam client must not get ProtonDB/HLTB badges, route/menu
    // patches or panels. We still connect to CEF and run the game-session
    // monitor below in desktop mode — only the plugin injection is skipped.
    const gameMode = await this.isGameMode();
    if (gameMode) {
      // Step 4: Inject if not already loaded
      const alreadyLoaded = await this.cdp.hasGlobalVar(GLOBAL_FLAG);
      if (!alreadyLoaded) {
        await this.inject();
      } else {
        this.log("[injector] Loadout already loaded in this context");
      }

      // Step 5: Wait for Steam to fully load, then connect to BPM tab.
      // SharedJSContext comes up first; BPM/QAM tabs appear later.
      for (let attempt = 0; attempt < 10 && this.running; attempt++) {
        await this.connectBPM();
        if (this.bpmCdp?.connected) break;
        this.log(`[injector] Waiting for BPM tab... (attempt ${attempt + 1}/10)`);
        await Bun.sleep(2000);
      }

      // Step 5.5: Inject inspector into BPM
      if (this.devMode) {
        await this.injectInspector();
      }

      // Step 6: Discover Steam's internal webpack components
      await this.discoverComponents();
    } else {
      this.log("[injector] Desktop mode (no gamescope) — skipping plugin injection");
    }

    // Step 7: Start game session monitor (forwards launch/exit events to TDP
    // backend). Runs in both modes — games can launch from the desktop client.
    await this.startGameSessionMonitor();

    // Step 8: Monitor for page events
    await this.monitor();
  }

  private async inject(): Promise<void> {
    this.log("[injector] Injecting Loadout frontend...");

    // Step 0: Inject webpack patcher FIRST (must intercept before modules load)
    await this.injectWebpackPatcher();

    if (this.injectBundles) {
      // Push bundles directly via CDP (avoids HTTP mixed-content blocks from steamloopback.host)
      await this.injectViaCDP();
    } else {
      // Fallback: try loading over HTTP (works in dev mode / non-steamloopback contexts)
      const script = this.buildInjectionScript();
      await this.cdp!.evaluate(script, { awaitPromise: true });
    }
    this.log("[injector] Injection sent");
  }

  /**
   * Inject vendor, SDK, and plugin bundles directly via CDP evaluate.
   * This bypasses HTTP mixed-content restrictions that block fetch/import
   * from steamloopback.host to localhost.
   */
  private async injectViaCDP(): Promise<void> {
    const bundles = this.injectBundles!;

    // Step 1: Discover Steam's React/ReactDOM from webpack and alias __VENDOR_* globals.
    // This MUST run before any plugin bundles, because plugin bundles reference
    // __VENDOR_REACT for their hooks/createElement. Two React instances = crash.
    await this.cdp!.evaluate(DISCOVER_STEAM_REACT);
    this.log("[injector] Steam React discovered and aliased");

    // Step 2: SDK bundle (@loadout/ui) — sets __LOADOUT_SDK global
    // NOTE: Skipped for now — the SDK is compiled with its own React JSX runtime
    // references which conflict with Steam's React. CEF-only plugins should use
    // Steam's components directly. The SDK is still useful for overlay plugins.
    // if (bundles.sdk) {
    //   await this.cdp!.evaluate(bundles.sdk);
    //   this.log("[injector] SDK bundle injected via CDP");
    // }

    // Step 3: Plugin bundles — sets __LOADOUT_PLUGIN_{id} globals
    for (const [pluginId, code] of bundles.plugins) {
      try {
        await this.cdp!.evaluate(code);
        this.log(`[injector] Plugin bundle injected: ${pluginId}`);
      } catch (err) {
        this.log(`[injector] Failed to inject plugin ${pluginId}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Step 4: Set the loaded flag
    await this.cdp!.evaluate(`window.loadoutHasLoaded = true;`);
  }

  /**
   * Fetch plugin patches and inject the webpack module interceptor.
   * Must run before any other scripts so it can intercept module loading.
   */
  private async injectWebpackPatcher(): Promise<void> {
    try {
      const res = await this.fetchApi("/api/plugins?all=1");
      const plugins = await res.json() as Array<{
        id: string;
        patches?: Array<{ find: string | string[]; replacement: unknown; optional?: boolean }>;
      }>;

      const patchEntries: WebpackPatchEntry[] = [];
      for (const plugin of plugins) {
        if (plugin.patches) {
          for (const patch of plugin.patches) {
            patchEntries.push({ pluginId: plugin.id, patch: patch as WebpackPatchEntry["patch"] });
          }
        }
      }

      if (patchEntries.length > 0) {
        this.log(`[injector] Injecting webpack patcher with ${patchEntries.length} patch(es)...`);
      }

      const script = buildWebpackPatcherScript(patchEntries);
      await this.cdp!.evaluate(script, { awaitPromise: true });

      if (patchEntries.length > 0) {
        this.log("[injector] Webpack patcher installed");
      }
    } catch (err) {
      this.log(`[injector] Webpack patcher injection failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }


  /**
   * Inject the element inspector into the BPM tab (visible UI).
   * Must be called after connectBPM().
   */
  private async injectInspector(): Promise<void> {
    try {
      if (this.bpmCdp?.connected) {
        const inspectorScript = buildInspectorScript();
        await this.bpmCdp.evaluate(inspectorScript, { awaitPromise: true });
        this.log("[injector] Element inspector injected into BPM (F12 to toggle)");
      } else {
        this.log("[injector] Skipping inspector — no BPM connection yet");
      }
    } catch (err) {
      this.log(`[injector] Element inspector failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Connect to the Big Picture Mode tab and mount panel-type plugins there.
   * The BPM tab is the visible UI — SharedJSContext is invisible.
   * Bundles are loaded in SharedJSContext (webpack), but visible panels
   * need to be mounted in the BPM tab's DOM.
   */
  private async connectBPM(): Promise<void> {
    try {
      const tabOptions: GetTabsOptions = {
        debugPort: this.debugPort,
        timeout: 5000,
      };
      const bpmTab = await findBigPictureTab(tabOptions);
      this.bpmCdp = new CDPClient(bpmTab.webSocketDebuggerUrl);
      await this.bpmCdp.connect();
      this.log(`[injector] Connected to Big Picture Mode tab`);

      // Mount panel plugins in the visible BPM tab
      await this.mountPanelsInBPM();
    } catch (err) {
      this.log(`[injector] BPM connection failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Set up the BPM tab: discover Steam React, inject plugin bundles,
   * and mount panel-type plugins into a visible overlay div.
   */
  private async mountPanelsInBPM(): Promise<void> {
    if (!this.bpmCdp?.connected) return;

    // Step 1: Discover Steam's React in the BPM tab
    await this.bpmCdp.evaluate(DISCOVER_STEAM_REACT);

    // Step 2: Inject plugin bundles into BPM (they need to be available for panel mounting)
    if (this.injectBundles) {
      await injectBPMBundles(this.bpmCdp, this.injectBundles.plugins);
    }

    // Step 3: Mount panel plugins using Steam's React (no vendor bundle
    // needed). Audit A-008 collapsed this and the SharedJSContext-side
    // copy into one helper — see `buildPanelMountScript` for the
    // (bundleLoader, loadStrategy, bailOnMissingReact) deltas.
    const script = buildPanelMountScript({
      loaderUrl: `http://localhost:${this.loaderPort}`,
      authHeader: this.sessionToken ? `Bearer ${this.sessionToken}` : "",
      containerId: "loadout-root",
      containerStyle: PANEL_CONTAINER_STYLE,
      globalSentinel: "__loadoutPanelsMounted",
      logPrefix: "[loadout:bpm]",
      bundleLoader: "scriptTag",
      loadStrategy: "loadOnlyPanel",
      bailOnMissingReact: true,
    });

    await this.bpmCdp.evaluate(script, { awaitPromise: true });
    this.log("[injector] Panel plugins mounted in BPM tab");
  }

  private async discoverComponents(): Promise<void> {
    try {
      this.log("[injector] Running Steam component discovery...");
      // Clear previous discovery flag to force re-discovery (code may have changed)
      await this.cdp!.evaluate("delete window.__steamComponentsDiscovered");
      const script = buildComponentDiscoveryScript(this.loaderPort);
      await this.cdp!.evaluate(script, { awaitPromise: true });
      this.log("[injector] Steam component discovery complete");
    } catch (err) {
      this.log(`[injector] Component discovery failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }

    // After discovery, apply QAM and route patches for target-aware plugins
    await this.applyTargetPatches();
  }

  /**
   * Subscribe to SteamClient.GameSessions via the CEF bridge.
   * Game launch/exit events are forwarded to the TDP backend via RPC
   * (from inside the injected JS) and also fire local callbacks for logging.
   */
  private async startGameSessionMonitor(): Promise<void> {
    if (!this.cdp?.connected) return;

    // Clean up any previous monitor from a prior connection cycle
    if (this.gameSessionMonitor) {
      await this.gameSessionMonitor.cleanup().catch(() => {});
      this.gameSessionMonitor = null;
    }

    try {
      this.gameSessionMonitor = await createGameSessionMonitor(this.cdp, {
        loaderPort: this.loaderPort,
        sessionToken: this.sessionToken,
        log: this.log,
        onGameLaunch: (appId, gameName) => {
          this.log(`[injector] Game launched: ${gameName} (appId=${appId})`);
          if (this.onGameLaunch) {
            Promise.resolve(this.onGameLaunch(appId, gameName)).catch((err) => {
              this.log(`[injector] onGameLaunch hook failed: ${err}`);
            });
          }
        },
        onGameExit: (appId, gameName) => {
          this.log(`[injector] Game exited: ${gameName} (appId=${appId})`);
          if (this.onGameExit) {
            Promise.resolve(this.onGameExit(appId, gameName)).catch((err) => {
              this.log(`[injector] onGameExit hook failed: ${err}`);
            });
          }
        },
      });
      this.log("[injector] Game session monitor active");
    } catch (err) {
      this.log(`[injector] Game session monitor failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Fetch the plugin list and apply QAM tab injection + route patching
   * for plugins that declare targets or routes.
   */
  private async applyTargetPatches(): Promise<void> {
    type PluginTargetInfo = {
      type: string;
      export?: string;
      title?: string;
      position?: number | string;
      overlayPosition?: { top?: string; bottom?: string; left?: string; right?: string };
      overlaySize?: { width?: string; height?: string };
      transparent?: boolean;
      route?: string;
      icon?: string;
    };

    try {
      const res = await this.fetchApi("/api/plugins?all=1");
      const plugins = await res.json() as Array<{
        id: string;
        name: string;
        target?: PluginTargetInfo | PluginTargetInfo[];
        routes?: Record<string, string>;
        styles?: Record<string, string>;
      }>;

      // Helper: normalize target to array
      const getTargets = (target?: PluginTargetInfo | PluginTargetInfo[]): PluginTargetInfo[] => {
        if (!target) return [];
        return Array.isArray(target) ? target : [target];
      };

      // Collect main menu plugins
      const menuPlugins: MenuPluginEntry[] = [];
      for (const plugin of plugins) {
        for (const t of getTargets(plugin.target)) {
          if (t.type === "menu") {
            menuPlugins.push({
              pluginId: plugin.id,
              title: t.title ?? plugin.name,
              route: t.route ?? (plugin.routes ? Object.keys(plugin.routes)[0] : ""),
              position: typeof t.position === "number" ? t.position : undefined,
              icon: t.icon,
            });
          }
        }
      }

      // Inject CSS for css-target plugins
      for (const plugin of plugins) {
        for (const t of getTargets(plugin.target)) {
          if (t.type === "css" && plugin.styles) {
            await this.injectPluginCSS(plugin.id, plugin.styles as Record<string, string>);
          }
        }
      }

      // Collect overlay targets (flatten from multi-target plugins)
      type OverlayInfo = { id: string; name: string; target: PluginTargetInfo };
      const overlayPlugins: OverlayInfo[] = [];
      for (const plugin of plugins) {
        for (const t of getTargets(plugin.target)) {
          if (t.type === "overlay") {
            overlayPlugins.push({ id: plugin.id, name: plugin.name, target: t });
          }
        }
      }
      await this.mountOverlayPlugins(overlayPlugins);

      // Collect routes from all plugins
      const routes: RouteEntry[] = [];
      for (const plugin of plugins) {
        if (plugin.routes) {
          for (const [path, exportName] of Object.entries(plugin.routes)) {
            routes.push({ path, pluginId: plugin.id, exportName });
          }
        }
      }

      // QAM patching disabled — no plugins currently use it usefully.
      // TODO: Re-enable when plugins need QAM tabs.

      // Apply route patches in SharedJSContext
      if (routes.length > 0) {
        this.log(`[injector] Patching router with ${routes.length} route(s)...`);
        const routeScript = buildRoutePatchScript(routes);
        await this.cdp!.evaluate(routeScript, { awaitPromise: true });
        this.log("[injector] Route patch applied");
      }

      // Apply main menu patches in SharedJSContext (where #root and the full React tree live)
      if (menuPlugins.length > 0) {
        this.log(`[injector] Patching main menu with ${menuPlugins.length} item(s)...`);
        const menuScript = buildMenuPatchScript(menuPlugins);
        await this.cdp!.evaluate(menuScript, { awaitPromise: true });
        this.log("[injector] Main menu patch applied");
      }

    } catch (err) {
      this.log(`[injector] Target patches failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Inject CSS files for css-target plugins into the appropriate CEF tabs.
   *
   * Fetches CSS content server-side and injects it as an inline <style> tag
   * via CDP Runtime.evaluate. This avoids mixed-content blocks — Steam's CEF
   * origin (https://steamloopback.host) refuses <link> tags pointing to
   * http://localhost.
   */
  private async injectPluginCSS(
    pluginId: string,
    styles: Record<string, string>,
  ): Promise<void> {
    for (const [filename, targetContext] of Object.entries(styles)) {
      try {
        // Fetch the CSS content server-side (injector runs in the loader process,
        // so localhost fetch works fine — it's the browser that blocks mixed content)
        const res = await this.fetchApi(`/plugins/${pluginId}/styles/${filename}`);
        if (!res.ok) {
          this.log(`[injector] CSS fetch failed for ${pluginId}/${filename}: HTTP ${res.status}`);
          continue;
        }
        const cssContent = await res.text();

        // Escape for embedding in a JS template literal
        const escapedCSS = cssContent
          .replace(/\\/g, "\\\\")
          .replace(/`/g, "\\`")
          .replace(/\$/g, "\\$");

        const styleId = `loadout-css-${pluginId}-${filename.replace(/[^a-zA-Z0-9-_]/g, "_")}`;
        const script = `
(function() {
  var existing = document.getElementById("${styleId}");
  if (existing) existing.remove();

  var style = document.createElement("style");
  style.id = "${styleId}";
  style.dataset.loadoutPlugin = "${pluginId}";
  style.dataset.loadoutStyle = "${filename}";
  style.textContent = \`${escapedCSS}\`;
  document.head.appendChild(style);
  console.log("[loadout:css] Injected ${filename} for ${pluginId} (inline)");
})();
        `.trim();

        if (targetContext === "SharedJSContext" && this.cdp?.connected) {
          await this.cdp.evaluate(script, { awaitPromise: true });
        } else if (targetContext === "QuickAccess" && this.qamCdp?.connected) {
          await this.qamCdp.evaluate(script, { awaitPromise: true });
        } else if (targetContext === "BigPictureMode" && this.bpmCdp?.connected) {
          await this.bpmCdp.evaluate(script, { awaitPromise: true });
        }
        this.log(`[injector] CSS injected: ${pluginId}/${filename} → ${targetContext}`);
      } catch (err) {
        this.log(`[injector] CSS injection failed for ${pluginId}/${filename}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Mount overlay-target plugins in the BPM tab with custom positioning.
   */
  private async mountOverlayPlugins(
    overlayPlugins: Array<{
      id: string;
      name: string;
      target: {
        type: string;
        export?: string;
        overlayPosition?: { top?: string; bottom?: string; left?: string; right?: string };
        overlaySize?: { width?: string; height?: string };
        transparent?: boolean;
      };
    }>,
  ): Promise<void> {
    if (!this.bpmCdp?.connected) return;
    if (overlayPlugins.length === 0) return;

    for (const plugin of overlayPlugins) {
      const pos = plugin.target.overlayPosition ?? {};
      const size = plugin.target.overlaySize ?? {};
      const transparent = plugin.target.transparent ?? false;
      const exportName = plugin.target.export;

      const posStyle = [
        pos.top ? `top:${pos.top}` : "",
        pos.bottom ? `bottom:${pos.bottom}` : "",
        pos.left ? `left:${pos.left}` : "",
        pos.right ? `right:${pos.right}` : "",
        size.width ? `width:${size.width}` : "",
        size.height ? `height:${size.height}` : "",
      ]
        .filter(Boolean)
        .join(";");

      const script = `
(async function() {
  try {
    var containerId = "loadout-overlay-${plugin.id}";
    if (document.getElementById(containerId)) return;

    // React/ReactDOM already available via DISCOVER_STEAM_REACT
    // Plugin bundles already injected via CDP in mountPanelsInBPM
    var globalKey = "__LOADOUT_PLUGIN_${plugin.id}";
    if (!window[globalKey]) {
      console.warn("[loadout:overlay] Plugin ${plugin.id} bundle not loaded");
      return;
    }

    var mod = window[globalKey] || {};
    var Panel = ${exportName ? `mod["${exportName}"]` : "mod.default || mod.Panel"};
    if (!Panel) return;

    var container = document.createElement("div");
    container.id = containerId;
    container.style.cssText = "position:fixed;z-index:999998;pointer-events:none;${posStyle}";
    ${transparent ? "" : 'container.style.background = "rgba(30,30,30,0.9)"; container.style.borderRadius = "8px";'}

    // Inner div for pointer events
    var inner = document.createElement("div");
    inner.style.pointerEvents = "auto";
    container.appendChild(inner);
    document.body.appendChild(container);

    var React = window.__VENDOR_REACT;
    var ReactDOM = window.__VENDOR_REACT_DOM_CLIENT;
    if (!React || !ReactDOM) { console.warn("[loadout:overlay] React not available"); return; }
    var root = ReactDOM.createRoot(inner);
    root.render(React.createElement(Panel));
    console.log("[loadout:overlay] Mounted overlay: ${plugin.name}");
  } catch (err) {
    console.error("[loadout:overlay] Failed to mount ${plugin.id}:", err);
  }
})();
      `.trim();

      try {
        await this.bpmCdp.evaluate(script, { awaitPromise: true });
        this.log(`[injector] Overlay plugin mounted: ${plugin.name}`);
      } catch (err) {
        this.log(`[injector] Overlay mount failed for ${plugin.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async monitor(): Promise<void> {
    if (!this.cdp) return;

    return new Promise<void>((resolve) => {
      // Re-inject on page reload
      const unsubDom = this.cdp!.on("Page.domContentEventFired", async () => {
        this.log("[injector] Page reloaded, checking if re-injection needed...");
        try {
          // Re-injection is gated on Gaming Mode too (issue #111) — a reload
          // in the desktop client must not re-add plugin injection. The game
          // session monitor is re-armed in both modes.
          const gameMode = await this.isGameMode();
          const loaded = await this.cdp!.hasGlobalVar(GLOBAL_FLAG);
          if (gameMode && !loaded) {
            await this.inject();
            await this.connectBPM();
            await this.discoverComponents();
          }
          await this.startGameSessionMonitor();
        } catch (err) {
          this.log(`[injector] Re-injection check failed: ${err}`);
        }
      });

      // Handle detach (Steam restart, etc.)
      const unsubDetach = this.cdp!.on("Inspector.detached", () => {
        this.log("[injector] CEF requested detach (Steam may be restarting)");
        cleanup();
        resolve();
      });

      // Handle WebSocket close
      const checkInterval = setInterval(() => {
        if (!this.cdp?.connected) {
          this.log("[injector] CDP connection lost");
          cleanup();
          resolve();
        }
      }, 2000);

      const cleanup = () => {
        unsubDom();
        unsubDetach();
        clearInterval(checkInterval);
        this.gameSessionMonitor?.cleanup().catch(() => {});
        this.gameSessionMonitor = null;
        this.cdp?.close();
        this.cdp = null;
        this.bpmCdp?.close();
        this.bpmCdp = null;
        this.qamCdp?.close();
        this.qamCdp = null;
      };
    });
  }

  private handleCrash(): void {
    const now = Date.now();
    if (now - this.lastCrashTime < 60_000) {
      this.crashCount++;
      this.log(`[injector] Crash within 1 minute of last crash (count: ${this.crashCount})`);
    } else {
      this.crashCount = 0;
    }
    this.lastCrashTime = now;
  }

  /**
   * Clear injected state and re-inject. Called on file changes for hot reload.
   */
  async reinject(): Promise<void> {
    if (!this.cdp?.connected) {
      this.log("[injector] Cannot reinject — no CDP connection");
      return;
    }

    // Hot reload must respect the Gaming Mode gate (issue #111) — don't
    // re-inject plugins into the desktop client on a file change.
    if (!(await this.isGameMode())) {
      this.log("[injector] Hot reload skipped — desktop mode (no gamescope)");
      return;
    }

    this.log("[injector] Hot reload — clearing and re-injecting...");

    // Clean up game session monitor before clearing context
    if (this.gameSessionMonitor) {
      await this.gameSessionMonitor.cleanup().catch(() => {});
      this.gameSessionMonitor = null;
    }

    // Clear SharedJSContext state
    await this.cdp.evaluate(`
      delete window.${GLOBAL_FLAG};
      delete globalThis.__LOADOUT_SDK;
      delete window.__LOADOUT_DEVTOOLS_BRIDGE;
      delete window.__LOADOUT_INSPECTOR;
      delete window.__LOADOUT_WEBPACK_PATCHER;
      document.querySelectorAll("[data-loadout]").forEach(s => s.remove());
      var inspectorEls = document.querySelectorAll("[id^='loadout-inspector']");
      inspectorEls.forEach(function(el) { el.remove(); });
      document.getElementById("loadout-root")?.remove();
      document.getElementById("loadout-route-overlay")?.remove();

      // Run route unpatch functions
      if (globalThis.__LOADOUT_ROUTE_UNPATCHERS) {
        globalThis.__LOADOUT_ROUTE_UNPATCHERS.forEach(function(fn) { try { fn(); } catch(e) {} });
        delete globalThis.__LOADOUT_ROUTE_UNPATCHERS;
      }

      // Clear plugin globals so bundles are reloaded fresh
      Object.keys(globalThis).forEach(function(k) {
        if (k.startsWith("__LOADOUT_PLUGIN_")) delete globalThis[k];
      });
    `);

    // Clear QAM state in QuickAccess tab
    if (this.qamCdp?.connected) {
      await this.qamCdp.evaluate(`
        if (window.__LOADOUT_QAM_CLEANUP) {
          try { window.__LOADOUT_QAM_CLEANUP(); } catch(e) {}
          delete window.__LOADOUT_QAM_CLEANUP;
        }
      `).catch(() => {});
      this.qamCdp.close();
      this.qamCdp = null;
    }

    // Clear BPM tab state
    if (this.bpmCdp?.connected) {
      await this.bpmCdp.evaluate(`
        delete window.__loadoutPanelsMounted;
        delete window.__LOADOUT_SDK;
        document.getElementById("loadout-root")?.remove();
      `).catch(() => {});
      this.bpmCdp.close();
      this.bpmCdp = null;
    }

    await this.inject();
    await this.connectBPM();
    await this.applyTargetPatches();
    await this.startGameSessionMonitor();
  }

  stop(): void {
    this.running = false;
    this.gameSessionMonitor?.cleanup().catch(() => {});
    this.gameSessionMonitor = null;
    this.cdp?.close();
    this.cdp = null;
    this.bpmCdp?.close();
    this.bpmCdp = null;
    this.qamCdp?.close();
    this.qamCdp = null;
    this.log("[injector] Stopped");
  }
}
