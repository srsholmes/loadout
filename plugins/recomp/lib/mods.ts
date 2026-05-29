import { mkdir, rm, readdir, cp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename, resolve as resolvePath } from "node:path";
import { runFull } from "@loadout/exec";
import { downloadFile } from "./github";
import { extractArchive } from "./pipeline-archive";
import { modCacheDir, tempDir } from "./platform";
import { setupModulePathFor } from "./registry";
import type {
  GameEntry,
  GitHubAsset,
  GitHubRelease,
  InstalledGame,
  ModEntry,
  PipelineEvent,
} from "./types";
import { globMatches } from "./glob";
import type {
  InternalModRuntime,
  ModRunOpts,
  ModRunResult,
  ModSDK,
} from "./sdk/mod";

type EventCallback = (event: PipelineEvent) => void;

export interface ModInstallResult {
  installedAt: string;
  version?: string;
}

/**
 * Install pipeline for `github-release` + `direct-url` mods.
 *
 * Steps:
 *   1. Resolve + download the archive into `<tempDir>/mods/<modId>/`.
 *   2. Extract into `<tempDir>/mods/<modId>/staged/`.
 *   3. Apply — either default `cp -r staged/* installDir/installSubdir/`
 *      OR invoke the mod's `setupModule` if declared.
 *   4. Cleanup the temp staging dir.
 *
 * Throws on any step's failure; caller doesn't persist install state
 * unless the promise resolves.
 */
