import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { listDrivers } from "./stores/registry";
import type { DetectedInstall, StoreId } from "./types";

/**
 * Maximum directory depth we'll walk from a user-supplied scan
 * root. Anything beyond this is almost certainly inside an
 * already-detected install or a developer build dir, and the cost
 * of walking unbounded trees on a handheld (slow SD card I/O) is
 * not worth the rare deep find.
 */
const MAX_DEPTH = 4;

/**
 * Walk every scan path and return the union of detected installs.
 * Dedupes by `(storeId, dir)` so a path that overlaps with another
 * isn't reported twice. Already-installed entries (passed in via
 * `excludeDirs`) are filtered out so the UI doesn't re-show them.
 */
export async function scanForInstalls(
  scanPaths: string[],
  excludeDirs: Set<string> = new Set(),
  onProgress?: (dir: string) => void,
): Promise<DetectedInstall[]> {
  const drivers = listDrivers();
  if (drivers.length === 0) return [];

  const found: DetectedInstall[] = [];
  const seen = new Set<string>();

  for (const root of scanPaths) {
    await walk(root, 0, async (dir) => {
      onProgress?.(dir);
      if (excludeDirs.has(dir)) return;
      for (const driver of drivers) {
        // Drivers without `identifyInstall` (e.g. streaming stores
        // like xCloud) have no on-disk install to find — skip.
        if (!driver.identifyInstall) continue;
        const r = await driver.identifyInstall(dir).catch(() => null);
        if (!r) continue;
        const key = `${driver.id}:${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          storeId: driver.id as StoreId,
          gameId: r.id,
          title: r.title,
          dir,
        });
      }
    });
  }
  return found;
}

/**
 * Lightweight depth-bounded directory walker. Refuses to follow
 * symlinks (uses `lstat`, so a link to `/etc` reports as a symlink
 * and we don't descend) and never recurses into `.egstore` — that's
 * the very marker the identifier looks for, recursing in would be
 * wasted I/O.
 *
 * Symlink refusal matters: `addScanPath`'s `isAllowedScanPath`
 * whitelist normalises away `..` traversal at the root, but once
 * the walker is inside an allowed root, an attacker-planted symlink
 * on a USB drive would otherwise let us enumerate any directory the
 * service user can read.
 */
async function walk(
  dir: string,
  depth: number,
  visit: (dir: string) => Promise<void>,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  try {
    const s = await lstat(dir);
    // Reject symlinks AND non-directories. Without the symlink
    // refusal a link from /mnt/games/escape → /etc would let the
    // walker enumerate /etc once the scan root is allow-listed.
    if (!s.isDirectory() || s.isSymbolicLink()) return;
  } catch {
    return; // unreadable / nonexistent
  }
  await visit(dir);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".egstore" || entry === ".git" || entry === "node_modules") continue;
    const next = join(dir, entry);
    await walk(next, depth + 1, visit);
  }
}
