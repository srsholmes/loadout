import { resolve, sep } from "node:path";

/**
 * Resolve `rel` against `base` and assert the result stays inside
 * `base` (no `..`/absolute escape); returns the resolved absolute path.
 *
 * The recomp backend runs as a ROOT system service, so any place it
 * writes/chmods a path built from a relative input — a recipe's
 * `placeRom`/`declareOutput` target, a mod's `installSubdir`, a catalog
 * `launchCommand` — must be confined or a `..`-bearing value would let
 * the root process touch arbitrary files. These inputs are bundled
 * (recipes + games.json ship in the plugin), so the realistic threat is
 * an authoring mistake rather than a remote attacker, but this matches
 * the confinement `runCommandTemplate` and `preservePaths` already
 * enforce and closes the class.
 */
export function resolveWithinDir(
  base: string,
  rel: string,
  label: string,
): string {
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(
      `${label} "${rel}" escapes the install directory (${base}).`,
    );
  }
  return abs;
}
