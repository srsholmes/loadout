import type { DmiInfo } from "./dmi";

export type DeviceId =
  | "apex"
  | "steamdeck-oled"
  | "steamdeck-lcd"
  | "onexfly-f1-pro"
  | "generic";

export interface DeviceCapabilities {
  hasRGB: boolean;
  hasFanControl: boolean;
  hasTDP: boolean;
  hasBatteryControl: boolean;
}

export interface Fingerprint {
  id: DeviceId;
  match: (dmi: DmiInfo) => boolean;
  capabilities: DeviceCapabilities;
}

export const FINGERPRINTS: Fingerprint[] = [
  {
    id: "apex",
    match: (d) =>
      d.sysVendor === "ONE-NETBOOK" && d.productName.startsWith("ONEXPLAYER APEX"),
    capabilities: {
      hasRGB: true,
      hasFanControl: true,
      hasTDP: true,
      hasBatteryControl: true,
    },
  },
  {
    id: "onexfly-f1-pro",
    match: (d) =>
      d.sysVendor === "ONE-NETBOOK" && /ONEXPLAYER\s+F1\s*PRO/i.test(d.productName),
    capabilities: {
      hasRGB: true,
      hasFanControl: true,
      hasTDP: true,
      hasBatteryControl: true,
    },
  },
  {
    id: "steamdeck-oled",
    match: (d) => d.sysVendor === "Valve" && d.productName === "Galileo",
    capabilities: {
      hasRGB: false,
      hasFanControl: true,
      hasTDP: true,
      hasBatteryControl: true,
    },
  },
  {
    id: "steamdeck-lcd",
    match: (d) => d.sysVendor === "Valve" && d.productName === "Jupiter",
    capabilities: {
      hasRGB: false,
      hasFanControl: true,
      hasTDP: true,
      hasBatteryControl: true,
    },
  },
];

export const GENERIC_CAPABILITIES: DeviceCapabilities = {
  hasRGB: false,
  hasFanControl: false,
  hasTDP: false,
  hasBatteryControl: false,
};

export function matchFingerprint(dmi: DmiInfo): Fingerprint | undefined {
  return FINGERPRINTS.find((f) => f.match(dmi));
}
