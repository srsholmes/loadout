import { mkdir, readdir, rm, copyFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { spawn } from "@loadout/exec";

// Re-export from the shared github helpers so existing callers
// (`installer-host.ts`, etc.) keep working without churn.
// Optional gh auth token to raise GitHub's 60/hr unauthenticated rate limit.
export { downloadFile, githubToken } from "./github";

/**
 * Extract a `.zip`, `.tar.gz`, `.tgz`, `.tar`, or `.appimage` to
 * `dest`. AppImages are copied (and renamed if `appimageBasename`
 * is provided so registry entries don't have to embed versioned
 * filenames). Recursively unpacks nested archives up to 3 levels.
 */
export async function extractArchive(
  archivePath: string,
  dest: string,
  appimageBasename?: string,
): Promise<void> {
  await mkdir(dest, { recursive: true });

  const filename = basename(archivePath).toLowerCase();

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
        const proc = spawn(["tar", "xzf", path, "-C", dir], {
          stdout: "ignore",
          stderr: "ignore",
        });
        await proc.exited;
        try { await rm(path); } catch { /* ignore */ }
        foundNested = true;
      } else if (lower.endsWith(".zip") && entries.length <= 2) {
        const proc = spawn(["unzip", "-o", path, "-d", dir], {
          stdout: "ignore",
          stderr: "ignore",
        });
        await proc.exited;
        try { await rm(path); } catch { /* ignore */ }
        foundNested = true;
      }
    }

    if (!foundNested) break;
  }
}

