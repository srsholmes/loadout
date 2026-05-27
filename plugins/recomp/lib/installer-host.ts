import { mkdir, rm, copyFile, readdir, rename, stat, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  detectBuildEnv,
  ensureRecompContainer,
  RECOMP_CONTAINER,
  type BuildEnv,
} from "./build-env";
import { shellQuote } from "./shell";
import { downloadFile, extractArchive } from "./pipeline-archive";
import { tempDir, type PlatformName } from "./platform";
import type { PipelineEvent } from "./types";
import type { RecompSDK, RecompEnv, Platform } from "./sdk";

type EventCallback = (event: PipelineEvent) => void;

export interface SetupContext {
  gameId: string;
  installDir: string;
  romPath?: string;
  platform: PlatformName;
}

export interface SetupResult {
  /** Path relative to installDir, declared by the recipe via
   *  `sdk.declareOutput()`. Required — install fails otherwise. */
  outputBinary: string;
  /** Override launch command from `sdk.declareLaunchCommand()`.
   *  When absent, the host constructs `{installDir}/${outputBinary}`. */
  launchCommand?: string;
  /** Version reported via `sdk.reportVersion()` or fallback. */
  version?: string;
  /** Target platform of the produced binary, declared via
   *  `sdk.declarePlatform()`. `"windows"` flags a cross-compiled
   *  `.exe` — pipeline uses this to set `installedPlatform` so the
   *  Steam shortcut gets Proton wired up. Defaults to the host
   *  platform when the recipe doesn't declare. */
  targetPlatform?: "linux" | "windows" | "macos";
}

/**
 * Module-level serialization gate for `runSetupScript`.
 *
 * The SDK reads its install context from `globalThis.__recomp_runtime`,
 * a single slot. The backend's `operations: Set<string>` blocks
 * re-entry on the same gameId but DOES NOT prevent two different
 * games from installing concurrently — at which point install B
 * overwrites the global slot mid-install of A, and A's subsequent
 * `sdk.placeRom()` etc. read B's runtime, copying A's ROM into B's
 * installDir.
 *
 * Cheapest correct fix: chain `runSetupScript` calls behind a single
 * Promise, so the global slot is held for the duration of exactly one
 * install at any moment. Installs queue rather than running in
 * parallel. This is fine in practice: build_from_source recipes are
 * heavily CPU-bound (cross-compile, vkd3d-proton build) and running
 * two on the same box at once would already thrash; prebuilt installs
 * are I/O-bound and short. Users very rarely click Install twice in a
 * row before the first finishes, but when they do we now serialize
 * silently instead of corrupting state.
 *
 * Alternative considered: drop the global slot, have recipes export
 * a default async function that takes `sdk` as a parameter. That's
 * the right long-term design but a meaningful breaking change to
 * every recipe; doing it as a follow-up.
 */
let installChain: Promise<unknown> = Promise.resolve();

/**
 * Run a per-game `setup.ts` recipe and bridge its `@recomp/sdk`
 * calls into the host's BuildEnv.
 *
 * Implementation note: we dynamic-import the recipe rather than
 * spawning it as a child process. Reasons:
 *   - The loadout server is a `--compile`d Bun binary, so
 *     `process.execPath` isn't a reusable runtime — we'd need
 *     `bun` on the user's PATH for `Bun.spawn(["bun", "run", ...])`,
 *     which we can't guarantee on Bazzite/SteamOS.
 *   - Dynamic import keeps the SDK module in the same process,
 *     letting requests be plain function calls instead of IPC.
 *   - Recipes are trusted code we ship in the plugin bundle; they
 *     don't need process-level isolation.
 *
 * The SDK module reads its install context + dispatcher from a
 * `globalThis.__recomp_runtime` slot we install before the import
 * starts; see `lib/sdk/index.ts` for the consumer side.
 *
 * Cache-busting via `?t=<now>` so two consecutive installs of the
 * same game both run their setup.ts top-to-bottom (otherwise the
 * second import would be a no-op against the cached module).
 */
