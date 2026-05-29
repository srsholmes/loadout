/**
 * Recomp SDK — the API per-game `setup.ts` scripts import from
 * `@recomp/sdk` to drive an install.
 *
 * Implementation: this module returns whatever `RecompRuntime` the
 * recomp host installed at `globalThis.__recomp_runtime` before
 * importing the recipe. Each install call:
 *   1. The host (`lib/installer-host.ts`) builds a runtime bound to
 *      the install context (installDir, romPath, env), assigns it
 *      to `globalThis.__recomp_runtime`.
 *   2. The host dynamic-imports the recipe (`setup.ts`).
 *   3. The recipe imports `@recomp/sdk` and calls e.g.
 *      `await sdk.env.run(...)`. Each method on the proxy below
 *      reads the live runtime and forwards.
 *   4. After the recipe's top-level await chain resolves, the host
 *      reads the recipe's declarations from the runtime accumulator
 *      and clears the global slot.
 *
 * This sidesteps Bun.spawn entirely — the steam-loader server is a
 * `--compile`d Bun binary, so spawning a child Bun process would
 * require `bun` to be installed on the host's PATH, which we can't
 * guarantee on Bazzite/SteamOS. Recipes are trusted code we ship in
 * the plugin bundle, so process-level isolation isn't needed.
 */

export type Platform = "linux" | "windows" | "macos";

export interface RecompEnv {
  readonly kind: "distrobox";
  readonly label: string;
  /** Install Fedora packages inside the env. Idempotent. */
  ensurePackages(pkgs: string[]): Promise<void>;
  /** Probe whether `cmd` is on PATH inside the env. */
  has(cmd: string): Promise<boolean>;
  /** Run a shell command inside the env. Stdout/stderr stream
   *  to the UI as `pipelineEvent` messages (stage defaults to
   *  `"building"`). Resolves on exit 0; rejects with the command
   *  + exit code on non-zero. */
  run(
    command: string,
    opts?: {
      cwd?: string;
      stage?: string;
      timeoutMs?: number;
    },
  ): Promise<void>;
}

export interface RecompSDK {
  /** Absolute path the recipe should install into. Created by the
   *  host before the script starts. */
  readonly installDir: string;
  /** Absolute path to the user-picked ROM, when the manifest
   *  declared `requiresRom: true`. Otherwise undefined. */
  readonly romPath?: string;
  /** Effective build platform — currently always "linux"; the
   *  field is here so future Windows-via-Wine recipes can branch. */
  readonly platform: Platform;
  /** The game id from the manifest. */
  readonly id: string;
  readonly env: RecompEnv;

  /** Download `https://github.com/<repo>/archive/<branch>.tar.gz`,
   *  extract into `installDir`, flatten the `<repo>-<branch>/`
   *  wrapper. No `git` dependency. Branch defaults to "master". */
  cloneFromGitHub(repo: string, branch?: string): Promise<void>;

  /** Copy the user's ROM (must be `sdk.romPath`) into
   *  `<installDir>/<destRel>`. Throws if no romPath or if the
   *  source is missing/unreadable. */
  placeRom(destRel: string): Promise<void>;

  /** Tell the host where the built binary ended up, relative to
   *  `installDir`. Required — install fails if not called. */
  declareOutput(binRelPath: string): void;

  /** Override the launch command the host registers with Steam.
   *  Use the literal `{installDir}` token if you need to embed the
   *  install path. Defaults to `{installDir}/<declareOutput value>`. */
  declareLaunchCommand(cmd: string): void;

  /** Declare what platform the produced binary targets. Defaults to
   *  the host platform (`"linux"` on Linux). Set to `"windows"` for
   *  recipes that cross-compile a `.exe`: the host then registers
   *  the Steam shortcut with Proton as the compat tool AND skips
   *  the distrobox launch wrapper (Proton invokes the exe directly,
   *  not via `distrobox enter`). Mainly for RT64 / D3D12 ports. */
  declarePlatform(platform: Platform): void;

  /** Tell the host the resolved upstream version (commit sha,
   *  release tag, or branch name + date). Used for the "Update
   *  available" check on the next poll. */
  reportVersion(version: string): void;

