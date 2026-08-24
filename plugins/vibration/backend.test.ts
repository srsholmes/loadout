/**
 * vibration backend spec.
 *
 * The filesystem is faked at the `node:fs/promises` boundary so detection,
 * restore and writes can be exercised without a OneXPlayer — including the
 * shapes we can't reproduce on any one machine (gen-1 device with no
 * attribute, a blacklisted driver, a wider future range).
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import * as storage from "@loadout/plugin-storage";

// Fake sysfs. Keys are absolute paths; directories are derived from them.
let files = new Map<string, string>();
let dirs: string[] = [];
let writes: { path: string; value: string }[] = [];
let writeFails = false;

mock.module("node:fs/promises", () => ({
  readdir: async (path: string) => {
    if (path !== "/sys/bus/hid/devices") throw new Error("ENOENT");
    return dirs;
  },
  readFile: async (path: string) => {
    const v = files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  },
  writeFile: async (path: string, value: string) => {
    if (writeFails) throw new Error("EACCES");
    writes.push({ path, value });
    files.set(path, `${value}\n`);
  },
}));

const { default: VibrationBackend } = await import("./backend");

const DEV = "/sys/bus/hid/devices/0003:1A86:FE00.0005";
let persisted: Record<string, unknown> = {};

function gen2Device(intensity = "5", range = "0-5") {
  dirs = ["0003:1A86:FE00.0005"];
  files.set(`${DEV}/rumble_intensity`, `${intensity}\n`);
  files.set(`${DEV}/rumble_intensity_range`, `${range}\n`);
}

function makeBackend() {
  const backend = new VibrationBackend();
  const events: unknown[] = [];
  backend.emit = (p) => events.push(p);
  return { backend, events };
}

beforeEach(() => {
  files = new Map();
  dirs = [];
  writes = [];
  writeFails = false;
  persisted = {};
  mock.module("@loadout/plugin-storage", () => ({
    ...storage,
    readPluginStorage: async () => persisted,
    writePluginStorage: async (_id: string, data: Record<string, unknown>) => {
      persisted = data;
    },
    mutatePluginStorage: async (
      _id: string,
      mutate: (cur: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      persisted = mutate(persisted);
    },
  }));
});

describe("detection", () => {
  it("finds the device by its attribute, not by a device table", async () => {
    // The point of globbing: any gen-2 OneXPlayer the driver binds works,
    // without an entry per model.
    dirs = ["0003:1A2C:B001.0001", "0003:1A86:FE00.0005"];
    files.set(`${DEV}/rumble_intensity`, "5\n");
    files.set(`${DEV}/rumble_intensity_range`, "0-5\n");
    const { backend } = makeBackend();
    await backend.onLoad();

    const info = await backend.getInfo();
    expect(info.available).toBe(true);
    expect(info.devicePath).toBe(DEV);
    await backend.onUnload();
  });

  it("reports unavailable on a device without the attribute", async () => {
    // A gen-1 OneXPlayer: the driver binds and exposes RGB, but no rumble.
    dirs = ["0003:1A2C:B001.0001"];
    files.set("/sys/bus/hid/devices/0003:1A2C:B001.0001/rgb_mode", "1\n");
    const { backend } = makeBackend();
    await backend.onLoad();

    const info = await backend.getInfo();
    expect(info.available).toBe(false);
    expect(info.intensity).toBeNull();
    await backend.onUnload();
  });

  it("reports unavailable when the HID bus isn't there at all", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();
    expect((await backend.getInfo()).available).toBe(false);
    await backend.onUnload();
  });

  it("takes the range from the device rather than assuming 0-5", async () => {
    gen2Device("3", "1-10");
    const { backend } = makeBackend();
    await backend.onLoad();

    const info = await backend.getInfo();
    expect(info.min).toBe(1);
    expect(info.max).toBe(10);
    await backend.onUnload();
  });

  it("falls back to 0-5 when the range attribute is unreadable", async () => {
    dirs = ["0003:1A86:FE00.0005"];
    files.set(`${DEV}/rumble_intensity`, "5\n"); // range file absent
    const { backend } = makeBackend();
    await backend.onLoad();

    const info = await backend.getInfo();
    expect(info.min).toBe(0);
    expect(info.max).toBe(5);
    await backend.onUnload();
  });
});

describe("setIntensity", () => {
  it("writes the level and remembers it", async () => {
    gen2Device();
    const { backend, events } = makeBackend();
    await backend.onLoad();
    writes = [];

    const res = await backend.setIntensity(2);

    expect(res.success).toBe(true);
    expect(writes).toEqual([{ path: `${DEV}/rumble_intensity`, value: "2" }]);
    expect(persisted.intensity).toBe(2);
    expect(events.length).toBeGreaterThan(0);
    await backend.onUnload();
  });

  it("clamps a value the driver would reject", async () => {
    // The driver returns EINVAL above the max; no reason to hand it one.
    gen2Device();
    const { backend } = makeBackend();
    await backend.onLoad();
    writes = [];

    await backend.setIntensity(99);
    expect(writes[0]?.value).toBe("5");
    await backend.onUnload();
  });

  it("reports failure when the write is refused", async () => {
    gen2Device();
    const { backend } = makeBackend();
    await backend.onLoad();
    writeFails = true;

    const res = await backend.setIntensity(1);
    expect(res.success).toBe(false);
    expect(res.error).toContain("EACCES");
    // Nothing recorded — the user's choice never reached the hardware.
    expect(persisted.intensity).toBeUndefined();
    await backend.onUnload();
  });

  it("still reports success when only the storage write fails", async () => {
    // The motors demonstrably changed; failing the call would misreport
    // something the user can feel.
    gen2Device();
    const { backend } = makeBackend();
    await backend.onLoad();
    mock.module("@loadout/plugin-storage", () => ({
      ...storage,
      readPluginStorage: async () => persisted,
      writePluginStorage: async () => {},
      mutatePluginStorage: async () => {
        throw new Error("disk full");
      },
    }));

    const res = await backend.setIntensity(3);
    expect(res.success).toBe(true);
    await backend.onUnload();
  });

  it("refuses when no device was found", async () => {
    const { backend } = makeBackend();
    await backend.onLoad();

    const res = await backend.setIntensity(3);
    expect(res.success).toBe(false);
    expect(writes).toEqual([]);
    await backend.onUnload();
  });
});

describe("restore on load", () => {
  it("re-applies the stored level, because the driver's cache resets", async () => {
    // hid-oxp initialises its cached intensity to the max on every probe, so
    // without this a reboot silently returns the user to full rumble.
    gen2Device("5");
    persisted = { intensity: 1 };
    const { backend } = makeBackend();

    await backend.onLoad();

    expect(writes).toEqual([{ path: `${DEV}/rumble_intensity`, value: "1" }]);
    await backend.onUnload();
  });

  it("writes nothing when the user has never chosen a level", async () => {
    gen2Device("5");
    const { backend } = makeBackend();

    await backend.onLoad();

    expect(writes).toEqual([]);
    await backend.onUnload();
  });

  it("ignores a stored value outside the device's range", async () => {
    // Storage is user-editable JSON.
    gen2Device("5");
    persisted = { intensity: 99 };
    const { backend } = makeBackend();

    await backend.onLoad();

    expect(writes).toEqual([]);
    await backend.onUnload();
  });
});

describe("getInfo", () => {
  it("prefers the stored level and says so", async () => {
    gen2Device("5");
    persisted = { intensity: 2 };
    const { backend } = makeBackend();
    await backend.onLoad();

    const info = await backend.getInfo();
    expect(info.intensity).toBe(2);
    expect(info.source).toBe("stored");
    await backend.onUnload();
  });

  it("falls back to the driver's value, flagged as such", async () => {
    gen2Device("4");
    const { backend } = makeBackend();
    await backend.onLoad();

    const info = await backend.getInfo();
    expect(info.intensity).toBe(4);
    expect(info.source).toBe("driver");
    await backend.onUnload();
  });
});
