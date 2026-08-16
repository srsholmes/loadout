/**
 * Intel RAPL powercap discovery.
 *
 * RAPL is the fallback for Intel devices whose vendor driver exposes no
 * firmware power rails (see `./firmware-attributes`). A powercap zone looks
 * like:
 *
 *     <zone>/constraint_0_name            "long_term"
 *     <zone>/constraint_0_power_limit_uw
 *     <zone>/constraint_1_name            "short_term"
 *     <zone>/constraint_1_power_limit_uw
 *
 * Two things this gets right that reading `constraint_0_power_limit_uw`
 * directly does not:
 *
 *  - **Which constraint is which is named, not positional.** The ordering is
 *    conventional, not guaranteed, and a zone may expose "peak_power" or
 *    "short_term" first. Resolve by `constraint_N_name`.
 *  - **The short-term limit matters.** Steering PL1 alone leaves PL2 at its
 *    firmware default, so a chip with a base/boost split — Panther Lake ships
 *    35 W base against a much higher boost ceiling — spends the boost budget
 *    regardless of where the slider sits.
 *
 * I/O is injected so this is unit-testable without /sys.
 */

/**
 * Candidate package zones, most-preferred first. The MMIO variant is
 * preferred where present: it is the interface the firmware itself uses, and
 * it survives on parts where the MSR view is locked.
 */
export const INTEL_RAPL_ZONES = [
  "/sys/devices/virtual/powercap/intel-rapl-mmio/intel-rapl-mmio:0",
  "/sys/devices/virtual/powercap/intel-rapl/intel-rapl:0",
  "/sys/class/powercap/intel-rapl:0",
];

/** How many `constraint_N_*` slots to probe within a zone. */
export const RAPL_MAX_CONSTRAINTS = 4;

export interface RaplConstraints {
  /** Zone directory the constraints belong to. */
  zone: string;
  /** Sustained limit (PL1) in microwatts — the rail we steer. */
  longTerm: string;
  /** Boost limit (PL2) in microwatts, when the zone exposes one. */
  shortTerm: string | null;
}

export interface RaplDeps {
  /** Read a file, or null when it doesn't exist / can't be read. */
  readFile: (path: string) => Promise<string | null>;
}

const LIMIT_SUFFIX = "_power_limit_uw";

/**
 * Resolve a zone's power-limit files by constraint name.
 *
 * Returns null when the zone exposes no writable sustained limit. When no
 * constraint is *named* but slot 0 has a limit file, slot 0 is taken as the
 * sustained limit — the positional assumption the kernel's own convention
 * makes, and what this code did before names were consulted.
 */
export async function resolveZoneConstraints(
  deps: RaplDeps,
  zone: string,
): Promise<RaplConstraints | null> {
  let longTerm: string | null = null;
  let shortTerm: string | null = null;
  let anyNamed = false;

  for (let i = 0; i < RAPL_MAX_CONSTRAINTS; i++) {
    const limit = `${zone}/constraint_${i}${LIMIT_SUFFIX}`;
    if ((await deps.readFile(limit)) === null) continue;

    const name = (await deps.readFile(`${zone}/constraint_${i}_name`))?.trim();
    if (name) anyNamed = true;
    if (name === "long_term" && !longTerm) longTerm = limit;
    else if (name === "short_term" && !shortTerm) shortTerm = limit;
  }

  if (!longTerm && !anyNamed) {
    const slot0 = `${zone}/constraint_0${LIMIT_SUFFIX}`;
    if ((await deps.readFile(slot0)) !== null) longTerm = slot0;
  }

  return longTerm ? { zone, longTerm, shortTerm } : null;
}

/** First candidate zone exposing a sustained power limit, or null. */
export async function discoverRaplConstraints(
  deps: RaplDeps,
): Promise<RaplConstraints | null> {
  // Probed in preference order rather than in parallel: the whole point of
  // the ordering is the tie-break, and a hit on the first candidate makes
  // the rest moot.
  for (const zone of INTEL_RAPL_ZONES) {
    const resolved = await resolveZoneConstraints(deps, zone);
    if (resolved) return resolved;
  }
  return null;
}
