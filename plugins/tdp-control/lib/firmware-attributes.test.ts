import { describe, it, expect } from "bun:test";
import {
  discoverPowerRails,
  inferWattScale,
  pickAttribute,
  FIRMWARE_ATTRIBUTES_DIR,
  type FirmwareAttrDeps,
} from "./firmware-attributes";

/**
 * In-memory sysfs: directories are keys mapping to their entry basenames,
 * files are keys mapping to their contents. Anything absent reads as null,
 * the same contract the backend's readFileText / readdir wrappers provide.
 */
function fakeFs(tree: {
  dirs: Record<string, string[]>;
  files: Record<string, string>;
}): FirmwareAttrDeps {
  return {
    readFile: async (path) => tree.files[path] ?? null,
    listDir: async (path) => tree.dirs[path] ?? null,
  };
}

/** The real shape of a vendor driver's attribute tree, in watts. */
function driverTree(
  driver: string,
  attrs: string[],
  range: { min: number; max: number } | null = { min: 8, max: 35 },
) {
  const base = `${FIRMWARE_ATTRIBUTES_DIR}/${driver}/attributes`;
  const files: Record<string, string> = {};
  for (const attr of attrs) {
    files[`${base}/${attr}/current_value`] = "15\n";
    if (range) {
      files[`${base}/${attr}/min_value`] = `${range.min}\n`;
      files[`${base}/${attr}/max_value`] = `${range.max}\n`;
    }
  }
  return {
    dirs: {
      [FIRMWARE_ATTRIBUTES_DIR]: [driver],
      [base]: attrs,
    },
    files,
  };
}

describe("pickAttribute", () => {
  it("returns the first candidate that exists", () => {
    expect(pickAttribute(["ppt_fppt", "ppt_pl3_fppt"], ["ppt_pl3_fppt", "ppt_fppt"])).toBe(
      "ppt_pl3_fppt",
    );
  });

  it("returns null when none exist", () => {
    expect(pickAttribute(["ppt_pl1_spl"], ["ppt_pl2_sppt"])).toBeNull();
  });
});

describe("inferWattScale", () => {
  // The `ppt_*` attributes are watts on every driver we know of; reading the
  // declared ceiling means a vendor that chose milliwatts still works.
  it("reads a two-digit ceiling as watts", () => {
    expect(inferWattScale(35)).toEqual({ scale: 1, known: true });
  });

  it("reads a five-digit ceiling as milliwatts", () => {
    expect(inferWattScale(35000)).toEqual({ scale: 1000, known: true });
  });

  it("assumes watts, and says so, when nothing is declared", () => {
    expect(inferWattScale(null)).toEqual({ scale: 1, known: false });
  });
});

describe("discoverPowerRails", () => {
  it("finds MSI's PL1 + PL2 and reports the absent PL3 as null", async () => {
    // msi-wmi-platform (MSI Claw, incl. the Arc G3 Extreme Claw 8 EX)
    // exposes no fast rail — the old code wrote all three unconditionally.
    const rails = await discoverPowerRails(
      fakeFs(driverTree("msi-wmi-platform", ["ppt_pl1_spl", "ppt_pl2_sppt"])),
    );
    const base = `${FIRMWARE_ATTRIBUTES_DIR}/msi-wmi-platform/attributes`;

    expect(rails).toEqual({
      spl: `${base}/ppt_pl1_spl/current_value`,
      sppt: `${base}/ppt_pl2_sppt/current_value`,
      fppt: null,
      scale: 1,
      scaleKnown: true,
      range: { min: 8, max: 35 },
      source: "msi-wmi-platform",
    });
  });

  it("finds ASUS's armoury rails, PL3 under its ppt_fppt spelling", async () => {
    const rails = await discoverPowerRails(
      fakeFs(
        driverTree("asus-armoury", ["ppt_pl1_spl", "ppt_pl2_sppt", "ppt_fppt"], {
          min: 7,
          max: 30,
        }),
      ),
    );
    expect(rails?.source).toBe("asus-armoury");
    expect(rails?.fppt).toContain("ppt_fppt/current_value");
    expect(rails?.range).toEqual({ min: 7, max: 30 });
  });

  it("finds Lenovo's rails, PL3 under its ppt_pl3_fppt spelling", async () => {
    const rails = await discoverPowerRails(
      fakeFs(
        driverTree("lenovo-wmi-other-0", ["ppt_pl1_spl", "ppt_pl2_sppt", "ppt_pl3_fppt"]),
      ),
    );
    expect(rails?.source).toBe("lenovo-wmi-other-0");
    expect(rails?.fppt).toContain("ppt_pl3_fppt/current_value");
  });

  it("converts a milliwatt-declared range into watts", async () => {
    const rails = await discoverPowerRails(
      fakeFs(
        driverTree("hypothetical-wmi", ["ppt_pl1_spl"], { min: 8000, max: 35000 }),
      ),
    );
    expect(rails?.scale).toBe(1000);
    expect(rails?.range).toEqual({ min: 8, max: 35 });
  });

  it("reports no range when the driver declares none", async () => {
    const rails = await discoverPowerRails(
      fakeFs(driverTree("bare-wmi", ["ppt_pl1_spl"], null)),
    );
    expect(rails?.range).toBeNull();
    expect(rails?.scaleKnown).toBe(false);
  });

  it("ignores a degenerate range where min equals max", async () => {
    const rails = await discoverPowerRails(
      fakeFs(driverTree("stuck-wmi", ["ppt_pl1_spl"], { min: 15, max: 15 })),
    );
    expect(rails?.range).toBeNull();
  });

  it("skips a driver with no sustained rail and keeps looking", async () => {
    // A boost limit with nothing to steer underneath is not controllable.
    const boostOnly = driverTree("boost-only-wmi", ["ppt_pl2_sppt"]);
    const real = driverTree("zz-real-wmi", ["ppt_pl1_spl"]);
    const rails = await discoverPowerRails(
      fakeFs({
        dirs: {
          ...boostOnly.dirs,
          ...real.dirs,
          [FIRMWARE_ATTRIBUTES_DIR]: ["boost-only-wmi", "zz-real-wmi"],
        },
        files: { ...boostOnly.files, ...real.files },
      }),
    );
    expect(rails?.source).toBe("zz-real-wmi");
  });

  it("returns null when the class directory doesn't exist", async () => {
    expect(await discoverPowerRails(fakeFs({ dirs: {}, files: {} }))).toBeNull();
  });

  it("returns null when no driver exposes power rails", async () => {
    const other = driverTree("thinklmi", ["boot_order"]);
    expect(await discoverPowerRails(fakeFs(other))).toBeNull();
  });

  it("picks the same driver every boot when several qualify", async () => {
    const a = driverTree("aaa-wmi", ["ppt_pl1_spl"]);
    const z = driverTree("zzz-wmi", ["ppt_pl1_spl"]);
    const tree = {
      dirs: { ...a.dirs, ...z.dirs, [FIRMWARE_ATTRIBUTES_DIR]: ["zzz-wmi", "aaa-wmi"] },
      files: { ...a.files, ...z.files },
    };
    expect((await discoverPowerRails(fakeFs(tree)))?.source).toBe("aaa-wmi");
  });
});
