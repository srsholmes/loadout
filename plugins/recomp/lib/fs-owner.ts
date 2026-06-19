import { lchown, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Hand ownership of a freshly-created path to the unprivileged target
 * user (uid/gid of $HOME). The loadout backend runs as a root system
 * service, so anything it writes — a downloaded/extracted prebuilt tree,
 * a copied ROM, a build output — lands root-owned. The games themselves
 * run AS the user (launched via Steam), and engines like Ship of
 * Harkinian / 2 Ship 2 Harkinian extract their ROM into game assets
 * (`*.otr`) *inside the install dir* on first launch — which fails with
 * EACCES against a root-owned tree. Re-owning the tree to the user after
 * install fixes that.
 *
 * No-op when already unprivileged (dev box running the backend directly).
 * Best-effort and recursive: any root-written child becomes user-owned
 * too, and a path that still can't be re-owned will surface as a loud
 * runtime failure rather than silent corruption.
 */
export async function chownInstallDirToUser(path: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  const home = process.env.HOME;
  if (!home) return;
  try {
    const h = await stat(home);
    await chownRecursive(path, h.uid, h.gid);
  } catch {
    /* best effort — a consumer that still can't write will fail loudly */
  }
}

async function chownRecursive(
  path: string,
  uid: number,
  gid: number,
): Promise<void> {
  // `lchown`, never `chown`: we run as root over a tree that may contain
  // extracted symlinks. `chown` follows links, so a symlink named e.g.
  // `x` → `/etc/shadow` would retarget ownership of the link's TARGET.
  // `lchown` re-owns the link itself. We also only recurse into REAL
  // directories (readdir's Dirent reports a symlink-to-dir as non-dir),
  // so we never descend through a link out of the tree.
  await lchown(path, uid, gid).catch(() => {});
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const e of entries) {
      const full = join(path, e.name);
      if (e.isDirectory()) {
        await chownRecursive(full, uid, gid);
      } else {
        await lchown(full, uid, gid).catch(() => {});
      }
    }
  } catch {
    /* unreadable dir — stop descending here */
  }
}
