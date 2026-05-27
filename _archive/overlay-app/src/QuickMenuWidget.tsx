import type { CSSProperties, ReactNode } from "react";
import { colors } from "./styles";

export interface QuickMenuWidgetProps {
  title: string;
  children: ReactNode;
}

/**
 * A titled section container for quick menu widgets.
 * Used by plugins to render their quick-menu surface.
 */
export function QuickMenuWidget({ title, children }: QuickMenuWidgetProps) {
  return (
    <div style={widgetStyle}>
      <div style={widgetHeaderStyle}>{title}</div>
      <div style={widgetContentStyle}>{children}</div>
    </div>
  );
}

// --- Styles ---

const widgetStyle: CSSProperties = {
  background: colors.surface,
  borderRadius: 8,
  border: `1px solid ${colors.border}`,
  marginBottom: 10,
  overflow: "hidden",
};

const widgetHeaderStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: colors.textSecondary,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "10px 14px 6px",
};

const widgetContentStyle: CSSProperties = {
  padding: "4px 14px 12px",
};
