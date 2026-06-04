import { ALL_MODES } from "./oxp";

/**
 * Pure parser for `openrgb --noautoconnect -l` listing output.
 *
 * Each device block starts with a header line like `0: DeviceName` and
 * contains zero or more `Zone N: ZoneName` lines. Devices that declare
 * no `Zone` lines are treated as a single zone (id suffix `0`).
 *
 * Returns one `RgbZone`-shaped record per detected zone, ready for the
 * backend's `RgbDriver` slot. No I/O — string in, structured array out
 * — so the unit test can pin behaviour against curated fixtures.
 */

export interface ParsedOpenRgbZone {
  id: string;
  name: string;
  color: { r: number; g: number; b: number };
  brightness: number;
  mode: string;
  supportedModes: string[];
}

export function parseOpenRgbList(listOutput: string): ParsedOpenRgbZone[] {
  const zones: ParsedOpenRgbZone[] = [];
  const deviceBlocks = listOutput.split(/(?=^\d+:\s)/m);
  for (const block of deviceBlocks) {
    const headerMatch = block.match(/^(\d+):\s+(.+)/);
    if (!headerMatch) continue;

    const deviceIndex = headerMatch[1];
    const deviceName = headerMatch[2].trim();

    const zoneMatches = block.matchAll(/Zone\s+(\d+):\s+(.+)/g);
    let hasZones = false;
    for (const zm of zoneMatches) {
      hasZones = true;
      zones.push({
        id: `openrgb:${deviceIndex}:${zm[1]}`,
        name: `${deviceName} - ${zm[2].trim()}`,
        color: { r: 0, g: 0, b: 0 },
        brightness: 100,
        mode: "static",
        supportedModes: [...ALL_MODES],
      });
    }

    if (!hasZones) {
      zones.push({
        id: `openrgb:${deviceIndex}:0`,
        name: deviceName,
        color: { r: 0, g: 0, b: 0 },
        brightness: 100,
        mode: "static",
        supportedModes: [...ALL_MODES],
      });
    }
  }
  return zones;
}
