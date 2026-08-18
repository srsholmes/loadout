/**
 * Discovery for the kernel's `firmware-attributes` power-limit interface —
 * the vendor-neutral way modern handheld firmware exposes its TDP rails.
 *
 * Every vendor driver implementing it lays the same tree out:
 *
 *     /sys/class/firmware-attributes/<driver>/attributes/<attr>/
 *         current_value  min_value  max_value  scalar_increment  type
 *
 * and, crucially, they agree on the attribute *names* for the power rails
 * even though the driver directory differs per vendor:
 *
 *     asus-armoury         ROG Ally / Ally X
 *     lenovo-wmi-other-N   Legion Go
 *     msi-wmi-platform     MSI Claw (incl. the Arc G3 Extreme Claw 8 EX)
 *
 * Matching on the attribute names rather than the driver name is what lets a
 * handheld we've never seen work on day one — the previous approach hardcoded
 * two driver paths behind a DMI check for "ROG Ally" / "Legion Go", so every
 * other device silently fell through to Intel RAPL (commonly locked or
 * overridden by the EC on these machines: the slider moved, nothing happened).
 *
 * The interface is self-describing — `min_value`/`max_value` state the
 * envelope the firmware will actually accept — so a device with no entry in
 * `@loadout/devices` still gets a correct slider range, and we learn the
 * rail's unit instead of assuming it.
 *
 * I/O is injected (`FirmwareAttrDeps`) so the whole module is unit-testable
 * without sysfs, the same pattern `plugins/wifi/lib/recovery.ts` uses.
 */

export const FIRMWARE_ATTRIBUTES_DIR = "/sys/class/firmware-attributes";

/**
 * Attribute names per power rail, most-preferred first.
 *
 * SPL (PL1, sustained) is the rail we actually steer and the one a device
 * must expose to be usable. SPPT (PL2, boost) and FPPT (PL3, fast) are
 * written alongside it when present so a boost limit can't blow past the
 * sustained one — MSI exposes only PL1 + PL2, ASUS and Lenovo expose all
 * three under different PL3 spellings.
 */
export const PPT_RAIL_ATTRS = {
  spl: ["ppt_pl1_spl"],
  sppt: ["ppt_pl2_sppt"],
  fppt: ["ppt_pl3_fppt", "ppt_fppt"],
} as const;

export interface WattRange {
  min: number;
  max: number;
}

/** The set of power-limit sysfs files to drive, plus what we learned about them. */
export interface PowerRails {
  /** Sustained limit (PL1/SPL) — always present; the rail we steer. */
  spl: string;
  /** Boost limit (PL2/SPPT), or null when the firmware exposes none. */
  sppt: string | null;
  /** Fast limit (PL3/FPPT), or null when the firmware exposes none. */
  fppt: string | null;
  /** Multiplier from watts to the unit these files expect (1 = W, 1000 = mW). */
  scale: number;
  /**
   * True when `scale` came from a firmware-declared `max_value` rather than
   * being assumed. Callers use this to decide whether a rejected write is
   * worth retrying in the other unit.
   */
  scaleKnown: boolean;
  /** Envelope the firmware declares for the SPL rail, in watts. */
  range: WattRange | null;
  /** Driver directory (or a label for the legacy path) — for logs. */
  source: string;
}

export interface FirmwareAttrDeps {
  /** Read a file, or null when it doesn't exist / can't be read. */
  readFile: (path: string) => Promise<string | null>;
  /** Entry basenames of a directory, or null when it doesn't exist. */
  listDir: (path: string) => Promise<string[] | null>;
}

/**
 * A declared ceiling at or above this is read as milliwatts.
 *
 * The two units are separated by three orders of magnitude and the plausible
 * ranges don't come close to overlapping: no handheld sustains 1000 W, and no
 * firmware caps a rail at under 1 W. `ppt_*` attributes are watts on every
 * driver we know of, but reading the declared ceiling means we don't have to
 * bet on that holding for the next vendor.
 */
export const MILLIWATT_MIN_CEILING = 1000;

/** Infer the watts→attribute-unit multiplier from a declared ceiling. Pure. */
export function inferWattScale(maxValue: number | null): {
  scale: number;
  known: boolean;
} {
  if (maxValue === null || !Number.isFinite(maxValue)) {
    return { scale: 1, known: false };
  }
  return maxValue >= MILLIWATT_MIN_CEILING
    ? { scale: 1000, known: true }
    : { scale: 1, known: true };
}

/** First candidate present in `available`, or null. Pure. */
export function pickAttribute(
  available: readonly string[],
  candidates: readonly string[],
): string | null {
  return candidates.find((name) => available.includes(name)) ?? null;
}

function parseIntOrNull(text: string | null): number | null {
  if (text === null) return null;
  const n = parseInt(text.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Scan `/sys/class/firmware-attributes` for a driver exposing the `ppt_*`
 * power rails and describe them. Returns null when no driver does.
 *
 * Drivers are visited in sorted order so a machine with more than one
 * resolves the same way every boot.
 */
export async function discoverPowerRails(
  deps: FirmwareAttrDeps,
): Promise<PowerRails | null> {
  const drivers = await deps.listDir(FIRMWARE_ATTRIBUTES_DIR);
  if (!drivers) return null;

  for (const driver of [...drivers].sort()) {
    const attrsDir = `${FIRMWARE_ATTRIBUTES_DIR}/${driver}/attributes`;
    const available = await deps.listDir(attrsDir);
    if (!available) continue;

    const spl = pickAttribute(available, PPT_RAIL_ATTRS.spl);
    // No sustained rail means nothing to steer — a driver exposing only a
    // boost limit isn't usable, so keep looking.
    if (!spl) continue;

    const sppt = pickAttribute(available, PPT_RAIL_ATTRS.sppt);
    const fppt = pickAttribute(available, PPT_RAIL_ATTRS.fppt);
    const valuePath = (attr: string) => `${attrsDir}/${attr}/current_value`;

    // The attribute *directory* existing is not enough: a stub or read-only
    // driver can publish `ppt_pl1_spl/` with no readable `current_value`.
    // Claiming those rails would latch method="wmi" and starve the Intel
    // RAPL fallback at step 2 of detectTdpMethod — a device that works on
    // the old code would lose TDP control entirely. Read it first, the way
    // the DMI-matched probes in backend.ts do.
    if ((await deps.readFile(valuePath(spl))) === null) continue;

    const [minText, maxText] = await Promise.all([
      deps.readFile(`${attrsDir}/${spl}/min_value`),
      deps.readFile(`${attrsDir}/${spl}/max_value`),
    ]);
    const rawMin = parseIntOrNull(minText);
    const rawMax = parseIntOrNull(maxText);
    const { scale, known } = inferWattScale(rawMax);

    // A range is only useful if it's a real interval — a driver reporting
    // min === max (or nothing at all) leaves the device database in charge.
    const range =
      rawMin !== null && rawMax !== null && rawMax > rawMin
        ? { min: Math.round(rawMin / scale), max: Math.round(rawMax / scale) }
        : null;

    return {
      spl: valuePath(spl),
      sppt: sppt ? valuePath(sppt) : null,
      fppt: fppt ? valuePath(fppt) : null,
      scale,
      scaleKnown: known,
      range,
      source: driver,
    };
  }

  return null;
}
