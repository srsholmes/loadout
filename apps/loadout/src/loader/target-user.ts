/**
 * Target-user resolution for the root system service.
 *
 * The backend runs as **root** (a systemd system unit — see
 * `scripts/install-local.sh`) so it can write privileged hardware sysfs
 * and run privileged tools without per-op `sudo`/`pkexec`. But the files
 * it persists live under the invoking user's home (`~/.config/loadout`,
 * resolved via `$HOME`, which the unit sets). Left as root they'd be
 * awkward to inspect or hand-edit, so we chown anything we create back to
 * the user named by the `--user` arg.
 *
 * This is cosmetic, not functional: the overlay reads config over RPC, so
 * ownership doesn't gate behaviour. Every chown here is best-effort and
 * swallows errors (a dev run without `--user`, or running as the user
 * already, is a no-op).
 */

import { chownSync, readFileSync } from "node:fs";

interface TargetUser {
  uid: number;
  gid: number;
}

let target: TargetUser | null = null;

/**
 * Look up a username's uid/gid + home from `/etc/passwd`. Returns null if
 * the file can't be read or the user isn't found. We parse the file
 * directly rather than shelling out to `id` — no subprocess, no PATH
 * assumptions, and it works identically inside the compiled binary.
 */
export function resolveUser(
  name: string,
): { uid: number; gid: number; home: string } | null {
  let passwd: string;
  try {
    passwd = readFileSync("/etc/passwd", "utf8");
  } catch {
    return null;
  }
  for (const line of passwd.split("\n")) {
    // name:passwd:uid:gid:gecos:home:shell
    const f = line.split(":");
    if (f.length >= 6 && f[0] === name) {
      const uid = Number(f[2]);
      const gid = Number(f[3]);
      const home = f[5];
      // f.length was checked >= 6, so f[5] is always present; the guard
      // only satisfies the type checker.
      if (Number.isFinite(uid) && Number.isFinite(gid) && home !== undefined) {
        return { uid, gid, home };
      }
    }
  }
  return null;
}

/**
 * Record the user that owns the files this process writes. Called once at
 * startup from the `--user` arg. A non-existent user is ignored (chowns
 * become no-ops), so a bad arg degrades to root-owned files rather than
 * crashing the service.
 */
export function setTargetUser(name: string): boolean {
  const u = resolveUser(name);
  if (!u) return false;
  target = { uid: u.uid, gid: u.gid };
  return true;
}

/** The resolved target user, or null when none was set (dev runs). */
export function getTargetUser(): TargetUser | null {
  return target;
}

/**
 * Best-effort chown a path to the target user. No-op when no target is set
 * or the chown fails (e.g. not running as root). Never throws.
 */
export function chownToTarget(path: string): void {
  if (!target) return;
  try {
    chownSync(path, target.uid, target.gid);
  } catch {
    // best effort — ownership is cosmetic
  }
}
