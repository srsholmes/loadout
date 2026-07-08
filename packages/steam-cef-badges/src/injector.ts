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

  /** Notified whenever `{connected, tabs}` changes so the plugin can emit. */
  onStateChange?: (state: { connected: boolean; tabs: number }) => void;

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
/** Steam splits the BPM UI across the parent BPM tab and per-session
 *  `MainMenu_uid<N>` popups; which hosts the visible React UI is
 *  build-dependent, so both are candidate render targets. */
const BPM_PREFIX_TARGETS = ["MainMenu"];

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

  /** Candidate BPM render targets — the parent BPM tab and/or MainMenu
   *  popups. We inject into and push to all of them; only the visible tab
   *  composites. Refilled by health-check rediscovery when popups die. */
  private bpmRenderKeys: string[] = [];

  private injectDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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
    this._connected = false;
  }

  /** Manual reconnect (RPC). Returns a Gaming-Mode error in desktop mode. */
  async reconnect(): Promise<{ success: boolean; error?: string }> {
    if (!(await this.isGameMode())) {
      return {
        success: false,
        error: "Steam CEF badges are only available in Gaming Mode.",
      };
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
    this._connected = false;

    const ok = await this._tryConnect();
    if (ok) {
      await this._injectBadgeSystem();
      return { success: true };
    }
    return {
      success: false,
      error: "Could not connect to Steam CEF. Is Steam running?",
    };
  }

  getStatus(): { connected: boolean; tabs: number } {
    return { connected: this._connected, tabs: this.connections.size };
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
    const conn = this.connections.get("SharedJSContext");
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
          try {
            await this._cdpEvaluate(t.conn!, expr);
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

      const exactTargets = [...SHARED_JS_NAMES, BIG_PICTURE_TITLE];

      // Tabs we've already opened a socket to this pass — so the store loop
      // below never opens a second WebSocket to a tab that already matched
      // an exact/prefix target (which would orphan one socket from
      // health-check pruning, since the two are stored under different keys).
      const connectedTabIds = new Set<string>();

      for (const tab of tabs) {
        if (!tab.webSocketDebuggerUrl) continue;

        const isExact = exactTargets.includes(tab.title);
        const prefixHit = BPM_PREFIX_TARGETS.find((p) => tab.title.startsWith(p));
        if (!isExact && !prefixHit) continue;

        try {
          const conn = await this._openCDP(tab.webSocketDebuggerUrl, tab.title);
          // Collapse SharedJSContext title variants to one canonical key;
          // MainMenu popups keep their per-session title.
          const key = SHARED_JS_NAMES.includes(tab.title)
            ? "SharedJSContext"
            : tab.title;
          this.connections.set(key, conn);
          connectedTabIds.add(tab.id);
          if (prefixHit === "MainMenu" || tab.title === BIG_PICTURE_TITLE) {
            this.bpmRenderKeys.push(key);
          }
          this.log(`Connected to: ${tab.title} (key: ${key})`);
        } catch (err) {
          this.warn(`Failed to connect to ${tab.title}:`, err);
        }
      }

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
      this._emitState();
      return this._connected;
    } catch {
      this._connected = false;
      return false;
    }
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

  private async _injectBadgeSystem(): Promise<void> {
    const css = this.cfg.css;

    // Inject into every candidate BPM render tab — only the visible one
    // composites; hidden tabs update their off-screen DOM harmlessly.
    const bpmConns = this.bpmRenderKeys
      .map((k) => ({ key: k, conn: this.connections.get(k) }))
      .filter((t) => t.conn && t.conn.client.connected);

    if (bpmConns.length > 0) {
      for (const t of bpmConns) {
        try {
          await this._injectCSSToTab(t.conn!, css);
          await this._cdpEvaluate(t.conn!, this.cfg.bpmScript);
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
          // Non-null: appIdMatch is truthy, group 1 is a required capture.
          ? await this.cfg.fetchBadgeData(appIdMatch[1]!)
          : null;

        await this._injectCSSToTab(conn, css);
        await this._cdpEvaluate(conn, this.cfg.buildStoreScript(badgeData));
      } catch {
        /* store tab transient — health check will retry */
      }
    }
  }

  private async _removeBadgeSystem(): Promise<void> {
    const { bpmGlobalName, storeGlobalName, styleId } = this.cfg;
    for (const conn of this.connections.values()) {
      if (!conn.client.connected) continue;
      try {
        await this._cdpEvaluate(
          conn,
          `
          if (window.${bpmGlobalName}) window.${bpmGlobalName}.cleanup();
          if (window.${storeGlobalName}) window.${storeGlobalName}.cleanup();
          var s = document.getElementById("${styleId}"); if (s) s.remove();
        `,
        );
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
          this.log(`Pruned dead connection: ${key}`);
        }
      }

      const wasConnected = this._connected;
      this._connected =
        this.connections.has("SharedJSContext") || this.bpmRenderKeys.length > 0;

      if (!this._connected || this.bpmRenderKeys.length === 0) {
        if (wasConnected && !this._connected) this._emitState();
        // Re-run discovery (gated inside _tryConnect) so a reopened BPM or a
        // freshly-started Steam reconnects without a manual nudge.
        const ok = await this._tryConnect();
        if (ok) await this._injectBadgeSystem();
      }
    } finally {
      this.healthChecking = false;
    }
  }

  private _emitState(): void {
    this.cfg.onStateChange?.({
      connected: this._connected,
      tabs: this.connections.size,
    });
  }
}
