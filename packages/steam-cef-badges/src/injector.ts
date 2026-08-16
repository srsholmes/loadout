/**
 * @loadout/steam-cef-badges — shared Steam-CEF badge-injection lifecycle.
 *
 * The ProtonDB and HLTB plugins both inject a small badge runtime into Steam's
 * CEF (Big Picture Mode game pages + store.steampowered.com tabs) over the CDP
 * debug port. The connection / discovery / health-check / route-polling /
 * push-coalescing machinery was byte-for-byte duplicated between them; this
 * class is the single source of truth, parameterised on the plugin-specific
 * bits (CSS, scripts, data fetch, global names) via {@link SteamCefBadgeInjectorConfig}.
 *
 * Gaming-Mode gated (issue #111): in the desktop Steam client we open NO CDP
 * connection and inject nothing — badges only make sense in Gaming Mode (BPM /
 * gamescope). The gate is re-checked at runtime via `isGamescopeRunning` from
 * @loadout/steam-paths, so a mode switch is picked up without a reload.
 */

import { CDPClient } from "@loadout/steam-cdp";
import { isGamescopeRunning } from "@loadout/steam-paths";

/** A CEF debug target as returned by Steam's `localhost:<port>/json`. */
export interface CefTab {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

interface CDPConnection {
  client: CDPClient;
  tabTitle: string;
}

export interface SteamCefBadgeInjectorConfig<TBadgeData> {
  /** Plugin id — used for the `<style data-loadout-plugin>` marker + log prefix. */
  pluginId: string;
  /** DOM id of the injected `<style>` element, e.g. "protondb-badges-styles". */
  styleId: string;
  /** BPM runtime global name, e.g. "__protondb_badges" / "__hltb_badges". */
  bpmGlobalName: string;
  /** Store runtime global name, e.g. "__protondb_store_badges". */
  storeGlobalName: string;

  /** Full CSS string injected into every tab (BPM + store). Static. */
  css: string;
  /**
   * CSS selector for the plugin's badge root(s) in the BPM document, e.g.
   * `"#protondb-badge-container"`. When set, the injector appends a rule
   * hiding it while the window is obscured — the Steam menu and Quick
   * Access menu are separate windows drawn over ours, so the badge has to
   * hide itself rather than sit behind them. Omit to opt out.
   */
  obscuredHideSelector?: string;
  /**
   * Passive BPM renderer IIFE source. Must define
   * `window[bpmGlobalName] = { cleanup, ... }`. The plugin owns the exact
   * surface; the helper only evaluates the string.
   */
  bpmScript: string;
  /** Build the store-page IIFE with data embedded at inject time. */
  buildStoreScript: (badgeData: TBadgeData | null) => string;

  /**
   * Fetch the plugin's badge payload for an appId. Called server-side (the
   * loader process, not CEF) so it sidesteps the steamloopback.host
   * mixed-content block. Return `null` when there's nothing to show.
   */
  fetchBadgeData: (appId: string) => Promise<TBadgeData | null>;

  /**
   * Build the JS expression pushed into a BPM tab on a route change.
   * `data === null` ⇒ "navigated off a game page" — the plugin decides
   * whether that means a remove call or an update(null).
   */
  buildBpmUpdateExpr: (data: TBadgeData | null) => string;

  /** Notified whenever `{connected, tabs, detail}` changes so the plugin can
   *  emit. `detail` mirrors `getStatus().detail` — the reason badges aren't
   *  showing, or `undefined` once they can. */
  onStateChange?: (state: {
    connected: boolean;
    tabs: number;
    detail?: string;
  }) => void;

  log?: (msg: string, ...args: unknown[]) => void;
  warn?: (msg: string, ...args: unknown[]) => void;

  /**
   * Gaming-Mode predicate seam — injectable for tests. Defaults to
   * `isGamescopeRunning`; always `await`ed (mirrors the loader's SteamInjector).
   */
  isGameMode?: () => boolean | Promise<boolean>;

