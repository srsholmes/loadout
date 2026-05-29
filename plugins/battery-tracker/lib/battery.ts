/**
 * Pure battery-sysfs parsing helpers.
 *
 * No I/O here — all functions take raw sysfs strings or numbers and return
 * typed values. This keeps them fast to unit-test without mocking the
 * filesystem.
 */

export interface BatteryInfo {
  percentage: number;
  status: string;
  powerWatts: number;
  voltage: number;
  energyNowWh: number;
  energyFullWh: number;
  energyFullDesignWh: number;
  healthPercent: number;
  timeRemainingMinutes: number | null;
  timeRemainingFormatted: string;
}

export interface HistoryEntry {
  timestamp: number;
  percentage: number;
  powerWatts: number;
  status: string;
}

/** Parse a sysfs integer string, returning 0 for invalid/missing values. */
export function parseSysfsInt(raw: string): number {
  const n = parseInt(raw.trim(), 10);
  return isNaN(n) ? 0 : n;
}

/** Convert a sysfs micro-unit value (µW, µV, µWh) to standard units. */
export function microToUnit(microVal: number): number {
  return microVal / 1_000_000;
}

/** Round a number to 2 decimal places (matches the original backend's rounding). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compute battery health as a percentage of design capacity.
 * Returns 100 when design capacity is zero or unknown (safe default).
 */
export function computeHealthPercent(energyFullWh: number, energyFullDesignWh: number): number {
  if (energyFullDesignWh <= 0) return 100;
  return Math.round((energyFullWh / energyFullDesignWh) * 100);
}

/**
 * Compute time remaining as minutes + a human-readable string.
 *
 * - Discharging: energy remaining / power draw
 * - Charging:    energy deficit / charge rate
 * - Full / no power: special-cased
 *
 * Returns `{ minutes: null, formatted: "--" }` when estimation is not
 * possible (powerWatts === 0 for Discharging, etc.).
 */
export function computeTimeRemaining(
  status: string,
  powerWatts: number,
  energyNowWh: number,
  energyFullWh: number,
): { minutes: number | null; formatted: string } {
  if (status === "Full") {
    return { minutes: null, formatted: "Full" };
  }

  let timeRemainingMinutes: number | null = null;

  if (powerWatts > 0) {
    if (status === "Discharging") {
      const hoursRemaining = energyNowWh / powerWatts;
      timeRemainingMinutes = Math.round(hoursRemaining * 60);
    } else if (status === "Charging") {
      const energyDeficit = energyFullWh - energyNowWh;
      if (energyDeficit > 0) {
        const hoursRemaining = energyDeficit / powerWatts;
        timeRemainingMinutes = Math.round(hoursRemaining * 60);
      } else {
        timeRemainingMinutes = 0;
      }
    }
  }

  const formatted = formatTimeRemaining(timeRemainingMinutes, status);
  return { minutes: timeRemainingMinutes, formatted };
}

/** Format a time-remaining duration (in minutes) to a human-readable string. */
export function formatTimeRemaining(minutes: number | null, status: string): string {
  if (status === "Full") return "Full";
  if (minutes === null) return "--";
  if (minutes <= 0) return status === "Full" ? "Full" : "0m";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/**
 * Assemble a BatteryInfo from raw sysfs micro-unit values.
 *
 * All energy/power/voltage values are expected in their native sysfs units
 * (microwatts, microvolts, microwatt-hours). This is the single conversion
 * boundary — callers supply sysfs ints, consumers receive standard units.
 */
export function assembleBatteryInfo(raw: {
  percentage: number;
  status: string;
  powerNowMicro: number;
  voltageNowMicro: number;
  energyNowMicro: number;
  energyFullMicro: number;
  energyFullDesignMicro: number;
}): BatteryInfo {
  const powerWatts = round2(microToUnit(raw.powerNowMicro));
  const voltage = round2(microToUnit(raw.voltageNowMicro));
  const energyNowWh = round2(microToUnit(raw.energyNowMicro));
  const energyFullWh = round2(microToUnit(raw.energyFullMicro));
  const energyFullDesignWh = round2(microToUnit(raw.energyFullDesignMicro));

  const healthPercent = computeHealthPercent(energyFullWh, energyFullDesignWh);
  const { minutes: timeRemainingMinutes, formatted: timeRemainingFormatted } =
    computeTimeRemaining(raw.status, powerWatts, energyNowWh, energyFullWh);

  return {
    percentage: raw.percentage,
    status: raw.status,
    powerWatts,
    voltage,
    energyNowWh,
    energyFullWh,
    energyFullDesignWh,
    healthPercent,
    timeRemainingMinutes,
    timeRemainingFormatted,
  };
}

/**
 * Score a power_supply candidate to distinguish the system battery from
 * peripheral (HID/USB) batteries.
 *
 * Higher score = more likely to be the main system battery:
 *  - `scope=Device` → heavy penalty (peripherals)
 *  - `hid-*` prefix  → moderate penalty (kernel convention)
 *  - has energy_full_design or charge_full_design → bonus (system batteries)
 */
export function scoreBatteryCandidate(opts: {
  name: string;
  scope: string;
  hasDesignCapacity: boolean;
}): number {
  let score = 10;
  if (opts.scope === "Device") score -= 100;
  if (opts.name.startsWith("hid-")) score -= 50;
  if (opts.hasDesignCapacity) score += 5;
  return score;
}
