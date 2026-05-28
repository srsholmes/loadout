/**
 * Pure UI helpers for the MangoHud Tweaks overlay.
 *
 * Lives in `lib/` so it's mockless-testable independent of React.
 */

import type { Preset } from "./config";

/** MangoHud `background_alpha` keys that are NOT metrics — used to
 *  decide whether a saved config matches a preset's metric set. */
const PRESET_IGNORE_KEYS = new Set([
  "position",
  "fps_limit",
  "background_alpha",
]);

/**
 * Identify which preset (if any) matches the current config.
 *
 * Ignores non-metric keys (position, fps_limit, background_alpha) so
 * the UI keeps showing "Standard" highlighted even after the user
 * tweaks position or opacity on top.
 *
 * Returns the preset's `name`, or `null` if nothing matches.
 */
export function detectActivePreset(
  config: Record<string, string>,
  presets: Preset[],
): string | null {
  const configKeys = Object.keys(config).filter((k) => !PRESET_IGNORE_KEYS.has(k));

  for (const preset of presets) {
    const presetKeys = Object.keys(preset.config);
    if (presetKeys.length !== configKeys.length) continue;

    const matches =
      presetKeys.every((k) => config[k] === preset.config[k]) &&
      configKeys.every((k) => k in preset.config);

    if (matches) return preset.name;
  }
  return null;
}

/** Parse MangoHud `background_alpha` (0–1 float) into a 0–100 percent. */
export function alphaToPercent(raw: string | undefined): number {
  if (!raw) return 50;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

/** Serialize a 0–100 percent back into MangoHud's 0–1 float string. */
export function percentToAlpha(pct: number): string {
  return (Math.max(0, Math.min(100, pct)) / 100).toFixed(2);
}