export async function installMod(
  game: GameEntry,
  installed: InstalledGame,
  mod: ModEntry,
  onEvent: EventCallback,
): Promise<ModInstallResult> {
  if (mod.source.kind === "manual-import") {
    throw new Error(
      `Mod "${mod.id}" is manual-import — call importModFromArchive() with a user-picked file instead.`,
    );
  }

  const stagedRoot = modStagedDir(game.id, mod.id);
  await rm(stagedRoot, { recursive: true, force: true });
  await mkdir(stagedRoot, { recursive: true });
  try {
    const archivePath = await downloadModArchive(mod, stagedRoot, game.id, onEvent);
    const stagedDir = join(stagedRoot, "staged");
    await mkdir(stagedDir, { recursive: true });

    emitStage(onEvent, game.id, `mod:${mod.id}:extract`, 0, "Extracting archive…");
    await extractArchive(archivePath, stagedDir);

    await applyMod(game, installed, mod, stagedDir, onEvent);

    // Terminal `complete` event so the frontend's per-mod progress
    // bar clears (the handler removes the entry on type === "complete"
    // or "error"). Without this the button sticks on "Installing…".
    onEvent({
      type: "complete",
      gameId: game.id,
      stage: `mod:${mod.id}:install`,
      message: "Installed",
    });
    return {
      installedAt: new Date().toISOString(),
      // Catalog-declared version wins over filename-derived version
      // when both are present — the manifest is the source of truth.
      version: mod.version ?? extractVersionFromArchive(archivePath),
    };
  } finally {
    // Always wipe the staging tree — success leaves a few MB lingering
    // until next boot's prune; failure mid-extract would leave whole
    // archives. The catch keeps a leftover-cleanup-failure from
    // masking the pipeline error itself.
    await rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Install pipeline for `manual-import` mods. The caller (frontend
 * file picker) has already produced a local archive file; we extract
 * and apply, same as the download path's tail.
 */
export async function installModFromArchive(
  game: GameEntry,
  installed: InstalledGame,
  mod: ModEntry,
  archivePath: string,
  onEvent: EventCallback,
): Promise<ModInstallResult> {
  if (!existsSync(archivePath)) {
    throw new Error(`Archive not found: ${archivePath}`);
  }
  const stagedRoot = modStagedDir(game.id, mod.id);
  await rm(stagedRoot, { recursive: true, force: true });
  const stagedDir = join(stagedRoot, "staged");
  await mkdir(stagedDir, { recursive: true });
  try {
    emitStage(onEvent, game.id, `mod:${mod.id}:extract`, 0, "Extracting archive…");
    await extractArchive(archivePath, stagedDir);

    await applyMod(game, installed, mod, stagedDir, onEvent);

    // Terminal `complete` event — see installMod for rationale.
    onEvent({
      type: "complete",
      gameId: game.id,
      stage: `mod:${mod.id}:install`,
      message: "Imported",
    });
    return {
      installedAt: new Date().toISOString(),
      // manual-import has no filename heuristic — only the
      // catalog-declared version, if any.
      version: mod.version,
    };
  } finally {
    await rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Internals ────────────────────────────────────────────────────────

/**
 * Per-(game, mod) staging directory under tempDir. Keyed on BOTH
 * gameId and modId so two recomps shipping mods with the same id
 * (`personal-reshade`, `widescreen-fix`, `hd-textures` — generic
 * names that will collide once a second recomp declares mods)
 * don't share the staging tree and torch each other's archives
 * mid-extract.
 */
function modStagedDir(gameId: string, modId: string): string {
  return join(tempDir(), "mods", gameId, modId);
}

/**
 * Module-level serialization gate for mod-install apply phase.
 *
 * Same shape as `installer-host.ts:installChain`. Two concerns
 * motivate serialization across BOTH apply paths (scripted +
 * default-copy):
 *
 *   1. The mod-SDK reads its install context from
 *      `globalThis.__recomp_mod_runtime` (a single slot — see
 *      `lib/sdk/mod.ts`). Two scripted mod installs running
 *      concurrently would clobber each other's runtime mid-await.
 *
 *   2. The default-copy path runs `cp -r staged/* dest/`. When
 *      two mods on the same game both target the same dest dir
 *      (the common case: a `userDataDir`-templated subdir like
 *      `texture_replacements/`), their copies interleave at the
 *      file level — last-write-wins per file, possibly with one
 *      mod's partial extract clobbering another's.
 *
 * The backend's `operations: Set<string>` blocks re-entry on the
 * SAME mod but NOT on different mods (or the same mod across two
 * games). Chain all `applyMod` invocations behind a single Promise.
 *
 * Mod installs aren't CPU-bound (mostly cp / extract), so the
 * serialization penalty is small. The lane is global (mirrors the
 * `__recomp_mod_runtime` slot's scope) — installing mod A on
 * game X blocks mod B on game Y for a few hundred milliseconds.
 */
let modApplyChain: Promise<unknown> = Promise.resolve();

function emitStage(
  onEvent: EventCallback,
  gameId: string,
  stage: string,
  percent?: number,
  message?: string,
): void {
  onEvent({ type: "progress", gameId, stage, percent, message });
}

/**
 * Download path for `github-release` / `direct-url` sources.
 * `manual-import` callers don't reach this — they bring their own
 * archive.
 */
async function downloadModArchive(
  mod: ModEntry,
  stagedRoot: string,
  gameId: string,
  onEvent: EventCallback,
): Promise<string> {
  if (mod.source.kind === "github-release") {
    const release = await fetchRelease(mod.source.repo, mod.source.tag);
    const asset = pickAsset(release.assets, mod.source.assetPattern);
    if (!asset) {
      throw new Error(
        `No asset matching "${mod.source.assetPattern}" on ${mod.source.repo}@${release.tag_name}. ` +
          `Update the manifest's assetPattern.`,
      );
    }
    const dest = join(stagedRoot, asset.name);
    emitStage(
      onEvent,
      gameId,
      `mod:${mod.id}:download`,
      0,
      `Downloading ${asset.name}…`,
    );
    await downloadFile(asset.browser_download_url, dest, (downloaded, total) => {
      emitStage(
        onEvent,
        gameId,
        `mod:${mod.id}:download`,
        total > 0 ? Math.round((downloaded / total) * 100) : undefined,
      );
    });
    return dest;
  }

  if (mod.source.kind === "direct-url") {
    const sourceUrl = new URL(mod.source.url);
    const filename =
      mod.source.filename ?? (basename(sourceUrl.pathname) || `${mod.id}.zip`);
    const dest = join(stagedRoot, filename);
    emitStage(
      onEvent,
      gameId,
      `mod:${mod.id}:download`,
      0,
      `Downloading ${filename}…`,
    );
    // Refuse cross-host redirects. The manifest declared a specific
    // host (gamebanana, modarchive, …); if the response ends up on
    // an unrelated host the mod is either misconfigured or someone
    // upstream is mid-incident — either way, abort.
    await downloadFile(
      mod.source.url,
      dest,
      (downloaded, total) => {
        emitStage(
          onEvent,
          gameId,
          `mod:${mod.id}:download`,
          total > 0 ? Math.round((downloaded / total) * 100) : undefined,
        );
      },
      [sourceUrl.host],
    );
    return dest;
  }

  throw new Error(`Unsupported mod source kind: ${(mod.source as { kind: string }).kind}`);
}

/**
 * Apply step — either the default copy path or the scripted path.
 * Validator guarantees one of `setupModule` / `installSubdir` is set;
 * we re-check defensively here so a broken manifest fails loud rather
 * than silently no-op.
 */
async function applyMod(
  game: GameEntry,
  installed: InstalledGame,
  mod: ModEntry,
  stagedDir: string,
  onEvent: EventCallback,
): Promise<void> {
  // Serialize all apply-phase work through the global chain. Both
  // the scripted path (uses __recomp_mod_runtime) and the default
  // copy path (writes into a shared dest dir) need this — see
  // `modApplyChain` comment for the rationale.
  //
  // Two-step chain so a rejected install doesn't poison the lane:
  //   - `modApplyChain` is set to the .catch'd promise (always
  //     resolves), so the NEXT install's `.then(...)` always runs.
  //   - The CALLER awaits `myTurn`, which propagates the rejection.
  const myTurn = modApplyChain
    .catch(() => undefined)
    .then(() => applyModInner(game, installed, mod, stagedDir, onEvent));
  modApplyChain = myTurn.catch(() => undefined);
  return myTurn;
}

async function applyModInner(
  game: GameEntry,
  installed: InstalledGame,
  mod: ModEntry,
  stagedDir: string,
  onEvent: EventCallback,
): Promise<void> {
  if (mod.setupModule) {
    await runModSetupScript(game, installed, mod, stagedDir, onEvent);
    return;
  }
  if (mod.installSubdir) {
    await copyIntoInstallSubdir(game, installed.installDir, mod.installSubdir, stagedDir, () => {
      emitStage(onEvent, game.id, `mod:${mod.id}:install`, 50, "Copying files…");
    });
    return;
  }
  throw new Error(
    `Mod "${mod.id}" declares neither setupModule nor installSubdir — invalid manifest`,
  );
}

async function copyIntoInstallSubdir(
  game: GameEntry,
  installDir: string,
  subdir: string,
  stagedDir: string,
  onCopyStart: () => void,
): Promise<void> {
  const dest = resolveModDest(game, installDir, subdir);
  await mkdir(dest, { recursive: true });
  onCopyStart();
  // Node's `cp` with recursive + force covers our case (overwrite
  // colliding files; merge directories). We don't shell out to `cp`
  // here so the path works identically in the spec environment.
  await cp(stagedDir, dest, { recursive: true, force: true });
}

/**
 * Resolve a mod's `installSubdir` to an absolute path. Three shapes
 * supported:
 *
 *   - `"textures/"`         → relative to `installDir` (default —
 *                              most texture-overlay mods)
 *   - `"~/Foo/Bar"`         → expanded against `$HOME` (engines
 *                              that read mods from a per-user data
 *                              dir, e.g. Dusklight's
 *                              `~/.local/share/TwilitRealm/Dusklight/
 *                              texture_replacements`)
 *   - `"/abs/path"`         → already absolute (rare; documented
 *                              for completeness)
 *
 * Security: the resolved path MUST live under `$HOME`. A mod
 * declaring `installSubdir: "/etc"` would otherwise write to
 * system dirs — manifest entries are bundled in the plugin so the
 * threat model is "lazy authoring mistake", not "attacker", but
 * fail-closed anyway.
 */
/**
 * Resolve a mod's `installSubdir` to an absolute path. Four shapes,
 * resolved in order:
 *
 *   `"{userDataDir}/foo/"`  → substitutes `game.userDataDir`, then
 *                              applies the same expansion as a `~/`
 *                              path. Errors if the parent game has
 *                              no `userDataDir` declared.
 *   `"~/Foo"`               → expanded against `$HOME`.
 *   `"/abs/path"`           → already absolute.
 *   `"textures/"`           → relative to the game's install dir.
 *
 * Absolute / tilde-expanded / template-resolved paths MUST land
 * under `$HOME`. Mods are bundled with the plugin so the threat
 * model is "lazy authoring mistake" not "attacker", but fail-closed
 * anyway. Relative paths skip the gate (install dir is the plugin's
 * own writable domain).
 */
// Exported for tests. Internal callers continue to use the same name.
export function resolveModDest(
  game: GameEntry,
  installDir: string,
  subdir: string,
): string {
  // {userDataDir} substitution. The token can appear anywhere in the
  // string but is most often a prefix. Requires the parent
  // GameEntry to declare userDataDir on its manifest.
  let resolved = subdir;
  if (resolved.includes("{userDataDir}")) {
    if (!game.userDataDir) {
      throw new Error(
        `Mod installSubdir "${subdir}" references {userDataDir} but game "${game.id}" doesn't declare one on its manifest.`,
      );
    }
    resolved = resolved.replaceAll("{userDataDir}", game.userDataDir);
  }
  // Relative path: resolve under the plugin's install dir. That dir
  // is the plugin's domain (recomp-hub) — no security gate needed.
  if (!resolved.startsWith("/") && !resolved.startsWith("~/")) {
    return resolvePath(installDir, resolved);
  }
  // Absolute / tilde-expanded path: gate it against $HOME.
  const raw = resolved.startsWith("~/")
    ? resolvePath((process.env.HOME ?? ""), resolved.slice(2))
    : resolvePath(resolved);
  const home = (process.env.HOME ?? "");
  if (!home || (!raw.startsWith(`${home}/`) && raw !== home)) {
    throw new Error(
      `Mod installSubdir "${subdir}" resolves outside $HOME (${raw}). ` +
        `Absolute mod-install paths must live under the user's home directory.`,
    );
  }
  return raw;
}

async function runModSetupScript(
  game: GameEntry,
  installed: InstalledGame,
  mod: ModEntry,
  stagedDir: string,
  onEvent: EventCallback,
): Promise<void> {
  const scriptPath = setupModulePathFor(game.id, mod.id, mod.setupModule!);
  if (!scriptPath) {
    throw new Error(
      `setup.ts not found for mod "${mod.id}" at games/${game.id}/mods/${mod.id}/${mod.setupModule}`,
    );
  }
  const cacheDir = modCacheDir(game.id, mod.id);
  await mkdir(cacheDir, { recursive: true });

  const sdk: ModSDK = buildModSdk(game, installed, mod, stagedDir, cacheDir, onEvent);
  const runtime: InternalModRuntime = { sdk };

  const slot = globalThis as unknown as { __recomp_mod_runtime?: InternalModRuntime };
  const previous = slot.__recomp_mod_runtime;
  slot.__recomp_mod_runtime = runtime;
  try {
    // Cache-bust the dynamic import so two consecutive installs of
    // the same mod re-execute the script (Bun caches modules by URL).
    // Renamed local binding (`setupModule`) to avoid shadowing the
    // outer `mod: ModEntry` parameter.
    const setupModule = await import(`${scriptPath}?recomp_mod_install=${Date.now()}`);
    if (typeof setupModule.install !== "function") {
      throw new Error(
        `Mod setup module at ${scriptPath} doesn't export install(ctx). ` +
          `Add: export async function install(ctx: ModSDK) { … }`,
      );
    }
    await setupModule.install(sdk);
  } finally {
    slot.__recomp_mod_runtime = previous;
  }
}

function buildModSdk(
  game: GameEntry,
  installed: InstalledGame,
  mod: ModEntry,
  stagedDir: string,
  cacheDir: string,
  onEvent: EventCallback,
): ModSDK {
  const defaultStage = `mod:${mod.id}:setup`;
  return {
    mod,
    game,
    installed,
    installDir: installed.installDir,
    stagedDir,
    cacheDir,
    ready: Promise.resolve(),
    run: async (argv, opts) => runForSdk(argv, opts ?? {}, defaultStage, game.id, mod.id, onEvent),
    download: async (url, dest) => {
      await mkdir(dirname(dest), { recursive: true });
      await downloadFile(url, dest, (downloaded, total) => {
        emitStage(
          onEvent,
          game.id,
          `mod:${mod.id}:download`,
          total > 0 ? Math.round((downloaded / total) * 100) : undefined,
        );
      });
    },
    extractArchive: async (archivePath, dest) => {
      await extractArchive(archivePath, dest);
    },
    copy: async (src, dest) => {
      await mkdir(dirname(dest), { recursive: true });
      const s = await stat(src);
      if (s.isDirectory()) {
        await cp(src, dest, { recursive: true, force: true });
      } else {
        await cp(src, dest, { force: true });
      }
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    emit: ({ message, percent, stage }) => {
      onEvent({
        type: "progress",
        gameId: game.id,
        stage: stage ?? defaultStage,
        percent,
        message,
      });
    },
  };
}

async function runForSdk(
  argv: string[],
  opts: ModRunOpts,
  defaultStage: string,
  gameId: string,
  modId: string,
  onEvent: EventCallback,
): Promise<ModRunResult> {
  const stage = opts.stage ?? defaultStage;
  emitStage(onEvent, gameId, stage, undefined, `Running ${argv[0]}…`);
  const r = await runFull(argv, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
  });
  // The script asked for a command; surface a tail of its output
  // through the event stream so the UI shows SOMETHING when the
  // command finishes (the live stdout/stderr isn't piped here).
  const tail = (r.stdout || r.stderr).split("\n").slice(-3).join(" ").slice(0, 200);
  if (tail) {
    onEvent({ type: "progress", gameId, stage, message: tail });
  }
  void modId;
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Fetch one GitHub release. `tag` undefined → /releases/latest;
 * explicit tag → /releases/tags/<tag>. Throws on non-200 so the
 * caller can surface the message to the user (e.g. "release v9.9.9
 * not found").
 */
async function fetchRelease(repo: string, tag: string | undefined): Promise<GitHubRelease> {
  const path = tag
    ? `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    : `/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = {
    "User-Agent": "SteamLoader-RecompPlugin/0.1.0",
    Accept: "application/vnd.github+json",
  };
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    // Distinguish pinned-tag misses from "latest" misses so the user
    // can act: a pinned tag that 404s usually means the upstream
    // renamed or deleted the release and the manifest needs a bump.
    if (tag && res.status === 404) {
      throw new Error(
        `GitHub release "${tag}" not found on ${repo} — the mod's pinned tag may have been renamed or deleted upstream. Check the latest release at https://github.com/${repo}/releases.`,
      );
    }
    if (res.status === 404) {
      throw new Error(
        `GitHub repo ${repo} has no releases yet (or doesn't exist). Verify the repo path on https://github.com/${repo}.`,
      );
    }
    if (res.status === 403 || res.status === 429) {
      throw new Error(
        `GitHub release lookup rate-limited (HTTP ${res.status}) for ${repo}. Wait a few minutes and try again, or configure a GitHub token in the loader.`,
      );
    }
    throw new Error(`GitHub release lookup failed: HTTP ${res.status} for ${repo}`);
  }
  return (await res.json()) as GitHubRelease;
}

function pickAsset(assets: GitHubAsset[], pattern: string): GitHubAsset | null {
  for (const asset of assets) {
    if (globMatches(pattern, asset.name)) return asset;
  }
  return null;
}

function extractVersionFromArchive(archivePath: string): string | undefined {
  // Filenames frequently embed a version like `Mod-1.2.3.zip`.
  // Pull the first `vX.Y.Z` / `X.Y.Z` we find as best-effort
  // metadata — used purely for the UI's "Installed (v1.2.3)" label.
  const match = basename(archivePath).match(/v?(\d+(?:\.\d+){1,3})/);
  return match ? match[1] : undefined;
}

/** Discover any mod-side leftovers in temp on startup so the next
 *  install starts clean. Caller (backend onLoad) fires-and-forgets. */
export async function pruneStaleModStaging(): Promise<void> {
  const root = join(tempDir(), "mods");
  if (!existsSync(root)) return;
  try {
    const entries = await readdir(root);
    await Promise.all(
      entries.map((entry) =>
        rm(join(root, entry), { recursive: true, force: true }).catch(() => {}),
      ),
    );
  } catch {
    // best-effort
  }
}