  /** Free-form progress message for the UI between long ops. */
  progress(message: string, percent?: number): void;

  /**
   * Write a launcher shell script at `<installDir>/<filename>`,
   * return its absolute path. By default wraps the exec in
   * `distrobox enter recomp-build -- env <env> bash -c 'cd <exeDir>
   * && exec <exe> <args> "$@"'` so binaries linked against the
   * container's libs (glibc, SDL, etc.) find them at launch time,
   * and the binary's working dir is its own directory so relative
   * asset lookups work.
   *
   * Each recipe still hand-writes its own launcher config — exe,
   * args, env vars are recipe-specific. This helper exists only so
   * recipes don't have to spell out the heredoc + shell-quoting +
   * `\\$@` escape boilerplate one more time. Use the in-recipe
   * heredoc instead if you need something the surface doesn't cover.
   */
  writeLauncher(opts: {
    /** Path relative to `installDir` (or absolute) of the binary
     *  the launcher should exec. */
    exe: string;
    /** Extra args appended after the binary. The user-supplied
     *  `"$@"` is always appended last so Steam's launch-options
     *  flow through. */
    args?: ReadonlyArray<string>;
    /** Env vars prepended to the exec line. Values are shell-quoted. */
    env?: Readonly<Record<string, string>>;
    /** Wrap in `distrobox enter recomp-build --`. Defaults to true.
     *  Set false for cross-compiled Windows .exe's that Proton
     *  manages outside the container. */
    enterContainer?: boolean;
    /** Filename relative to installDir. Defaults to `launcher.sh`. */
    filename?: string;
  }): Promise<string>;

  /** Resolves once the runtime is bound. With the current in-process
   *  dispatcher this is always already-resolved by the time the
   *  recipe's top-level code runs, but recipes are encouraged to
   *  `await sdk.ready` first as future-proofing for a Worker /
   *  spawn-based runtime. */
  readonly ready: Promise<void>;
}

// Internal contract shared with `lib/installer-host.ts` — the host
// installs one of these on `globalThis.__recomp_runtime`. Imported
// (type-only) by the host so the two stay in sync.
export interface RecompRuntime {
  readonly sdk: RecompSDK;
}

// ── Proxy that reads the live runtime ────────────────────────────────

function runtime(): RecompRuntime {
  const slot = globalThis as unknown as { __recomp_runtime?: RecompRuntime };
  if (!slot.__recomp_runtime) {
    throw new Error(
      "@recomp/sdk: no recomp runtime bound. Recipes must be invoked by " +
        "the recomp installer-host (plugins/recomp/lib/installer-host.ts), " +
        "not run standalone.",
    );
  }
  return slot.__recomp_runtime;
}

const env: RecompEnv = {
  get kind(): "distrobox" {
    return runtime().sdk.env.kind;
  },
  get label(): string {
    return runtime().sdk.env.label;
  },
  ensurePackages: (pkgs) => runtime().sdk.env.ensurePackages(pkgs),
  has: (cmd) => runtime().sdk.env.has(cmd),
  run: (command, opts) => runtime().sdk.env.run(command, opts),
};

export const sdk: RecompSDK = {
  get installDir(): string {
    return runtime().sdk.installDir;
  },
  get romPath(): string | undefined {
    return runtime().sdk.romPath;
  },
  get platform(): Platform {
    return runtime().sdk.platform;
  },
  get id(): string {
    return runtime().sdk.id;
  },
  env,
  get ready(): Promise<void> {
    return runtime().sdk.ready;
  },
  cloneFromGitHub: (repo, branch) =>
    runtime().sdk.cloneFromGitHub(repo, branch),
  placeRom: (destRel) => runtime().sdk.placeRom(destRel),
  declareOutput: (binRelPath) => runtime().sdk.declareOutput(binRelPath),
  declareLaunchCommand: (cmd) => runtime().sdk.declareLaunchCommand(cmd),
  declarePlatform: (p) => runtime().sdk.declarePlatform(p),
  reportVersion: (version) => runtime().sdk.reportVersion(version),
  progress: (message, percent) => runtime().sdk.progress(message, percent),
  writeLauncher: (opts) => runtime().sdk.writeLauncher(opts),
};
