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
import {
  buildOverlayMenuInjectScript,
  buildOverlayMenuRemoveScript,
  OVERLAY_MENU_BINDING,
} from "./overlay-menu";
import { buildRoutePatchScript, type RouteEntry } from "./route-patcher";
import { buildWebpackPatcherScript, type WebpackPatchEntry } from "./webpack-patcher";
import { buildInspectorScript } from "./inspector";
import { DISCOVER_STEAM_REACT } from "./steam-react";
import { createGameSessionMonitor, type GameSessionMonitor } from "./game-session-monitor";
import { isGamescopeRunning } from "@loadout/steam-paths";

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
  /**
   * In-process launch/exit hooks. Steam's CEF blocks fetch() to localhost
   * (mixed content), so the injected JS-side rpcCall to /api/rpc is
   * unreliable; the binding callback runs in the loader process and is
   * the authoritative dispatch path.
   */
  onGameLaunch?: (appId: number, gameName: string) => void | Promise<void>;
  onGameExit?: (appId: number, gameName: string) => void | Promise<void>;
  /**
   * Fired when the injected Steam-menu overlay entry is activated
   * (issue #169). The loader wires this to `broadcastShow()` so the
   * overlay window pops. Dispatched from a CDP `Runtime.addBinding`
   * callback because Steam's CEF blocks fetch() to localhost.
   */
  onOverlayOpen?: () => void;
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
 * Resolve whether the main-menu "Loadout" entry should be present from a
 * raw user-config object (issue #169). The new `steamOverlayButtonMainMenu`
 * key wins once it exists — so toggling it *off* removes the item even for
 * a config that still carries the legacy `steamOverlayButtonEnabled` flag
 * (used by the first build of this feature, pre key-rename). The legacy key
 * is honoured only as a fallback when the new key was never written.
 *
 * Pure + exported so the back-compat precedence is unit-testable without a
 * live CEF connection.
 */
export function resolveOverlayMainMenu(cfg: Record<string, unknown>): boolean {
  const hasNew = Object.prototype.hasOwnProperty.call(
    cfg,
    "steamOverlayButtonMainMenu",
  );
  return hasNew
    ? cfg.steamOverlayButtonMainMenu === true
    : cfg.steamOverlayButtonEnabled === true;
}

/*
 * The plugin-bundle / panel-mount machinery (injectBPMBundles,
 * PANEL_CONTAINER_STYLE, PanelMountScriptOptions, buildPanelMountScript,
 * mountPanelsInBPM, mountOverlayPlugins) was removed as dead code — issue
 * #60. No plugin ships a panel.tsx, so the __LOADOUT_PLUGIN_* bundle map
 * was always empty and every consumer of it was unreachable. The live
 * bootstrap (DISCOVER_STEAM_REACT + webpack/route/menu patches + CSS
 * injection) is unaffected.
 */

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
  private gameSessionMonitor: GameSessionMonitor | null = null;
  private onGameLaunch?: InjectorOptions["onGameLaunch"];
  private onGameExit?: InjectorOptions["onGameExit"];
  private onGiveUp?: InjectorOptions["onGiveUp"];
  private onOverlayOpen?: InjectorOptions["onOverlayOpen"];
  /** Unsubscribe for the overlay-open CDP binding (issue #169). */
  private overlayBindingUnsub: (() => void) | null = null;
  private isGameMode: () => boolean | Promise<boolean>;

  constructor(options: InjectorOptions = {}) {
    this.debugPort = options.debugPort ?? 8080;
    this.loaderPort = options.loaderPort ?? 33820;
    this.cefTimeout = options.cefTimeout ?? 0;
    this.devMode = options.devMode ?? false;
    this.sessionToken = options.sessionToken ?? "";
    this.onGameLaunch = options.onGameLaunch;
    this.onGameExit = options.onGameExit;
    this.onGiveUp = options.onGiveUp;
    this.onOverlayOpen = options.onOverlayOpen;
    this.log = options.log ?? console.log;
    this.cdpFactory = options.cdpFactory ?? null;
    this.isGameMode = options.isGameMode ?? isGamescopeRunning;
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
      // Step 3.5: Arm the overlay-open binding (issue #169) so the injected
      // Steam-menu entry has a callback to hit the moment it's clicked.
      await this.setupOverlayBinding();

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

    // Bootstrap via CDP (avoids HTTP mixed-content blocks from
    // steamloopback.host). The old HTTP-fallback branch only built the
    // panel-mount script, which was removed as dead code — issue #60.
    await this.injectViaCDP();
    this.log("[injector] Injection sent");
  }

  /**
   * Bootstrap the SharedJSContext via CDP evaluate: discover Steam's
   * React/ReactDOM and set the loaded flag. This bypasses HTTP
   * mixed-content restrictions that block fetch/import from
   * steamloopback.host to localhost.
   *
   * The plugin-bundle eval loop (setting __LOADOUT_PLUGIN_* globals) was
   * removed as dead code — issue #60: the bundle map was always empty.
   */
  private async injectViaCDP(): Promise<void> {
    // Step 1: Discover Steam's React/ReactDOM from webpack and alias __VENDOR_* globals.
    // This MUST run before anything that references __VENDOR_REACT for its
    // hooks/createElement. Two React instances = crash.
    await this.cdp!.evaluate(DISCOVER_STEAM_REACT);
    this.log("[injector] Steam React discovered and aliased");

    // Step 2: Set the loaded flag
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
   * Connect to the Big Picture Mode tab. The BPM tab is the visible UI —
   * SharedJSContext is invisible. We keep `bpmCdp` connected so
   * `injectPluginCSS` can target BigPictureMode-context styles.
   *
   * The panel-mount step (mountPanelsInBPM) was removed as dead code —
   * issue #60: no plugin ships a panel.tsx, so there was nothing to mount.
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
    } catch (err) {
      this.log(`[injector] BPM connection failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
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
   * Add the `Runtime.addBinding` the injected overlay-menu entry calls
   * (issue #169), and fan its invocations out to `onOverlayOpen`. Runs on
   * `this.cdp` (SharedJSContext) where the menu patch + watcher live.
   * Idempotent — re-adding an existing binding is a non-fatal no-op.
   */
  private async setupOverlayBinding(): Promise<void> {
    const cdp = this.cdp;
    if (!cdp?.connected) return;

    // Attach the client-side listener exactly once — *synchronously*, before
    // any await, so two concurrent callers (launch-time setup racing a
    // Settings-toggle refresh) can't both pass the guard and double-add it,
    // which would fire onOverlayOpen twice per activation. The listener
    // survives page reloads (it lives on the CDP client, not the page).
    if (!this.overlayBindingUnsub) {
      this.overlayBindingUnsub = cdp.on(
        "Runtime.bindingCalled",
        (params: Record<string, unknown>) => {
          if (params.name !== OVERLAY_MENU_BINDING) return;
          this.log("[injector] Overlay-menu entry activated");
          try {
            this.onOverlayOpen?.();
          } catch (err) {
            this.log(`[injector] onOverlayOpen hook threw: ${err instanceof Error ? err.message : err}`);
          }
        },
      );
    }

    try {
      await cdp.send("Runtime.enable");
    } catch {
      // May already be enabled — non-fatal.
    }
    // Always (re)add the binding itself: CDP drops bindings on page
    // navigation, so this must run again after a reload even though the
    // listener above is attached only once.
    try {
      await cdp.send("Runtime.addBinding", { name: OVERLAY_MENU_BINDING });
    } catch {
      // Binding may already exist from a prior session — non-fatal.
    }
  }

  /**
   * Read the overlay-button user settings from the loader's config
   * (issue #169). Server-side fetch — the injector runs in the loader
   * process, so localhost is reachable here even though Steam's CEF
   * blocks it. Missing / malformed config reads as "disabled".
   *
   * `steamOverlayButtonMainMenu` gates the main-menu "Loadout" entry;
   * the legacy `steamOverlayButtonEnabled` key (pre-#169-split) is
   * honoured as an alias so an existing opt-in isn't silently dropped.
   */
  private async readOverlayButtonConfig(): Promise<boolean | null> {
    try {
      const res = await this.fetchApi("/api/user-config");
      if (!res.ok) return null;
      const cfg = (await res.json()) as Record<string, unknown>;
      return resolveOverlayMainMenu(cfg);
    } catch {
      // Distinguish "couldn't read" (null) from "read: disabled" (false) so
      // callers don't tear down an enabled item on a transient blip.
      return null;
    }
  }

  /**
   * (Re)apply the main-menu "Loadout" entry (issue #169). Injects when
   * enabled, tears down when disabled. Returns a `{ ok, error }` result so
   * the loader's refresh endpoint can surface a failure toast in the
   * overlay.
   *
   * `opts.mainMenu` carries the *explicit* desired state from the Settings
   * toggle so we act on it directly instead of re-reading `/api/user-config`
   * — the config PATCH the toggle fires is async and could otherwise race
   * this read. Omit it (launch / reinject) to fall back to the persisted
   * config; a read failure there is surfaced as `ok: false` rather than
   * silently removing an enabled item.
   */
  async refreshOverlayButton(
    opts: { mainMenu?: boolean } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.cdp?.connected) {
      return { ok: false, error: "Not connected to Steam — is Steam running?" };
    }
    if (!(await this.isGameMode())) {
      return { ok: false, error: "The Steam overlay button is only available in Gaming Mode." };
    }

    let mainMenu: boolean;
    if (typeof opts.mainMenu === "boolean") {
      mainMenu = opts.mainMenu;
    } else {
      const read = await this.readOverlayButtonConfig();
      if (read === null) {
        return { ok: false, error: "Couldn't read Loadout settings." };
      }
      mainMenu = read;
    }

    try {
      // Make sure the binding is live before the entry can be activated.
      await this.setupOverlayBinding();
      if (mainMenu) {
        await this.cdp.evaluate(buildOverlayMenuInjectScript(), { awaitPromise: false });
        this.log("[injector] Main-menu 'Loadout' entry injected");
      } else {
        await this.cdp.evaluate(buildOverlayMenuRemoveScript(), { awaitPromise: false });
        this.log("[injector] Main-menu 'Loadout' entry removed (disabled)");
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[injector] Overlay-menu refresh failed: ${msg}`);
      return { ok: false, error: `Failed to update Steam: ${msg}` };
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

      // The overlay-target collection + mountOverlayPlugins call was
      // removed as dead code — issue #60: it depended on the never-set
      // __LOADOUT_PLUGIN_* bundles, so overlays never mounted.

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

      // Apply the optional "open overlay" menu entry (issue #169). Reads
      // the toggle from user config; injects or removes accordingly.
      await this.refreshOverlayButton();

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

  // mountOverlayPlugins() was removed as dead code — issue #60. It mounted
  // overlay-target plugins from the __LOADOUT_PLUGIN_* globals, which were
  // never populated (no plugin ships a panel.tsx), so it always bailed.

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
        this.overlayBindingUnsub?.();
        this.overlayBindingUnsub = null;
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
    this.overlayBindingUnsub?.();
    this.overlayBindingUnsub = null;
    this.cdp?.close();
    this.cdp = null;
    this.bpmCdp?.close();
    this.bpmCdp = null;
    this.qamCdp?.close();
    this.qamCdp = null;
    this.log("[injector] Stopped");
  }
}
