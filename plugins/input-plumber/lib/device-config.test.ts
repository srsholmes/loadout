import { describe, it, expect } from "bun:test";
import {
  DEVICE_CONFIGS,
  DEVICES_D,
  NOT_APPLICABLE,
  X2_MINI_PRO,
  configPath,
  findDeviceConfig,
  isSupersededByUpstream,
  parseUpstreamMatches,
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

  it("keeps USB ids as strings, not numbers", () => {
    // InputPlumber glob-matches evdev ids against a %04x-formatted string.
    // Unquoted, "045e" is the number 45 to a YAML parser — which serde would
    // reject outright, and InputPlumber would then skip the file with only a
    // log line to show for it.
    const doc = Bun.YAML.parse(X2_MINI_PRO.yaml) as {
      source_devices: { evdev?: { vendor_id?: unknown; product_id?: unknown } }[];
    };
    for (const src of doc.source_devices) {
      if (!src.evdev?.vendor_id && !src.evdev?.product_id) continue;
      expect(typeof src.evdev.vendor_id).toBe("string");
      expect(typeof src.evdev.product_id).toBe("string");
    }
  });

  it("joins the MCU's second evdev node instead of forking a composite", () => {
    // The 1a86:fe00 MCU exposes TWO evdev nodes under one name (input0, and
    // input1 with a mouse). Left unique, the second forks a second
    // CompositeDevice off this same config — duplicate virtual pads.
    const doc = Bun.YAML.parse(X2_MINI_PRO.yaml) as {
      source_devices: { unique?: boolean; evdev?: { name?: string } }[];
    };
    const mcu = doc.source_devices.find((s) => s.evdev?.name === "HID 1a86:fe00");
    expect(mcu?.unique).toBe(false);
  });

  it("does not swallow external XInput pads into the handheld's composite", () => {
    // 045e:028e is the generic XInput id. unique:false here would fold any
    // external Xbox pad into the built-in controller; the name narrows it.
    const doc = Bun.YAML.parse(X2_MINI_PRO.yaml) as {
      source_devices: { unique?: boolean; evdev?: { name?: string; vendor_id?: string } }[];
    };
    const pad = doc.source_devices.find((s) => s.evdev?.vendor_id === "045e");
    expect(pad?.evdev?.name).toBe("Microsoft X-Box 360 pad");
    expect(pad?.unique).not.toBe(false);
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

describe("parseUpstreamMatches", () => {
  it("pulls the DMI pairs a config claims", () => {
    expect(
      parseUpstreamMatches(`version: 1
kind: CompositeDevice
matches:
  - dmi_data:
      product_name: ONEXPLAYER X1 A
      sys_vendor: ONE-NETBOOK
  - dmi_data:
      product_name: ONEXPLAYER X1 i
      sys_vendor: ONE-NETBOOK
`),
    ).toEqual([
      { productName: "ONEXPLAYER X1 A", sysVendor: "ONE-NETBOOK" },
      { productName: "ONEXPLAYER X1 i", sysVendor: "ONE-NETBOOK" },
    ]);
  });

  it("yields nothing rather than throwing on anything unexpected", () => {
    // These are files another project ships, in a schema it can extend. A
    // parse error here would break the whole status probe.
    for (const bad of ["", "just a string", "{{{", "matches: not-a-list", "version: 1"]) {
      expect(parseUpstreamMatches(bad)).toEqual([]);
    }
    // A match with no dmi_data (InputPlumber also supports other match
    // kinds) contributes nothing rather than an undefined-filled entry.
    expect(parseUpstreamMatches("matches:\n  - dmi_data:\n      product_name: X\n")).toEqual([]);
  });
});

describe("isSupersededByUpstream", () => {
  it("spots upstream claiming this machine's DMI", () => {
    expect(
      isSupersededByUpstream(X2_MINI_PRO, [
        { productName: "ONEXPLAYER APEX", sysVendor: "ONE-NETBOOK" },
      ]),
    ).toBe(false);
    expect(
      isSupersededByUpstream(X2_MINI_PRO, [
        { productName: "ONEXPLAYER APEX", sysVendor: "ONE-NETBOOK" },
        { productName: "ONEXPLAYER X2Mini PRO", sysVendor: "ONE-NETBOOK" },
      ]),
    ).toBe(true);
  });

  it("still spots it when upstream picks a different filename", () => {
    // The whole point of keying on DMI. Their family is named
    // 50-onexplayer_apex / _x1 / _mini_pro, so 50-onexplayer_x2_mini_pro.yaml
    // is at least as likely as our 50-onexplayer_x2.yaml — and under a
    // different name BOTH configs load and both match this machine.
    const upstreamFile = `matches:
  - dmi_data:
      product_name: ONEXPLAYER X2Mini PRO
      sys_vendor: ONE-NETBOOK
`;
    expect(isSupersededByUpstream(X2_MINI_PRO, parseUpstreamMatches(upstreamFile))).toBe(true);
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
