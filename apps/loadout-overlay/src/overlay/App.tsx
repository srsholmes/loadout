import { useRef, useState, useEffect, useCallback, useMemo, type CSSProperties } from "react";
import { Toaster, toast } from "react-hot-toast";
import { LoadoutProvider, TOAST_EVENT, type ToastEventDetail } from "@loadout/ui";
import { Sidebar } from "./components/Sidebar";
import { PluginHost } from "./components/PluginHost";
import {
  PluginHeaderHost,
  PluginFavoriteButton,
  DefaultHeader,
  usePluginHasHeader,
} from "./components/PluginHeaderHost";
import { Settings } from "./components/Settings";
import { Homepage } from "./components/Homepage";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { usePlugins } from "./hooks/usePlugins";
import { useSidebarAutoCollapseSetting } from "./hooks/useSidebarCollapse";
import { useStatusMetrics } from "./hooks/useStatusMetrics";
import { useEnabledPlugins } from "./hooks/useEnabledPlugins";
import { useConfigValue, getConfigValue, setConfigValue } from "./lib/userConfig";
import { GamepadNavProvider, useFocusable, Focusable, FocusContext, setFocus, getCurrentFocusKey } from "./components/GamepadNav";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { hideOverlay, isGamescopeMode, getControllerShortcuts, setControllerShortcuts, sendOverlayHeartbeat } from "./lib/host";
import { OverlayKeyboard } from "./components/OverlayKeyboard";
import { useOverlayKeyboard } from "@loadout/ui";
import { isTextLike, rememberLastInput } from "./lib/keystrokeDispatcher";


// ---------------------------------------------------------------------------
// Hash routing — #/plugin/<id> | #/settings | #/
// ---------------------------------------------------------------------------

export type Route =
  | { view: "plugin"; pluginId: string }
  | { view: "settings" }
  | { view: "home" };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h === "settings") return { view: "settings" };
  if (h.startsWith("plugin/")) {
    const id = h.slice("plugin/".length);
    if (id) return { view: "plugin", pluginId: id };
  }
  return { view: "home" };
}

export function routeToHash(route: Route): string {
  switch (route.view) {
    case "settings": return "#/settings";
    case "plugin":   return `#/plugin/${route.pluginId}`;
    default:         return "#/";
  }
}

/**
 * Push a new overlay-shell route via the hash router so back/forward work.
 *
 * Audit C-020 (2026-05) renamed this from `navigate` to disambiguate it
 * from `@loadout/ui::navigate` — the latter is a Steam-BPM URL
 * helper that takes a path string, this one's the overlay shell's own
 * view switcher and takes a `Route` object. Keeping the names distinct
 * stops plugins from importing the wrong symbol and getting a runtime
 * "Route is not assignable to string" shape error.
 */
export function navigateOverlay(route: Route) {
  const hash = routeToHash(route);
  if (window.location.hash !== hash) {
    window.history.pushState(null, "", hash);
  }
  // Notify listeners (hashchange doesn't fire for pushState)
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

const GAMESCOPE_SCALE = 1.2;
const DESKTOP_SCALE = 1;

function loadScale(gamescope: boolean): number {
  const v = getConfigValue<number | undefined>("uiScale", undefined);
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.max(0.75, Math.min(2, v));
  }
  return gamescope ? GAMESCOPE_SCALE : DESKTOP_SCALE;
}

/**
 * Root overlay application.
 *
 * Layout: fixed sidebar on the left with plugin list, main content area on the
 * right that renders the active plugin's React app. The shell provides routing,
 * theme, and the WebSocket provider so every plugin has access to its backend.
 *
 * Wrapped in LoadoutProvider (WebSocket) and GamepadNavProvider (d-pad/A/B
 * navigation). The quick menu slides in from the right (F10 or hardware button).
 */
