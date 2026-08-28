import { describe, it, expect } from "bun:test";
import { RumbleControl, type RumbleInfo } from "./rumble-control";

/**
 * Sysfs is injected, so these run identically on a machine with OneXPlayer
 * rumble hardware attached and one without. That matters: the first version
 * of this module read the host's real /sys, and the plugin's own backend
 * tests then passed or failed depending on what was plugged into the
 * developer's device.
 */

const DEV = "/sys/bus/hid/devices/0003:1A86:FE00.0003";

function makeFs(files: Record<string, string>, entries = ["0003:1A86:FE00.0003"]) {
  const writes: { path: string; data: string }[] = [];
  return {
    writes,
    files,
    fs: {
      readdir: async (p: string) => {
        if (p !== "/sys/bus/hid/devices") throw new Error("ENOENT");
        return entries;
      },
      readFile: async (p: string) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p]!;
      },
      writeFile: async (p: string, d: string) => {
        writes.push({ path: p, data: d });
        files[p] = d;
      },
    },
  };
}

function makeControl(
  over: {
    files?: Record<string, string>;
    entries?: string[];
    stored?: number | undefined;
  } = {},
) {
  const harness = makeFs(
    over.files ?? {
      [`${DEV}/rumble_intensity`]: "5\n",
      [`${DEV}/rumble_intensity_range`]: "0-5\n",
    },
    over.entries,
  );
  let stored = over.stored;
  const changes: RumbleInfo[] = [];
  const control = new RumbleControl({
    readStored: async () => stored,
    writeStored: async (v) => {
      stored = v;
    },
    onChange: (i) => changes.push(i),
    fs: harness.fs,
  });
  return { control, changes, ...harness, getStored: () => stored };
}

describe("detection", () => {
  it("finds the device by attribute and reads its range", async () => {
    const { control } = makeControl();
    const info = await control.rescan();
    expect(info.available).toBe(true);
    expect(info.devicePath).toBe(DEV);
    expect(info.min).toBe(0);
    expect(info.max).toBe(5);
  });

  it("reports unavailable when no HID device carries the attribute", async () => {
    const { control } = makeControl({ files: {}, entries: ["0003:DEAD:BEEF.0001"] });
    const info = await control.rescan();
    expect(info.available).toBe(false);
    expect(info.devicePath).toBeNull();
  });

  it("falls back to 0-5 when the range attribute is unreadable", async () => {
    const { control } = makeControl({
      files: { [`${DEV}/rumble_intensity`]: "3\n" },
    });
    const info = await control.rescan();
    expect(info.available).toBe(true);
    expect(info.min).toBe(0);
    expect(info.max).toBe(5);
  });
});

describe("reported level", () => {
  it("prefers what we stored over what the driver reports", async () => {
    // The driver's value is a cache initialised to max on probe — it never
    // queries the MCU — so after a module reload it says 5 regardless.
    const { control } = makeControl({ stored: 2 });
    const info = await control.rescan();
    expect(info.intensity).toBe(2);
    expect(info.source).toBe("stored");
  });

  it("falls back to the driver's value, flagged as such", async () => {
    const { control } = makeControl({ stored: undefined });
    const info = await control.rescan();
    expect(info.intensity).toBe(5);
    expect(info.source).toBe("driver");
  });

  it("ignores a stored value outside the device's range", async () => {
    // Plugin storage is user-editable JSON.
    const { control } = makeControl({ stored: 99 });
    const info = await control.rescan();
    expect(info.source).toBe("driver");
  });
});

describe("setIntensity", () => {
  it("writes the level to sysfs and persists it", async () => {
    const { control, writes, getStored } = makeControl();
    await control.rescan();
    const res = await control.setIntensity(3);
    expect(res.success).toBe(true);
    expect(writes).toContainEqual({ path: `${DEV}/rumble_intensity`, data: "3" });
    expect(getStored()).toBe(3);
  });

  it("clamps rather than writing nonsense to the driver", async () => {
    const { control, writes } = makeControl();
    await control.rescan();
    await control.setIntensity(99);
    expect(writes.at(-1)!.data).toBe("5");
    await control.setIntensity(-4);
    expect(writes.at(-1)!.data).toBe("0");
  });

  it("fails cleanly with no device rather than throwing", async () => {
    const { control } = makeControl({ files: {}, entries: [] });
    const res = await control.setIntensity(3);
    expect(res.success).toBe(false);
    expect(res.error).toContain("No device");
  });

  it("still reports success when persisting fails", async () => {
    // The hardware took it; failing the call over a storage error would
    // misreport what the user can plainly feel.
    const harness = makeFs({
      [`${DEV}/rumble_intensity`]: "5\n",
      [`${DEV}/rumble_intensity_range`]: "0-5\n",
    });
    const control = new RumbleControl({
      readStored: async () => undefined,
      writeStored: async () => {
        throw new Error("EROFS");
      },
      fs: harness.fs,
    });
    await control.rescan();
    expect((await control.setIntensity(2)).success).toBe(true);
  });

  it("notifies listeners so other views follow the change", async () => {
    const { control, changes } = makeControl();
    await control.rescan();
    changes.length = 0;
    await control.setIntensity(1);
    expect(changes.at(-1)?.intensity).toBe(1);
  });
});

describe("start", () => {
  it("re-applies a stored level, since the driver's cache resets on reload", async () => {
    const { control, writes } = makeControl({ stored: 2 });
    await control.start();
    control.stop();
    expect(writes).toContainEqual({ path: `${DEV}/rumble_intensity`, data: "2" });
  });

  it("writes nothing when the user has never chosen a level", async () => {
    // Leaving the firmware default alone means a user managing this
    // elsewhere is never clobbered.
    const { control, writes } = makeControl({ stored: undefined });
    await control.start();
    control.stop();
    expect(writes).toEqual([]);
  });
});
