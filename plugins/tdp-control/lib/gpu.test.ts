import { describe, it, expect } from "bun:test";
import { findXeFreqDirs, writeCeilingFirst, type GpuFsDeps } from "./gpu";

function fakeFs(tree: {
  dirs: Record<string, string[]>;
  files: Record<string, string>;
}): GpuFsDeps {
  return {
    readFile: async (path) => tree.files[path] ?? null,
    listDir: async (path) => tree.dirs[path] ?? null,
  };
}

const CARD = "/sys/class/drm/card0";

/** An `xe` card exposing one freq0 dir per (tile, gt) pair given. */
function xeCard(gts: Array<[string, string]>) {
  const dirs: Record<string, string[]> = {};
  const files: Record<string, string> = {};
  const tiles = [...new Set(gts.map(([tile]) => tile))];
  dirs[`${CARD}/device`] = [...tiles, "power", "uevent"];
  for (const tile of tiles) {
    dirs[`${CARD}/device/${tile}`] = gts.filter(([t]) => t === tile).map(([, gt]) => gt);
  }
  for (const [tile, gt] of gts) {
    files[`${CARD}/device/${tile}/${gt}/freq0/max_freq`] = "2300\n";
  }
  return { dirs, files };
}

describe("findXeFreqDirs", () => {
  it("finds every GT on a multi-GT part, in tile-then-GT order", async () => {
    // Panther Lake exposes a render GT and a media GT — bounding only the
    // first would leave the other running free.
    const dirs = await findXeFreqDirs(
      fakeFs(xeCard([["tile0", "gt1"], ["tile0", "gt0"]])),
      CARD,
    );
    expect(dirs).toEqual([
      `${CARD}/device/tile0/gt0/freq0`,
      `${CARD}/device/tile0/gt1/freq0`,
    ]);
  });

  it("walks multiple tiles", async () => {
    const dirs = await findXeFreqDirs(
      fakeFs(xeCard([["tile1", "gt0"], ["tile0", "gt0"]])),
      CARD,
    );
    expect(dirs).toEqual([
      `${CARD}/device/tile0/gt0/freq0`,
      `${CARD}/device/tile1/gt0/freq0`,
    ]);
  });

  it("skips a GT with no freq0 knobs", async () => {
    const tree = xeCard([["tile0", "gt0"], ["tile0", "gt1"]]);
    delete tree.files[`${CARD}/device/tile0/gt1/freq0/max_freq`];
    expect(await findXeFreqDirs(fakeFs(tree), CARD)).toEqual([
      `${CARD}/device/tile0/gt0/freq0`,
    ]);
  });

  it("returns nothing for an i915 card (no tile dirs)", async () => {
    const tree = {
      dirs: { [`${CARD}/device`]: ["power", "uevent"] },
      files: { [`${CARD}/gt_max_freq_mhz`]: "2300\n" },
    };
    expect(await findXeFreqDirs(fakeFs(tree), CARD)).toEqual([]);
  });

  it("returns nothing when the device dir doesn't exist", async () => {
    expect(await findXeFreqDirs(fakeFs({ dirs: {}, files: {} }), CARD)).toEqual([]);
  });
});

describe("writeCeilingFirst", () => {
  // Either fixed order wedges half the time: the kernel rejects a write that
  // would leave the floor above the ceiling.
  it("raises the ceiling first when the new floor clears the old ceiling", () => {
    expect(writeCeilingFirst(500, 800)).toBe(true);
  });

  it("lowers the floor first when the new floor fits under the old ceiling", () => {
    expect(writeCeilingFirst(2000, 300)).toBe(false);
  });

  it("treats an equal floor and ceiling as no reordering needed", () => {
    expect(writeCeilingFirst(800, 800)).toBe(false);
  });

  it("assumes a raise when the current ceiling can't be read", () => {
    expect(writeCeilingFirst(null, 800)).toBe(true);
    expect(writeCeilingFirst(NaN, 800)).toBe(true);
  });
});
