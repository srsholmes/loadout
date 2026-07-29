/**
 * Pure charge-control helpers (charge limit + bypass charging).
 *
 * No I/O here — value parsing and sysfs-string mapping only, so it unit-tests
 * without mocking the filesystem (same convention as lib/battery.ts).
 *
 * Mechanism notes (one generic sysfs layer — the kernel's vendor driver
 * does the EC work, so the same code covers every device whose driver
 * exposes these attributes):
 *
 *  - Charge limit: integer percent written to
 *    `<battery>/charge_control_end_threshold`. Exposed by asus-wmi (ROG
 *    Ally), oxp-platform/oxpec (OneXPlayer/AOKZOE), msi_ec, and others.
 *
 *  - Bypass charging (run off AC without charging the pack), two variants:
 *      `charge_behaviour` — mainline attr. Prints every supported value
 *        with the active one bracketed, e.g.
 *        `[auto] inhibit-charge inhibit-charge-awake`. `inhibit-charge-awake`
 *        (resume charging while asleep/off) is a handheld-kernel extension,
 *        so its presence is probed from the option list, never assumed.
 *      `charge_type` — legacy OneXPlayer patched-kernel spelling
 *        (`Standard`/`Bypass`/`BypassS0`). Only trustworthy on ONE-NETBOOK
 *        hardware; other vendors use `charge_type` for unrelated concepts
 *        (e.g. Fast/Trickle), so callers must DMI-gate this variant.
 */

export type BypassMode = "disabled" | "awake" | "always";
export type BypassMechanism = "charge_behaviour" | "charge_type";

export const BYPASS_MODES: readonly BypassMode[] = ["disabled", "awake", "always"];

export const CHARGE_LIMIT_MIN = 50;
export const CHARGE_LIMIT_MAX = 100;

/** What the backend reports to the frontend. */
export interface ChargeControlInfo {
  supportsChargeLimit: boolean;
  /** Current threshold from sysfs; null when unsupported or unlimited (100). */
  chargeLimitPercent: number | null;
  supportsBypass: boolean;
  /** Whether the "bypass only while awake" variant is available. */
  supportsBypassAwake: boolean;
  bypassMode: BypassMode;
}

/** Validate a charge-limit percentage (integer, 50–100). */
export function isValidChargeLimit(percent: number): boolean {
  return (
    Number.isInteger(percent) && percent >= CHARGE_LIMIT_MIN && percent <= CHARGE_LIMIT_MAX
  );
}

/**
 * Extract the active value from a power_supply enum attribute.
 * These print all supported values with the active one in brackets
 * (`[auto] inhibit-charge`); plain single-value attrs print bare text.
 */
export function parseActiveEnumValue(raw: string): string {
  const bracketed = raw.match(/\[([^\]]+)\]/);
  if (bracketed?.[1]) return bracketed[1];
  return raw.trim();
}

/**
 * Split a power_supply enum attribute into its list of supported values,
 * stripping the brackets around the active one. `[auto] inhibit-charge
 * inhibit-charge-awake` → `["auto", "inhibit-charge", "inhibit-charge-awake"]`.
 * Membership testing on this avoids substring false-positives (plain
 * `inhibit-charge` is a substring of `inhibit-charge-awake`).
 */
export function parseEnumOptions(raw: string): string[] {
  return raw
    .trim()
    .split(/\s+/)
    .map((tok) => tok.replace(/^\[/, "").replace(/\]$/, ""))
    .filter(Boolean);
}

/** Whether a charge_behaviour option list offers the "always" (plain
 *  inhibit-charge) bypass value. */
export function behaviourSupportsAlways(raw: string): boolean {
  return parseEnumOptions(raw).includes("inhibit-charge");
}

/** Whether a charge_behaviour option list offers the awake-only variant
 *  (a handheld-kernel extension). */
export function behaviourSupportsAwake(raw: string): boolean {
  return parseEnumOptions(raw).includes("inhibit-charge-awake");
}

const BEHAVIOUR_BY_MODE: Record<BypassMode, string> = {
  disabled: "auto",
  awake: "inhibit-charge-awake",
  always: "inhibit-charge",
};

const CHARGE_TYPE_BY_MODE: Record<BypassMode, string> = {
  disabled: "Standard",
  awake: "BypassS0",
  always: "Bypass",
};

/** Map a bypass mode to the string written to the mechanism's sysfs attr. */
export function bypassModeToSysfs(mechanism: BypassMechanism, mode: BypassMode): string {
  return mechanism === "charge_behaviour"
    ? BEHAVIOUR_BY_MODE[mode]
    : CHARGE_TYPE_BY_MODE[mode];
}

/**
 * Map an active sysfs value back to a bypass mode. Unknown values
 * (e.g. `force-discharge`, `Fast`) read as "disabled" — we only claim
 * bypass is engaged when we can positively identify it.
 */
export function sysfsToBypassMode(mechanism: BypassMechanism, active: string): BypassMode {
  const table = mechanism === "charge_behaviour" ? BEHAVIOUR_BY_MODE : CHARGE_TYPE_BY_MODE;
  for (const mode of BYPASS_MODES) {
    if (mode !== "disabled" && table[mode] === active) return mode;
  }
  return "disabled";
}

/** Normalize a stored threshold for reporting: 100 means "no limit". */
export function thresholdToLimitPercent(threshold: number | null): number | null {
  if (threshold === null || threshold >= 100 || threshold <= 0) return null;
  return threshold;
}
