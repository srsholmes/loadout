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
import { chownInstallDirToUser } from "./fs-owner";
import type { PipelineEvent } from "./types";
import type { RecompSDK, RecompEnv, Platform, RecompRuntime } from "./sdk";

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
  targetPlatform?: "linux" | "windows";
}

/**
 * Run a per-game `setup.ts` recipe and bridge its `@recomp/sdk`
 * calls into the host's BuildEnv.
 *
 * Implementation note: we dynamic-import the recipe rather than
 * spawning it as a child process. Reasons:
 *   - The steam-loader server is a `--compile`d Bun binary, so
 *     `process.execPath` isn't a reusable runtime — we'd need
 *     `bun` on the user's PATH for `Bun.spawn(["bun", "run", ...])`,
 *     which we can't guarantee on Bazzite/SteamOS.
 *   - Dynamic import keeps the SDK module in the same process,
 *     letting requests be plain function calls instead of IPC.
 *   - Recipes are trusted code we ship in the plugin bundle; they
 *     don't need process-level isolation.
 *
 * The SDK module reads its install context + dispatcher from a single
 * `globalThis.__recomp_runtime` slot we install before the import
 * starts; see `lib/sdk/index.ts` for the consumer side.
 *
 * CONCURRENCY: that slot is process-wide, so two installs of DIFFERENT
 * games must not run at once — install B would overwrite the slot while
 * A is parked on an await, and A's resumed `sdk.placeRom()` would read
 * B's runtime and copy A's ROM into B's installDir. The backend's
 * per-gameId `operations` set does NOT prevent this (it only blocks
 * re-entry on the SAME game).
 *
 * We serialize ALL installs behind `installChain` (see
 * `runSetupScript`) so exactly one install owns the slot at any moment.
 *
 * Why a global lock rather than a per-install context: the obvious
 * "thread the runtime per-install via AsyncLocalStorage" approach does
 * NOT work under Bun, because Bun runs a dynamically-`import()`ed
 * module's top-level code on a FRESH async context — the ALS store set
 * around the `await import(...)` is not visible inside the recipe's
 * top-level `await sdk.placeRom()` (verified empirically). And recipes
 * are written as top-level scripts (`await sdk.ready; …`), not as an
 * exported `default (sdk) => {}`, so we can't pass the context as a
 * parameter without a breaking change to every shipped recipe. The
 * global lock is the correct, non-invasive fix; build_from_source
 * recipes are CPU-bound and prebuilt installs are short, so serializing
 * costs little in practice. Converting recipes to take `sdk` as a
 * parameter (enabling true parallel installs) is a future follow-up.
 *
 * Cache-busting via `?t=<now>` so two consecutive installs of the
 * same game both run their setup.ts top-to-bottom (otherwise the
 * second import would be a no-op against the cached module).
 */
let installChain: Promise<unknown> = Promise.resolve();

export async function runSetupScript(
  scriptPath: string,
  ctx: SetupContext,
  onEvent: EventCallback,
): Promise<SetupResult> {
  // Chain behind any in-flight install (regardless of gameId) so the
  // shared runtime slot is held by exactly one install at a time. We
  // always await the previous link even if it rejected — installs are
  // independent; one failing must not poison the queue.
  const myTurn = installChain
    .catch(() => undefined)
    .then(() => runSetupScriptInner(scriptPath, ctx, onEvent));
  installChain = myTurn.catch(() => undefined);
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
  // The (root) backend just created installDir, but the build runs AS
  // the user (distrobox/podman are rootless — see build-env). A
  // root-owned install dir means the build's first write fails with
  // "Permission denied". Hand ownership to the target user.
  await chownInstallDirToUser(ctx.installDir);

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
    `# Strip Steam's LD_PRELOAD (gameoverlayrenderer.so → needs host\n` +
    `# libGL.so.1) / LD_LIBRARY_PATH BEFORE entering — they break every\n` +
    `# binary inside the container. \`env\` runs on the host (which has\n` +
    `# libGL) so the strip itself is safe.\n` +
    `exec env -u LD_PRELOAD -u LD_LIBRARY_PATH distrobox enter ${RECOMP_CONTAINER} -- ${shellQuote(binaryAbsPath)} "$@"\n`;
  await writeFile(wrapperPath, script);
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

// ── Runtime exposed to the SDK ───────────────────────────────────────

interface SetupAccumulator {
  outputBinary?: string;
  launchCommand?: string;
  version?: string;
  targetPlatform?: "linux" | "windows";
}

function buildRuntime(
  ctx: SetupContext,
  env: BuildEnv,
  acc: SetupAccumulator,
  onEvent: EventCallback,
): RecompRuntime {
  const platform: Platform = ctx.platform === "windows" ? "windows" : "linux";

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
      const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;
      const r = await env.run(command, cwd, {
        onLine: (line) => recordLine(line, stage),
        timeoutMs,
      });
      if (r.exitCode !== 0) {
        // exitCode -1 is the exec layer's timeout sentinel (the process
        // was killed for exceeding `timeoutMs`). Make a build timeout
        // read distinctly from a build that ran and failed — the
        // broken-container case is recovered upstream in
        // ensureRecompContainer, so a -1 here means the build itself hung.
        if (r.exitCode === -1) {
          throw new Error(
            `Build step timed out after ${Math.round(timeoutMs / 60000)} min ` +
              `(the build hung, not a container/setup problem): ${command}`,
          );
        }
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
      // This download+extract runs in the (root) backend, so the cloned
      // tree is root-owned. The build runs AS the user, so hand the whole
      // tree over or the build can't write its outputs into the source
      // subdirs ("Permission denied" on e.g. tools/audiofile/*.o).
      await chownInstallDirToUser(ctx.installDir);
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
      // Copied by the (root) backend → hand to the user so the build can
      // read/overwrite it.
      await chownInstallDirToUser(ctx.installDir);
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
        ? // Strip Steam's LD_PRELOAD/LD_LIBRARY_PATH on the host before
          // entering — gameoverlayrenderer.so needs host libGL.so.1 the
          // container lacks, which otherwise breaks every binary inside.
          `exec env -u LD_PRELOAD -u LD_LIBRARY_PATH distrobox enter ${RECOMP_CONTAINER} -- env ${envPrefix} bash -c ${shellQuote(
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
