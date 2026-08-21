/**
 * The user's global fan-control choice, persisted across restarts.
 *
 * Issue #265: `applyPreset` only ever set `activePreset` in memory, so a
 * reboot (or a `loadout.service` restart) dropped the selection. Nothing
 * restarted the curve loop, and `getFanInfo` fell back to reading
 * `pwm1_enable` — which drivers like `oxp_ec` initialise to 1 (manual) —
 * so a user who had picked "Silent" came back to a fixed manual duty.
 *
 * "Global" is the operative word: this is what the user chose for the
 * system, distinct from the per-game profiles the PerGameEngine owns. A
 * per-game profile applying on launch must NOT overwrite it, or exiting
 * the game (or rebooting after playing one) would silently promote that
 * game's fan setting to the user's default.
 */

import type { PresetName } from "./fan-curves";

const PRESET_NAMES: readonly string[] = ["silent", "balanced", "performance"];

export type GlobalFanMode =
  /** One of the built-in curves. */
  | { kind: "preset"; name: PresetName }
  /** The user's own curve, whose points persist separately as `customCurve`. */
  | { kind: "custom" }
  /**
   * Manual duty. `percent` is null when the user flipped to manual without
   * naming a speed — restoring then only re-asserts the mode, since we have
   * no duty to write.
   */
  | { kind: "manual"; percent: number | null }
  /** Kernel/EC-controlled. Worth persisting: several drivers come up in
   *  manual, so "auto" has to be re-asserted rather than assumed. */
  | { kind: "auto" };

/**
 * Parse a persisted value back into a {@link GlobalFanMode}, or null when it
 * is absent or malformed.
 *
 * Plugin storage is user-editable JSON, so this trusts nothing — same
 * posture as `sanitiseCurve`. A bad value restores nothing rather than
 * throwing during `onLoad` and taking the whole plugin down with it.
 */
export function sanitiseGlobalMode(input: unknown): GlobalFanMode | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;

  switch (raw.kind) {
    case "preset":
      return typeof raw.name === "string" && PRESET_NAMES.includes(raw.name)
        ? { kind: "preset", name: raw.name as PresetName }
        : null;
    case "custom":
      return { kind: "custom" };
    case "auto":
      return { kind: "auto" };
    case "manual": {
      // Absent/!finite percent degrades to "manual, no duty" rather than
      // discarding the mode — the user's auto-vs-manual intent still stands.
      const pct = raw.percent;
      if (typeof pct !== "number" || !Number.isFinite(pct)) {
        return { kind: "manual", percent: null };
      }
      return { kind: "manual", percent: Math.max(0, Math.min(100, Math.round(pct))) };
    }
    default:
      return null;
  }
}