  debugPort?: number;
  cdpTimeoutMs?: number;
  healthIntervalMs?: number;
  pollIntervalMs?: number;
  injectDebounceMs?: number;
}

/** Steam's SharedJSContext goes by several titles across builds. */
const SHARED_JS_NAMES = [
  "SharedJSContext",
  "Steam Shared Context presented by Valve™",
  "SP",
  "Steam",
];
const BIG_PICTURE_TITLE = "Steam Big Picture Mode";
/** Per-session `MainMenu_uid<N>` popups. On older builds these could host
 *  the visible React UI, so they stay as a *fallback* render target — but
 *  never alongside the real BPM window (see `_pickRenderKeys`). */
const BPM_PREFIX_TARGETS = ["MainMenu"];
/**
 * Steam renders the Big Picture chrome — the Steam menu (`MainMenu_uid<N>`),
 * the Quick Access menu, notification toasts — as *browser-view popups*,
 * each its own CEF target whose debug URL carries `browserviewpopup=1`.
 * The main BPM window (which hosts the library / game-detail React tree)
 * does not. Title-matching alone can't tell them apart, so this marker is
 * what keeps a `position: fixed` badge out of the Steam menu overlay.
 */
const BROWSER_VIEW_POPUP_MARKER = "browserviewpopup=1";

/** Steam's own marker for a Big Picture browser window. */
const BPM_BROWSER_TYPE = "browserType=4";

/** Ceiling on the rediscovery back-off, in health ticks (~5s each). */
const MAX_DISCOVERY_SKIPS = 63;

/** A chrome popup — the Steam menu, QAM, toasts. Never a render target. */
function isBrowserViewPopup(tab: CefTab): boolean {
  return tab.url.includes(BROWSER_VIEW_POPUP_MARKER);
}

/** A `MainMenu_uid<N>`-style popup by title. */
function isMenuPopup(tab: CefTab): boolean {
  return BPM_PREFIX_TARGETS.some((p) => tab.title.startsWith(p));
}

/**
 * The main Big Picture window — the one hosting the library / game-detail
 * DOM. Mirrors `isBigPictureMode` in apps/loadout/src/injector/tabs.ts:
 * Gaming Mode titles it "Steam Big Picture Mode", desktop BPM titles it
 * "Steam" and marks it with `browserType=4`. Popups are excluded outright
 * so a renamed popup can never be mistaken for the window.
 */
function isBigPictureWindow(tab: CefTab): boolean {
  if (isBrowserViewPopup(tab) || isMenuPopup(tab)) return false;
  if (tab.title === BIG_PICTURE_TITLE) return true;
  return tab.title === "Steam" && tab.url.includes(BPM_BROWSER_TYPE);
}

/** URL patterns the GamepadUI / shared context is served from. */
const LOOPBACK_URL_PATTERNS = [
  "https://steamloopback.host/routes/",
  "https://steamloopback.host/index.html",
];

/**
 * The shared JS context. Mirrors `isSharedJSContext` in
 * apps/loadout/src/injector/tabs.ts: title alone is not enough, because
 * `SHARED_JS_NAMES` contains generic titles ("Steam", "SP") that an ordinary
 * steamcommunity.com tab can also carry. Matching those loosely lets a decoy
 * claim the key and evict the real context.
 */
function isSharedContext(tab: CefTab): boolean {
  if (!SHARED_JS_NAMES.includes(tab.title)) return false;
  return LOOPBACK_URL_PATTERNS.some((u) => tab.url.includes(u));
}

/** How strongly a tab claims the SharedJSContext key. Higher wins, so a
 *  loosely-matching decoy can never displace the canonical target
 *  regardless of the order Steam lists them in. */
function sharedContextRank(tab: CefTab): number {
  if (tab.title === "SharedJSContext" && isSharedContext(tab)) return 3;
  if (isSharedContext(tab)) return 2;
  if (tab.title === "SharedJSContext") return 1;
  return 0;
}

/** Tabs worth opening a socket to: the BPM window, the shared context (for
 *  route polling) and menu popups (so we can scrub old builds' badges). */
function isBadgeCandidate(tab: CefTab): boolean {
  return (
    isBigPictureWindow(tab) ||
    sharedContextRank(tab) > 0 ||
    isMenuPopup(tab)
  );
}

/** Per-plugin class the obscured-gate parks on `<html>` while hiding.
 *  Namespaced: two plugins gate the same document independently, and a
 *  shared class let either one's teardown un-hide the other's badge. */
function obscuredClass(safeId: string): string {
  return `loadout-badges-obscured-${safeId}`;
}

/** `pluginId` reduced to a JS-identifier-safe token for globals/classes. */
function safePluginId(pluginId: string): string {
  return pluginId.replace(/\W/g, "_");
}

/**
 * Obscured-gate: hides the badge whenever the window it lives in is covered.
 *
 * The Steam menu / Quick Access menu are separate OS-level windows composited
 * *above* the BPM window, so no `z-index` in our document can get behind them
 * — the badge has to take itself out of the picture instead. Deliberately
 * built on nothing but `document.visibilityState`, `document.hasFocus()` and
 * the `focus`/`blur`/`visibilitychange` events: the badge's own document can
 * tell it has been covered without knowing *what* covered it, so a Steam UI
 * reshuffle (renamed popups, new overlays, restructured React tree) can't
 * break it the way selector- or store-sniffing would.
 *
 * Fail-open on `hasFocus`: a document that has never once reported focus is
 * assumed to be a build where Steam doesn't route focus there, and keeps its
 * badge rather than hiding it forever.
 *
 * Settle delay: opening the Steam menu doesn't produce one clean blur — it
 * bounces focus between the windows several times in under 100ms (measured
 * on SteamOS, 5 transitions inside one frame budget). Applying every edge
 * would strobe the badge, so an edge only lands once the state has held for
 * {@link OBSCURED_SETTLE_MS}; a burst collapses into a single toggle at its
 * settled value.
 *
 * Re-arm carries state across: `_injectBadgeSystem` re-runs this script on
 * every rediscovery, and a naive re-arm resets `everFocused` to false. While
 * the Steam menu is open that reads as "never focused" ⇒ fail-open ⇒ the
 * class comes off and the badge draws over the menu again — the original bug,
 * reintroduced by a health blip. So the previous gate's `everFocused` and the
 * already-applied class are both inherited.
 *
 * Exported (with the constant) for tests — otherwise only evaluated over CDP.
 */
export const OBSCURED_SETTLE_MS = 250;

export function buildObscuredGateScript(pluginId: string): string {
  const safeId = safePluginId(pluginId);
  const globalKey = `__loadout_badge_gate_${safeId}`;
  const cls = obscuredClass(safeId);
  return `
(function() {
  var root = document.documentElement;
  var prev = window.${globalKey};
  // Inherit across re-arm (see "Re-arm carries state across" above).
  var everFocused = prev && prev.wasEverFocused ? prev.wasEverFocused() : false;
  if (prev) prev.cleanup();

  var applied = false;
  var timer = null;

  function desired() {
    if (document.hasFocus()) everFocused = true;
    return (
      document.visibilityState === "hidden" ||
      (everFocused && !document.hasFocus())
    );
  }

  function apply() {
    timer = null;
    var want = desired();
    if (want === applied) return;
    applied = want;
    root.classList.toggle("${cls}", want);
  }

  // Every edge restarts the timer, so only the settled value is applied.
  function sync() {
    desired();
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, ${OBSCURED_SETTLE_MS});
  }

  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);

  window.${globalKey} = {
    wasEverFocused: function() { return everFocused; },
    cleanup: function() {
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
      root.classList.remove("${cls}");
      delete window.${globalKey};
    }
  };

  // Re-assert immediately: cleanup above dropped any inherited class, and
  // the inherited everFocused puts it straight back within this same
  // evaluation, so there is no gap where the badge shows over the menu.
  apply();
})();
`;
}

export class SteamCefBadgeInjector<TBadgeData> {
  private readonly cfg: Required<
    Pick<
      SteamCefBadgeInjectorConfig<TBadgeData>,
      | "debugPort"
      | "cdpTimeoutMs"
      | "healthIntervalMs"
      | "pollIntervalMs"
      | "injectDebounceMs"
    >
  > &
    SteamCefBadgeInjectorConfig<TBadgeData>;
  private readonly log: (msg: string, ...args: unknown[]) => void;
  private readonly warn: (msg: string, ...args: unknown[]) => void;
  private readonly isGameMode: () => boolean | Promise<boolean>;

