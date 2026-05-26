import { useFocusable } from "../spatial-nav";
import { colors } from "../colors";

const containerClass = "flex border-b border-base-300";

function Tab({
  id,
  label,
  active,
  onSelect,
}: {
  id: string;
  label: string;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => onSelect(id),
  });

  return (
    <button
      ref={ref}
      onClick={() => onSelect(id)}
      className={`px-4 min-h-[44px] text-sm font-medium border-b-2 transition-colors ${focused ? "ring-2 ring-primary/40 rounded-t" : ""}`}
      style={{
        color: active || focused ? colors.accent : colors.textSecondary,
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
    <div className={containerClass}>
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          id={tab.id}
          label={tab.label}
          active={tab.id === activeTab}
          onSelect={onTabChange}
        />
      ))}
    </div>
  );
}
