import { describe, it, expect } from "bun:test";
import {
  DEVICE_CONFIGS,
  DEVICES_D,
  NOT_APPLICABLE,
  X2_MINI_PRO,
  configPath,
  findDeviceConfig,
  isSupersededByUpstream,
  shouldOfferInstall,
  type DeviceConfigStatus,
} from "./device-config";

/**
 * These configs hand a device's input handling to InputPlumber, so the tests
 * care about two things above all: that the YAML is actually loadable, and
 * that we never claim a machine we didn't mean to.
 */

function status(over: Partial<DeviceConfigStatus> = {}): DeviceConfigStatus {
  return {
    applicable: true,
    label: X2_MINI_PRO.label,
    path: configPath(X2_MINI_PRO),
    installed: false,
    hasCompositeDevices: false,
    superseded: false,
    ...over,
  };
}

describe("the shipped configs", () => {
  it.each(DEVICE_CONFIGS.map((c) => [c.label, c] as const))("%s parses as YAML", (_label, c) => {
    // A config InputPlumber can't parse is worse than none: it's a file on
    // the user's disk doing nothing, with no error surfaced to them.
    expect(() => Bun.YAML.parse(c.yaml)).not.toThrow();
  });

  it.each(DEVICE_CONFIGS.map((c) => [c.label, c] as const))(
    "%s declares the shape InputPlumber requires",
    (_label, c) => {
      const doc = Bun.YAML.parse(c.yaml) as Record<string, unknown>;
      expect(doc.version).toBe(1);
      expect(doc.kind).toBe("CompositeDevice");
      expect(Array.isArray(doc.source_devices)).toBe(true);
      expect((doc.source_devices as unknown[]).length).toBeGreaterThan(0);
      expect(Array.isArray(doc.target_devices)).toBe(true);
    },
  );

  it.each(DEVICE_CONFIGS.map((c) => [c.label, c] as const))(
    "%s matches the same DMI in its YAML as in its metadata",
    (_label, c) => {
      // These are two hand-written copies of the same fact. If they drift,
      // the file installs on a device whose DMI it then doesn't match, and
      // InputPlumber silently ignores it.
      const doc = Bun.YAML.parse(c.yaml) as {
        matches: { dmi_data: { product_name: string; sys_vendor: string } }[];
      };
      expect(doc.matches.map((m) => m.dmi_data.product_name)).toContain(c.productName);
      expect(doc.matches.map((m) => m.dmi_data.sys_vendor)).toContain(c.sysVendor);
    },
  );

  it("keeps the X2's DMI string exactly as the firmware reports it", () => {
    // No space in "X2Mini", uppercase PRO. Taken from a doctor report and
    // corroborated by Handheld Daemon's device table; InputPlumber matches
    // this literally, so a prettified string matches nothing.
    expect(X2_MINI_PRO.productName).toBe("ONEXPLAYER X2Mini PRO");
    expect(X2_MINI_PRO.sysVendor).toBe("ONE-NETBOOK");
  });

  it("names files the way upstream would, so a future config is shadowed not duplicated", () => {
    // /etc/inputplumber/devices.d is searched before /usr/share, and ties
    // are broken by basename. A Loadout-branded name would load *alongside*
    // an upstream config rather than instead of it.
    for (const c of DEVICE_CONFIGS) {
      expect(c.filename).toMatch(/^\d\d-[a-z0-9_]+\.yaml$/);
      expect(c.filename).not.toMatch(/loadout/i);
    }
  });

  it("does not claim the system keyboard or map the back paddles", () => {
    // Both are deliberate omissions (see the module docblock); a later edit
    // adding either should have to argue with this test first.
    const doc = Bun.YAML.parse(X2_MINI_PRO.yaml) as {
      source_devices: { evdev?: { name?: string } }[];
      capability_map_id?: string;
    };
    const names = doc.source_devices.map((s) => s.evdev?.name).filter(Boolean);
    expect(names).not.toContain("AT Translated Set 2 keyboard");
    expect(doc.capability_map_id).toBeUndefined();
  });
});

describe("findDeviceConfig", () => {
  it("finds the X2 Mini Pro by its exact DMI", () => {
    expect(
      findDeviceConfig({ productName: "ONEXPLAYER X2Mini PRO", sysVendor: "ONE-NETBOOK" }),
    ).toBe(X2_MINI_PRO);
  });

  it("tolerates the trailing newline sysfs actually returns", () => {
    expect(
      findDeviceConfig({ productName: "ONEXPLAYER X2Mini PRO\n", sysVendor: "ONE-NETBOOK\n" }),
    ).toBe(X2_MINI_PRO);
  });

  it("refuses near-misses rather than claiming a device we've never run on", () => {
    // Substring matching would catch all of these. A config claims specific
    // USB ids and takes over input handling, so a false positive is far
    // worse than a false negative.
    for (const dmi of [
      { productName: "ONEXPLAYER X2Mini", sysVendor: "ONE-NETBOOK" }, // the non-Pro
      { productName: "ONEXPLAYER X2Mini PRO 2", sysVendor: "ONE-NETBOOK" },
      { productName: "ONEXPLAYER APEX", sysVendor: "ONE-NETBOOK" },
      { productName: "ONEXPLAYER X2Mini PRO", sysVendor: "AOKZOE" },
      { productName: "", sysVendor: "" },
    ]) {
      expect(findDeviceConfig(dmi)).toBeNull();
    }
  });

  it("returns null when the DMI couldn't be read at all", () => {
    expect(findDeviceConfig(null)).toBeNull();
  });
});

describe("configPath", () => {
  it("installs into InputPlumber's drop-in directory", () => {
    expect(configPath(X2_MINI_PRO)).toBe(`${DEVICES_D}/50-onexplayer_x2.yaml`);
  });
});

describe("isSupersededByUpstream", () => {
  it("spots upstream shipping the same basename", () => {
    expect(isSupersededByUpstream(X2_MINI_PRO, ["50-onexplayer_apex.yaml"])).toBe(false);
    expect(
      isSupersededByUpstream(X2_MINI_PRO, ["50-onexplayer_apex.yaml", "50-onexplayer_x2.yaml"]),
    ).toBe(true);
  });
});

describe("shouldOfferInstall", () => {
  it("offers it when InputPlumber has nothing for this device", () => {
    expect(shouldOfferInstall(status())).toBe(true);
  });

  it("stays quiet when the device already works", () => {
    // The worst outcome here is handing a config to a device InputPlumber
    // already drives correctly.
    expect(shouldOfferInstall(status({ hasCompositeDevices: true }))).toBe(false);
  });

  it("stays quiet once ours is installed", () => {
    expect(shouldOfferInstall(status({ installed: true }))).toBe(false);
  });

  it("stays quiet once upstream ships its own", () => {
    expect(shouldOfferInstall(status({ superseded: true }))).toBe(false);
  });

  it("stays quiet on a device we have no config for", () => {
    expect(shouldOfferInstall(NOT_APPLICABLE)).toBe(false);
  });
});