export function App() {
  const handleBack = useCallback(() => {
    let current = "";
    try { current = getCurrentFocusKey(); } catch {}
    // Check if focus is inside the "content" zone (plugin area)
    // by walking up the parent chain
    const nav = window.__SPATIAL_NAV__;
    let isInContent = false;
    if (nav) {
      let key = current;
      for (let i = 0; i < 20; i++) {
        if (!key || key === "SN:ROOT") break;
        if (key === "content") { isInContent = true; break; }
        const comp = nav.focusableComponents?.[key];
        if (!comp) break;
        key = comp.parentFocusKey;
      }
    }
    if (isInContent) {
      setFocus("sidebar");
    } else {
      hideOverlay().catch(() => {});
    }
  }, []);

  // Liveness heartbeat for the bun-side freeze watchdog. Runs whenever the
  // webview is mounted (the window is minimized, never destroyed, on close).
  // If this renderer wedges, the pings stop and bun thaws Steam + force-closes
  // rather than leaving Steam SIGSTOPped. Cheap (one RPC/s).
  useEffect(() => {
    sendOverlayHeartbeat();
    const id = setInterval(sendOverlayHeartbeat, 1000);
    return () => clearInterval(id);
  }, []);

  // Plugin → shell toast bridge. Plugins call `notify(...)` from
  // `@loadout/ui`, which dispatches a window CustomEvent; we
  // pick it up here and forward to the shell-owned `react-hot-toast`
  // singleton. See `packages/ui/src/notify.ts` for the rationale —
  // each plugin bundles its own SDK copy, so a singleton imported
  // inside a plugin never reaches the shell-mounted Toaster.
  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastEventDetail>).detail;
      if (!detail) return;
      const fn =
        detail.kind === "error"
          ? toast.error
          : detail.kind === "loading"
            ? toast.loading
            : toast.success;
      fn(detail.message, { id: detail.id, duration: detail.duration });
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  return (
    <LoadoutProvider>
      <GamepadNavProvider onBack={handleBack}>
        <AppInner />
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 3000,
            style: {
              background: "var(--bg-inset)",
              color: "var(--fg-1)",
              border: "1px solid var(--line)",
              borderRadius: "10px",
              fontSize: "13px",
              padding: "10px 14px",
              boxShadow: "0 8px 24px rgb(0 0 0 / 0.32)",
            },
            success: {
              iconTheme: { primary: "var(--accent)", secondary: "var(--bg-inset)" },
            },
            error: {
              iconTheme: { primary: "var(--color-error)", secondary: "var(--bg-inset)" },
            },
          }}
        />
      </GamepadNavProvider>
    </LoadoutProvider>
  );
}

