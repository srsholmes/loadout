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

/**
 * Labels that explicitly identify a sensor as NOT the CPU/APU. Must be
 * checked BEFORE chip-name CPU heuristics so we don't blanket-classify
 * every sensor on a chip whose name suggests CPU. The biggest offender
 * is `steamdeck_hwmon`, which hosts ONLY a "Battery Temp" sensor —
 * misreading it as CPU caused the safety watchdog to compare APU thermals
 * to a battery that idles ~40 °C, never engaged, and the APU cooked.
 */
export const NON_CPU_LABEL_KEYWORDS = ["battery", "nvme", "ssd", "ambient"];

/** A temperature zone classification. */
export type TempZone = "cpu" | "gpu" | "soc" | "battery" | "unknown";

/**
 * Classify a temperature sensor into a zone based on its chip name and
 * label. Matching is case-insensitive against the chip+label string.
 * Pure.
 *
 * Order matters: NON-CPU labels are checked BEFORE the chip-name CPU
 * heuristic, because some chips host *only* non-CPU sensors and the
 * safety watchdog would otherwise read the wrong thing. On the Steam
 * Deck specifically, the real APU package temperature is exposed via
 * `acpitz` (ACPI thermal zone), not steamdeck_hwmon.
 */
export function classifyTempZone(chipName: string, label: string): TempZone {
  const lower = (chipName + " " + label).toLowerCase();

  // Negative matches first — these labels are NEVER the CPU even when
  // they live on a chip whose other sensors are. Battery gets its own
  // zone so the UI can surface it without confusing it for CPU.
  if (lower.includes("battery")) return "battery";
  if (NON_CPU_LABEL_KEYWORDS.some((kw) => lower.includes(kw))) return "unknown";

  if (CPU_TEMP_CHIPS.some((c) => lower.includes(c))) return "cpu";
  if (CPU_LABEL_KEYWORDS.some((kw) => lower.includes(kw))) return "cpu";
  if (GPU_TEMP_CHIPS.some((c) => lower.includes(c))) return "gpu";
  if (lower.includes("gpu") || lower.includes("junction") || lower.includes("edge")) return "gpu";
  if (lower.includes("soc")) return "soc";

  // acpitz is the ACPI thermal zone — on the Steam Deck (and most AMD
  // handhelds where k10temp isn't loaded) it IS the APU package
  // temperature. Classify as CPU so the safety watchdog has a real
  // signal. Done AFTER label-based negatives so a hypothetical labelled
  // acpitz/Battery wouldn't slip through.
  if (chipName.toLowerCase() === "acpitz") return "cpu";

  return "unknown";
}

/** Sort weight for a zone — CPU first, then GPU, SoC, battery, unknown. Pure. */
export function zoneSortWeight(zone: string): number {
  const order: Record<string, number> = { cpu: 0, gpu: 1, soc: 2, battery: 3, unknown: 4 };
  return order[zone] ?? 4;
}

/**
 * Within a zone, prefer a real CPU die sensor (k10temp / coretemp / zenpower)
 * over the `acpitz` ACPI-thermal-zone fallback. On AMD handhelds acpitz is a
 * slow board/skin sensor that lags the die by tens of degrees, so when a real
 * die chip is present it must win the "which sensor is the CPU" tiebreak.
 * Both are classified `cpu` by `classifyTempZone`, so this is the secondary
 * sort key. Lower = preferred. Pure.
 */
export function cpuChipPriority(chipName: string): number {
  return CPU_TEMP_CHIPS.some((c) => chipName.toLowerCase().includes(c)) ? 0 : 1;
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
