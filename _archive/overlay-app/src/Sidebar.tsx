import { useState, useEffect, useCallback } from "react";
import type { PluginInfo } from "./hooks/usePlugins";
import { useFocusable, FocusContext, Focusable } from "./GamepadNav";
import { colors } from "./styles";

export interface SidebarProps {
  plugins: PluginInfo[];
  activePluginId: string | null;
  onSelectPlugin: (id: string) => void;
  loading: boolean;
  showSettings: boolean;
  onShowSettings: () => void;
}

/** Returns true when the viewport is at or below 640px. */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 640px)").matches
      : false,
  );

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 640px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return isMobile;
}

/**
 * Left sidebar showing the list of installed plugins.
 * Each plugin is a clickable row with an icon and name.
 *
 * On viewports <= 640px the sidebar collapses to a narrow icon rail (60px).
 * Tapping the hamburger button expands the full sidebar as an overlay panel.
 */
export function Sidebar({ plugins, activePluginId, onSelectPlugin, loading, showSettings, onShowSettings }: SidebarProps) {
  const [settingsHovered, setSettingsHovered] = useState(false);
  const isMobile = useIsMobile();
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const { ref: navRef, focusKey } = useFocusable({
    focusKey: "sidebar",
    trackChildren: true,
    saveLastFocusedChild: true,
  });

  // Close the mobile overlay when the viewport goes back to desktop
  useEffect(() => {
    if (!isMobile) setMobileExpanded(false);
  }, [isMobile]);

  const handleSelectPlugin = useCallback(
    (id: string) => {
      onSelectPlugin(id);
      if (isMobile) setMobileExpanded(false);
    },
    [onSelectPlugin, isMobile],
  );

  const handleShowSettings = useCallback(() => {
    onShowSettings();
    if (isMobile) setMobileExpanded(false);
  }, [onShowSettings, isMobile]);

  // --- Collapsed icon rail (mobile only) ---
  const collapsed = isMobile && !mobileExpanded;

  const currentSidebarStyle: React.CSSProperties = collapsed
    ? { ...sidebarStyle, width: 60, minWidth: 60 }
    : isMobile
      ? { ...sidebarStyle, ...mobileExpandedStyle }
      : sidebarStyle;

  return (
    <>
      {/* Backdrop scrim when mobile sidebar is expanded */}
      {isMobile && mobileExpanded && (
        <div
          style={backdropStyle}
          onClick={() => setMobileExpanded(false)}
        />
      )}

      <FocusContext.Provider value={focusKey}>
      <nav ref={navRef} style={currentSidebarStyle}>
        {/* Header */}
        <div style={collapsed ? headerCollapsedStyle : headerStyle}>
          {isMobile && (
            <button
              style={hamburgerButtonStyle}
              onClick={() => setMobileExpanded((prev) => !prev)}
              aria-label={mobileExpanded ? "Collapse sidebar" : "Expand sidebar"}
            >
              <span style={hamburgerIconStyle}>{mobileExpanded ? "\u2715" : "\u2630"}</span>
            </button>
          )}
          {!collapsed && (
            <>
              <div style={logoStyle}>SL</div>
              <span style={brandStyle}>Loadout</span>
            </>
          )}
        </div>

        {/* Plugin list */}
        <div style={pluginListStyle}>
          {loading && plugins.length === 0 && (
            <div style={emptyStyle}>{collapsed ? "..." : "Loading..."}</div>
          )}
          {plugins.map((plugin) => (
            <Focusable
              key={plugin.id}
              onActivate={() => handleSelectPlugin(plugin.id)}
              style={focusableItemStyle}
            >
              <SidebarItem
                plugin={plugin}
                active={plugin.id === activePluginId}
                collapsed={collapsed}
                onClick={() => handleSelectPlugin(plugin.id)}
              />
            </Focusable>
          ))}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <Focusable onActivate={handleShowSettings} style={focusableItemStyle}>
            <button
              style={{
                ...settingsButtonStyle,
                justifyContent: collapsed ? "center" : "flex-start",
                padding: collapsed ? "8px 0" : "8px 10px",
                background: showSettings ? `${colors.accent}22` : settingsHovered ? "#ffffff08" : "transparent",
              }}
              onClick={handleShowSettings}
              onMouseEnter={() => setSettingsHovered(true)}
              onMouseLeave={() => setSettingsHovered(false)}
              tabIndex={-1}
            >
              <span style={settingsIconStyle}>&#9881;</span>
              {!collapsed && <span>Settings</span>}
            </button>
          </Focusable>
          {!collapsed && <span style={footerTextStyle}>v0.1.0</span>}
        </div>
      </nav>
      </FocusContext.Provider>
    </>
  );
}

