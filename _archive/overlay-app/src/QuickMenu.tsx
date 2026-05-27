import { useState, useEffect, useCallback } from "react";
import { useBackend } from "@loadout/ui";
import { TDPWidget } from "./TDPWidget";
import { SystemMonitorWidget } from "./SystemMonitorWidget";
import { usePlugins, type PluginInfo } from "./hooks/usePlugins";
import { useFocusable, FocusContext, Focusable } from "./GamepadNav";
import { navigate } from "./App";
import { colors } from "./styles";

export interface QuickMenuProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * Slide-out quick menu panel.
 * Appears from the right edge of the screen (~320px wide) with a smooth
 * CSS transition. Contains widget slots for plugins and a built-in
 * "Plugins" section with enable/disable toggles.
 *
 * Features:
 * - Semi-transparent background with backdrop blur
 * - Gamepad-navigable via Focusable wrappers and zone registration
 * - Auto-dismisses when a game launches (via "game-launch" WebSocket event)
 * - Keyboard: Escape or B button closes the menu
 */
export function QuickMenu({ visible, onClose }: QuickMenuProps) {
  const { plugins } = usePlugins();
  const [disabledPlugins, setDisabledPlugins] = useState<Set<string>>(new Set());
  const { ref: zoneRef, focusKey, focusSelf } = useFocusable({
    focusKey: "quickmenu",
    trackChildren: true,
    saveLastFocusedChild: true,
    focusable: visible,
  });
  const { useEvent } = useBackend("system-monitor");

  useEffect(() => {
    if (visible) focusSelf();
  }, [visible, focusSelf]);

  // Auto-dismiss when a game launches
  useEvent({
    event: "game-launch",
    handler: useCallback(() => {
      onClose();
    }, [onClose]),
  });

  // Close on Escape key
  useEffect(() => {
    if (!visible) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visible, onClose]);

  const togglePlugin = useCallback((id: string) => {
    setDisabledPlugins((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <div
      style={{
        ...backdropStyle,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
      onClick={onClose}
    >
      <FocusContext.Provider value={focusKey}>
      <div
        ref={zoneRef}
        style={{
          ...panelStyle,
          transform: visible ? "translateX(0)" : "translateX(100%)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={headerStyle}>
          <span style={headerTitleStyle}>Quick Menu</span>
          <div style={headerActionsStyle}>
            <Focusable onActivate={() => { onClose(); navigate({ view: "settings" }); }} style={closeButtonWrapperStyle}>
              <button
                style={closeButtonStyle}
                onClick={() => { onClose(); navigate({ view: "settings" }); }}
                title="Settings"
              >
                &#9881;
              </button>
            </Focusable>
            <Focusable onActivate={onClose} style={closeButtonWrapperStyle}>
              <button style={closeButtonStyle} onClick={onClose} title="Close (Esc)">
                &#x2715;
              </button>
            </Focusable>
          </div>
        </div>

        {/* Widget area */}
        <div style={contentStyle}>
          <SystemMonitorWidget />
          <TDPWidget />

          {/* Plugins section */}
          <div style={pluginsSectionStyle}>
            <div style={pluginsSectionTitleStyle}>Plugins</div>
            {plugins.length === 0 && (
              <div style={noPluginsStyle}>No plugins loaded</div>
            )}
            {plugins.map((plugin) => (
              <PluginToggleRow
                key={plugin.id}
                plugin={plugin}
                enabled={!disabledPlugins.has(plugin.id)}
                onToggle={() => togglePlugin(plugin.id)}
              />
            ))}
          </div>
        </div>
      </div>
      </FocusContext.Provider>
    </div>
  );
}

function PluginToggleRow({
  plugin,
  enabled,
  onToggle,
}: {
  plugin: PluginInfo;
  enabled: boolean;
  onToggle: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <Focusable onActivate={onToggle} style={focusableRowStyle}>
      <div
        style={{
          ...pluginRowStyle,
          background: hovered ? "#ffffff08" : "transparent",
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div style={pluginInfoStyle}>
          <div style={pluginIconStyle}>
            {plugin.icon
              ? plugin.icon.charAt(0).toUpperCase()
              : plugin.name.charAt(0).toUpperCase()}
          </div>
          <div style={pluginTextStyle}>
            <div style={pluginNameStyle}>{plugin.name}</div>
            <div style={pluginVersionStyle}>v{plugin.version}</div>
          </div>
        </div>
        <button
          style={{
            ...toggleStyle,
            background: enabled ? colors.accent : "#3d4450",
          }}
          onClick={onToggle}
          tabIndex={-1}
          title={enabled ? "Disable plugin" : "Enable plugin"}
        >
          <div
            style={{
              ...toggleKnobStyle,
              transform: enabled ? "translateX(16px)" : "translateX(0)",
            }}
          />
        </button>
      </div>
    </Focusable>
  );
}

// --- Styles ---

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(0, 0, 0, 0.35)",
  backdropFilter: "blur(4px)",
  WebkitBackdropFilter: "blur(4px)",
  zIndex: 10000,
  transition: "opacity 300ms ease-out",
};

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  width: 340,
  height: "100%",
  background: "rgba(14, 14, 26, 0.88)",
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
  boxShadow:
    "-4px 0 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06)",
  display: "flex",
  flexDirection: "column",
  transition: "transform 300ms cubic-bezier(0.4, 0.0, 0.2, 1)",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px 16px 12px",
  borderBottom: `1px solid rgba(255, 255, 255, 0.08)`,
  flexShrink: 0,
};

const headerTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "#ffffff",
};

const headerActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
};

const closeButtonWrapperStyle: React.CSSProperties = {
  borderRadius: 6,
};

const closeButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: colors.textSecondary,
  fontSize: 16,
  cursor: "pointer",
  padding: "10px 12px",
  minWidth: 44,
  minHeight: 44,
  borderRadius: 4,
  lineHeight: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const contentStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 12,
};

const pluginsSectionStyle: React.CSSProperties = {
  marginTop: 8,
  background: colors.surface,
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  overflow: "hidden",
};

const pluginsSectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: colors.textSecondary,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "10px 14px 6px",
};

const noPluginsStyle: React.CSSProperties = {
  fontSize: 12,
  color: colors.textSecondary,
  padding: "8px 14px 12px",
  fontStyle: "italic",
};

const focusableRowStyle: React.CSSProperties = {
  borderRadius: 4,
};

const pluginRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "8px 14px",
  minHeight: 44,
  transition: "background 0.12s",
};

const pluginInfoStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  minWidth: 0,
};

const pluginIconStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  background: "#23233a",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  fontWeight: 600,
  color: colors.accent,
  flexShrink: 0,
};

const pluginTextStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
};

const pluginNameStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: colors.text,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const pluginVersionStyle: React.CSSProperties = {
  fontSize: 10,
  color: colors.textSecondary,
};

const toggleStyle: React.CSSProperties = {
  width: 38,
  height: 22,
  borderRadius: 11,
  border: "none",
  cursor: "pointer",
  padding: 3,
  flexShrink: 0,
  transition: "background 0.2s",
  position: "relative",
};

const toggleKnobStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: "50%",
  background: "#ffffff",
  transition: "transform 0.2s",
};