/** Inner app component that can use GamepadNav hooks. */
function AppInner() {
  const { plugins, loading } = usePlugins();
  const { enabled: enabledList, isEnabled } = useEnabledPlugins();
  const [welcomeCompleted] = useConfigValue<boolean>("welcomeCompleted", false);
  // Lets Settings re-open the welcome flow even after it's been dismissed.
  const [welcomeForceOpen, setWelcomeForceOpen] = useState(false);
  const showWelcome = welcomeForceOpen || !welcomeCompleted;

  // Plugins surfaced in the sidebar + homepage. Settings keeps the full
  // list so users can re-enable hidden plugins from the new Plugins tab.
  const visiblePlugins = useMemo(
    () => plugins.filter((p) => isEnabled(p.id)),
    [plugins, isEnabled],
  );
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [scale, setScale] = useConfigValue<number>("uiScale", loadScale(false));
  const [, setGamescope] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [autoCollapse] = useSidebarAutoCollapseSetting();

  // Mirror sidebar state onto `<html data-sidebar="…">` so plugin
  // CSS (via the `sidebar-open` / `sidebar-collapsed` custom variants
  // registered in index.css) can react to it. Plugins live in their
  // own React trees mounted under PluginHost; this attribute is the
  // simplest cross-tree channel that survives unmount/remount.
  useEffect(() => {
    document.documentElement.dataset.sidebar = sidebarCollapsed
      ? "collapsed"
      : "open";
  }, [sidebarCollapsed]);
  // Set of keepAlive plugin IDs that have been opened at least once in
  // this session — we keep their React tree + DOM mounted (hidden with
  // `display: none` while another view is active) so state like open
  // browser tabs survives switching plugins. Bounded by the number of
  // plugins with `keepAlive: true` in their manifest (currently 1:
  // `browser`); only those IDs are ever added below. If keepAlive is
  // adopted by many more plugins, add LRU eviction here.
  const [mountedKeepAlive, setMountedKeepAlive] = useState<Set<string>>(() => new Set());
  // Lifted ref to the active plugin's topbar DOM element. A `ref`
  // (not state) because both effects fire in the same commit:
  // `PluginHeaderHost` sets the ref in its mount effect, then
  // `PluginHost` reads it in its mount effect a moment later when
  // calling `mount(opts.headerSlot)`. State would still be stale at
  // that point because React batches updates between effect phases.
  // Plugins consume it via `<PluginHeader>` to portal a dynamic
  // header from inside their main React tree.
  const activeHeaderSlotRef = useRef<HTMLElement | null>(null);
  const setActiveHeaderSlot = useCallback((el: HTMLElement | null) => {
    activeHeaderSlotRef.current = el;
  }, []);
  // Home-screen chrome state lives here so the topbar can own the
  // Edit Layout / Add Widget buttons. Homepage reads/writes these
  // through props — keeps the heading row in one place and avoids
  // duplicating a title both in the shell topbar and in the Home body.
  const [homeEditing, setHomeEditing] = useState(false);
  const [homePickerOpen, setHomePickerOpen] = useState(false);
  const metrics = useStatusMetrics();

  // On mount: detect gamescope mode for scaling
  useEffect(() => {
    isGamescopeMode().then((gs) => {
      setGamescope(gs);
      if (gs && getConfigValue<number | undefined>("uiScale", undefined) === undefined) {
        setScale(GAMESCOPE_SCALE);
      }
    }).catch(() => {});
    // Sync persisted controller shortcuts to the Rust backend on startup
    getControllerShortcuts().then((shortcuts) => {
      setControllerShortcuts(shortcuts).catch(() => {});
    }).catch(() => {});
  }, [setScale]);
  const { ref: mainRef, focusKey: contentFocusKey } = useFocusable({
    focusKey: "content",
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  // Auto-collapse the sidebar while focus lives inside the main content
  // area. Expands automatically when focus returns to the sidebar so the
  // user can see labels again while navigating the plugin list. Manual
  // collapse (via the chevron button) still wins — the manual state and
  // the auto state share a single `sidebarCollapsed` state, so a focus
  // event after a manual toggle will override it; that's intentional so
  // the behavior feels consistent rather than fighting the user.
  useEffect(() => {
    if (!autoCollapse) return;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (!target || !mainRef.current) return;
      const inContent = mainRef.current.contains(target);
      setSidebarCollapsed(inContent);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [autoCollapse, mainRef]);

  // Auto-show the on-screen keyboard whenever a text-like input gains
  // Track which text input the user most recently focused so the
  // dispatcher knows where to deliver keystrokes when the user
  // summons the OSK manually via the footer keyboard icon. Capture-
  // phase so re-entrant focus changes (modals, nested portals) all
  // trigger the same path. CEF child webviews don't surface focus
  // across the process boundary; plugins that embed child webviews
  // are responsible for relaying focus events to the host themselves.
  //
  // The OSK is NEVER opened automatically on focus — closes #123.
  // Auto-popping the keyboard on every input click in Gaming Mode
  // got in the way of users with a physical keyboard AND of users
  // who only wanted to focus an input to read it / paste from the
  // controller. The footer keyboard icon is the single entry point;
  // a follow-up PR will make that affordance more discoverable for
  // controller-only workflows.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Element | null;
      if (isTextLike(target)) rememberLastInput(target);
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => document.removeEventListener("focusin", onFocusIn, true);
  }, []);


  // Sync state from hash changes (back/forward, navigateOverlay() calls)
  useEffect(() => {
    function onHashChange() {
      setRoute(parseHash(window.location.hash));
    }
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
    };
  }, []);

  // Resolve route to active state
  const showSettings = route.view === "settings";
  const showHome = route.view === "home";
  const activePluginId = route.view === "plugin" ? route.pluginId : null;
  const activePlugin = plugins.find((p) => p.id === activePluginId) ?? null;

  // The first time the user opens a keepAlive plugin, add it to the
  // mounted set so subsequent navigation away + back doesn't unmount.
  useEffect(() => {
    if (!activePlugin?.keepAlive) return;
    setMountedKeepAlive((prev) => {
      if (prev.has(activePlugin.id)) return prev;
      const next = new Set(prev);
      next.add(activePlugin.id);
      return next;
    });
  }, [activePlugin]);

  const keepAlivePluginsToRender = plugins.filter((p) => mountedKeepAlive.has(p.id));

  // Probe the active plugin for a `mountHeader` export so the topbar
  // can fall back to a name/subtitle line for plugins that don't ship
  // one. The bar itself is always rendered — that's where the
  // favourite-star sits, and we don't want headerless plugins to lose
  // access to it.
  const pluginHasHeader = usePluginHasHeader(activePlugin);

  // Startup preference: restore last route if configured
  useEffect(() => {
    if (window.location.hash && window.location.hash !== "#/" && window.location.hash !== "#") return;
    const startupView = getConfigValue<string>("startupView", "home");
    if (startupView === "last-tab") {
      const lastRoute = getConfigValue<string | undefined>("lastRoute", undefined);
      if (lastRoute) {
        const parsed = parseHash(lastRoute);
        if (parsed.view !== "home") {
          window.history.replaceState(null, "", lastRoute);
          setRoute(parsed);
        }
      }
    }
  }, []);

  // Persist current route for "resume last view"
  useEffect(() => {
    if (route.view !== "home") {
      setConfigValue("lastRoute", routeToHash(route));
    }
  }, [route]);

  const handleSelectPlugin = useCallback((id: string) => {
    navigateOverlay({ view: "plugin", pluginId: id });
  }, []);

  const handleSelectHome = useCallback(() => {
    navigateOverlay({ view: "home" });
  }, []);

  const handleShowSettings = useCallback(() => {
    navigateOverlay({ view: "settings" });
  }, []);

  const handleScaleChange = useCallback((v: number) => {
    setScale(v);
  }, [setScale]);

  // Scale the UI using CSS `zoom`. Under Chromium (CEF), `zoom` is a
  // first-class layout property — hit-testing, overflow and offset* all
  // agree with the zoomed layout, so touch/pointer coordinates stay
  // aligned. `transform: scale()` also worked visually but split the hit
  // test from the visual transform enough that finger-touch ended up
  // pointing at the wrong element. Legacy note for WebKitGTK: we
  // originally avoided `zoom` because norigin-spatial-navigation's
  // offset*-based measurements were wrong under WebKit. That's moot now
  // that the overlay runs on CEF.
  //
  // `scale` is used directly without dividing by devicePixelRatio —
  // Chromium already handles HiDPI natively. Dividing by DPR here (a
  // leftover from the WebKitGTK days) would double-compensate and put
  // the zoomed layout out of register with where finger-touch lands.
  const scaleFactor = scale;
  const wrapperStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    zoom: scaleFactor,
  };

  if (showWelcome) {
    return (
      <div style={wrapperStyle} className="bg-transparent text-base-content font-sans overflow-clip flex items-center justify-center p-3">
        <div className="flex flex-col flex-1 max-h-full h-full rounded-xl overflow-clip bg-base-100 border border-base-300 shadow-2xl">
          <WelcomeScreen
            plugins={plugins}
            initialEnabled={enabledList}
            loading={loading}
            onClose={() => {
              setWelcomeForceOpen(false);
              if (!getConfigValue<boolean>("welcomeCompleted", false)) {
                setConfigValue("welcomeCompleted", true);
              }
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={wrapperStyle} className="bg-transparent text-base-content font-sans overflow-clip flex items-center justify-center p-3">
        <div className="flex flex-col flex-1 max-h-full h-full rounded-xl overflow-clip bg-base-100 border border-base-300 shadow-2xl">
          {/* DaisyUI drawer — always in grid layout (drawer-open). The
              checkbox state drives `is-drawer-open` / `is-drawer-close`
              variants on Sidebar descendants so they swap between a
              56px icon-only rail and a 256px full list.
              `grid-template-rows: minmax(0, 1fr)` + `overflow-clip` —
              DaisyUI's drawer defaults to `grid-auto-rows: auto` which
              content-sizes the row. Inside a `flex-1 min-h-0` parent
              that feedback loop lets the row balloon past the drawer
              and plugin content ends up covering the status bar below.
              Pinning the row to a single `1fr` track fixes it.
              `overflow-clip` (not `overflow-hidden`) is critical:
              DaisyUI sizes `.drawer-side` to 100vh which overflows the
              drawer row by ~191px. `overflow-hidden` clips visually
              but STILL creates a scroll container, so any focus change
              fires `scrollIntoView` which walks up ancestors and
              *programmatically* scrolls the drawer, dragging
              drawer-content + the topbar off the top of the viewport.
              `overflow: clip` clips without creating a scroll container
              — immune to programmatic scrolls. */}
          <div
            className="drawer drawer-open flex-1 min-h-0 overflow-clip"
            style={{ gridTemplateRows: "minmax(0, 1fr)" }}
          >
            <input
              id="sl-drawer"
              type="checkbox"
              className="drawer-toggle"
              checked={!sidebarCollapsed}
              onChange={(e) => setSidebarCollapsed(!e.target.checked)}
            />

            <div className="drawer-content flex flex-col min-w-0 min-h-0 h-full overflow-clip">
              {/* Page title bar — shows current view name + subtitle.
                  Height + typography match the Loadout handoff's .topbar.
                  Always rendered: the favourite-star anchors here and
                  needs to be reachable from every view, including
                  plugins that don't export `mountHeader`. For those,
                  we fall back to a `DefaultHeader` populated from the
                  plugin's manifest (name + subtitle/description) so
                  the slot isn't empty and the layout matches every
                  other plugin's topbar shape. */}
              <div className="shrink-0 h-[60px] px-8 flex items-center justify-between border-b border-base-300 gap-4">
                {showSettings ? (
                  <DefaultHeader
                    title="Settings"
                    sub="App preferences · theme · controller shortcuts"
                  />
                ) : activePlugin ? (
                  pluginHasHeader === false ? (
                    <DefaultHeader
                      title={activePlugin.name}
                      sub={activePlugin.subtitle ?? activePlugin.description}
                    />
                  ) : (
                    <PluginHeaderHost
                      key={activePlugin.id}
                      plugin={activePlugin}
                      onSlot={setActiveHeaderSlot}
                    />
                  )
                ) : (
                  <DefaultHeader
                    title={showHome ? "Home" : "Loadout"}
                    sub={showHome ? "Dashboard overview · drag widgets to rearrange" : undefined}
                  />
                )}
                {activePlugin && (
                  <div className="flex items-center gap-2 shrink-0">
                    <PluginFavoriteButton pluginId={activePlugin.id} />
                  </div>
                )}
                {showHome && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      className={`btn btn-sm ${homeEditing ? "btn-primary" : "btn-ghost"}`}
                      onClick={() => setHomeEditing((v) => !v)}
                    >
                      {homeEditing ? (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                          Done
                        </>
                      ) : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                          </svg>
                          Edit Layout
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => setHomePickerOpen(true)}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                      </svg>
                      Add Widget
                    </button>
                  </div>
                )}
              </div>

              <FocusContext.Provider value={contentFocusKey}>
                {/* `overflow-clip` (not `auto`/`hidden`): every plugin
                    provides its own `h-full overflow-y-auto` root, so
                    <main> itself must never be a scroll container —
                    otherwise focus-driven `scrollIntoView` can drag
                    the plugin view around behind the user's back. */}
                <main ref={mainRef} className="flex-1 min-h-0 overflow-clip relative">
                  {/* Keep-alive plugins stay mounted across navigation.
                      `display: none` isn't enough: Electrobun's native
                      `<electrobun-webview>` elements (used by the browser
                      plugin) are OS-level overlays that float above the
                      DOM — their visibility tracks the host element's
                      bounding rect, not CSS display. Moving the host
                      far off-screen with `translate` + disabling pointer
                      events + `inert` is the reliable way to hide them
                      without tearing down their state. */}
                  {keepAlivePluginsToRender.map((p) => {
                    const active = p.id === activePluginId && !showSettings;
                    const inertProp = active ? {} : { inert: "" };
                    return (
                      <div
                        key={p.id}
                        aria-hidden={!active}
                        className="absolute inset-0"
                        style={
                          active
                            ? undefined
                            : {
                                transform: "translateX(-200vw)",
                                pointerEvents: "none",
                                visibility: "hidden",
                              }
                        }
                        {...inertProp}
                      >
                        <ErrorBoundary pluginId={p.id} pluginName={p.name}>
                          <PluginHost
                            plugin={p}
                            headerSlotRef={p.id === activePluginId ? activeHeaderSlotRef : undefined}
                          />
                        </ErrorBoundary>
                      </div>
                    );
                  })}

                  {/* Non-keep-alive views: standard mount/unmount
                      lifecycle — the keyed wrapper triggers enter
                      animation on route change. */}
                  {(() => {
                    const activeIsKeepAlive = Boolean(activePlugin?.keepAlive);
                    const renderNormal = !activeIsKeepAlive || showSettings;
                    if (!renderNormal) return null;
                    return (
                      <div
                        key={showSettings ? "__settings" : activePluginId ?? "__home"}
                        className="absolute inset-0 animate-[viewEnter_180ms_ease-out]"
                      >
                        {showSettings ? (
                          <Settings
                            scale={scale}
                            onScaleChange={handleScaleChange}
                            plugins={plugins}
                            onShowWelcome={() => setWelcomeForceOpen(true)}
                          />
                        ) : activePlugin ? (
                          <ErrorBoundary
                            key={activePlugin.id}
                            pluginId={activePlugin.id}
                            pluginName={activePlugin.name}
                          >
                            <PluginHost
                              plugin={activePlugin}
                              headerSlotRef={activeHeaderSlotRef}
                            />
                          </ErrorBoundary>
                        ) : showHome ? (
                          <Homepage
                            plugins={visiblePlugins}
                            isEditing={homeEditing}
                            pickerOpen={homePickerOpen}
                            onClosePicker={() => setHomePickerOpen(false)}
                          />
                        ) : (
                          <SplashScreen loading={loading} />
                        )}
                      </div>
                    );
                  })()}
                </main>
              </FocusContext.Provider>
            </div>

            {/* `h-full min-h-0` pins drawer-side to its grid row.
                DaisyUI's default `drawer-side` styling sets `height:
                100vh`, which overflows the drawer by the statusbar's
                height when we're inside a flex container, rather than
                the viewport. Without this, the drawer-side is taller
                than the drawer and becomes the reason `scrollIntoView`
                could scroll the drawer programmatically. */}
            <div className="drawer-side is-drawer-close:overflow-visible h-full min-h-0">
              <label htmlFor="sl-drawer" aria-label="close sidebar" className="drawer-overlay" />
              <Sidebar
                plugins={visiblePlugins}
                activePluginId={activePluginId}
                onSelectPlugin={handleSelectPlugin}
                loading={loading}
                showHome={showHome}
                onSelectHome={handleSelectHome}
                showSettings={route.view === "settings"}
                onSelectSettings={handleShowSettings}
                onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
              />
            </div>
          </div>

          {/* App-wide on-screen keyboard. Renders nothing when hidden;
              when visible, takes ~40 vh from the bottom of the column.
              <main> is `flex-1 min-h-0`, so plugin content shrinks to
              accommodate rather than being covered. */}
          <OverlayKeyboard />

          {/* Slim status bar — spans the full width below the drawer.
              Loadout-style layout: connection indicator + shell metadata
              on the left, live telemetry + Settings cog on the right.
              Settings lives here (not in the sidebar) so it's always
              reachable at any UI scale. */}
          <div className="shrink-0 h-8 px-3.5 flex items-center gap-3.5 border-t border-base-300 bg-base-100 text-[11.5px] text-base-content/70">
            <span className="w-[7px] h-[7px] rounded-full bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-success)_25%,transparent)]" />
            <span className="font-medium text-base-content">Connected to Steam</span>
            <span className="w-px h-3.5 bg-base-300" />
            <span className="mono text-base-content/60">
              {plugins.length} plugins loaded
            </span>
            <div className="flex-1" />
            {metrics.cpuTemp != null && (
              <span className="mono">
                CPU <span className="text-base-content">{Math.round(metrics.cpuTemp)}°</span>
              </span>
            )}
            {metrics.fanRpm != null && (
              <span className="mono">
                FAN <span className="text-base-content">{Math.round(metrics.fanRpm)}</span>
              </span>
            )}
            {metrics.batteryPct != null && (
              <span className="mono">
                {metrics.charging ? "⚡ " : ""}{Math.round(metrics.batteryPct)}%
              </span>
            )}
            <KeyboardToggleButton />
            <Focusable focusKey="sidebar-settings" onActivate={handleShowSettings}>
              <button
                type="button"
                onClick={handleShowSettings}
                aria-label="Settings"
                title="Settings"
                className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                  showSettings
                    ? "bg-primary/20 text-primary"
                    : "text-base-content/60 hover:text-base-content hover:bg-base-300/70"
                }`}
                tabIndex={-1}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </Focusable>
          </div>
        </div>
      </div>

    </>
  );
}

// Footer toggle for the overlay-wide on-screen keyboard. Mirrors the
// Settings cog's shape so the two icons feel like a pair. Visibility is
// driven by the `__SL_OSK__` singleton, so this stays in sync regardless
// of whether the user opened the keyboard via this button or an input
// focus elsewhere in the overlay.
function KeyboardToggleButton() {
  const { visible, toggle } = useOverlayKeyboard();
  return (
    <Focusable focusKey="footer-keyboard" onActivate={toggle}>
      <button
        type="button"
        onClick={toggle}
        aria-label={visible ? "Hide keyboard" : "Show keyboard"}
        title={visible ? "Hide keyboard" : "Show keyboard"}
        className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors ${
          visible
            ? "bg-primary/20 text-primary"
            : "text-base-content/60 hover:text-base-content hover:bg-base-300/70"
        }`}
        tabIndex={-1}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path strokeLinecap="round" d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
        </svg>
      </button>
    </Focusable>
  );
}

function SplashScreen({ loading }: { loading: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-2xl font-extrabold text-white shadow-lg">
        SL
      </div>
      <h1 className="text-2xl font-bold text-base-content">Loadout</h1>
      <p className="text-sm text-base-content/40">
        {loading ? "Loading plugins..." : "Select a plugin from the sidebar"}
      </p>
      <div className="flex gap-6 mt-4">
        {[
          { key: "D-pad", action: "Navigate" },
          { key: "A", action: "Select" },
          { key: "B", action: "Back" },
        ].map((hint) => (
          <div key={hint.key} className="flex items-center gap-2 text-sm text-base-content/25">
            <kbd className="kbd kbd-sm">{hint.key}</kbd>
            <span>{hint.action}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