  /** Open CDP connections keyed by tab title (SharedJSContext variants
   *  collapse to the canonical `SharedJSContext` key; store tabs use a
   *  `store:<title>` key; BPM popups keep their per-session title). */
  private connections = new Map<string, CDPConnection>();
  private _connected = false;
  private healthInterval?: ReturnType<typeof setInterval>;
  private urlPollInterval?: ReturnType<typeof setInterval>;

  /** appId of the game page currently viewed in BPM (route-derived). */
  private currentAppId: string | null = null;

  /** Re-entrancy guards for the two interval ticks. */
  private polling = false;
  private healthChecking = false;

  /** Tail-queue for `_pushBadgeDataToBPM`: stash the latest appId and let
   *  the running push drain to it. `pendingPushSet` (not a null check)
   *  because `null` is a valid pending value (= "navigated away"). */
  private pushingBadgeData = false;
  private pendingPushAppId: string | null = null;
  private pendingPushSet = false;

  /** The tab(s) that host the BPM library UI — where the badge renders.
   *  Exactly one tier of candidate wins (see `_pickRenderKeys`); refilled
   *  by health-check rediscovery when the window dies. */
  private bpmRenderKeys: string[] = [];

  /** Connected-but-not-rendering tabs (the Steam menu popups, and
   *  SharedJSContext when it isn't the render target). We scrub any badge
   *  runtime out of these — a Loadout update lands mid-Steam-session, so a
   *  tab an older build injected into keeps its badge until we remove it. */
  private purgeKeys: string[] = [];

  private injectDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Why the last `_tryConnect` gave up, surfaced through `getStatus()`. */
  private lastConnectError: string | null = null;

  /** Scrub non-render tabs on the next inject only. The stale badge a purge
   *  clears is a one-off migration (an update landing mid-Steam-session), so
   *  it runs once per discovery rather than on every debounced re-inject. */
  private purgePending = false;

  /** Health ticks still to skip before the next discovery attempt. */
  private discoverySkips = 0;
  /** Current back-off size. Kept separate from the countdown above — sharing
   *  one field means the ratchet is read back after being decremented to
   *  zero, so it never actually grows. Ratchets 1, 3, 7, 15, 31, 63. */
  private discoveryBackoff = 0;

  /** Guards `_injectBadgeSystem` against overlapping runs. */
  private injecting = false;

