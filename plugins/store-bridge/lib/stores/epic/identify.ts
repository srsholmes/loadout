import { readdir, readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

/**
 * An Epic install signature lives in `<dir>/.egstore/Manifests/` —
 * Epic's launcher drops `.manifest` files there describing the
 * downloaded title. `legendary import` looks at the same dir.
 *
 * The manifest format is binary, but the AppName is also exposed
 * via a sibling `<dir>/.egstore/<AppName>.manifest` (no Manifests/
 * subdir on older launches) and an even-older format that puts a
 * JSON-flavoured `<dir>/.egstore/<AppName>.mancpn` next to it.
 *
 * Identification strategy:
 *   1. If `<dir>/.egstore` exists, it's an Epic install — that's
 *      enough to be worth surfacing. We don't try to parse the
 *      binary manifest ourselves; `legendary import` does it for us.
 *   2. The AppName we report comes from filenames in `.egstore` so
 *      the UI can match against the library entry. If we can't pick
 *      one out we still return the dir and leave `id` empty so the
 *      UI can ask the user to confirm.
 */
export interface EpicIdentified {
  /** AppName (legendary id), or empty string when we couldn't deduce it. */
  id: string;
  /** Best-effort title — falls back to the directory basename. */
  title: string;
}

export async function identifyEpicInstall(
  dir: string,
): Promise<EpicIdentified | null> {
  const eg = join(dir, ".egstore");
  if (!(await fileExists(eg))) return null;

  let appName = "";
  try {
    const entries = await readdir(eg);
    appName = extractAppName(entries);
    if (!appName) {
      // Look in nested Manifests/ — newer launcher builds.
      const manifestsDir = join(eg, "Manifests");
      if (await fileExists(manifestsDir)) {
        const nested = await readdir(manifestsDir);
        appName = extractAppName(nested);
      }
    }
  } catch {
    // unreadable .egstore — still treat as Epic, just without an id
  }

  // Cap title length: when AppName extraction fails we fall back to
  // the directory basename, which an attacker on a planted USB can
  // make arbitrarily long. The title round-trips into state.json
  // and the Steam shortcut display name, so a megabyte-sized basename
  // would corrupt both. 256 is a comfortable ceiling — real Epic
  // titles top out around 80 chars.
  const TITLE_MAX_LEN = 256;
  const fallbackTitle = basename(dir);
  const title = (appName || fallbackTitle).slice(0, TITLE_MAX_LEN);
  return { id: appName, title };
}

/**
 * Match candidate filenames against known Epic patterns and return
 * the AppName when one is found. Exported so the spec can verify.
 *
 * Patterns observed in the wild:
 *   - `<AppName>.manifest`
 *   - `<AppName>.mancpn`
 *
 * Real legendary AppNames ARE 32-char hex (e.g.
 * `9773aa1aa54f4f7b80e44bef04986cf5`) — Epic's launcher uses UUIDs
 * for most titles, only a handful of human-readable mirrors like
 * `Fortnite` exist. An earlier version of this code tried to skip
 * "manifest UUIDs"; that heuristic broke the entire scan flow for
 * the majority of real titles. We now accept hex IDs and rely on
 * the length + character-class cap to keep planted garbage out.
 */
// Mirrors APP_NAME_MAX_LEN in legendary.ts — keeping the cap here
// avoids round-tripping a multi-megabyte filename into state, log
// output, or UI text. Real Epic AppNames are 8-32 chars; 128 is a
// generous ceiling.
const APP_NAME_MAX_LEN = 128;
const APP_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export function extractAppName(filenames: string[]): string {
  for (const fn of filenames) {
    if (!fn.endsWith(".manifest") && !fn.endsWith(".mancpn")) continue;
    const stem = fn.replace(/\.(manifest|mancpn)$/, "");
    if (stem.length === 0 || stem.length > APP_NAME_MAX_LEN) continue;
    // Same allow-list legendary.ts enforces. A manifest filename that
    // doesn't match this can't be passed to legendary's argv anyway,
    // so we drop it here rather than surface a "candidate" the user
    // can't actually import.
    if (!APP_NAME_RE.test(stem)) continue;
    return stem;
  }
  return "";
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Convenience: read a manifest's raw bytes for callers that want to
 *  parse it themselves. The current scan flow doesn't use this — we
 *  delegate to legendary — but it's here so a future feature
 *  (e.g. verifying the install) can pull bytes without duplicating
 *  the path math. */
export async function readManifestBytes(
  dir: string,
  appName: string,
): Promise<Uint8Array | null> {
  for (const candidate of [
    join(dir, ".egstore", `${appName}.manifest`),
    join(dir, ".egstore", "Manifests", `${appName}.manifest`),
  ]) {
    try {
      return new Uint8Array(await readFile(candidate));
    } catch {
      // try next
    }
  }
  return null;
}
