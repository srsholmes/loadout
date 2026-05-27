import { useState, type CSSProperties } from "react";
import { useFocusable } from "../spatial-nav";
import { colors } from "../colors";

const containerStyle: CSSProperties = {
  display: "flex",
  gap: 0,
  borderBottom: `1px solid ${colors.border}`,
};

const buttonBase: CSSProperties = {
  background: "none",
  border: "none",
  borderBottom: "2px solid transparent",
  padding: "0 16px",
  minHeight: 44,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  transition: "color 0.15s, border-color 0.15s, outline 0.15s",
};

function Tab({
  id,
  label,
  active,
  onTabChange,
}: {
  id: string;
  label: string;
  active: boolean;
  onTabChange: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { ref, focused } = useFocusable({
    onEnterPress: () => onTabChange(id),
  });

  return (
    <button
      ref={ref}
      onClick={() => onTabChange(id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={focused ? "ring-2 ring-primary/40 rounded" : ""}
      style={{
        ...buttonBase,
        color: active || focused ? colors.accent : hovered ? colors.text : colors.textSecondary,
        borderBottomColor: active ? colors.accent : "transparent",
      }}
    >
      {label}
    </button>
  );
}

export function TabBar({
  tabs,
  activeTab,
  onTabChange,
}: {
  tabs: { id: string; label: string }[];
  activeTab: string;
  onTabChange: (id: string) => void;
}) {
  return (
    <div style={containerStyle}>
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          id={tab.id}
          label={tab.label}
          active={tab.id === activeTab}
          onTabChange={onTabChange}
        />
      ))}
    </div>
  );
}
