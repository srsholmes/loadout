import { useState, useEffect, useRef } from "react";
import type { PluginInfo } from "./hooks/usePlugins";
import { colors } from "./styles";

/**
 * Loads and renders a plugin's compact sidebar widget.
 *
 * Each plugin can optionally export a `mountWidget(container, opts)` function
 * from its app bundle. If present, WidgetHost mounts it into a constrained
 * container with a clickable title bar above. If absent, the entire card is
 * clickable and opens the plugin in the full overlay.
 */
export function WidgetHost({
  plugin,
  parentFocusKey,
  onOpen,
}: {
  plugin: PluginInfo;
  parentFocusKey?: string;
  onOpen?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const unmountRef = useRef<(() => void) | null>(null);
  const [hasWidget, setHasWidget] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    async function loadWidget() {
      try {
        const url = `/plugins/${plugin.id}/app-bundle.js?t=${Date.now()}`;
        const mod = await import(/* @vite-ignore */ url);

        if (cancelled) return;

        const mountWidget = mod.mountWidget;
        if (typeof mountWidget !== "function") {
          setHasWidget(false);
          return;
        }

        const unmount = mountWidget(container, {
          parentFocusKey: parentFocusKey ?? `sidebar-widget-${plugin.id}`,
        });
        unmountRef.current = typeof unmount === "function" ? unmount : null;
        setHasWidget(true);
      } catch {
        if (!cancelled) setHasWidget(false);
      }
    }

    loadWidget();

    return () => {
      cancelled = true;
      if (unmountRef.current) {
        unmountRef.current();
        unmountRef.current = null;
      }
      if (container) container.innerHTML = "";
    };
  }, [plugin.id, parentFocusKey]);

  const initial = plugin.icon
    ? plugin.icon.charAt(0).toUpperCase()
    : plugin.name.charAt(0).toUpperCase();

  // Plugin has a widget: clickable title bar + non-clickable widget controls
  if (hasWidget) {
    return (
      <div style={widgetCardStyle}>
        <button style={titleBarStyle} onClick={onOpen} title={`Open ${plugin.name}`}>
          <div style={titleIconStyle}>{initial}</div>
          <span style={titleNameStyle}>{plugin.name}</span>
          <span style={titleArrowStyle}>&#x203A;</span>
        </button>
        <div ref={containerRef} style={widgetContainerStyle} />
      </div>
    );
  }

  // No widget: entire card is clickable to open the plugin
  return (
    <div style={widgetCardStyle}>
      <button style={defaultClickableStyle} onClick={onOpen} title={`Open ${plugin.name}`}>
        <div style={titleIconStyle}>{initial}</div>
        <div style={defaultTextStyle}>
          <div style={titleNameStyle}>{plugin.name}</div>
          <div style={defaultHintStyle}>{plugin.description}</div>
        </div>
        <span style={titleArrowStyle}>&#x203A;</span>
      </button>
      <div
        ref={containerRef}
        style={{ ...widgetContainerStyle, display: "none" }}
      />
    </div>
  );
}

// --- Styles ---

const widgetCardStyle: React.CSSProperties = {
  borderRadius: 8,
  overflow: "hidden",
  minHeight: 44,
};

const titleBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "8px 14px",
  border: "none",
  borderBottom: `1px solid ${colors.border}`,
  background: "rgba(255, 255, 255, 0.03)",
  cursor: "pointer",
  textAlign: "left",
  color: colors.text,
  transition: "background 0.12s",
};

const titleIconStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  background: colors.surface,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  fontWeight: 600,
  color: colors.accent,
  flexShrink: 0,
};

const titleNameStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: colors.text,
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const titleArrowStyle: React.CSSProperties = {
  fontSize: 16,
  color: colors.textSecondary,
  flexShrink: 0,
  opacity: 0.5,
};

const widgetContainerStyle: React.CSSProperties = {
  width: "100%",
};

const defaultClickableStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "10px 14px",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
  color: colors.text,
  transition: "background 0.12s",
};

const defaultTextStyle: React.CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: "hidden",
};

const defaultHintStyle: React.CSSProperties = {
  fontSize: 11,
  color: colors.textSecondary,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
