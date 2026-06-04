import { mkdir, readdir, rm, copyFile } from "node:fs/promises";
import { join, basename, isAbsolute, normalize } from "node:path";
import { spawn } from "@loadout/exec";

// Re-export from the shared github helpers so existing callers
// (`installer-host.ts`, etc.) keep working without churn.
// Optional gh auth token to raise GitHub's 60/hr unauthenticated rate limit.
export { downloadFile, githubToken } from "./github";

/**
 * Inspect an archive's member list WITHOUT extracting and reject
 * anything that could write outside the destination directory:
 *
 *   - members with a `..` path component (traversal),
 *   - absolute member names (`/etc/...`),
 *   - symlink/hardlink members whose target is absolute or escapes
 *     the archive root via `..` — GNU tar happily restores such a
 *     symlink, and a later write (or a nested-archive extract) through
 *     it lands outside `dest`.
 *
 * GNU `tar` already refuses `..` members and strips leading `/` on
 * extract, but it does NOT guard the symlink-target case, and `unzip`
 * only emits a *warning* (exit 1) for `../` paths while still writing
 * the stripped file — so we can't rely on the tools' exit codes alone.
 * Pre-flighting the listing gives one reliable, tool-independent gate.
 *
 * Throws a clear error naming the offending entry; returns normally
 * when every member stays inside the destination.
 */
async function assertSafeArchive(archivePath: string): Promise<void> {
  const lower = basename(archivePath).toLowerCase();

  // (memberName, linkTarget?) pairs.
  const entries: { name: string; link?: string }[] = [];

  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    entries.push(...(await listTar(archivePath, true)));
  } else if (lower.endsWith(".tar")) {
    entries.push(...(await listTar(archivePath, false)));
  } else if (lower.endsWith(".zip")) {
    entries.push(...(await listZip(archivePath)));
  } else {
    // .appimage and unknown formats are copied verbatim, not unpacked
    // — nothing to validate here.
    return;
  }

  for (const { name, link } of entries) {
    rejectIfUnsafe(name, "entry path", archivePath);
    if (link != null) rejectIfUnsafe(link, "symlink target", archivePath);
  }
}

/** Throw if `member` is absolute or contains a `..` component. */
function rejectIfUnsafe(member: string, kind: string, archivePath: string): void {
  const cleaned = member.replace(/\\/g, "/").trim();
  if (cleaned === "") return;
  if (isAbsolute(cleaned) || cleaned.startsWith("/")) {
    throw new Error(
      `Refusing to extract ${basename(archivePath)}: ${kind} "${member}" is an absolute path (would escape the install directory).`,
    );
  }
  // normalize collapses `a/../b`; a leading `..` after normalize means
  // the member resolves above the archive root.
  const norm = normalize(cleaned);
  if (norm === ".." || norm.startsWith("../") || norm.startsWith("..\\")) {
    throw new Error(
      `Refusing to extract ${basename(archivePath)}: ${kind} "${member}" contains a ".." traversal component (would escape the install directory).`,
    );
  }
}

/**
 * List a tar(.gz) archive's members with symlink targets. Uses
 * `tar -tv` so symlink/hardlink lines carry their ` -> target`. The
 * verbose listing is `mode user/group size date time name [-> link]`.
 */
async function listTar(
  archivePath: string,
  gzip: boolean,
): Promise<{ name: string; link?: string }[]> {
  const flag = gzip ? "tvzf" : "tvf";
  const proc = spawn(["tar", flag, archivePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Could not read archive listing for ${basename(archivePath)} (tar exit ${code}): ${err}`);
  }
  const result: { name: string; link?: string }[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    // The name is everything after the 5th whitespace-collapsed field
    // (mode, owner/group, size, date, time). Split on the first run of
    // spaces six times is brittle across locales, so instead grab the
    // tail after the "time" token by matching the timestamp.
    const m = line.match(/^\S+\s+\S+\s+\d+\s+[\d-]+\s+[\d:]+\s+(.*)$/);
    const tail = m ? m[1]! : line;
    const arrow = tail.indexOf(" -> ");
    if (arrow !== -1) {
      result.push({
        name: tail.slice(0, arrow),
        link: tail.slice(arrow + 4),
      });
    } else {
      result.push({ name: tail });
    }
  }
  return result;
}

/** List a zip archive's member names (`unzip -Z1`). */
async function listZip(
  archivePath: string,
): Promise<{ name: string; link?: string }[]> {
  const proc = spawn(["unzip", "-Z1", archivePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Could not read archive listing for ${basename(archivePath)} (unzip exit ${code}): ${err}`);
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((name) => ({ name }));
}

/**
 * Extract a `.zip`, `.tar.gz`, `.tgz`, `.tar`, or `.appimage` to
 * `dest`. AppImages are copied (and renamed if `appimageBasename`
 * is provided so registry entries don't have to embed versioned
 * filenames). Recursively unpacks nested archives up to 3 levels.
 *
 * Every archive is pre-validated (`assertSafeArchive`) so no member
 * can write outside `dest`, and every extraction's exit code is
 * checked so a truncated/corrupt archive fails loudly instead of
 * silently shipping a half-extracted binary.
 */
export async function extractArchive(
  archivePath: string,
  dest: string,
  appimageBasename?: string,
): Promise<void> {
  await mkdir(dest, { recursive: true });

  const filename = basename(archivePath).toLowerCase();

  await assertSafeArchive(archivePath);

  if (filename.endsWith(".zip")) {
    const proc = spawn(["unzip", "-o", archivePath, "-d", dest], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`unzip failed (exit ${code}): ${err}`);
    }
  } else if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) {
    const proc = spawn(["tar", "xzf", archivePath, "-C", dest], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`tar extract failed (exit ${code}): ${err}`);
    }
  } else if (filename.endsWith(".tar")) {
    const proc = spawn(["tar", "xf", archivePath, "-C", dest], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`tar extract failed (exit ${code}): ${err}`);
    }
  } else if (filename.endsWith(".appimage")) {
    const destPath = join(dest, appimageBasename ?? basename(archivePath));
    await copyFile(archivePath, destPath);
    await spawn(["chmod", "+x", destPath]).exited;
  } else {
    throw new Error(`Unsupported archive format: ${filename}`);
  }

  await extractNestedArchives(dest);
}

async function extractNestedArchives(dir: string): Promise<void> {
  for (let depth = 0; depth < 3; depth++) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    let foundNested = false;

    for (const name of entries) {
      const path = join(dir, name);
      const lower = name.toLowerCase();

      if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
        await assertSafeArchive(path);
        const proc = spawn(["tar", "xzf", path, "-C", dir], {
          stdout: "ignore",
          stderr: "pipe",
        });
        const code = await proc.exited;
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          throw new Error(
            `nested tar extract failed for ${name} (exit ${code}): ${err}`,
          );
        }
        try { await rm(path); } catch { /* ignore */ }
        foundNested = true;
      } else if (lower.endsWith(".zip") && entries.length <= 2) {
        await assertSafeArchive(path);
        const proc = spawn(["unzip", "-o", path, "-d", dir], {
          stdout: "ignore",
          stderr: "pipe",
        });
        const code = await proc.exited;
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          throw new Error(
            `nested unzip failed for ${name} (exit ${code}): ${err}`,
          );
        }
        try { await rm(path); } catch { /* ignore */ }
        foundNested = true;
      }
    }

    if (!foundNested) break;
  }
}
