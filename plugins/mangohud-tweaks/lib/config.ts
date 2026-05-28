/**
 * Pure parse/serialize helpers for MangoHud.conf.
 *
 * MangoHud's config is a tiny "ini-like" `key=value` file with `#`
 * comments and blank lines. All parsing/serialisation is pure and lives
 * here so the backend can stick to I/O + RPC plumbing.
 */

export interface Preset {
  name: string;
  label: string;
  config: Record<string, string>;
}

/**
 * Built-in presets the backend ships.
 *
 * The set + names ("minimal", "standard", "full", "battery", "off") and
 * each preset's key-set are part of the plugin's RPC contract — the UI
 * preset-detection logic in `app.tsx` and the source plugin's tests
 * both pin these names. Don't rename without bumping the contract.
 */
export const PRESETS: Preset[] = [
  {
    name: "minimal",
    label: "Minimal",
    config: { fps: "1", fps_only: "1" },
  },
  {
    name: "standard",
    label: "Standard",
    config: { fps: "1", gpu_stats: "1", cpu_stats: "1", ram: "1", vram: "1" },
  },
  {
    name: "full",
    label: "Full",
    config: {
      fps: "1",
      gpu_stats: "1",
      cpu_stats: "1",
      cpu_temp: "1",
      gpu_temp: "1",
      ram: "1",
      vram: "1",
      frame_timing: "1",
      battery: "1",
      gamemode: "1",
    },
  },
  {
    name: "battery",
    label: "Battery",
    config: { fps: "1", battery: "1", battery_watt: "1", gpu_power: "1" },
  },
  {
    name: "off",
    label: "Off",
    config: { no_display: "1" },
  },
];

/**
 * Parse a MangoHud.conf text blob into a key-value record.
 *
 * - Skips blank lines and lines starting with `#`.
 * - First `=` splits key from value; both sides are trimmed.
 * - Lines without `=` are silently dropped (matches the source plugin's
 *   behaviour).
 */
export function parseConfig(text: string): Record<string, string> {
  const config: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();
    config[key] = value;
  }
  return config;
}

/**
 * Extract the comment + blank lines from an existing MangoHud.conf text
 * blob, in the order they appeared. Used by `serializeConfig` to
 * preserve user comments on rewrite.
 */
export function extractCommentLines(text: string): string[] {
  return text.split("\n").filter((line) => {
    const t = line.trim();
    return !t || t.startsWith("#");
  });
}

/**
 * Render a `Record<string, string>` back to MangoHud.conf text,
 * appending the original comments (if any) verbatim at the top and the
 * `key=value` pairs below. Trailing newline included.
 */
export function serializeConfig(
  config: Record<string, string>,
  commentLines: string[] = [],
): string {
  const lines: string[] = [...commentLines];
  for (const [key, value] of Object.entries(config)) {
    lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Look up a preset by name. Returns `undefined` if not found.
 */
export function findPreset(name: string): Preset | undefined {
  return PRESETS.find((p) => p.name === name);
}
