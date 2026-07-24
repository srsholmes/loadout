import { useState, useEffect, useCallback, useRef } from "react";
import { FaBatteryFull, FaBolt, FaPlug, FaTriangleExclamation } from "react-icons/fa6";
import {
  Alert,
  Button,
  Select,
  Slider,
  Spinner,
  Toggle,
  notify,
  useBackend,
  mountComponent,
} from "@loadout/ui";
import type { BatteryInfo, HistoryEntry } from "./lib/battery";
import type { BypassMode, ChargeControlInfo } from "./lib/charge-control";

export const icon = FaBatteryFull;

// Re-export types for test convenience
export type { BatteryInfo, HistoryEntry };

// Discriminated union: backend returns one or the other, narrow with `"error" in data`.
type BatteryInfoResult = BatteryInfo | { error: string };

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
  const oldest = entries[0];
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
          {entries.length > 1 && oldest
            ? `${Math.round((Date.now() - oldest.timestamp) / 60000)}m ago`
            : ""}
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChargingControls
// ---------------------------------------------------------------------------

const DEFAULT_CHARGE_LIMIT = 80;
// After enabling "always" bypass, wait this long before checking whether the
// battery actually stopped charging. The EC applies inhibit within a second or
// two; this leaves margin for the read to reflect it.
const BYPASS_CHECK_DELAY_MS = 6000;
// Practical slider bounds. 100 is intentionally excluded — a threshold of
// 100 means "no limit", which the toggle expresses instead.
const LIMIT_MIN = 50;
const LIMIT_MAX = 95;

/** Clamp a stored threshold into the slider's displayable range. */
function clampLimit(percent: number): number {
  return Math.max(LIMIT_MIN, Math.min(LIMIT_MAX, Math.round(percent)));
}

const BYPASS_LABELS: Record<BypassMode, string> = {
  disabled: "Off",
  awake: "While awake",
  always: "Always",
};

type SetResult = { success: boolean; error?: string };

/**
 * Charge limit + bypass charging card. Capability-driven: rendered only
 * when the backend reports at least one control is supported (the parent
 * skips it entirely otherwise), and each row hides individually.
 */