function SidebarItem({
  plugin,
  active,
  collapsed,
  onClick,
}: {
  plugin: PluginInfo;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  const currentItemStyle: React.CSSProperties = {
    ...itemStyle,
    justifyContent: collapsed ? "center" : "flex-start",
    padding: collapsed ? "8px 0" : "10px 12px",
    minHeight: 44,
    background: active ? `${colors.accent}22` : hovered ? "#ffffff08" : "transparent",
  };

  return (
    <button
      style={currentItemStyle}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={collapsed ? plugin.name : plugin.description}
      tabIndex={-1}
    >
      <div style={iconStyle}>
        {plugin.icon ? plugin.icon.charAt(0).toUpperCase() : plugin.name.charAt(0).toUpperCase()}
      </div>
      {!collapsed && (
        <div style={itemTextStyle}>
          <div style={itemNameStyle}>{plugin.name}</div>
          <div style={itemDescStyle}>{plugin.description}</div>
        </div>
      )}
    </button>
  );
}

// --- Styles ---

const focusableItemStyle: React.CSSProperties = {
  borderRadius: 6,
};

const sidebarStyle: React.CSSProperties = {
  width: 240,
  minWidth: 240,
  height: "100%",
  background: "rgba(15, 52, 96, 0.7)",
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid rgba(255, 255, 255, 0.06)",
};

/** Mobile expanded: overlay on top of content */
const mobileExpandedStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  bottom: 0,
  zIndex: 100,
  width: 240,
  minWidth: 240,
  background: "rgba(15, 52, 96, 0.97)",
  boxShadow: "4px 0 24px rgba(0, 0, 0, 0.5)",
};

const backdropStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 99,
  background: "rgba(0, 0, 0, 0.4)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "16px 16px 12px",
  borderBottom: `1px solid ${colors.surface}`,
};

const headerCollapsedStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "16px 0 12px",
  borderBottom: "1px solid #1a1a2e",
};

const hamburgerButtonStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "#dcdedf",
  flexShrink: 0,
};

const hamburgerIconStyle: React.CSSProperties = {
  fontSize: 20,
  lineHeight: 1,
};

const logoStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: `linear-gradient(135deg, ${colors.accent}, #0073e6)`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 14,
  fontWeight: 700,
  color: "#fff",
  flexShrink: 0,
};

const brandStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "#ffffff",
};

const pluginListStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "8px 0",
};

const emptyStyle: React.CSSProperties = {
  padding: "16px",
  color: colors.textSecondary,
  fontSize: 13,
  textAlign: "center",
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "10px 12px",
  minHeight: 44,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
  color: colors.text,
  transition: "background 0.12s",
};

const iconStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: "#23233a",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 14,
  fontWeight: 600,
  color: colors.accent,
  flexShrink: 0,
};

const itemTextStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
};

const itemNameStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const itemDescStyle: React.CSSProperties = {
  fontSize: 11,
  color: colors.textSecondary,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const footerStyle: React.CSSProperties = {
  padding: "8px 8px 12px",
  borderTop: `1px solid ${colors.surface}`,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const settingsButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "10px 10px",
  minHeight: 44,
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  color: colors.text,
  fontSize: 13,
  fontWeight: 500,
  textAlign: "left",
  transition: "background 0.12s",
  minHeight: 44,
};

const settingsIconStyle: React.CSSProperties = {
  fontSize: 16,
};

const footerTextStyle: React.CSSProperties = {
  fontSize: 11,
  color: colors.textSecondary,
  paddingLeft: 10,
};
