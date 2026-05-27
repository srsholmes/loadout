import { useState, useCallback } from "react";
import { useBackend } from "@loadout/ui";
import { QuickMenuWidget } from "./QuickMenuWidget";
import { colors } from "./styles";

interface StatsData {
  battery?: { percent: number; timeRemaining?: string };
  cpuTemp?: number;
  gpuTemp?: number;
  tdp?: number;
}

/**
 * Demo system monitor widget for the quick menu.
 * Subscribes to stats-update events from the system-monitor backend.
 * Shows battery, CPU temp, GPU temp, and current TDP.
 */
export function SystemMonitorWidget() {
  const { useEvent } = useBackend("system-monitor");
  const [stats, setStats] = useState<StatsData | null>(null);

  useEvent({
    event: "stats-update",
    handler: useCallback((data: unknown) => {
      setStats(data as StatsData);
    }, []),
  });

  if (!stats) {
    return (
      <QuickMenuWidget title="System Monitor">
        <p style={noDataStyle}>No data</p>
      </QuickMenuWidget>
    );
  }

  return (
    <QuickMenuWidget title="System Monitor">
      <div style={gridStyle}>
        {stats.battery != null && (
          <StatRow
            label="Battery"
            value={`${stats.battery.percent}%`}
            detail={stats.battery.timeRemaining ?? undefined}
          />
        )}
        {stats.cpuTemp != null && (
          <StatRow label="CPU Temp" value={`${stats.cpuTemp}\u00B0C`} />
        )}
        {stats.gpuTemp != null && (
          <StatRow label="GPU Temp" value={`${stats.gpuTemp}\u00B0C`} />
        )}
        {stats.tdp != null && (
          <StatRow label="TDP" value={`${stats.tdp}W`} />
        )}
      </div>
    </QuickMenuWidget>
  );
}

function StatRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div style={statRowStyle}>
      <span style={statLabelStyle}>{label}</span>
      <div style={statValueWrapperStyle}>
        <span style={statValueStyle}>{value}</span>
        {detail && <span style={statDetailStyle}>{detail}</span>}
      </div>
    </div>
  );
}

// --- Styles ---

const noDataStyle: React.CSSProperties = {
  fontSize: 13,
  color: colors.textSecondary,
  margin: 0,
  fontStyle: "italic",
};

const gridStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const statRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "4px 0",
};

const statLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: colors.textSecondary,
};

const statValueWrapperStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const statValueStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: colors.text,
};

const statDetailStyle: React.CSSProperties = {
  fontSize: 11,
  color: colors.textSecondary,
};