  /** Last `{connected, detail}` handed to `onStateChange`, so failure paths
   *  can emit the new reason without re-emitting an unchanged one. */
  private lastEmittedDetail: string | null = null;
  private lastEmittedConnected: boolean | null = null;
  private lastEmittedTabs: number | null = null;

  constructor(config: SteamCefBadgeInjectorConfig<TBadgeData>) {
    this.cfg = {
      debugPort: 8080,
      cdpTimeoutMs: 5000,
      healthIntervalMs: 5000,
      pollIntervalMs: 500,
      injectDebounceMs: 250,
      ...config,
    };
    const prefix = `[${config.pluginId}]`;
    this.log = config.log ?? ((m, ...a) => console.log(`${prefix} ${m}`, ...a));
    this.warn = config.warn ?? ((m, ...a) => console.warn(`${prefix} ${m}`, ...a));
    this.isGameMode = config.isGameMode ?? isGamescopeRunning;
  }

  get connected(): boolean {
    return this._connected;
  }

  // ─── Public lifecycle ───────────────────────────────────────────

  /** Gated initial connect + inject, then start health (5s) and route-poll
   *  (500ms) intervals. Never throws if Steam isn't up — the health check
   *  retries. Safe to call once from the plugin's onLoad. */
  async start(): Promise<void> {
    try {
      const ok = await this._tryConnect();
      if (ok) await this._injectBadgeSystem();
    } catch {
      this.log("Steam CEF not available yet, will retry");
    }
    if (!this.healthInterval) {
      this.healthInterval = setInterval(
        () => void this._checkHealth(),
        this.cfg.healthIntervalMs,
      );
    }
    if (!this.urlPollInterval) {
      this.urlPollInterval = setInterval(
        () => void this._pollCurrentAppId(),
        this.cfg.pollIntervalMs,
      );
    }
  }

  /** Stop intervals, remove the badge system from every live tab, close all
   *  sockets, clear state. Mirrors the plugin onUnload. */
  async stop(): Promise<void> {
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.urlPollInterval) clearInterval(this.urlPollInterval);
    this.healthInterval = undefined;
    this.urlPollInterval = undefined;
    if (this.injectDebounceTimer) clearTimeout(this.injectDebounceTimer);
    this.injectDebounceTimer = null;

    await this._removeBadgeSystem();

    for (const conn of this.connections.values()) {
      try {
        conn.client.close();
      } catch {
        /* already closed */
      }
    }
    this.connections.clear();
    this.bpmRenderKeys = [];
    this.purgeKeys = [];
    this._connected = false;
    this.lastConnectError = null;
    this.currentAppId = null;
    this.purgePending = false;
    this.discoverySkips = 0;
    this.discoveryBackoff = 0;
    // Announce the shutdown, then forget what we announced — a later start()
    // must be free to emit the same values again.
    this._emitStateIfChanged();
    this.lastEmittedDetail = null;
    this.lastEmittedConnected = null;
    this.lastEmittedTabs = null;
  }

  /** Manual reconnect (RPC). Returns a Gaming-Mode error in desktop mode. */
  async reconnect(): Promise<{ success: boolean; error?: string }> {
    if (!(await this.isGameMode())) {
      // Reflect it in the status too — returning only a toast leaves the dot
      // reading "Connected (3 tabs)" after a Gaming→Desktop switch.
      this._connected = false;
      this.lastConnectError =
        "Steam CEF badges are only available in Gaming Mode.";
      this._emitStateIfChanged();
      return { success: false, error: this.lastConnectError };
    }
    for (const conn of this.connections.values()) {
      try {
        conn.client.close();
      } catch {
        /* already closed */
      }
    }
    this.connections.clear();
    this.bpmRenderKeys = [];
    this.purgeKeys = [];
    this._connected = false;

    const ok = await this._tryConnect();
    if (ok) {
      await this._injectBadgeSystem();
      return { success: true };
    }
    return {
      success: false,
      error:
        this.lastConnectError ?? "Could not connect to Steam CEF. Is Steam running?",
    };
  }

  /** `detail` is the human-readable reason badges aren't showing — the
   *  "connected" dot alone can't distinguish desktop mode from a Steam
   *  that never opened its debug port, and both look identical to a user
   *  who just sees no badges. `undefined` once badges can render. */
  getStatus(): { connected: boolean; tabs: number; detail?: string } {
    const detail = this._statusDetail();
    return {
      connected: this._connected,
      tabs: this.connections.size,
      ...(detail ? { detail } : {}),
    };
  }

  private _statusDetail(): string | undefined {
    if (this.lastConnectError) return this.lastConnectError;
    if (!this._connected) return "Not connected to Steam.";
    if (this.bpmRenderKeys.length === 0) {
      return "Connected, but no Big Picture window was found to draw into.";
    }
    if (!this.connections.has("SharedJSContext")) {
      // Render target but no route source: the badge can never be told which
      // game is on screen, so nothing appears. Without this clause the status
      // reads as healthy while showing no badges at all.
      return "Connected to the Big Picture window, but not to Steam's shared context — the game you're viewing can't be detected.";
    }
    return undefined;
  }