export async function runSetupScript(
  scriptPath: string,
  ctx: SetupContext,
  onEvent: EventCallback,
): Promise<SetupResult> {
  // Chain behind any in-flight install. We always await the previous
  // chain link (even if it rejected) — installs are independent, one
  // failing shouldn't poison the queue.
  const myTurn = installChain.catch(() => undefined).then(() =>
    runSetupScriptInner(scriptPath, ctx, onEvent),
  );
  installChain = myTurn;
  return myTurn;
}

async function runSetupScriptInner(
  scriptPath: string,
  ctx: SetupContext,
  onEvent: EventCallback,
): Promise<SetupResult> {
  if (!existsSync(scriptPath)) {
    throw new Error(`setup.ts not found at ${scriptPath}`);
  }

  // Phase A: provision the env + container so the recipe's first
  // SDK call doesn't surprise the user with a 60s image pull.
  onEvent({
    type: "progress",
    gameId: ctx.gameId,
    stage: "provisioning",
    message: "Detecting build environment…",
  });
  const env = await detectBuildEnv();
  onEvent({
    type: "progress",
    gameId: ctx.gameId,
    stage: "provisioning",
    message: `Build env: ${env.label}`,
  });
  await ensureRecompContainer((line) => {
    onEvent({
      type: "progress",
      gameId: ctx.gameId,
      stage: "provisioning",
      message: line.slice(0, 200),
    });
  });

  // Phase B: ensure installDir exists.
  await mkdir(ctx.installDir, { recursive: true });

  // Phase C: install runtime → import recipe.
  const acc: SetupAccumulator = {};
  const runtime = buildRuntime(ctx, env, acc, onEvent);

  const slot = globalThis as unknown as {
    __recomp_runtime?: RecompRuntime;
  };
  const previous = slot.__recomp_runtime;
  slot.__recomp_runtime = runtime;
  try {
    // Cache-bust the dynamic import. Bun caches modules by URL so
    // a second install attempt against the same `scriptPath`
    // wouldn't re-execute the recipe's top-level code — meaning
    // the next `declareOutput()` notification would never fire and
    // the install would error with "Recipe did not call
    // declareOutput()". The query-string suffix gives Bun a fresh
    // cache key per attempt. Recipes don't need to be aware.
    //
    // Earlier this broke `@recomp/sdk` tsconfig path resolution;
    // we've since switched recipes to relative imports so this
    // works again.
    await import(`${scriptPath}?recomp_install=${Date.now()}`);
  } finally {
    slot.__recomp_runtime = previous;
  }

  if (!acc.outputBinary) {
    throw new Error(
      `Recipe did not call sdk.declareOutput() — recomp doesn't know which ` +
        `binary to launch. Add a declareOutput("path/to/binary") call before ` +
        `the script exits.`,
    );
  }

  // Phase D: verify the declared binary exists, chmod +x.
  const fullBin = join(ctx.installDir, acc.outputBinary);
  if (!existsSync(fullBin)) {
    throw new Error(
      `Recipe declared output ${acc.outputBinary} but it doesn't exist ` +
        `at ${fullBin}. Build may have failed silently.`,
    );
  }
  try {
    await chmod(fullBin, 0o755);
  } catch {
    // best-effort; some filesystems don't support exec bit
  }

  // Phase E: generate a launch wrapper. The built binary is linked
  // against the distrobox container's glibc/SDL2/etc., which are
  // typically NEWER than the host's (Bazzite host glibc 2.42 vs
  // Fedora-44 container glibc 2.43 → "version GLIBC_2.43 not found"
  // when Steam tries to launch the raw ELF). The wrapper re-enters
  // the container at launch time so the binary sees the same libs
  // it was linked against. Steam's shortcut Exe field invokes the
  // wrapper directly; arguments and environment pass through.
  //
  // Skipped when:
  //   - the recipe explicitly declared its own launchCommand
  //     (custom entrypoint takes priority), OR
  //   - the recipe declared targetPlatform === "windows" (a .exe
  //     run via Proton inside Steam — wrapping it in `distrobox
  //     enter` would just confuse Wine).
  const isWindowsTarget = acc.targetPlatform === "windows";
  if (!acc.launchCommand && !isWindowsTarget) {
    const wrapperPath = await writeLaunchWrapper(ctx.installDir, fullBin);
    acc.launchCommand = wrapperPath;
  } else if (isWindowsTarget && !acc.launchCommand) {
    // Windows binary, no custom launch command — point Steam at the
    // .exe directly. Proton handles wineprefix + vkd3d-proton.
    acc.launchCommand = fullBin;
  }

  return {
    outputBinary: acc.outputBinary,
    launchCommand: acc.launchCommand,
    version: acc.version,
    targetPlatform: acc.targetPlatform,
  };
}

