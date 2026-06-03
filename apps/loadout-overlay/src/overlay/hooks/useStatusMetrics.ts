import { useEffect, useState } from "react";
import { call, subscribe } from "@loadout/ui/ws-client";

/**
 * Live telemetry for the status bar footer.
 *
 * Subscribes to fan-control + battery-tracker events where available
 * (both plugins already broadcast state changes), and falls back to a
 * slow poll for first-paint. If a plugin isn't installed the call
 * errors and the metric stays null — the statusbar renders whichever
 * values it has.
 */
export interface StatusMetrics {
  cpuTemp: number | null;      // °C — from fan-control `fan-update` / `getFanInfo` (`cpuTempC`)
  fanRpm: number | null;       // RPM — same source
  batteryPct: number | null;   // % — from battery-tracker `batteryUpdate` / `getBatteryInfo`
  charging: boolean | null;
}

export function useStatusMetrics(): StatusMetrics {
  const [metrics, setMetrics] = useState<StatusMetrics>({
    cpuTemp: null,
    fanRpm: null,
    batteryPct: null,
    charging: null,
  });

  useEffect(() => {
    let cancelled = false;
    const update = (patch: Partial<StatusMetrics>) => {
      if (cancelled) return;
      setMetrics((prev) => ({ ...prev, ...patch }));
    };

    // First-paint poll — the events only fire when state changes.
    const refreshFan = async () => {
      try {
        const info = (await call({
          plugin: "fan-control",
          method: "getFanInfo",
          args: [],
        })) as { fans?: { rpm?: number }[]; cpuTempC?: number } | null;
        if (!info) return;
        const rpm = info.fans?.[0]?.rpm;
        update({
          fanRpm: typeof rpm === "number" ? rpm : null,
          cpuTemp: typeof info.cpuTempC === "number" ? info.cpuTempC : null,
        });
      } catch {
        /* plugin not installed or not ready — metric stays null */
      }
    };
    const refreshBattery = async () => {
      try {
        const info = (await call({
          plugin: "battery-tracker",
          method: "getBatteryInfo",
          args: [],
        })) as { percentage?: number; status?: string } | null;
        if (!info) return;
        update({
          batteryPct: typeof info.percentage === "number" ? info.percentage : null,
          charging: info.status === "Charging",
        });
      } catch {
        /* same as above */
      }
    };

    refreshFan();
    refreshBattery();

    // Event subscriptions — backends broadcast on their own cadence.
    const unsubFan = subscribe({
      plugin: "fan-control",
      event: "fan-update",
      handler: (data: unknown) => {
        const d = data as { fans?: { rpm?: number }[]; cpuTempC?: number };
        const rpm = d?.fans?.[0]?.rpm;
        update({
          fanRpm: typeof rpm === "number" ? rpm : null,
          cpuTemp: typeof d?.cpuTempC === "number" ? d.cpuTempC : null,
        });
      },
    });
    const unsubBattery = subscribe({
      plugin: "battery-tracker",
      event: "batteryUpdate",
      handler: (data: unknown) => {
        const d = data as { percentage?: number; status?: string };
        update({
          batteryPct: typeof d?.percentage === "number" ? d.percentage : null,
          charging: d?.status === "Charging",
        });
      },
    });

    return () => {
      cancelled = true;
      unsubFan();
      unsubBattery();
    };
  }, []);

  return metrics;
}
