/**
 * Recomp Mod SDK — the API per-mod `setup.ts` scripts import to drive
 * a mod install. Same shape as the per-game SDK in `./index.ts`
 * (globalThis-bound runtime, methods proxy through), just scoped to
 * mod operations.
 *
 * Implementation: the host (`lib/mods.ts`) builds a runtime bound to
 * the install context, assigns it to `globalThis.__recomp_mod_runtime`,
 * dynamic-imports the setup script, then clears the slot. Each method
 * on the proxy below reads the live runtime and forwards.
 *
 * Recipes are trusted code we ship in the plugin bundle, so
 * process-level isolation isn't needed.
 */

import type { GameEntry, ModEntry, InstalledGame, PipelineEvent } from "../types";

export interface ModRunOpts {
  cwd?: string;
  /** Pipeline stage to report progress under. Defaults to
   *  `mod:<modId>:setup` so the UI's per-mod progress bar lights up
   *  during long scripts. */
  stage?: string;
  /** Hard ceiling on the command's run time. Defaults to 10min. */
  timeoutMs?: number;
}

export interface ModRunResult {
  exitCode: number;
  /** Captured stdout (first ~1 MB), for scripts that need to parse a
   *  tool's output. Live progress lines flow through `emit` as they
   *  arrive — this is the post-completion blob. */
  stdout: string;
  stderr: string;
}

export interface ModSDK {
  /** The mod entry being installed (id, source, externalUrl, etc.). */
  readonly mod: ModEntry;
  /** The game this mod is being installed onto. */
  readonly game: GameEntry;
  /** Snapshot of the base game's install record at the moment the
   *  pipeline started. Setup scripts use `installed.installDir` to
   *  resolve target paths. */
  readonly installed: InstalledGame;
  /** Game's install dir on disk — the root the script writes into. */
  readonly installDir: string;
  /** Staged extraction dir for github-release / direct-url. For
   *  manual-import the caller hands a pre-extracted dir here. The
   *  script `cp`s / `mv`s files OUT of this into `installDir`. */
  readonly stagedDir: string;
  /** Per-mod cache dir under `~/.cache/steam-loader/recomp/mods/<gameId>/<modId>/`.
   *  Survives across runs; safe place for scripts to checkpoint a
   *  partial download or memoise a network probe. */
  readonly cacheDir: string;

  /** Run a shell command. Resolves regardless of exit code; the
   *  script is responsible for checking `exitCode`. Use this rather
   *  than spawning Bun.spawn directly so progress lines reach the UI. */
  run(argv: string[], opts?: ModRunOpts): Promise<ModRunResult>;

  /** Download a URL to `dest`. Reports progress through `emit`
   *  automatically (stage = `mod:<modId>:download`). */
  download(url: string, dest: string): Promise<void>;

  /** Extract `archivePath` into `dest`. Reuses recomp's
   *  `extractArchive` (`lib/pipeline-archive.ts`) — supports
   *  zip/tar/tar.gz/appimage, 3-level nested unpack. */
  extractArchive(archivePath: string, dest: string): Promise<void>;

  /** Recursive copy `src` → `dest`. Creates parents. Equivalent to
   *  `cp -r src dest` (with overwrite). */
  copy(src: string, dest: string): Promise<void>;

  /** Recursive mkdir. */
  mkdir(path: string): Promise<void>;

  /** Free-form progress message routed into the pipeline event
   *  stream. Stage defaults to `mod:<modId>:setup`; pass a more
   *  specific one for multi-phase scripts (e.g.
   *  `mod:<modId>:patch-config`). Percent is optional (omit for
   *  indeterminate operations — the UI just shows a moving bar). */
  emit(progress: { message?: string; percent?: number; stage?: string }): void;

  /** Resolves once the runtime is bound. Always already-resolved by
   *  the time the script's top-level code runs (in-process dispatcher),
   *  but scripts are encouraged to `await sdk.ready` first as
   *  future-proofing for a Worker / spawn-based runtime. */
  readonly ready: Promise<void>;
}

/**
 * What a mod's `setup.ts` exports. The pipeline dynamic-imports the
 * module and invokes `install(ctx)`. Throwing aborts the install and
 * reports the error to the UI; the install state is NOT written.
 *
 * The SDK is imported separately by the script (via
 * `import { modSdk } from "../../../lib/sdk/mod"` or similar). The
 * `ctx` param is the same object the proxy reads from — convenient
 * for scripts that want both the SDK getters AND access to e.g.
 * `ctx.installed.steamAppId` without going through the proxy.
 */
export interface ModSetupModule {
  install(ctx: ModSDK): Promise<void>;
}

// Internal contract shared with `lib/mods.ts`. The host installs one
// of these on `globalThis.__recomp_mod_runtime` for the duration of a
// single mod install.
export interface ModRuntime {
  readonly sdk: ModSDK;
}

// ── Proxy that reads the live runtime ────────────────────────────────

function runtime(): ModRuntime {
  const slot = globalThis as unknown as { __recomp_mod_runtime?: ModRuntime };
  if (!slot.__recomp_mod_runtime) {
    throw new Error(
      "@recomp/sdk/mod: no recomp mod runtime bound. Mod setup.ts files " +
        "must be invoked by the recomp mod-installer (plugins/recomp/lib/mods.ts), " +
        "not run standalone.",
    );
  }
  return slot.__recomp_mod_runtime;
}

/** The public proxy. Mods import this and call its methods; the
 *  getters/methods route to whatever runtime the host has bound. */
export const modSdk: ModSDK = {
  get mod() { return runtime().sdk.mod; },
  get game() { return runtime().sdk.game; },
  get installed() { return runtime().sdk.installed; },
  get installDir() { return runtime().sdk.installDir; },
  get stagedDir() { return runtime().sdk.stagedDir; },
  get cacheDir() { return runtime().sdk.cacheDir; },
  get ready() { return runtime().sdk.ready; },
  run: (argv, opts) => runtime().sdk.run(argv, opts),
  download: (url, dest) => runtime().sdk.download(url, dest),
  extractArchive: (archivePath, dest) => runtime().sdk.extractArchive(archivePath, dest),
  copy: (src, dest) => runtime().sdk.copy(src, dest),
  mkdir: (path) => runtime().sdk.mkdir(path),
  emit: (progress) => runtime().sdk.emit(progress),
};

// Re-export so `lib/mods.ts` can drop the runtime into the global
// slot without re-typing the shape.
export type { ModRuntime as InternalModRuntime };

// Re-export the event type for consumers that want to plumb stages
// through their own helpers.
export type { PipelineEvent };
