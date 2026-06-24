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
  } else if (lower.endsWith(".rar") || lower.endsWith(".7z")) {
    entries.push(...(await listLibarchive(archivePath)));
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

// Force the C locale on listing tools so their human-readable output is
// stable: GNU tar localizes both the date column AND the " link to "
// hardlink phrase, and zipinfo localizes its month names — parsing those
// is what the traversal/symlink guard depends on. (Merged onto
// process.env so PATH etc. survive — Bun.spawn's env REPLACES, not
// merges.)
function cLocaleEnv(): Record<string, string | undefined> {
  return { ...process.env, LC_ALL: "C", LANG: "C", LC_TIME: "C" };
}

/**
 * Run a listing/inspection command and return its stdout. Drains BOTH
 * stdout and stderr concurrently with exit: a tool that emits a lot of
 * stderr (e.g. `tar` warning "implausibly old time stamp" on a foreign
 * archive) would otherwise fill the OS pipe buffer and block before
 * exiting → `proc.exited` never resolves → the root backend hangs.
 */
async function listingStdout(cmd: string[], archivePath: string): Promise<string> {
  const proc = spawn(cmd, { stdout: "pipe", stderr: "pipe", env: cLocaleEnv() });
  const [out, errText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `Could not read archive listing for ${basename(archivePath)} (${cmd[0]} exit ${code}): ${errText}`,
    );
  }
  return out;
}

/**
 * List a tar(.gz) archive's members with symlink AND hardlink targets.
 * Uses `tar -tv`; symlink lines carry ` -> target`, hardlink lines carry
 * ` link to target` (both localized — hence the C locale). The verbose
 * listing is `mode user/group size date time name [-> link | link to link]`.
 */
async function listTar(
  archivePath: string,
  gzip: boolean,
): Promise<{ name: string; link?: string }[]> {
  const flag = gzip ? "tvzf" : "tvf";
  const out = await listingStdout(["tar", flag, archivePath], archivePath);
  const result: { name: string; link?: string }[] = [];
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    // Grab the tail after the timestamp (mode, owner/group, size, date,
    // time, then the name). C locale keeps the date/time columns stable.
    const m = line.match(/^\S+\s+\S+\s+\d+\s+[\d-]+\s+[\d:]+\s+(.*)$/);
    const tail = m ? m[1]! : line;
    const sym = tail.indexOf(" -> "); // symlink
    const hard = tail.indexOf(" link to "); // hardlink
    if (sym !== -1) {
      result.push({ name: tail.slice(0, sym), link: tail.slice(sym + 4) });
    } else if (hard !== -1) {
      result.push({ name: tail.slice(0, hard), link: tail.slice(hard + 9) });
    } else {
      result.push({ name: tail });
    }
  }
  return result;
}

/**
 * List a zip archive's members with symlink targets.
 *
 *   - Names come from `unzip -Z1`: exactly one clean name per line for
 *     EVERY zip host type. (The fixed-width `unzip -Z` columns vary by
 *     host — a DOS/FAT zip has a short attribute field — so a column
 *     regex would silently miss entries and blind the traversal guard.)
 *   - Symlink targets: zipinfo (`unzip -Z`) flags symlinks with a
 *     leading `l` in the perms column (only Unix-host zips carry
 *     symlinks; `unzip` restores them iff that bit is set, so detecting
 *     `l` matches extraction behavior). zipinfo does NOT print the
 *     target, so we read each symlink's target from its entry CONTENT
 *     via `unzip -p` and hand it to the same traversal check tar uses.
 */
