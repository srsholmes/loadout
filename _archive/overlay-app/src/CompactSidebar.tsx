import { useCallback, useEffect } from "react";
import { SteamLoaderProvider } from "@loadout/ui";
import { GamepadNavProvider, useFocusable, FocusContext, Focusable } from "./GamepadNav";
import { usePlugins } from "./hooks/usePlugins";
import { WidgetHost } from "./WidgetHost";
import { navigate } from "./App";
import { colors } from "./styles";

const GAMESCOPE = (() => {
  try {
    return new URLSearchParams(window.location.search).get("gamescope") === "1";
  } catch { return false; }
})();

const QAM_SCALE = GAMESCOPE ? 1.3 : 1;

/** Switch to expanded overlay mode, setting the hash route first. */
function openOverlay(hash?: string) {
  if (hash) {
    // Set hash before mode switch so App reads the right route on mount
    window.history.pushState(null, "", hash);
  }
  (window as any).__LOADOUT_MODE__ = "expanded";
  window.dispatchEvent(new CustomEvent("loadout-mode", { detail: "expanded" }));
}

/**
 * Compact sidebar — slides over the game/Steam UI for quick access.
 *
 * Rendered when the overlay loads with ?mode=qam. This is a standalone
 * view (not part of the full overlay layout). Shows a vertical strip of
 * compact plugin widgets. D-pad ↑↓ navigates between widgets.
 *
 * Hidden via title change signal ("__HIDE_OVERLAY__") when the user
 * presses B at the top level.
 */
export function CompactSidebar() {
  return (
    <SteamLoaderProvider>
      <GamepadNavProvider>
        <CompactSidebarInner />
      </GamepadNavProvider>
    </SteamLoaderProvider>
  );
}

function CompactSidebarInner() {
  const { plugins, loading } = usePlugins();
  const { ref: navRef, focusKey } = useFocusable({
    focusKey: "compact-sidebar",
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  const handleClose = useCallback(() => {
    document.title = "__HIDE_OVERLAY__";
    // Reset title after a tick so it can fire again
    setTimeout(() => { document.title = "Loadout"; }, 100);
  }, []);

  // Apply zoom at document level — scales content + layout, overflow scrolls.
  useEffect(() => {
    if (QAM_SCALE !== 1) {
      document.documentElement.style.zoom = String(QAM_SCALE);
      return () => { document.documentElement.style.zoom = "1"; };
    }
  }, []);

  return (
    <div style={rootStyle}>
      <FocusContext.Provider value={focusKey}>
        <nav ref={navRef} style={panelStyle}>
          {/* Header */}
          <div style={headerStyle}>
            <span style={headerTitleStyle}>Quick Access</span>
            <div style={headerActionsStyle}>
              <Focusable onActivate={() => openOverlay("#/settings")} style={iconBtnFocusableStyle}>
                <button
                  style={headerIconBtnStyle}
                  onClick={() => openOverlay("#/settings")}
                  title="Settings"
                >
                  &#9881;
                </button>
              </Focusable>
              <Focusable onActivate={() => openOverlay()} style={iconBtnFocusableStyle}>
                <button
                  style={headerIconBtnStyle}
                  onClick={() => openOverlay()}
                  title="Open Full Overlay"
                >
                  &#x2922;
                </button>
              </Focusable>
              <Focusable onActivate={handleClose} style={iconBtnFocusableStyle}>
                <button style={headerIconBtnStyle} onClick={handleClose} title="Close (B)">
                  &#x2715;
                </button>
              </Focusable>
            </div>
          </div>

          {/* Widget list */}
          <div style={widgetListStyle}>
            {loading && plugins.length === 0 && (
              <div style={emptyStyle}>Loading...</div>
            )}
            {plugins.map((plugin) => (
              <Focusable
                key={plugin.id}
                onActivate={() => openOverlay(`#/plugin/${plugin.id}`)}
                style={widgetSlotStyle}
              >
                <WidgetHost
                  plugin={plugin}
                  parentFocusKey={`compact-widget-${plugin.id}`}
                  onOpen={() => openOverlay(`#/plugin/${plugin.id}`)}
                />
              </Focusable>
            ))}
          </div>
        </nav>
      </FocusContext.Provider>
    </div>
  );
}

// --- Styles ---

const rootStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  display: "flex",
  justifyContent: "flex-end",
  pointerEvents: "none",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  color: colors.text,
};

const panelStyle: React.CSSProperties = {
  width: "min(320px, 40vw)",
  height: "100%",
  background: "rgba(14, 14, 26, 0.92)",
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
  boxShadow: "-4px 0 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06)",
  display: "flex",
  flexDirection: "column",
  pointerEvents: "auto",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "14px 16px 10px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
  flexShrink: 0,
};

const headerTitleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "#ffffff",
};

const headerActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
};

const iconBtnFocusableStyle: React.CSSProperties = {
  borderRadius: 6,
};

const headerIconBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: colors.textSecondary,
  fontSize: 16,
  cursor: "pointer",
  padding: "10px 12px",
  minWidth: 44,
  minHeight: 44,
  borderRadius: 6,
  lineHeight: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const widgetListStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "6px 8px",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const emptyStyle: React.CSSProperties = {
  padding: 16,
  color: colors.textSecondary,
  fontSize: 13,
  textAlign: "center",
};

const widgetSlotStyle: React.CSSProperties = {
  borderRadius: 8,
  transition: "background 0.12s",
};
