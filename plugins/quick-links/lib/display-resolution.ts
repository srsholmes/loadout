/**
 * Detect the active display resolution from `/sys/class/drm`. Used at
 * browser-install time to bake `--window-size` flags into the
 * shortcut's launch options so the browser opens at native resolution
 * under gamescope.
 *
 * Sits in `lib/` rather than `backend.ts` so the FS-readback shape
 * (preferred mode of the first connected output, fallback to 1080p
 * when nothing's readable) is testable directly with `mock.module`.
 */

import { readFile, readdir } from "fs/promises";
import { join } from "path";

export interface DisplayResolution {
  width: number;
  height: number;
}

export const FALLBACK_RESOLUTION: DisplayResolution = {
  width: 1920,
  height: 1080,
};

/**
 * Read the preferred mode of the first connected DRM output. Each
 * cardN-OUTPUT/modes file under /sys/class/drm lists modes in
 * priority order (line 1 = preferred / native). Returns
 * FALLBACK_RESOLUTION if /sys is unreadable or no outputs are
 * connected.
 */
export async function detectDisplayResolution(): Promise<DisplayResolution> {
  const drmDir = "/sys/class/drm";
  let entries: string[];
  try {
    entries = await readdir(drmDir);
  } catch {
    return FALLBACK_RESOLUTION;
  }
  const outputs = entries
    .filter((e) => /^card\d+-/.test(e) && !e.includes("Writeback"))
    .sort();
  for (const out of outputs) {
    try {
      const status = (
        await readFile(join(drmDir, out, "status"), "utf-8")
      ).trim();
      if (status !== "connected") continue;
      const modes = (
        await readFile(join(drmDir, out, "modes"), "utf-8")
      ).trim();
      const first = modes.split("\n")[0]?.trim();
      const m = first?.match(/^(\d+)x(\d+)/);
      if (m) {
        // Both groups always capture when the match succeeds.
        return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) };
      }
    } catch {
      /* keep probing */
    }
  }
  return FALLBACK_RESOLUTION;
}
