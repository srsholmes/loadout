import { readDmi, type DmiInfo } from "./dmi";
import {
  matchFingerprint,
  GENERIC_CAPABILITIES,
  type DeviceCapabilities,
  type DeviceId,
} from "./fingerprints";

export type { DmiInfo } from "./dmi";
export type { DeviceCapabilities, DeviceId } from "./fingerprints";

export interface Device {
  id: DeviceId;
  dmi: DmiInfo;
  gamescope: boolean;
  capabilities: DeviceCapabilities;
}

let cached: Device | undefined;

export async function detectDevice(): Promise<Device> {
  if (cached) return cached;
  const dmi = await readDmi();
  const fp = matchFingerprint(dmi);
  const gamescope =
    !!process.env.GAMESCOPE_DISPLAY || !!process.env.GAMESCOPE_WAYLAND_DISPLAY;
  cached = {
    id: fp?.id ?? "generic",
    dmi,
    gamescope,
    capabilities: fp?.capabilities ?? GENERIC_CAPABILITIES,
  };
  return cached;
}

/** Test-only: reset the detection cache. */
export function _resetDeviceCache(): void {
  cached = undefined;
}
