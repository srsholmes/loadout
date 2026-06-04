import { mkdir, rm, cp, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "@loadout/exec";
import { createExternalCache } from "@loadout/external-cache";
import {
  currentPlatform,
  gamesDir,
  getEffectivePlatformValue,
  getPlatformValue,
  tempDir,
  type PlatformName,
} from "./platform";
import { globMatches } from "./glob";
import type {
  GameEntry, InstalledGame, PersistedState, PipelineEvent,
  GitHubRelease,
} from "./types";
import { updateInstalledGame, removeInstalledGame } from "./state";
import { addToSteam, removeFromSteam } from "./steam-shortcut";
import { applyArtwork } from "./artwork";
import { extractArchive } from "./pipeline-archive";
import { downloadFile, githubToken } from "./github";
import { runSetupScript } from "./installer-host";
import { setupScriptPathFor } from "./registry";

type EventCallback = (event: PipelineEvent) => void;

// Disk-backed cache for the most-recent-release lookup. Distinct
// instance from `lib/artwork.ts`'s `cache` so the two concerns
// can be cleared / invalidated independently.
const releaseCache = createExternalCache("recomp");

// ── Template Resolution ──────────────────────────────────────────────

export function resolveTemplate(
  template: string,
  installDir: string,
  romPath?: string,
): string {
  let result = template.replaceAll("{installDir}", installDir);
  result = result.replaceAll("{platform}", currentPlatform());
  if (romPath) {
    result = result.replaceAll("{romPath}", romPath);
  }
  return result;
}

// ── GitHub Integration ───────────────────────────────────────────────

/**
 * Disk-cached lookup of the most recent non-prerelease tag for
 * `repo`. The hand-curated registry's `latestVersion` field goes
 * stale every time upstream cuts a release; using this for update
 * detection instead means the comparison is always authoritative.
 *
 * 6 h TTL bounds GitHub-API hits to ~4/day per installed repo —
 * comfortably under the 60/hour unauthenticated limit even for a
 * user with dozens of installed recomp games.
 *
 * Returns null on rate-limit, network failure, or empty release
 * list. Callers fall back to the registry hint (or skip the
 * update check entirely).
 */
export async function latestReleaseTag(repo: string): Promise<string | null> {
  try {
    const tag = await releaseCache.getOrFetch<string>(
      `latest:${repo}`,
      async () => {
        const releases = await fetchReleases(repo);
        const release = releases.find((r) => !r.prerelease) ?? releases[0];
        return release?.tag_name ?? "";
      },
      { ttlSec: 6 * 60 * 60 },
    );
    return tag && tag.length > 0 ? tag : null;
  } catch {
    return null;
  }
}

export async function fetchReleases(repo: string): Promise<GitHubRelease[]> {
  const url = `https://api.github.com/repos/${repo}/releases`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "SteamLoader-RecompPlugin/0.1.0",
  };

  const token = await githubToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} for ${repo}: ${body}`);
  }

  return (await res.json()) as GitHubRelease[];
}

export async function resolveAssetUrl(
  entry: GameEntry,
): Promise<{ url: string; version: string; platform: PlatformName; sha256?: string }> {
  // `getEffectivePlatformValue` returns Linux pattern first; if there
  // isn't one and we're on Linux, falls back to the Windows pattern
  // with `platform: "windows"` so the install pipeline knows to set
  // Proton as the compat tool when it registers the Steam shortcut.
  const resolved = getEffectivePlatformValue(entry.releaseAssets);
  if (!resolved) {
    throw new Error(
      `${entry.name} is not available on your platform (${currentPlatform()})`,
    );
  }
  const { value: pattern, platform } = resolved;

  // Expected SHA-256 for the resolved platform, when the manifest
  // pinned one. Threaded back to the install pipeline so it can verify
  // the downloaded bytes before extraction.
  const sha256 = entry.releaseSha256?.[platform];

  // Fast path: pre-resolved URLs from registry. Only use the
  // pre-resolved URL if it's for the SAME platform we ended up
  // resolving — otherwise fall through to the GitHub query so the
  // pattern below can match a Windows asset.
  if (entry.latestAssetUrl) {
    const preResolved =
      platform === currentPlatform()
        ? getPlatformValue(entry.latestAssetUrl)
        : entry.latestAssetUrl[platform];
    if (preResolved) {
      return {
        url: preResolved,
        version: entry.latestVersion ?? "unknown",
        platform,
        sha256,
      };
    }
  }

  // Fallback: query GitHub Releases API
  const releases = await fetchReleases(entry.repo);
  const release =
    releases.find((r) => !r.prerelease) ?? releases[0];
  if (!release) {
    throw new Error(`No releases found for ${entry.repo}`);
  }

  const asset = release.assets.find((a) => globMatches(pattern, a.name));
  if (!asset) {
    const available = release.assets.map((a) => a.name);
    throw new Error(
      `No asset matching '${pattern}' for ${entry.name} (${release.tag_name}). Available: ${available.join(", ")}`,
    );
  }

  return { url: asset.browser_download_url, version: release.tag_name, platform, sha256 };
}

/**
 * Verify a freshly downloaded file against an expected SHA-256
 * (FIX 4 — checksum pinning).
 *
 *   - `expected` present: compute the file's SHA-256 and throw
 *     (removing the file first) on mismatch. The expected digest may
 *     carry a `sha256:` prefix and is compared case-insensitively.
 *   - `expected` absent: emit a one-line "unverified download" notice
 *     via `log` and return (existing games carry no checksum yet, so
 *     this must NOT block them).
 *
 * Streams the file through Bun's incremental hasher so a multi-GB
 * release asset isn't buffered into memory just to hash it.
 */
export async function verifyDownloadChecksum(
  filePath: string,
  expected: string | undefined,
  log: (message: string) => void,
): Promise<void> {
  if (!expected || expected.trim() === "") {
    log(
      `Unverified download: no sha256 pinned for ${basename(filePath)} — proceeding without integrity check.`,
    );
    return;
  }

  const want = expected.trim().replace(/^sha256:/i, "").toLowerCase();

  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(filePath).stream();
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  const got = hasher.digest("hex").toLowerCase();

  if (got !== want) {
    try { await rm(filePath, { force: true }); } catch { /* ignore */ }
    throw new Error(
      `Checksum mismatch for ${basename(filePath)}: expected sha256 ${want}, got ${got}. ` +
        `The download was rejected and removed.`,
    );
  }
  log(`Checksum verified (sha256 ${got}) for ${basename(filePath)}.`);
}

// ── Set Executable Permissions ───────────────────────────────────────

async function makeExecutable(
  installDir: string,
  entry: GameEntry,
  platform: PlatformName,
): Promise<void> {
  // Skip on Windows hosts (NTFS doesn't have an exec bit) AND when
  // the install is a Windows .exe running through Proton (Wine
  // invokes the binary, doesn't need +x set on it).
  if (platform === "windows") return;

  const launchCmd = entry.launchCommand[platform];
  if (!launchCmd) return;

  // Recipes pass JUST the executable path to declareLaunchCommand;
  // any arguments live inside a launcher.sh wrapper. So we treat
  // the entire resolved string as the binary to chmod.
  const exe = resolveTemplate(launchCmd, installDir);
  if (exe && existsSync(exe)) {
    await spawn(["chmod", "+x", exe]).exited;
  }
}

// ── Install ──────────────────────────────────────────────────────────

export async function installGame(
  entry: GameEntry,
  state: PersistedState,
  romPath: string | undefined,
  onEvent: EventCallback,
): Promise<PersistedState> {
  const gameId = entry.id;

  // Check if ROM is required but not provided
  if (requiresRom(entry) && !romPath) {
    const description =
      entry.romInfo?.description ?? "Please provide your ROM file.";
    onEvent({ type: "rom_required", gameId, message: description });
    return state;
  }

  const installDir = join(state.installPath || gamesDir(), gameId);
  const partialDir = `${installDir}.partial`;
  const tmpGameDir = join(tempDir(), gameId);

  // Clean temp + any stale `.partial` from a previous crashed install.
  // We leave a `.partial` from THIS install on failure (below) for
  // debugging, but on the next attempt we deliberately wipe it so
  // we don't merge bytes from two different attempts.
  try { await rm(tmpGameDir, { recursive: true, force: true }); } catch { /* ok */ }
  try { await rm(partialDir, { recursive: true, force: true }); } catch { /* ok */ }
  await mkdir(tmpGameDir, { recursive: true });

  // Steam shortcut appId for THIS install, recorded the moment the
  // shortcut is written so the catch block can tear it down if a
  // later step throws. Without this a mid-pipeline failure after the
  // shortcut write would orphan a shortcut that launches nothing.
  let createdShortcutAppId: number | undefined;

  try {
    let version: string;
    let resolvedPlatform: PlatformName;
    // Resolved launch command for THIS install. Persisted on the
    // InstalledGame at the end of the function. Computed differently
    // per branch (recipe-declared for build_from_source, registry-
    // declared for the others). MUST NOT MUTATE `entry.launchCommand`
    // — that's the shared registry object held by RecompBackend; a
    // mutation there would leak to every subsequent UI render +
    // every future install attempt for any other user / install
    // path. addToSteam reads `installed.launchCommand` first, so
    // this local is the single source of truth.
    let resolvedLaunchCommand: string | undefined;

    if (entry.installType === "build_from_source") {
      // Per-game `setup.ts` recipe owns all build logic. We just
      // spawn it inside the recomp distrobox and bridge its
      // `@recomp/sdk` calls into BuildEnv operations.
      const scriptPath = setupScriptPathFor(entry.id);
      if (!scriptPath) {
        throw new Error(
          `${entry.name} is installType=build_from_source but no setup.ts ` +
            `was found at plugins/recomp/games/${entry.id}/setup.ts`,
        );
      }
      // Stage into `partialDir`. If the recipe crashes halfway,
      // we wipe partialDir on the next install attempt (line ~206)
      // — without this, a crashed `make` would leave a half-tree
      // at `installDir`, the next install's `cloneFromGitHub` would
      // overwrite top-level files but leave stale `build/` artifacts
      // that would pass `declareOutput`'s `existsSync` and ship a
      // corrupt binary. Recipes don't know about this staging —
      // they receive `partialDir` as their `installDir`, do all
      // their work there, and the pipeline promotes to the final
      // location only on success (parallel to the prebuilt branch).
      await mkdir(partialDir, { recursive: true });
      const result = await runSetupScript(
        scriptPath,
        {
          gameId: entry.id,
          installDir: partialDir,
          romPath,
          platform: currentPlatform(),
        },
        onEvent,
      );
      version = result.version ?? new Date().toISOString();
      // A recipe that cross-compiled (e.g. Render96-RT, which is
      // mingw → Windows .exe run via Proton) declares targetPlatform.
      // Without this, addToSteam would treat the binary as a native
      // Linux ELF and skip Proton compat-tool registration → the
      // .exe wouldn't launch through Steam.
      resolvedPlatform = result.targetPlatform ?? currentPlatform();
      // Recipe-declared launch command wins; otherwise the host-
      // generated wrapper (auto-written by installer-host when the
      // recipe didn't set one) is at `{installDir}/<outputBinary>`.
      // Both forms get persisted on installed.launchCommand below.
      //
      // Path rewrite: the recipe ran with `installDir = partialDir`,
      // so any absolute launch command it produced (e.g.
      // `${sdk.installDir}/launcher.sh`) currently points inside
      // partialDir. After the post-build rename below, those files
      // live at installDir. Swap the prefix here so the persisted
      // value matches reality. (Templated `{installDir}/...` strings
      // resolve later at addToSteam time and don't need rewriting.)
      const rawLaunch =
        result.launchCommand ??
        entry.launchCommand[resolvedPlatform] ??
        `{installDir}/${result.outputBinary}`;
      resolvedLaunchCommand = rawLaunch.startsWith(partialDir)
        ? installDir + rawLaunch.slice(partialDir.length)
        : rawLaunch;

      // Atomic promotion: clear any pre-existing installDir, then
      // `rename` the staged tree into place. Parallel to the
      // prebuilt branch's promotion at the end of its block.
      if (existsSync(installDir)) {
        await rm(installDir, { recursive: true, force: true });
      }
      await rename(partialDir, installDir);
    } else {
      // Resolve asset URL
      onEvent({
        type: "progress", gameId, stage: "resolving",
        percent: 0, message: "Finding latest release...",
      });
      const resolved = await resolveAssetUrl(entry);
      version = resolved.version;
      resolvedPlatform = resolved.platform;
      const assetUrl = resolved.url;
      const expectedSha256 = resolved.sha256;

    // Download
    const filename = assetUrl.split("/").pop() ?? "download";
    const downloadPath = join(tmpGameDir, filename);

    onEvent({
      type: "progress", gameId, stage: "downloading",
      percent: 0, message: "Starting download...",
    });

    await downloadFile(assetUrl, downloadPath, (downloaded, total) => {
      const percent = total > 0 ? (downloaded / total) * 100 : 0;
      const mbDown = (downloaded / 1_048_576).toFixed(1);
      const mbTotal = (total / 1_048_576).toFixed(1);
      onEvent({
        type: "progress", gameId, stage: "downloading",
        percent, message: `${mbDown} / ${mbTotal} MB`,
      });
    });

    // Checksum gate (FIX 4): if the manifest pinned an expected
    // sha256 for this platform, verify the downloaded bytes BEFORE
    // extraction and abort (the helper removes the file) on mismatch.
    // Absent ⇒ a one-line "unverified" notice, then proceed — existing
    // games carry no checksums yet.
    onEvent({
      type: "progress", gameId, stage: "verifying",
      percent: 0, message: "Verifying download...",
    });
    await verifyDownloadChecksum(downloadPath, expectedSha256, (m) =>
      onEvent({
        type: "progress", gameId, stage: "verifying", percent: 100, message: m,
      }),
    );

    // Stage extraction in `${installDir}.partial`. On success we
    // atomically `rename(partialDir, installDir)` at the end of the
    // prebuilt branch — so a download/extract that crashes halfway
    // never leaves a half-populated `installDir` for Steam to launch.
    // The `installDir`-substituted templates below resolve against
    // `partialDir` since the files actually live there during install.
    onEvent({
      type: "progress", gameId, stage: "extracting",
      percent: 0, message: "Extracting...",
    });
    await mkdir(partialDir, { recursive: true });
    const launchCmd = entry.launchCommand[resolvedPlatform];
    const appimageBasename =
      launchCmd && downloadPath.toLowerCase().endsWith(".appimage")
        ? basename(resolveTemplate(launchCmd, partialDir))
        : undefined;
    await extractArchive(downloadPath, partialDir, appimageBasename);
    onEvent({
      type: "progress", gameId, stage: "extracting",
      percent: 100, message: "Extraction complete",
    });

    // Post-extract commands for ROM-based install types
    if (entry.installType === "rom_extract" || entry.installType === "toolchain" || entry.installType === "custom") {
      // `placeRomAs` is the simple case — engine ingests the ROM
      // on first launch from a known filename next to the binary
      // (Ship of Harkinian, 2 Ship 2 Harkinian, etc). Prefer over
      // `extractionCommand` because there's no GUI process to
      // spawn and wait on — SoH/2ship don't have a CLI extraction
      // mode despite older manifests trying to pass `--generate-otr`
      // (a flag that doesn't exist; the AppImage ignored it and
      // sat in its GUI event loop forever).
      if (romPath && entry.romInfo?.placeRomAs) {
        const dest = join(partialDir, entry.romInfo.placeRomAs);
        onEvent({
          type: "progress", gameId, stage: "extraction",
          percent: 50, message: `Copying ROM → ${entry.romInfo.placeRomAs}…`,
        });
        await cp(romPath, dest, { force: true });
      }
      if (entry.romInfo?.extractionCommand) {
        onEvent({
          type: "progress", gameId, stage: "extraction",
          percent: 50, message: "Running ROM extraction...",
        });
        await runCommandTemplate(
          entry.romInfo.extractionCommand, partialDir, romPath,
        );
      }
      if (entry.installType === "toolchain" && entry.toolchain?.setupCommand) {
        onEvent({
          type: "progress", gameId, stage: "setup",
          percent: 50, message: "Running toolchain setup...",
        });
        await runCommandTemplate(
          entry.toolchain.setupCommand, partialDir, romPath,
        );
      }
    }

      // Make executable (file is still at partialDir until rename below)
      await makeExecutable(partialDir, entry, resolvedPlatform);

      // Atomic promotion: clear any pre-existing installDir, then
      // `rename` the staged tree into place.
      if (existsSync(installDir)) {
        await rm(installDir, { recursive: true, force: true });
      }
      await rename(partialDir, installDir);
    } // end of prebuilt branch — build_from_source skipped to here

    const now = new Date().toISOString();
    // Carry forward `installedMods` from the previous record (if any).
    // Mods whose `installSubdir` resolves under the engine's
    // `userDataDir` (texture packs etc.) land their files OUTSIDE
    // the install dir, so the `rm installDir` above doesn't touch
    // them — they survive the reinstall. Without carrying state
    // forward the UI would report them as "not installed" even
    // though the engine still loads them.
    //
    // A future relative-path mod whose files DO get wiped will
    // appear as "installed" until the user re-imports. Acceptable
    // tradeoff — the Re-import button just re-runs the same cp
    // and self-heals.
    const carriedInstalledMods = state.games[gameId]?.installedMods;
    let installed: InstalledGame = {
      installedVersion: version,
      installedAt: now,
      updatedAt: now,
      installDir,
      romPath,
      addedToSteam: false,
      installedPlatform: resolvedPlatform,
      ...(carriedInstalledMods
        ? { installedMods: carriedInstalledMods }
        : {}),
      // Persist the resolved launch command. For prebuilt branches
      // it falls back to `entry.launchCommand[platform]` (which is
      // never mutated). For build_from_source it's the recipe-
      // declared value or the host-wrapper path. addToSteam +
      // addInstalledToSteam read this field first.
      launchCommand:
        resolvedLaunchCommand ?? entry.launchCommand[resolvedPlatform],
    };

    // Add to Steam + apply SGDB artwork. Both are best-effort: a
    // failure here doesn't fail the install, and the user can retry
    // from the detail page. Always-on now — the previous opt-out
    // setting just confused users since there's no realistic reason
    // to install a recomp game and NOT play it through Steam.
    try {
      onEvent({
        type: "progress", gameId, stage: "steam",
        percent: 0, message: "Adding to Steam...",
      });
      const shortcut = await addToSteam(entry, installed);
      createdShortcutAppId = shortcut.appId;
      installed = {
        ...installed,
        addedToSteam: true,
        steamAppId: shortcut.appId,
        steamGameId64: shortcut.gameId64,
      };
      onEvent({
        type: "progress", gameId, stage: "steam",
        percent: 100, message: "Added to Steam library",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", gameId, stage: "steam", message });
    }

    if (installed.addedToSteam && installed.steamAppId != null) {
      try {
        onEvent({
          type: "progress", gameId, stage: "artwork",
          percent: 0, message: "Fetching artwork...",
        });
        const { written } = await applyArtwork(entry, installed.steamAppId);
        onEvent({
          type: "progress", gameId, stage: "artwork",
          percent: 100,
          message: written > 0
            ? `Applied ${written} artwork file${written === 1 ? "" : "s"}`
            : "No artwork found on SteamGridDB",
        });
      } catch (err) {
        // Most common cause: no SGDB key. Steam shows a default tile.
        const message = err instanceof Error ? err.message : String(err);
        onEvent({ type: "error", gameId, stage: "artwork", message });
      }
    }

    const newState = await updateInstalledGame(state, gameId, installed);

    onEvent({ type: "complete", gameId, version });
    return newState;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Roll back partial artifacts so a failed install never leaves a
    // half-populated install dir, an orphaned Steam shortcut, or a
    // half-install state record behind:
    //   - the staged `.partial` tree (never promoted on failure, but
    //     a crash mid-extract leaves it on disk),
    //   - any pre-promotion `installDir` from a prior attempt is NOT
    //     touched here — we only own what THIS attempt created,
    //   - the Steam shortcut, if we got far enough to write one before
    //     a later step (e.g. the state persist) threw.
    try { await rm(partialDir, { recursive: true, force: true }); } catch { /* ok */ }
    if (createdShortcutAppId != null) {
      try { await removeFromSteam(createdShortcutAppId); } catch { /* ok */ }
    }
    onEvent({ type: "error", gameId, message });
    throw err;
  } finally {
    // Cleanup temp
    try { await rm(tmpGameDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

// ── Uninstall ────────────────────────────────────────────────────────

export async function uninstallGame(
  gameId: string,
  state: PersistedState,
): Promise<PersistedState> {
  const installDir = join(state.installPath || gamesDir(), gameId);

  if (existsSync(installDir)) {
    await rm(installDir, { recursive: true, force: true });
  }

  return await removeInstalledGame(state, gameId);
}

// ── Update ───────────────────────────────────────────────────────────

export async function updateGame(
  entry: GameEntry,
  state: PersistedState,
  onEvent: EventCallback,
): Promise<PersistedState> {
  const gameId = entry.id;
  const installed = state.games[gameId];
  if (!installed) {
    throw new Error(`Game '${gameId}' is not installed`);
  }

  const installDir = join(state.installPath || gamesDir(), gameId);
  const preservePaths = entry.preservePaths ?? [];
  // Timestamped backup dir next to the install so a previous failed
  // update's backup is never silently overwritten — the user can
  // always recover the most recent saves manually if anything weird
  // happens. We don't put this under tempDir() because the install
  // pipeline may wipe parts of tempDir mid-flight.
  const backupDir = `${installDir}.backup-${Date.now()}`;

  // Snapshot preserved paths (saves, configs) into the backup dir.
  // Track which entries we actually copied so the restore phase can
  // verify every one made it back.
  const backedUp: string[] = [];
  if (existsSync(installDir) && preservePaths.length > 0) {
    await mkdir(backupDir, { recursive: true });
    for (const pattern of preservePaths) {
      const src = join(installDir, pattern);
      if (existsSync(src)) {
        const dest = join(backupDir, pattern);
        await cp(src, dest, { recursive: true });
        backedUp.push(pattern);
      }
    }
  }

  // Remove old install
  if (existsSync(installDir)) {
    await rm(installDir, { recursive: true, force: true });
  }

  // Reinstall
  const romPath = installed.romPath;
  let newState: PersistedState;
  try {
    newState = await installGame(entry, state, romPath, onEvent);
  } catch (err) {
    // Reinstall failed: try to restore the backup over a fresh
    // installDir. Always leave the backup on disk afterwards — if
    // anything trips, the user still has their saves at `backupDir`.
    if (existsSync(backupDir)) {
      try {
        await mkdir(installDir, { recursive: true });
        for (const pattern of backedUp) {
          const src = join(backupDir, pattern);
          if (existsSync(src)) {
            const dest = join(installDir, pattern);
            await cp(src, dest, { recursive: true });
          }
        }
      } catch (restoreErr) {
        const original = err instanceof Error ? err.message : String(err);
        const restoreMessage =
          restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        throw new Error(
          `Update failed (${original}) AND restore failed (${restoreMessage}). ` +
            `Your previous save data is preserved at: ${backupDir}`,
        );
      }
      const original = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Update failed: ${original}. A copy of your previous save data ` +
          `is preserved at: ${backupDir}`,
      );
    }
    throw err;
  }

  // Restore preserved paths. Only delete the backup once we've
  // verified every backed-up path exists at the destination — if any
  // copy fails we leave the backup so the user can recover.
  if (existsSync(backupDir) && existsSync(installDir)) {
    try {
      for (const pattern of backedUp) {
        const src = join(backupDir, pattern);
        if (existsSync(src)) {
          const dest = join(installDir, pattern);
          await cp(src, dest, { recursive: true });
        }
      }
      const missing = backedUp.filter(
        (pattern) => !existsSync(join(installDir, pattern)),
      );
      if (missing.length > 0) {
        throw new Error(
          `Failed to restore preserved paths: ${missing.join(", ")}. ` +
            `Your saves are still at: ${backupDir}`,
        );
      }
      await rm(backupDir, { recursive: true, force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes(backupDir)) throw err;
      throw new Error(
        `Restore failed: ${message}. Your saves are preserved at: ${backupDir}`,
      );
    }
  }

  return newState;
}

