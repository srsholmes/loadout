/**
 * Pure aggregation of Steam appmanifest_*.acf entries into a single
 * appId → name map. Filters non-manifest filenames and drops entries
 * whose ACF body fails to parse.
 *
 * The I/O (readdir + readFile) stays in the caller — keeping this
 * module pure matches the rest of the plugin's `lib/` convention and
 * lets us test the filename filter + the silent-skip branches directly,
 * without spy gymnastics.
 */

import { parseAcf } from "./parse-acf";

export interface ManifestFile {
  /** Filename within steamapps/ (e.g. `appmanifest_730.acf`). */
  name: string;
  /** Raw file contents. */
  content: string;
}

export function buildAppManifestMap(files: ManifestFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { name, content } of files) {
    if (!name.startsWith("appmanifest_") || !name.endsWith(".acf")) continue;
    const parsed = parseAcf(content);
    if (parsed) map.set(parsed.appId, parsed.name);
  }
  return map;
}
