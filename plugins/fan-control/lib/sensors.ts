/**
 * Temperature-sensor classification + pwm_enable mode parsing — pure
 * logic, no I/O.
 *
 * Split out of backend.ts so the chip/keyword heuristics and the sysfs
 * value mappings are independently readable and unit-testable. The
 * backend reads the chip `name` and `tempN_label` files and passes the
 * strings through `classifyTempZone`; it reads `pwmN_enable` and passes
 * the integer through `parsePwmMode`.
 */

/** Chip names known to host CPU temperature sensors. */
export const CPU_TEMP_CHIPS = ["k10temp", "coretemp", "zenpower"];

/** Chip names known to host GPU temperature sensors. */
export const GPU_TEMP_CHIPS = ["amdgpu", "nvidia", "nouveau", "radeon"];

/** Keywords that hint at a CPU-related temp label. */
export const CPU_LABEL_KEYWORDS = ["tctl", "tdie", "cpu", "soc", "package"];

/** A temperature zone classification. */
export type TempZone = "cpu" | "gpu" | "soc" | "unknown";

/**
 * Classify a temperature sensor into a zone based on its chip name and
 * label. Matching is case-insensitive against the chip+label string.
 * Pure.
 *
 * Note: "soc" appears in CPU_LABEL_KEYWORDS, so a SoC-labelled sensor
 * classifies as "cpu" (it's the hot die we care about for safety); the
 * explicit "soc" branch only catches chips/labels that contain "soc"
 * without also matching a CPU keyword first — kept for completeness.
 */
export function classifyTempZone(chipName: string, label: string): TempZone {
  const lower = (chipName + " " + label).toLowerCase();

  if (CPU_TEMP_CHIPS.some((c) => lower.includes(c))) return "cpu";
  if (CPU_LABEL_KEYWORDS.some((kw) => lower.includes(kw))) return "cpu";
  if (GPU_TEMP_CHIPS.some((c) => lower.includes(c))) return "gpu";
  if (lower.includes("gpu") || lower.includes("junction") || lower.includes("edge")) return "gpu";
  if (lower.includes("soc")) return "soc";

  // steamdeck_hwmon has CPU temp
  if (lower.includes("steamdeck")) return "cpu";

  return "unknown";
}

/** Sort weight for a zone — CPU first, then GPU, SoC, unknown. Pure. */
export function zoneSortWeight(zone: string): number {
  const order: Record<string, number> = { cpu: 0, gpu: 1, soc: 2, unknown: 3 };
  return order[zone] ?? 3;
}

/** Parse a pwm_enable integer into a human-readable mode string. Pure. */
export function parsePwmMode(value: number): "auto" | "manual" | "full" | "unknown" {
  switch (value) {
    case 0:
      return "full";
    case 1:
      return "manual";
    case 2:
      return "auto";
    default:
      return "unknown";
  }
}