/**
 * Write `<installDir>/recomp-launch.sh` that re-enters the recomp
 * distrobox to invoke `binaryAbsPath` so the binary's container-
 * linked libs (glibc, SDL, GLEW…) are in scope at launch time.
 *
 * Returns the absolute path to the wrapper, suitable for a Steam
 * shortcut's Exe field. Idempotent (overwrites any prior wrapper).
 */
async function writeLaunchWrapper(
  installDir: string,
  binaryAbsPath: string,
): Promise<string> {
  const wrapperPath = join(installDir, "recomp-launch.sh");
  const script =
    `#!/usr/bin/env bash\n` +
    `# Generated by recomp installer-host. Runs the build_from_source\n` +
    `# binary inside the ${RECOMP_CONTAINER} distrobox so the container's\n` +
    `# glibc/SDL/etc. are in scope at launch time.\n` +
    `exec distrobox enter ${RECOMP_CONTAINER} -- ${shellQuote(binaryAbsPath)} "$@"\n`;
  await writeFile(wrapperPath, script);
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

// ── Runtime exposed to the SDK ───────────────────────────────────────

interface SetupAccumulator {
  outputBinary?: string;
  launchCommand?: string;
  version?: string;
  targetPlatform?: "linux" | "windows" | "macos";
}

/**
 * Public-but-internal contract between `lib/sdk/index.ts` and the
 * installer-host. `globalThis.__recomp_runtime` is set to one of
 * these for the duration of an install; the SDK module's getters /
 * methods route through it.
 */
export interface RecompRuntime {
  readonly sdk: RecompSDK;
}

function buildRuntime(
  ctx: SetupContext,
  env: BuildEnv,
  acc: SetupAccumulator,
  onEvent: EventCallback,
): RecompRuntime {
  const platform: Platform =
    ctx.platform === "windows" ? "windows" : ctx.platform === "macos" ? "macos" : "linux";

  const recordLine = (line: string, stage: string) => {
    onEvent({
      type: "progress",
      gameId: ctx.gameId,
      stage,
      message: line.slice(0, 200),
    });
  };

  const sdkEnv: RecompEnv = {
    kind: env.kind,
    label: env.label,
    ensurePackages: async (pkgs) => {
      const r = await env.installPackages(pkgs, (line) =>
        recordLine(line, "installing-deps"),
      );
      if (r.exitCode !== 0) {
        throw new Error(
          `Package install failed (exit ${r.exitCode}) for ${pkgs.join(" ")}`,
        );
      }
    },
    has: (cmd) => env.has(cmd),
    run: async (command, opts = {}) => {
      const cwd = opts.cwd ?? ctx.installDir;
      const stage = opts.stage ?? "building";
      const r = await env.run(command, cwd, {
        onLine: (line) => recordLine(line, stage),
        timeoutMs: opts.timeoutMs ?? 60 * 60 * 1000,
      });
      if (r.exitCode !== 0) {
        throw new Error(`Command failed (exit ${r.exitCode}): ${command}`);
      }
    },
  };

  const sdk: RecompSDK = {
    installDir: ctx.installDir,
    romPath: ctx.romPath,
    platform,
    id: ctx.gameId,
    env: sdkEnv,
    ready: Promise.resolve(),
    cloneFromGitHub: async (repo, branch = "master") => {
      await cloneFromGitHub(repo, branch, ctx.installDir, (downloaded, total) => {
        recordLine(
          `Downloading ${repo}@${branch}… ${(downloaded / 1_048_576).toFixed(1)} MB${
            total > 0 ? ` / ${(total / 1_048_576).toFixed(1)} MB` : ""
          }`,
          "extracting",
        );
      });
    },
    placeRom: async (destRel) => {
      if (!ctx.romPath) {
        throw new Error("placeRom() called but no ROM was provided");
      }
      if (!existsSync(ctx.romPath)) {
        throw new Error(`ROM file not found: ${ctx.romPath}`);
      }
      const dest = join(ctx.installDir, destRel);
      await mkdir(join(dest, ".."), { recursive: true });
      await copyFile(ctx.romPath, dest);
    },
    declareOutput: (binRelPath) => {
      acc.outputBinary = binRelPath;
    },
    declareLaunchCommand: (cmd) => {
      acc.launchCommand = cmd;
    },
    declarePlatform: (p) => {
      acc.targetPlatform = p;
    },
    reportVersion: (version) => {
      acc.version = version;
    },
    progress: (message, percent) => {
      onEvent({
        type: "progress",
        gameId: ctx.gameId,
        message,
        percent,
      });
    },
    writeLauncher: async ({
      exe,
      args = [],
      env: extraEnv = {},
      enterContainer = true,
      filename = "launcher.sh",
    }) => {
      const exeAbs = exe.startsWith("/") ? exe : join(ctx.installDir, exe);
      const argsQuoted = args.map(shellQuote).join(" ");
      const envPrefix = Object.entries(extraEnv)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ");
      // distrobox enter inherits its working dir from the caller — we
      // chdir to the exe's directory first so the binary can find
      // sibling assets (mods/, res/, OTR archives, etc.) via relative
      // lookups, which most recomp ports do.
      const exeDir = dirname(exeAbs);
      const enterPrefix = enterContainer
        ? `exec distrobox enter ${RECOMP_CONTAINER} -- env ${envPrefix} bash -c ${shellQuote(
            `cd ${shellQuote(exeDir)} && exec ${shellQuote(exeAbs)} ${argsQuoted} "$@"`,
          )} -- "$@"`
        : `exec env ${envPrefix} bash -c ${shellQuote(
            `cd ${shellQuote(exeDir)} && exec ${shellQuote(exeAbs)} ${argsQuoted} "$@"`,
          )} -- "$@"`;
      const script =
        `#!/usr/bin/env bash\n` +
        `# Generated by recomp sdk.writeLauncher.\n` +
        enterPrefix +
        `\n`;
      const launcherPath = join(ctx.installDir, filename);
      await writeFile(launcherPath, script);
      await chmod(launcherPath, 0o755);
      return launcherPath;
    },
  };

  return { sdk };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Tarball-clone with no `git` dep. GitHub serves
 * `https://github.com/<repo>/archive/refs/heads/<branch>.tar.gz`;
 * extracted layout is `<repo>-<branch>/<contents>`, which we
 * flatten into `dest`.
 */
async function cloneFromGitHub(
  repo: string,
  branch: string,
  dest: string,
  onProgress: (downloaded: number, total: number) => void,
): Promise<void> {
  const tarball = `https://github.com/${repo}/archive/refs/heads/${branch}.tar.gz`;
  const tmpRoot = join(tempDir(), `clone-${Date.now()}`);
  await mkdir(tmpRoot, { recursive: true });
  const tarPath = join(tmpRoot, "src.tar.gz");
  try {
    await downloadFile(tarball, tarPath, onProgress);
    const stagingDir = join(tmpRoot, "staging");
    await mkdir(stagingDir, { recursive: true });
    await extractArchive(tarPath, stagingDir);
    const entries = await readdir(stagingDir);
    let sourceRoot = stagingDir;
    if (entries.length === 1) {
      const onlyEntry = join(stagingDir, entries[0]!);
      const stats = await stat(onlyEntry);
      if (stats.isDirectory()) sourceRoot = onlyEntry;
    }
    // Move contents into dest (which already exists). Don't wipe
    // dest — the recipe may have called placeRom first. Overwrite
    // collisions: the tarball wins (recipe controls call order).
    for (const name of await readdir(sourceRoot)) {
      const target = join(dest, name);
      if (existsSync(target)) {
        await rm(target, { recursive: true, force: true });
      }
      await rename(join(sourceRoot, name), target);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}