async function listZip(
  archivePath: string,
): Promise<{ name: string; link?: string }[]> {
  const namesOut = await listingStdout(["unzip", "-Z1", archivePath], archivePath);
  const result: { name: string; link?: string }[] = namesOut
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l !== "")
    .map((name) => ({ name }));
  const byName = new Map(result.map((e) => [e.name, e]));

  const zOut = await listingStdout(["unzip", "-Z", archivePath], archivePath);
  for (const line of zOut.split("\n")) {
    // Unix symlink entry: `lrwxrwxrwx … dd-Mon-yy HH:MM name`.
    const m = line.match(
      /^l[rwxsStT-]{9}\s.*\s\d{2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/,
    );
    if (!m) continue;
    const name = m[1]!.replace(/\r$/, "");
    // The symlink's content IS its target path. CRITICAL: `unzip -p`
    // treats the member-name argument as its OWN wildcard pattern
    // (`*`, `?`, `[…]`) — not a literal — even via argv. An attacker
    // could name a symlink `link[x]` and add a benign decoy `linkx`;
    // `unzip -p archive 'link[x]'` would then glob to the decoy and
    // return ITS safe content, hiding the real (e.g. absolute) target
    // from this guard. Escape unzip's glob metacharacters so the name
    // matches literally.
    const literal = name.replace(/([\\*?[\]])/g, "\\$1");
    const target = (
      await listingStdout(["unzip", "-p", archivePath, literal], archivePath)
    ).replace(/\r?\n$/, "");
    const e = byName.get(name);
    if (e) e.link = target;
    else result.push({ name, link: target });
  }
  return result;
}

/**
 * List a `.rar` / `.7z` archive's members (with symlink targets) via
 * `bsdtar` (libarchive), for the safety pre-flight. We don't reuse the GNU
 * tar verbose-line regex here: libarchive renders its verbose (`-tvf`) date
 * in an `ls -l` month-name style (`Jun 24 22:18`) that differs from GNU
 * tar's numeric `2024-06-24`, so the shared regex silently mis-parsed the
 * member name (it kept a date prefix), and the traversal/absolute check
 * never fired. Instead:
 *
 *   - names come from `-tf` (one full member path per line, no columns to
 *     parse — robust regardless of date/locale formatting), and
 *   - symlink/hardlink targets come from a `-tvf` pass, taking the text
 *     after the LAST ` -> ` (a member name containing ` -> ` can't hide
 *     the real, final target).
 */
async function listLibarchive(
  archivePath: string,
): Promise<{ name: string; link?: string }[]> {
  const result: { name: string; link?: string }[] = [];

  const names = await listingStdout(["bsdtar", "-tf", archivePath], archivePath);
  for (const line of names.split("\n")) {
    const name = line.replace(/\/+$/, ""); // dirs list with a trailing slash
    if (name.trim() === "") continue;
    result.push({ name });
  }

  // Symlink/hardlink targets only surface in the verbose listing as
  // `… name -> target`. We only need the target for the escape check; the
  // names were already checked above, so push target-only entries.
  const verbose = await listingStdout(["bsdtar", "-tvf", archivePath], archivePath);
  for (const line of verbose.split("\n")) {
    const i = line.lastIndexOf(" -> ");
    if (i !== -1) result.push({ name: "", link: line.slice(i + 4).trim() });
  }

  return result;
}

/**
 * Extract a `.zip`, `.tar.gz`, `.tgz`, `.tar`, `.rar`, `.7z`, or
 * `.appimage` to `dest`. AppImages are copied (and renamed if
 * `appimageBasename` is provided so registry entries don't have to
 * embed versioned filenames). `.rar`/`.7z` go through `bsdtar`
 * (libarchive) since `unzip`/`tar` can't read them — some upstreams
 * (e.g. GoldenEye-Recomp) only publish a `.rar`. Recursively unpacks
 * nested archives up to 3 levels.
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
  } else if (filename.endsWith(".rar") || filename.endsWith(".7z")) {
    // `unzip`/`tar` can't read these; libarchive's `bsdtar` handles both.
    // `-x` extract, `-f` file, `-C` into dest.
    const proc = spawn(["bsdtar", "-xf", archivePath, "-C", dest], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`bsdtar extract failed (exit ${code}): ${err}`);
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
        // Only auto-unpack a nested `.zip` when it's (essentially) the
        // sole payload (≤2 entries). Unlike nested tarballs — which are
        // unambiguously wrappers — a `.zip` sitting alongside many other
        // files is more likely a data archive the game reads at runtime
        // (e.g. an asset pack) than a wrapper, and unpacking+deleting it
        // would corrupt the install. The trade-off: a genuine wrapper
        // zip shipped beside ≥2 siblings is left packed (opaque launch
        // failure) — rare for the prebuilt/rom_extract sources we target.
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
