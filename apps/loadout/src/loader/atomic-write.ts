import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { chownToTarget } from "./target-user";

/**
 * Atomically write JSON to a file. Writes to a `.tmp` sibling first,
 * `fsync`'s the file handle to flush kernel buffers to disk, then
 * renames into place. Readers never see a half-written file AND a
 * power loss between write+rename won't leave the target referencing
 * an unwritten data block — the rename can only land after the data
 * is durable.
 *
 * Cost: one extra syscall per write. Acceptable for plugin-config
 * persistence (~10s of writes per session) and worth it because the
 * loader's settings files are the only persistent state most plugins
 * have.
 */
export async function atomicWriteJSON(
  filePath: string,
  data: unknown,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  // Root service writes config under the user's home — keep it user-owned
  // so it stays inspectable/hand-editable. No-op for dev runs.
  chownToTarget(dir);

  const tmpPath = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2) + "\n";

  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(json);
    // sync() flushes the kernel page cache for this file to the
    // underlying storage. Without it the rename can land in the
    // directory entry while the data block is still in cache —
    // a crash between the two would surface the new filename with
    // empty content.
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, filePath);
  chownToTarget(filePath);
}

/**
 * Read and parse a JSON file, returning `fallback` if the file is
 * missing or contains invalid JSON.
 */
export async function atomicReadJSON<T>(
  filePath: string,
  fallback: T,
): Promise<T> {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
