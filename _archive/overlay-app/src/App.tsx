import { useState, useEffect, useCallback } from "react";
import { SteamLoaderProvider } from "@loadout/ui";
import { Sidebar } from "./Sidebar";
import { PluginHost } from "./PluginHost";
import { Settings } from "./Settings";
import { QuickMenu } from "./QuickMenu";
import { usePlugins } from "./hooks/usePlugins";
import { GamepadNavProvider, useFocusable, FocusContext } from "./GamepadNav";
import { ErrorBoundary } from "./ErrorBoundary";
import { StatusIndicator } from "./StatusIndicator";
import { colors } from "./styles";

// ---------------------------------------------------------------------------
// Hash routing — #/plugin/<id> | #/settings | #/
// ---------------------------------------------------------------------------

type Route =
  | { view: "plugin"; pluginId: string }
  | { view: "settings" }
  | { view: "home" };

function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h === "settings") return { view: "settings" };
  if (h.startsWith("plugin/")) {
    const id = h.slice("plugin/".length);
    if (id) return { view: "plugin", pluginId: id };
  }
  return { view: "home" };
}

function routeToHash(route: Route): string {
  switch (route.view) {
    case "settings": return "#/settings";
    case "plugin":   return `#/plugin/${route.pluginId}`;
    default:         return "#/";
  }
}

/** Navigate via hash — pushes history so back/forward work. */
export function navigate(route: Route) {
  const hash = routeToHash(route);
  if (window.location.hash !== hash) {
    window.history.pushState(null, "", hash);
  }
  // Notify listeners (hashchange doesn't fire for pushState)
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

const SCALE_KEY = "loadout-ui-scale-v2";

function isGamescope(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("gamescope") === "1";
  } catch {}
  return false;
}

const GAMESCOPE = isGamescope();
const DEFAULT_SCALE = GAMESCOPE ? 1.2 : 1;

function loadScale(): number {
  try {
    const v = localStorage.getItem(SCALE_KEY);
    if (v) return Math.max(0.75, Math.min(2, parseFloat(v)));
  } catch {}
  return DEFAULT_SCALE;
}

/**
 * Root overlay application.
 *
 * Layout: fixed sidebar on the left with plugin list, main content area on the
 * right that renders the active plugin's React app. The shell provides routing,
 * theme, and the WebSocket provider so every plugin has access to its backend.
 *
 * Wrapped in SteamLoaderProvider (WebSocket) and GamepadNavProvider (d-pad/A/B
 * navigation). The quick menu slides in from the right (F10 or hardware button).
 */
export function App() {
  return (
    <SteamLoaderProvider>
      <GamepadNavProvider>
        <AppInner />
      </GamepadNavProvider>
    </SteamLoaderProvider>
  );
}

