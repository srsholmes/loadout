import { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { FaBatteryFull, FaBolt } from "react-icons/fa6";
import { Button, PluginProvider, Spinner, useBackend } from "@loadout/ui";
import type { BatteryInfo, HistoryEntry } from "./lib/battery";

export const icon = FaBatteryFull;

// Re-export types for test convenience
export type { BatteryInfo, HistoryEntry };

// ---------------------------------------------------------------------------
// Internal types (UI-only extension — adds optional error field)
// ---------------------------------------------------------------------------

type BatteryInfoOrError = BatteryInfo & { error?: string };

// ---------------------------------------------------------------------------
// Pure UI helpers
// ---------------------------------------------------------------------------

function healthColor(pct: number): string {
  if (pct >= 90) return "var(--color-success)";
  if (pct >= 75) return "var(--color-warning)";
  return "var(--color-error)";
}

function percentageColor(pct: number, charging: boolean): string {
  if (charging) return "var(--color-success)";
  if (pct > 50) return "var(--fg-1)";
  if (pct >= 20) return "var(--color-warning)";
  return "var(--color-error)";
}

// ---------------------------------------------------------------------------
// HistoryChart
// ---------------------------------------------------------------------------

/** Stacked-bar history visualization. Shows the last N entries as
 *  thin bars; thicker top cap for charging samples. */
function HistoryChart({ history }: { history: HistoryEntry[] }) {
  const entries = history.slice(-30);
  if (entries.length === 0) {
    return (
      <div className="subsection-desc" style={{ textAlign: "center", padding: "18px 0" }}>
        No history yet. Data is recorded every minute.
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-end gap-[3px] h-20 w-full pb-0.5 border-b border-base-300">
        {entries.map((entry, i) => {
          const charging = entry.status === "Charging";
          return (
            <div
              key={i}
              className="flex-1 min-w-[2px] rounded-t transition-[height] duration-300"
              style={{
                height: `${entry.percentage}%`,
                background: charging ? "var(--color-success)" : "var(--accent)",
                opacity: charging ? 1 : 0.7,
              }}
              title={`${entry.percentage}% · ${entry.powerWatts}W · ${entry.status}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between mt-1.5 mono text-[10.5px] text-base-content/50">
        <span>
          {entries.length > 1
            ? `${Math.round((Date.now() - entries[0].timestamp) / 60000)}m ago`
            : ""}
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MetricTile
// ---------------------------------------------------------------------------

function MetricTile({
  label,
  value,
  unit,
  color,
}: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
}) {
  return (
    <div className="bg-base-300/50 rounded-xl px-3.5 py-4 text-center">
      <div className="metric-value mono" style={{ fontSize: 22, color: color ?? "var(--fg-1)" }}>
        {value}
        {unit}
      </div>
      <div className="metric-label mt-1">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main plugin view
// ---------------------------------------------------------------------------

function BatteryTracker() {
  const { call, useEvent } = useBackend("battery-tracker");

  const [battery, setBattery] = useState<BatteryInfo | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEvent({
    event: "batteryUpdate",
    handler: (data) => setBattery(data as BatteryInfo),
  });

  useEffect(() => {
    call("getBatteryInfo").then((info) => {
      const data = info as BatteryInfoOrError;
      if (data.error) setError(data.error);
      else setBattery(data);
    });
    call("getHistory").then((h) => setHistory(h as HistoryEntry[]));
  }, [call]);

  useEffect(() => {
    const t = setInterval(() => {
      call("getHistory").then((h) => setHistory(h as HistoryEntry[]));
    }, 60_000);
    return () => clearInterval(t);
  }, [call]);

  const handleRefresh = useCallback(async () => {
    const info = await call("getBatteryInfo");
    const data = info as BatteryInfoOrError;
    if (data.error) setError(data.error);
    else {
      setBattery(data);
      setError(null);
    }
    setHistory((await call("getHistory")) as HistoryEntry[]);
  }, [call]);

  if (error) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="card">
            <div className="card-body p-6">
              <div className="subsection-label mb-2">Error</div>
              <div className="text-sm text-base-content">{error}</div>
              <div className="mt-4">
                <Button onClick={handleRefresh}>Retry</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!battery) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size={32} />
      </div>
    );
  }

  const charging = battery.status === "Charging";
  const pctColor = percentageColor(battery.percentage, charging);
  const healthPct = Math.round(battery.healthPercent);
  const segColor = healthColor(healthPct);
  const wearPct = Math.max(0, 100 - healthPct);
  const drawW = battery.powerWatts;
  const voltage = battery.voltage;
  const amps = voltage > 0 ? (drawW / voltage).toFixed(2) : "—";

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        {/* LIVE CHARGE */}
        <div className="card">
          <div className="card-header flex items-center justify-between py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaBatteryFull className="w-3 h-3" /> CHARGE
            </div>
            {charging ? (
              <span className="chip chip-success">
                <FaBolt className="w-2.5 h-2.5" /> CHARGING
              </span>
            ) : (
              <span className="chip">{battery.timeRemainingFormatted} remaining</span>
            )}
          </div>
          <div className="px-6 py-7">
            <div className="flex items-baseline justify-center gap-2 mb-5">
              <span className="metric-value mono" style={{ fontSize: 64, color: pctColor }}>
                {Math.round(battery.percentage)}
              </span>
              <span className="metric-unit" style={{ fontSize: 18 }}>
                %
              </span>
            </div>
            <div className="rail" style={{ height: 10 }}>
              <span
                style={{
                  width: `${battery.percentage}%`,
                  background: pctColor,
                }}
              />
            </div>
            <div className="flex justify-between mt-2.5 mono text-[11.5px] text-base-content/50">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </div>
        </div>

        {/* POWER FLOW + HEALTH + DETAILS */}
        <div className="card">
          <div className="subsection">
            <div className="subsection-label">Power Flow</div>
            <div className="grid grid-cols-3 gap-2.5 mb-3">
              <MetricTile
                label="WATTS"
                value={`${drawW >= 0 ? "+" : ""}${drawW.toFixed(1)}`}
                color={drawW >= 0 ? "var(--color-success)" : "var(--fg-1)"}
              />
              <MetricTile label="VOLTS" value={voltage.toFixed(2)} />
              <MetricTile label="AMPS" value={amps} />
            </div>
            <div className="subsection-desc">
              {charging
                ? "Pack is absorbing energy from the adapter. Charge rate depends on TDP budget and thermals."
                : "Pack is discharging. Lowering TDP or brightness is the fastest way to extend runtime."}
            </div>
          </div>

          <div className="subsection">
            <div className="flex items-center justify-between mb-3.5">
              <div className="subsection-label mb-0">Health</div>
              <span className="chip" style={{ borderColor: segColor, color: segColor }}>
                ● {healthPct}%
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5 mb-3.5">
              <MetricTile
                label="CAPACITY"
                value={`${battery.energyFullWh.toFixed(1)}`}
                unit=" Wh"
              />
              <MetricTile label="WEAR" value={`${wearPct}%`} color={segColor} />
            </div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-base-content/70">Capacity</span>
              <span className="mono text-base-content/50">
                {battery.energyFullWh.toFixed(1)} / {battery.energyFullDesignWh.toFixed(1)} Wh
              </span>
            </div>
            <div className="relative h-2.5 bg-base-300 rounded overflow-hidden">
              <div
                className="absolute top-0 left-0 bottom-0 transition-[width] duration-300"
                style={{
                  width: `${Math.min(100, (battery.energyFullWh / battery.energyFullDesignWh) * 100)}%`,
                  background: segColor,
                }}
              />
            </div>
            <div className="subsection-desc">
              {healthPct >= 90
                ? "Battery is healthy. No action needed."
                : healthPct >= 75
                  ? "Moderate wear. Consider enabling charge limit to slow degradation."
                  : "Significant wear. Replacement may be worth considering."}
            </div>
          </div>

          <div className="subsection">
            <div className="subsection-label">Details</div>
            <div className="row">
              <span className="row-label">Design capacity</span>
              <span className="row-value">{battery.energyFullDesignWh.toFixed(1)} Wh</span>
            </div>
            <div className="row">
              <span className="row-label">Full-charge capacity</span>
              <span className="row-value">{battery.energyFullWh.toFixed(1)} Wh</span>
            </div>
            <div className="row">
              <span className="row-label">Current charge</span>
              <span className="row-value">{battery.energyNowWh.toFixed(1)} Wh</span>
            </div>
            <div className="row">
              <span className="row-label">Voltage</span>
              <span className="row-value">{voltage.toFixed(2)} V</span>
            </div>
            <div className="row">
              <span className="row-label">Status</span>
              <span className="row-value">{battery.status}</span>
            </div>
            <div className="row">
              <span className="row-label">Time remaining</span>
              <span className="row-value">{battery.timeRemainingFormatted}</span>
            </div>
          </div>

          <div className="subsection">
            <div className="flex items-center justify-between mb-3.5">
              <div className="subsection-label mb-0">Charge History (30 min)</div>
              <Button onClick={handleRefresh}>Refresh</Button>
            </div>
            <HistoryChart history={history} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Homepage widget
// ---------------------------------------------------------------------------

/** Compact battery display for the dashboard home widget. */
function BatteryWidget() {
  const { call, useEvent } = useBackend("battery-tracker");
  const [battery, setBattery] = useState<BatteryInfo | null>(null);

  useEvent({ event: "batteryUpdate", handler: (data) => setBattery(data as BatteryInfo) });
  useEffect(() => {
    call("getBatteryInfo").then((info) => {
      const d = info as BatteryInfoOrError;
      if (!d.error) setBattery(d);
    });
  }, [call]);

  if (!battery) return <div className="p-4 text-xs text-base-content/40">Loading battery…</div>;

  const charging = battery.status === "Charging";
  const pct = Math.round(battery.percentage);
  const currentWh = battery.energyNowWh;
  const designWh = battery.energyFullDesignWh;
  const hasWh = Number.isFinite(currentWh) && Number.isFinite(designWh) && designWh > 0;
  const drawW = battery.powerWatts;
  const hasDraw = Number.isFinite(drawW);
  const healthPct = Math.round(battery.healthPercent);
  const hasHealth = Number.isFinite(battery.healthPercent) && battery.healthPercent > 0;
  const timeLeft = battery.timeRemainingFormatted;
  const hasTimeLeft = !charging && timeLeft && timeLeft.trim().length > 0;

  return (
    <div className="card-body">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div className="card-title">
          <FaBatteryFull className="w-3 h-3" /> BATTERY
        </div>
        {charging ? (
          <div className="chip chip-success">
            <FaBolt className="w-2.5 h-2.5" /> CHARGING
          </div>
        ) : hasTimeLeft ? (
          <div className="chip">{timeLeft}</div>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 18 }}>
        <div className="metric-value mono">{pct}</div>
        <div className="metric-unit">%</div>
        {hasWh && (
          <div
            style={{
              marginLeft: "auto",
              fontSize: 11,
              color: "var(--fg-3)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {currentWh.toFixed(1)} / {designWh.toFixed(1)} Wh
          </div>
        )}
      </div>
      <div className="rail">
        <span style={{ width: `${pct}%` }} />
      </div>
      {(hasDraw || hasHealth) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 12,
            fontSize: 11.5,
            color: "var(--fg-2)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span>{hasDraw ? `${drawW >= 0 ? "+" : ""}${drawW.toFixed(1)} W` : ""}</span>
          <span>{hasHealth ? `Health: ${healthPct}%` : ""}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header component
// ---------------------------------------------------------------------------

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">Battery</h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Real-time power monitoring
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// mountComponent factory — collapses the createRoot/PluginProvider/unmount
// boilerplate shared by mount / mountHomeWidget / mountHeader.
// ---------------------------------------------------------------------------

function mountComponent(Component: React.ComponentType) {
  return (container: HTMLElement, opts?: { parentFocusKey?: string }): (() => void) => {
    const root = createRoot(container);
    root.render(
      <PluginProvider parentFocusKey={opts?.parentFocusKey}>
        <Component />
      </PluginProvider>,
    );
    return () => root.unmount();
  };
}

export const mount = mountComponent(BatteryTracker);
export const mountHomeWidget = mountComponent(BatteryWidget);
export const mountHeader = mountComponent(Header);