  getCurrentAppId(): string | null {
    return this.currentAppId;
  }

  /** Trailing-edge debounced re-inject. Plugin calls this from updateSettings
   *  after persisting. No-op if not connected. */
  reinjectDebounced(): void {
    if (!this._connected) return;
    if (this.injectDebounceTimer) clearTimeout(this.injectDebounceTimer);
    this.injectDebounceTimer = setTimeout(() => {
      this.injectDebounceTimer = null;
      void this._injectBadgeSystem();
    }, this.cfg.injectDebounceMs);
  }

  // ─── Route polling (SharedJSContext) ────────────────────────────
  //
  // In BPM / gamescope, window.location.href stays pinned to the BPM entry
  // URL forever — navigation happens inside a React Router SPA. Steam exposes
  // the router on SharedJSContext as `window.tempNavStore`; on a game page the
  // pathname is `/library/app/<id>` (or `/routes/library/app/<id>`).

  private async _pollCurrentAppId(): Promise<void> {
    if (this.polling) return;
    // SharedJSContext only — see _routeConn for why there is no fallback.
    const conn = this._routeConn();
    if (!conn || !conn.client.connected) return;

    this.polling = true;
    try {
      const pathname = (await this._cdpEvaluate(
        conn,
        "(window.tempNavStore && window.tempNavStore.m_history && window.tempNavStore.m_history.location && window.tempNavStore.m_history.location.pathname) || window.location.pathname || ''",
      )) as string;
      const match = pathname?.match?.(/^\/(?:routes\/)?library\/app\/(\d+)/);
      const newAppId = match ? (match[1] ?? null) : null;

      if (newAppId !== this.currentAppId) {
        this.currentAppId = newAppId;
        this._pushBadgeDataToBPM(newAppId).catch(() => {});
      }
    } catch {
      // Ignore — will retry next tick.
    } finally {
      this.polling = false;
    }
  }

  /**
   * Tab the route is read from. SharedJSContext only — `tempNavStore` lives
   * there, and in BPM `window.location` is pinned to the entry URL forever.
   * Falling back to the render tab therefore reads a pathname that can never
   * match a game route, which would push a `null` update and evict a badge
   * that was on screen. Health rediscovery reconnects the shared context
   * instead; until it does, the last-pushed badge simply stays put.
   */
  private _routeConn(): CDPConnection | undefined {
    const shared = this.connections.get("SharedJSContext");
    return shared?.client.connected ? shared : undefined;
  }

  /** Fetch badge data server-side and push it into the BPM tab(s) via CDP. */
  private async _pushBadgeDataToBPM(appId: string | null): Promise<void> {
    // Coalesce rapid route changes: stash the latest and let the running
    // push drain to it, so a fast navigation never strands a stale badge.
    this.pendingPushAppId = appId;
    this.pendingPushSet = true;
    if (this.pushingBadgeData) return;
    this.pushingBadgeData = true;

    try {
      while (this.pendingPushSet) {
        const targetAppId = this.pendingPushAppId;
        this.pendingPushSet = false;

        const targets = this.bpmRenderKeys
          .map((k) => ({ key: k, conn: this.connections.get(k) }))
          .filter((t) => t.conn && t.conn.client.connected);
        if (targets.length === 0) continue;

        let data: TBadgeData | null = null;
        if (targetAppId) {
          data = await this.cfg.fetchBadgeData(targetAppId);
          // If a newer appId arrived while awaiting, drop this batch.
          if (this.pendingPushSet) continue;
        }
        const expr = this.cfg.buildBpmUpdateExpr(data);

        const pushed: string[] = [];
        for (const t of targets) {
          // targets was filtered to entries with a live conn, so this is
          // always set; the guard only satisfies the type checker.
          const conn = t.conn;
          if (!conn) continue;
          try {
            await this._cdpEvaluate(conn, expr);
            pushed.push(t.key);
          } catch (err) {
            this.warn(`Failed to push badge data to ${t.key}:`, err);
          }
        }
        if (targetAppId && pushed.length > 0) {
          this.log(
            `Pushed badge data to ${pushed.join(", ")} for app ${targetAppId}`,
          );
        }
      }
    } finally {
      this.pushingBadgeData = false;
    }
  }

  // ─── CDP infrastructure ─────────────────────────────────────────

