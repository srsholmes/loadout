import { describe, it, expect } from "bun:test";
import {
  discoverRaplConstraints,
  resolveZoneConstraints,
  INTEL_RAPL_ZONES,
  type RaplDeps,
} from "./rapl";

function fakeFs(files: Record<string, string>): RaplDeps {
  return { readFile: async (path) => files[path] ?? null };
}

/** A package zone with the named constraints, in the given slot order. */
function zoneFiles(zone: string, names: string[]) {
  const files: Record<string, string> = {};
  names.forEach((name, i) => {
    files[`${zone}/constraint_${i}_name`] = `${name}\n`;
    files[`${zone}/constraint_${i}_power_limit_uw`] = "15000000\n";
  });
  return files;
}

const MMIO = INTEL_RAPL_ZONES[0]!;
const MSR = INTEL_RAPL_ZONES[1]!;

describe("resolveZoneConstraints", () => {
  it("resolves both limits by name", async () => {
    const zone = MMIO;
    const got = await resolveZoneConstraints(
      fakeFs(zoneFiles(zone, ["long_term", "short_term"])),
      zone,
    );
    expect(got).toEqual({
      zone,
      longTerm: `${zone}/constraint_0_power_limit_uw`,
      shortTerm: `${zone}/constraint_1_power_limit_uw`,
    });
  });

  // Slot order is conventional, not guaranteed — reading the name is the
  // whole point of resolving rather than assuming index 0 is PL1.
  it("resolves correctly when the constraints are in the other order", async () => {
    const zone = MMIO;
    const got = await resolveZoneConstraints(
      fakeFs(zoneFiles(zone, ["short_term", "long_term"])),
      zone,
    );
    expect(got?.longTerm).toBe(`${zone}/constraint_1_power_limit_uw`);
    expect(got?.shortTerm).toBe(`${zone}/constraint_0_power_limit_uw`);
  });

  it("ignores constraints it doesn't steer, like peak_power", async () => {
    const zone = MMIO;
    const got = await resolveZoneConstraints(
      fakeFs(zoneFiles(zone, ["long_term", "peak_power"])),
      zone,
    );
    expect(got?.longTerm).toBe(`${zone}/constraint_0_power_limit_uw`);
    expect(got?.shortTerm).toBeNull();
  });

  it("reports a missing short-term limit as null rather than failing", async () => {
    const zone = MMIO;
    const got = await resolveZoneConstraints(fakeFs(zoneFiles(zone, ["long_term"])), zone);
    expect(got?.shortTerm).toBeNull();
  });

  // Pre-name behaviour: an unnamed zone still works off slot 0.
  it("falls back to slot 0 when no constraint is named", async () => {
    const zone = MMIO;
    const got = await resolveZoneConstraints(
      fakeFs({ [`${zone}/constraint_0_power_limit_uw`]: "15000000\n" }),
      zone,
    );
    expect(got?.longTerm).toBe(`${zone}/constraint_0_power_limit_uw`);
  });

  it("refuses to pin the sustained rail to short_term", async () => {
    // Slot 0 is the short_term limit here, so the positional fallback must
    // NOT claim it — capping boost while believing we capped sustained draw
    // is worse than reporting no RAPL control at all.
    const zone = MMIO;
    expect(
      await resolveZoneConstraints(fakeFs(zoneFiles(zone, ["short_term"])), zone),
    ).toBeNull();
  });

  it("falls back to slot 0 when constraints are named but none is long_term", async () => {
    // A zone that names peak_power/short_term but no long_term used to
    // resolve to null, losing TDP control on a device the old positional
    // code handled fine.
    const zone = MMIO;
    const got = await resolveZoneConstraints(
      fakeFs(zoneFiles(zone, ["peak_power", "short_term"])),
      zone,
    );
    expect(got?.longTerm).toBe(`${zone}/constraint_0_power_limit_uw`);
    expect(got?.shortTerm).toBe(`${zone}/constraint_1_power_limit_uw`);
  });

  it("returns null for a zone that doesn't exist", async () => {
    expect(await resolveZoneConstraints(fakeFs({}), MMIO)).toBeNull();
  });
});

describe("discoverRaplConstraints", () => {
  it("prefers the MMIO zone over the MSR one", async () => {
    const got = await discoverRaplConstraints(
      fakeFs({
        ...zoneFiles(MMIO, ["long_term", "short_term"]),
        ...zoneFiles(MSR, ["long_term", "short_term"]),
      }),
    );
    expect(got?.zone).toBe(MMIO);
  });

  it("falls through to the next zone when the preferred one is absent", async () => {
    const got = await discoverRaplConstraints(
      fakeFs(zoneFiles(MSR, ["long_term", "short_term"])),
    );
    expect(got?.zone).toBe(MSR);
  });

  it("returns null when no zone exposes a sustained limit", async () => {
    expect(await discoverRaplConstraints(fakeFs({}))).toBeNull();
  });
});