function ChargingControls({
  control,
  call,
  onPatch,
  batteryStatus,
}: {
  control: ChargeControlInfo;
  call: (method: string, ...args: unknown[]) => Promise<unknown>;
  onPatch: (patch: Partial<ChargeControlInfo>) => void;
  batteryStatus: string | null;
}) {
  const stored = control.chargeLimitPercent;
  // Local slider position so dragging stays responsive; backend writes
  // happen on commit only. Clamp the seed to the slider's bounds so an
  // externally-set threshold (e.g. 98%, or an off-range value) never leaves
  // the chip and the thumb showing different numbers.
  const [sliderPct, setSliderPct] = useState(clampLimit(stored ?? DEFAULT_CHARGE_LIMIT));
  useEffect(() => {
    if (stored !== null) setSliderPct(clampLimit(stored));
  }, [stored]);

  const limitEnabled = stored !== null;

  const applyLimit = useCallback(
    async (percent: number | null) => {
      try {
        const result = (await call("setChargeLimit", percent)) as SetResult | null;
        if (result?.success) {
          notify(percent === null ? "Charge limit off" : `Charge limit set to ${percent}%`);
          // Trust the successful write rather than immediately re-reading:
          // charge_control_end_threshold is EC-backed and a read-back right
          // after the write can still report the old value until the EC
          // propagates it, which would visibly snap the slider back.
          onPatch({ chargeLimitPercent: percent });
        } else {
          notify(result?.error ?? "Failed to set charge limit", { kind: "error" });
          // Write rejected — snap the slider back to the persisted value so
          // it doesn't show a limit the hardware never accepted.
          setSliderPct(clampLimit(stored ?? DEFAULT_CHARGE_LIMIT));
        }
      } catch {
        notify("Failed to set charge limit", { kind: "error" });
        setSliderPct(clampLimit(stored ?? DEFAULT_CHARGE_LIMIT));
      }
    },
    [call, onPatch, stored],
  );

  // "Bypass didn't take effect" advisory. Some devices expose charge_behaviour
  // but their firmware/driver silently ignores the inhibit (the write succeeds
  // and reads back as set), so we verify by outcome instead. Device-agnostic —
  // no per-model logic.
  const [bypassIneffective, setBypassIneffective] = useState(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    },
    [],
  );

  // Self-heal: if charging later stops (a device whose EC honours the inhibit
  // a bit after our 6s window, or any other reason), drop the warning so it
  // doesn't linger falsely until the next mode change.
  useEffect(() => {
    if (bypassIneffective && batteryStatus && batteryStatus !== "Charging") {
      setBypassIneffective(false);
    }
  }, [batteryStatus, bypassIneffective]);

  const applyBypass = useCallback(
    async (mode: BypassMode) => {
      // Any mode change clears a prior warning and cancels a pending check.
      if (checkTimer.current) {
        clearTimeout(checkTimer.current);
        checkTimer.current = null;
      }
      setBypassIneffective(false);
      try {
        const result = (await call("setBypassMode", mode)) as SetResult | null;
        if (result?.success) {
          notify(
            mode === "disabled"
              ? "Bypass charging off"
              : `Bypass charging: ${BYPASS_LABELS[mode].toLowerCase()}`,
          );
          // Same EC read-back lag as the charge limit — reflect the mode we
          // just wrote instead of racing a stale re-read.
          onPatch({ bypassMode: mode });
          // Effectiveness check — ONLY for "always". "awake" deliberately keeps
          // charging until the device sleeps, so still-charging there is
          // correct, not a failure. If "always" is still Charging a few seconds
          // on, the firmware/driver isn't honouring it: warn rather than
          // pretend it worked. ("Full"/"Not charging"/"Discharging" don't warn
          // — nothing to stop / already stopped.)
          if (mode === "always") {
            checkTimer.current = setTimeout(() => {
              void call("getBatteryInfo")
                .then((info) => {
                  const d = info as BatteryInfoResult;
                  if (d && !("error" in d) && d.status === "Charging") {
                    setBypassIneffective(true);
                  }
                })
                .catch(() => {});
            }, BYPASS_CHECK_DELAY_MS);
          }
        } else {
          notify(result?.error ?? "Failed to set bypass mode", { kind: "error" });
        }
      } catch {
        notify("Failed to set bypass mode", { kind: "error" });
      }
    },
    [call, onPatch],
  );

  const bypassOptions: BypassMode[] = control.supportsBypassAwake
    ? ["disabled", "awake", "always"]
    : ["disabled", "always"];

  return (
    <div className="card">
      <div className="card-header flex items-center justify-between py-3.5 px-4.5 border-b border-base-300">
        <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
          <FaPlug className="w-3 h-3" /> CHARGING
        </div>
      </div>

      {control.supportsChargeLimit && (
        <div className="subsection">
          <div className="flex items-center justify-between mb-1.5">
            <div className="subsection-label mb-0">Charge limit</div>
            <div className="flex items-center gap-3">
              {limitEnabled && <span className="chip">{sliderPct}%</span>}
              <Toggle
                checked={limitEnabled}
                onChange={(on) => void applyLimit(on ? sliderPct : null)}
              />
            </div>
          </div>
          {limitEnabled && (
            <div className="mt-3">
              <Slider
                value={sliderPct}
                onChange={setSliderPct}
                onCommit={(v) => void applyLimit(v)}
                min={LIMIT_MIN}
                max={LIMIT_MAX}
                step={1}
              />
            </div>
          )}
          <div className="subsection-desc">
            Stop charging at a set percentage. Staying below 100% reduces
            long-term battery wear, especially when docked.
          </div>
        </div>
      )}

      {control.supportsBypass && (
        <div className="subsection">
          <div className="flex items-center justify-between mb-1.5">
            <div className="subsection-label mb-0">Bypass charging</div>
            <Select
              value={control.bypassMode}
              options={bypassOptions}
              labels={BYPASS_LABELS}
              onChange={(mode) => void applyBypass(mode)}
            />
          </div>
          <div className="subsection-desc">
            Run from the power adapter without charging the pack — less heat
            and no charge cycles during long plugged-in sessions.
            {control.supportsBypassAwake &&
              " “While awake” resumes normal charging when the device sleeps."}
          </div>
          {bypassIneffective && (
            <Alert
              variant="warning"
              className="mt-3"
              icon={<FaTriangleExclamation size={16} />}
              title="Bypass didn’t take effect"
            >
              The battery is still charging. Your device’s firmware or kernel
              driver may not support bypass charging yet, even though the option
              is available.
            </Alert>
          )}
        </div>
      )}
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
  const [chargeControl, setChargeControl] = useState<ChargeControlInfo | null>(null);

  useEvent({
    event: "batteryUpdate",
    handler: (data) => setBattery(data as BatteryInfo),
  });

  // Older backends (and the spec's mock) return null for unknown methods —
  // treat that as "no charge control support" and render nothing. This reads
  // hardware, so it's used only on mount; writes update state optimistically
  // via patchChargeControl to avoid the EC read-back race.
  const refreshChargeControl = useCallback(() => {
    call("getChargeControl")
      .then((info) => {
        setChargeControl((info as ChargeControlInfo | null) ?? null);
      })
      .catch(() => {
        /* older backend / read failure — leave controls hidden */
      });
  }, [call]);

  const patchChargeControl = useCallback((patch: Partial<ChargeControlInfo>) => {
    setChargeControl((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  useEffect(() => {
    call("getBatteryInfo").then((info) => {
      const data = info as BatteryInfoResult;
      if ("error" in data) setError(data.error);
      else setBattery(data);
    });
    call("getHistory").then((h) => setHistory(h as HistoryEntry[]));
    refreshChargeControl();
  }, [call, refreshChargeControl]);

  useEffect(() => {
    const t = setInterval(() => {
      call("getHistory").then((h) => setHistory(h as HistoryEntry[]));
    }, 60_000);
    return () => clearInterval(t);
  }, [call]);

  const handleRefresh = useCallback(async () => {
    const info = await call("getBatteryInfo");
    const data = info as BatteryInfoResult;
    if ("error" in data) setError(data.error);
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

        {/* CHARGE LIMIT + BYPASS (only when the hardware supports either) */}
        {chargeControl && (chargeControl.supportsChargeLimit || chargeControl.supportsBypass) && (
          <ChargingControls
            control={chargeControl}
            call={call}
            onPatch={patchChargeControl}
            batteryStatus={battery?.status ?? null}
          />
        )}

        {/* POWER FLOW + HEALTH + DETAILS */}
        <div className="card">
          <div className="subsection">
            <div className="subsection-label">Power Flow</div>
            <div className="grid grid-cols-3 gap-2.5 mb-3">
              <MetricTile
                label="WATTS"
                value={`${charging ? "+" : "-"}${drawW.toFixed(1)}`}
                color={charging ? "var(--color-success)" : "var(--fg-1)"}
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
      const d = info as BatteryInfoResult;
      if (!("error" in d)) setBattery(d);
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
          <span>{hasDraw ? `${charging ? "+" : "-"}${drawW.toFixed(1)} W` : ""}</span>
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

export const mount = mountComponent(BatteryTracker);
export const mountHomeWidget = mountComponent(BatteryWidget);
export const mountHeader = mountComponent(Header);