/** Inner app component that can use GamepadNav hooks. */
function AppInner() {
  const { plugins, loading } = usePlugins();
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [showQuickMenu, setShowQuickMenu] = useState(false);
  const [scale, setScale] = useState(loadScale);
  const { ref: mainRef, focusKey: contentFocusKey } = useFocusable({
    focusKey: "content",
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  // Sync state from hash changes (back/forward, navigate() calls)
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

  // Resolve route to active state — fall back to first plugin for home/missing
  const showSettings = route.view === "settings";
  const activePluginId = route.view === "plugin" ? route.pluginId : null;
  const activePlugin = plugins.find((p) => p.id === activePluginId) ?? null;

  // If on home or plugin not found, default to first plugin
  useEffect(() => {
    if (plugins.length === 0) return;
    if (showSettings) return;
    if (activePlugin) return;
    // Replace (not push) so we don't pollute history with the redirect
    const hash = `#/plugin/${plugins[0].id}`;
    window.history.replaceState(null, "", hash);
    setRoute({ view: "plugin", pluginId: plugins[0].id });
  }, [plugins, showSettings, activePlugin]);

  // Toggle quick menu with F10 (placeholder for hardware button)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "F10") {
        e.preventDefault();
        setShowQuickMenu((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleSelectPlugin = useCallback((id: string) => {
    navigate({ view: "plugin", pluginId: id });
  }, []);

  const handleShowSettings = useCallback(() => {
    navigate({ view: "settings" });
  }, []);

  const handleScaleChange = useCallback((v: number) => {
    setScale(v);
    try { localStorage.setItem(SCALE_KEY, String(v)); } catch {}
  }, []);

  const handleQuickMenuClose = useCallback(() => {
    setShowQuickMenu(false);
  }, []);

  // Apply zoom at the document level — scales content + layout so overflow
  // scrolls naturally (unlike transform: scale which clips).
  useEffect(() => {
    document.documentElement.style.zoom = String(scale);
    return () => { document.documentElement.style.zoom = "1"; };
  }, [scale]);

  return (
    <>
      <div style={rootStyle}>
        <div style={shellStyle}>
          <div style={contentRowStyle}>
            <Sidebar
              plugins={plugins}
              activePluginId={activePluginId}
              onSelectPlugin={handleSelectPlugin}
              loading={loading}
              showSettings={showSettings}
              onShowSettings={handleShowSettings}
            />
            <FocusContext.Provider value={contentFocusKey}>
              <main ref={mainRef} style={mainStyle}>
                {showSettings ? (
                  <Settings scale={scale} onScaleChange={handleScaleChange} />
                ) : activePlugin ? (
                  <ErrorBoundary
                    key={activePlugin.id}
                    pluginId={activePlugin.id}
                    pluginName={activePlugin.name}
                  >
                    <PluginHost plugin={activePlugin} />
                  </ErrorBoundary>
                ) : (
                  <SplashScreen loading={loading} />
                )}
              </main>
            </FocusContext.Provider>
          </div>
          <div style={footerBarStyle}>
            <StatusIndicator />
          </div>
        </div>
      </div>
      <QuickMenu visible={showQuickMenu} onClose={handleQuickMenuClose} />
    </>
  );
}

function SplashScreen({ loading }: { loading: boolean }) {
  return (
    <div style={splashStyle}>
      <div style={splashLogoStyle}>
        <div style={logoIconStyle}>SL</div>
        <h1 style={splashTitleStyle}>Loadout</h1>
      </div>
      <p style={splashSubtitleStyle}>
        {loading
          ? "Loading plugins..."
          : "Select a plugin from the sidebar to get started"}
      </p>
      <p style={splashHintStyle}>
        D-pad \u2191\u2193 navigate \u2022 A expand \u2022 B back
      </p>
    </div>
  );
}

// --- Styles ---

const rootStyle: React.CSSProperties = {
  display: "flex",
  width: "100vw",
  height: "100vh",
  padding: 40,
  background: "transparent",
  color: colors.text,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  overflow: "hidden",
  pointerEvents: "none",
};

const shellStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  borderRadius: 16,
  overflow: "hidden",
  background: "rgba(26, 26, 46, 0.92)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08)",
  pointerEvents: "auto",
};

const contentRowStyle: React.CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

const mainStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  background: "rgba(22, 33, 62, 0.6)",
};

const splashStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  gap: 16,
  background: "transparent",
};

const splashLogoStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
};

const logoIconStyle: React.CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 12,
  background: `linear-gradient(135deg, ${colors.accent}, #0073e6)`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 20,
  fontWeight: 700,
  color: "#fff",
};

const splashTitleStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  color: "#ffffff",
  margin: 0,
};

const splashSubtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: colors.textSecondary,
  margin: 0,
};

const splashHintStyle: React.CSSProperties = {
  fontSize: 12,
  color: colors.textSecondary,
  margin: "8px 0 0 0",
  opacity: 0.6,
};

const footerBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "6px 8px",
  borderTop: "1px solid rgba(255, 255, 255, 0.06)",
  flexShrink: 0,
};