// ── Helpers ──────────────────────────────────────────────────────────

function requiresRom(entry: GameEntry): boolean {
  // `custom` is included because the post-extract block (around
  // line 301) runs its `extractionCommand` and may substitute
  // `{romPath}` — without listing it here, the early gate at the
  // top of installGame() wouldn't emit `rom_required` and the
  // install would silently proceed with an undefined ROM, then
  // shell-tokenize `undefined` into the command and fail with an
  // opaque exit code mid-pipeline.
  return (
    entry.installType === "rom_extract" ||
    entry.installType === "toolchain" ||
    entry.installType === "build_from_source" ||
    entry.installType === "custom"
  );
}

/**
 * Run a templated `extractionCommand` / `setupCommand` from the
 * registry inside `cwd`. The template typically looks like
 *
 *   "{installDir}/soh.elf --generate-otr {romPath}"
 *
 * Args after the executable are common (most rom_extract entries
 * pass `--generate-otr {romPath}` or similar) and may contain
 * spaces once `{romPath}` is substituted (ROM filenames frequently
 * have parens, brackets, commas).
 *
 * Naive splitting of the resolved string by whitespace would
 * shatter the romPath. We tokenize the TEMPLATE first (before any
 * substitution introduces spaces), substitute each token
 * individually, then exec with [exe, ...args]. This keeps
 * substituted values as single argv tokens regardless of their
 * internal whitespace.
 *
 * Security: realpath-verifies the exe lives inside `cwd` (the
 * install dir) before running, so a malformed template can't run
 * something outside the install scope.
 */