  private async _tryConnect(): Promise<boolean> {
    // Gaming-Mode gate (issue #111): no CEF connection in the desktop client.
    // Covers start(), health rediscovery and reconnect() — all funnel here.
    if (!(await this.isGameMode())) {
      this._connected = false;
      this.lastConnectError =
        "Steam CEF badges are only available in Gaming Mode.";
      this._emitStateIfChanged();
      return false;
    }
    try {
      const res = await fetch(`http://localhost:${this.cfg.debugPort}/json`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`/json returned ${res.status}`);

      const tabs = (await res.json()) as CefTab[];

      // Close any existing connections before rediscovering.
      for (const conn of this.connections.values()) {
        try {
          conn.client.close();
        } catch {
          /* already closed */
        }
      }
      this.connections.clear();
      this.bpmRenderKeys = [];
      this.purgeKeys = [];

      // Tabs we've already opened a socket to this pass — so the store loop
      // below never opens a second WebSocket to a tab that already matched
      // an exact/prefix target (which would orphan one socket from
      // health-check pruning, since the two are stored under different keys).
      const connectedTabIds = new Set<string>();

      // Classify every tab first, with no I/O, so duplicate keys are resolved
      // on merit rather than on the order Steam happened to list them in.
      const claims = new Map<string, { tab: CefTab; rank: number }>();
      for (const tab of tabs) {
        if (!tab.webSocketDebuggerUrl) continue;
        if (!isBadgeCandidate(tab)) continue;

        // A BPM window titled "Steam" is in SHARED_JS_NAMES too — classify it
        // as the window, or it collapses onto the SharedJSContext key and
        // evicts the real shared context.
        const isBpm = isBigPictureWindow(tab);
        const key = isBpm ? tab.title : isMenuPopup(tab) ? tab.title : "SharedJSContext";
        const rank = isBpm || isMenuPopup(tab) ? 1 : sharedContextRank(tab);

        const held = claims.get(key);
        if (held && held.rank >= rank) {
          this.log(`Ignoring weaker ${key} candidate: "${tab.title}" (${tab.url})`);
          continue;
        }
        if (held) {
          this.log(`Preferring "${tab.title}" over "${held.tab.title}" for ${key}`);
        }
        claims.set(key, { tab, rank });
      }

      const candidates: { key: string; tab: CefTab }[] = [];
      for (const [key, { tab }] of claims) {
        try {
          const conn = await this._openCDP(tab.webSocketDebuggerUrl, tab.title);
          this.connections.set(key, conn);
          connectedTabIds.add(tab.id);
          candidates.push({ key, tab });
          this.log(`Connected to: ${tab.title} (key: ${key})`);
        } catch (err) {
          this.warn(`Failed to connect to ${tab.title}:`, err);
        }
      }

      this.bpmRenderKeys = this._pickRenderKeys(candidates);
      this.purgeKeys = candidates
        .map((c) => c.key)
        .filter((k) => !this.bpmRenderKeys.includes(k));
      // Log the whole target list once per discovery: which tab hosts the
      // visible UI is build-dependent, so a field report of "no badges" is
      // only diagnosable if we recorded what Steam actually offered.
      this.log(
        `Discovered targets: ${tabs.map((t) => `"${t.title}" (${t.url})`).join(", ")}`,
      );
      this.log(
        this.bpmRenderKeys.length > 0
          ? `Badge render target: ${this.bpmRenderKeys.join(", ")}`
          : "No badge render target — badges will not appear.",
      );
      this.purgePending = true;

      // Also connect to Steam store tabs (store.steampowered.com).
      for (const tab of tabs) {
        if (!tab.webSocketDebuggerUrl) continue;
        if (!tab.url.includes("store.steampowered.com")) continue;
        if (connectedTabIds.has(tab.id)) continue;
        try {
          const conn = await this._openCDP(tab.webSocketDebuggerUrl, tab.title);
          this.connections.set(`store:${tab.title}`, conn);
          connectedTabIds.add(tab.id);
          this.log(`Connected to store: ${tab.title}`);
        } catch {
          /* store tab optional */
        }
      }

      this._connected =
        this.connections.has("SharedJSContext") || this.bpmRenderKeys.length > 0;
      this.lastConnectError = this._connected
        ? null
        : "Steam is running but exposed no Big Picture tab to inject into.";
      this._emitState();
      return this._connected;
    } catch {
      this._connected = false;
      // Overwhelmingly the cause when Steam is up: the debug port was never
      // opened, so /json refuses the connection.
      this.lastConnectError =
        `Steam's CEF debug port (${this.cfg.debugPort}) is not reachable. ` +
        "Create an empty `.cef-enable-remote-debugging` file in Steam's root " +
        "(~/.steam/steam or ~/.local/share/Steam) and restart Steam.";
      this._emitStateIfChanged();
      return false;
    }
  }

