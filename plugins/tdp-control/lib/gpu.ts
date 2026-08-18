/**
 * GPU frequency-interface helpers.
 *
 * Intel's two DRM drivers expose completely different trees for the same
 * four numbers, and which one a machine uses is a function of its silicon:
 *
 *   i915  <card>/gt_{min,max,RP0,RPn}_freq_mhz
 *   xe    <card>/device/tile<N>/gt<M>/freq0/{min,max,rp0,rpn}_freq
 *
 * `xe` is what Xe/Xe3 graphics bind to, so every Lunar Lake and Panther Lake
 * part — including the Arc G3 Extreme handhelds — lands there. Probing only
 * the i915 layout left `gpuVendor` as "Unknown" on those devices and hid the
 * GPU panel outright.
 *
 * I/O is injected so this is unit-testable without /sys.
 */

export interface GpuFsDeps {
  /** Read a file, or null when it doesn't exist / can't be read. */
  readFile: (path: string) => Promise<string | null>;
  /** Entry basenames of a directory, or null when it doesn't exist. */
  listDir: (path: string) => Promise<string[] | null>;
}

/**
 * Frequency-control directories for an `xe` card, one per graphics tile/GT,
 * in stable tile-then-GT order. Empty when the card isn't an `xe` device.
 *
 * The tree is walked rather than assuming `tile0/gt0`: a Panther Lake part
 * exposes a render GT and a media GT, and leaving the second one unbounded
 * would undercut the point of setting a ceiling.
 */
export async function findXeFreqDirs(
  deps: GpuFsDeps,
  cardPath: string,
): Promise<string[]> {
  const deviceDir = `${cardPath}/device`;
  const entries = (await deps.listDir(deviceDir)) ?? [];
  const dirs: string[] = [];

  for (const tile of entries.filter((e) => /^tile\d+$/.test(e)).sort()) {
    const tileDir = `${deviceDir}/${tile}`;
    const gts = (await deps.listDir(tileDir)) ?? [];
    for (const gt of gts.filter((e) => /^gt\d+$/.test(e)).sort()) {
      const freqDir = `${tileDir}/${gt}/freq0`;
      if ((await deps.readFile(`${freqDir}/max_freq`)) !== null) {
        dirs.push(freqDir);
      }
    }
  }
  return dirs;
}

/**
 * Whether a floor/ceiling pair must be written ceiling-first. Pure.
 *
 * Both Intel drivers reject a write that would leave the floor above the
 * ceiling, so neither fixed order is safe: raising the whole range needs the
 * ceiling moved up first, lowering it needs the floor moved down first. An
 * unreadable current ceiling is treated as "raise" — that's the order that
 * can't wedge on a range we couldn't inspect.
 */
export function writeCeilingFirst(
  currentMax: number | null,
  minMhz: number,
): boolean {
  if (currentMax === null || Number.isNaN(currentMax)) return true;
  return minMhz > currentMax;
}