async function runCommandTemplate(
  template: string,
  cwd: string,
  romPath: string | undefined,
): Promise<void> {
  const tokens = template.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("Empty command template");
  const [exeTemplate, ...argTemplates] = tokens;
  const exe = resolveTemplate(exeTemplate!, cwd, romPath);
  const args = argTemplates.map((t) => resolveTemplate(t, cwd, romPath));

  const { realpath } = await import("node:fs/promises");
  const { sep } = await import("node:path");
  try {
    const canonicalCwd = await realpath(cwd);
    const canonicalExe = await realpath(exe);
    // Path-segment match, not a bare prefix: `startsWith(cwd)` alone
    // would let `/share/games/foo` permit `/share/games/foobar/evil`
    // because the sibling shares the same prefix string. Require
    // either equality or that the next char after cwd is a separator
    // — anchoring the match to a full path segment.
    if (
      canonicalExe !== canonicalCwd &&
      !canonicalExe.startsWith(canonicalCwd + sep)
    ) {
      throw new Error(
        `Security: executable '${exe}' is outside install directory '${cwd}'`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Security:")) throw err;
    throw new Error(`Security: cannot verify executable '${exe}': ${err}`);
  }

  const proc = spawn([exe, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Command failed (exit ${code}): ${stderr}`);
  }
}