  /**
   * Pick the tab(s) the badge renders into, in strict preference order —
   * the first tier that yields anything wins, and the rest are purged.
   *
   * The badge is a `position: fixed` child of `document.body`, so it draws
   * over *whatever* that document shows. Injecting into every candidate
   * ("only the visible one composites") was wrong: the Steam menu is its
   * own always-live popup document, so on current SteamOS builds the badge
   * showed up inside the menu as well as on the game page.
   *
   *   1. The main Big Picture window — see {@link isBigPictureWindow}.
   *      Hosts the library / game-detail React tree on current builds.
   *   2. `MainMenu_uid<N>` popups — legacy builds with no separate BPM
   *      window, where the popup *was* the whole UI.
   *
   * There is deliberately no SharedJSContext tier. It is documented as the
   * invisible page (docs/ui-modding-framework.md, docs/steam-ui-injection.md)
   * — rendering there draws nothing, and because `_connected` is true
   * whenever it is present, electing it would also mask the "no render
   * target" diagnostic that tells the user what is actually wrong.
   */
  private _pickRenderKeys(candidates: { key: string; tab: CefTab }[]): string[] {
    // Exactly one window: two BPM-shaped tabs (the Gaming-Mode one plus a
    // desktop `Steam`/browserType=4 window) would otherwise both get a badge
    // and an independent gate. Prefer the Gaming-Mode title.
    const windows = candidates.filter((c) => isBigPictureWindow(c.tab));
    const preferred =
      windows.find((c) => c.tab.title === BIG_PICTURE_TITLE) ?? windows[0];
    if (preferred) return [preferred.key];

    // Menu popups stay plural: on legacy builds the UI really was split
    // across the per-session popups.
    return candidates.filter((c) => isMenuPopup(c.tab)).map((c) => c.key);
  }

  private async _openCDP(wsUrl: string, tabTitle: string): Promise<CDPConnection> {
    const client = new CDPClient(wsUrl);
    await client.connect();
    return { client, tabTitle };
  }

  private _cdpEvaluate(conn: CDPConnection, expression: string): Promise<unknown> {
    return conn.client.evaluate(expression, { timeoutMs: this.cfg.cdpTimeoutMs });
  }

  // ─── CSS / JS injection ─────────────────────────────────────────

  private async _injectCSSToTab(conn: CDPConnection, css: string): Promise<void> {
    const escaped = css
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$");
    await this._cdpEvaluate(
      conn,
      `
      (function() {
        var e = document.getElementById("${this.cfg.styleId}");
        if (e) e.remove();
        var s = document.createElement("style");
        s.id = "${this.cfg.styleId}";
        s.dataset.loadoutPlugin = "${this.cfg.pluginId}";
        document.head.appendChild(s);
        s.textContent = \`${escaped}\`;
      })()
    `,
    );
  }

  /** Plugin CSS + the rule the obscured-gate toggles. */
  private _bpmCss(): string {
    const sel = this.cfg.obscuredHideSelector;
    if (!sel) return this.cfg.css;
    return `${this.cfg.css}
html.${obscuredClass(safePluginId(this.cfg.pluginId))} ${sel} { display: none !important; }
`;
  }

  private async _injectBadgeSystem(): Promise<void> {
    // Re-entrancy guard: a debounced re-inject can land inside _tryConnect's
    // window between clearing the connections and refilling them, where it
    // would see no render keys and log a spurious "badge will not appear".
    if (this.injecting) return;
    this.injecting = true;
    try {
      await this._injectBadgeSystemInner();
    } finally {
      this.injecting = false;
    }
  }

  private async _injectBadgeSystemInner(): Promise<void> {
    const css = this._bpmCss();

    // Scrub tabs we deliberately don't render into. A Loadout update lands
    // mid-Steam-session, so a Steam-menu popup an older build injected into
    // still has its badge + <style> until we take them back out. One-off per
    // discovery — a settings re-inject has nothing new to clear.
    const purgeKeys = this.purgePending ? this.purgeKeys : [];
    this.purgePending = false;
    for (const key of purgeKeys) {
      const conn = this.connections.get(key);
      if (!conn || !conn.client.connected) continue;
      try {
        await this._removeFromTab(conn);
      } catch {
        /* best effort — nothing to remove is the common case */
      }
    }

    // Inject into every candidate BPM render tab — only the visible one
    // composites; hidden tabs update their off-screen DOM harmlessly.
    const bpmConns = this.bpmRenderKeys
      .map((k) => ({ key: k, conn: this.connections.get(k) }))
      .filter((t) => t.conn && t.conn.client.connected);

    if (bpmConns.length > 0) {
      for (const t of bpmConns) {
        // bpmConns was filtered to entries with a live conn, so this is
        // always set; the guard only satisfies the type checker.
        const conn = t.conn;
        if (!conn) continue;
        try {
          await this._injectCSSToTab(conn, css);
          await this._cdpEvaluate(conn, this.cfg.bpmScript);
          if (this.cfg.obscuredHideSelector) {
            await this._cdpEvaluate(conn, buildObscuredGateScript(this.cfg.pluginId));
          }
          this.log(`Injected badge system into ${t.key}`);
        } catch (err) {
          this.warn(`Failed to inject into ${t.key}:`, err);
        }
      }
      if (this.currentAppId) {
        this._pushBadgeDataToBPM(this.currentAppId).catch(() => {});
      }
    } else {
      this.warn(
        "No BPM render tab discovered — badge will not appear. Tabs:",
        Array.from(this.connections.keys()).join(", "),
      );
    }

    // Inject into store tabs — fetch data server-side and embed it at
    // injection time (no fetch() from inside CEF).
    for (const [key, conn] of this.connections) {
      if (!key.startsWith("store:")) continue;
      if (!conn.client.connected) continue;
      try {
        const url = (await this._cdpEvaluate(
          conn,
          "window.location.href",
        )) as string;
        const appIdMatch = url?.match?.(
          /store\.steampowered\.com\/app\/(\d+)/,
        );
        const badgeData = appIdMatch
          // group 1 is a required capture, so it is always present when
          // appIdMatch matched; `?? ""` only satisfies the type checker.
          ? await this.cfg.fetchBadgeData(appIdMatch[1] ?? "")
          : null;

        await this._injectCSSToTab(conn, css);
        await this._cdpEvaluate(conn, this.cfg.buildStoreScript(badgeData));
      } catch {
        /* store tab transient — health check will retry */
      }
    }
  }

  /** Tear the badge runtime, the obscured-gate and `<style>` back out of one tab. */
  private _removeFromTab(conn: CDPConnection): Promise<unknown> {
    const { bpmGlobalName, storeGlobalName, styleId, pluginId } = this.cfg;
    const gateKey = `__loadout_badge_gate_${safePluginId(pluginId)}`;
    return this._cdpEvaluate(
      conn,
      `
      if (window.${bpmGlobalName}) { window.${bpmGlobalName}.cleanup(); delete window.${bpmGlobalName}; }
      if (window.${storeGlobalName}) { window.${storeGlobalName}.cleanup(); delete window.${storeGlobalName}; }
      if (window.${gateKey}) window.${gateKey}.cleanup();
      var s = document.getElementById("${styleId}"); if (s) s.remove();
    `,
    );
  }

  private async _removeBadgeSystem(): Promise<void> {
    for (const conn of this.connections.values()) {
      if (!conn.client.connected) continue;
      try {
        await this._removeFromTab(conn);
      } catch {
        /* best effort */
      }
    }
  }

  // ─── Health check ───────────────────────────────────────────────

  private async _checkHealth(): Promise<void> {
    if (this.healthChecking) return;
    this.healthChecking = true;
    try {
      // Desktop mode with nothing open: stay network-silent (no /json spin),
      // but re-evaluate the gate each tick so a mode-flip is picked up.
      if (this.connections.size === 0 && !(await this.isGameMode())) return;

      for (const [key, conn] of this.connections) {
        if (!conn.client.connected) {
          this.connections.delete(key);
          this.bpmRenderKeys = this.bpmRenderKeys.filter((k) => k !== key);
          this.purgeKeys = this.purgeKeys.filter((k) => k !== key);
          // Real state change — Steam moved, so stop backing off.
          this.discoverySkips = 0;
          this.discoveryBackoff = 0;
          this.log(`Pruned dead connection: ${key}`);
        }
      }

      this._connected =
        this.connections.has("SharedJSContext") || this.bpmRenderKeys.length > 0;

      // Rediscover when we lack a render target OR the shared context — the
      // latter is the only place the route can be read, so losing it alone
      // (BPM socket still alive) would otherwise freeze the badge silently.
      const wants =
        !this._connected ||
        this.bpmRenderKeys.length === 0 ||
        !this.connections.has("SharedJSContext");

      if (wants && this.discoverySkips > 0) {
        this.discoverySkips--;
      } else if (wants) {
        // Re-run discovery (gated inside _tryConnect) so a reopened BPM or a
        // freshly-started Steam reconnects without a manual nudge.
        const ok = await this._tryConnect();
        if (ok) await this._injectBadgeSystem();

        // Back off when a *successful* discovery still leaves us wanting.
        // That means Steam simply has no such target — retrying every tick
        // reconnects every socket and re-runs the BPM script, and the badge
        // script's own cleanup() drops the badge before the async re-push
        // puts it back, so the badge blinks out once per tick, forever.
        // A failed connect is a different case (Steam not up yet) and keeps
        // the plain 5s retry.
        const stillWants =
          !this._connected ||
          this.bpmRenderKeys.length === 0 ||
          !this.connections.has("SharedJSContext");
        if (ok && stillWants) {
          this.discoveryBackoff = Math.min(
            this.discoveryBackoff * 2 + 1,
            MAX_DISCOVERY_SKIPS,
          );
          this.discoverySkips = this.discoveryBackoff;
        } else {
          this.discoveryBackoff = 0;
          this.discoverySkips = 0;
        }
      }
      this._emitStateIfChanged();
    } finally {
      this.healthChecking = false;
    }
  }

  /** Emit only when the user-visible state actually moved. Compares every
   *  field in the payload, so adding one here can't silently go unemitted. */
  private _emitStateIfChanged(): void {
    if (
      (this._statusDetail() ?? null) === this.lastEmittedDetail &&
      this._connected === this.lastEmittedConnected &&
      this.connections.size === this.lastEmittedTabs
    ) {
      return;
    }
    this._emitState();
  }

  private _emitState(): void {
    this.lastEmittedDetail = this._statusDetail() ?? null;
    this.lastEmittedConnected = this._connected;
    this.lastEmittedTabs = this.connections.size;
    this.cfg.onStateChange?.({
      connected: this._connected,
      tabs: this.connections.size,
      detail: this._statusDetail(),
    });
  }
}
