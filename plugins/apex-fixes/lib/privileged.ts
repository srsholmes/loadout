/**
 * Privileged command helpers.
 *
 * Every fix in this plugin reaches system state that a normal user
 * can't modify: loading kernel modules, writing to /etc, reading
 * /var/lib, installing systemd units. In Loadout the plugin backend
 * already runs as root, so — unlike the old Steam Loader port — these
 * helpers invoke the target binary **directly** (no `sudo`/`pkexec`
 * wrapper). They still centralise:
 *
 *  - A 30s default timeout so a stuck child doesn't hang the plugin.
 *  - Env hygiene — strip LD_LIBRARY_PATH and LD_PRELOAD so the child
 *    sees a clean dynamic-linker environment (Decky's sibling code
 *    does this in xhci_recovery.py:_clean_env; we've seen Bun
 *    preserve LD_LIBRARY_PATH from its own runtime into spawned
 *    children, which trips up some system utilities).
 *  - A single path for file writes via `tee`, which is the simplest
 *    way to land content at a root-only path without shelling out to
 *    bash -c.
 *
 * The `sudo*` export names are kept for continuity with the four fix
 * modules that call them; the names now just mean "privileged", not
 * "via sudo".
 */

import { runFull } from "@loadout/exec";

export interface SudoSpawnOptions {
  /** Kill the child after this many ms. Default 30_000. */
  timeoutMs?: number;
  /** Write this string to the child's stdin before closing it. */
  stdin?: string;
  /** If true, throw on non-zero exit with stderr in the message. Default false. */
  throwOnNonZero?: boolean;
}

export interface SudoSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Strip LD_LIBRARY_PATH / LD_PRELOAD via `runFull`'s `env` option. */
const CLEAN_ENV: Record<string, string | undefined> = {
  LD_LIBRARY_PATH: undefined,
  LD_PRELOAD: undefined,
};

/**
 * Run a privileged command with captured stdio. The backend is root,
 * so the binary is invoked directly (no `sudo`). Safe to call from any
 * fix module. Never throws on non-zero unless `throwOnNonZero` is set —
 * callers typically want to inspect exit code + stderr to build their
 * own error message.
 */
export async function sudoSpawn(
  cmd: string,
  args: string[],
  opts: SudoSpawnOptions = {},
): Promise<SudoSpawnResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const { stdout, stderr, exitCode } = await runFull(
    [cmd, ...args],
    {
      env: CLEAN_ENV,
      stdin: opts.stdin,
      timeoutMs,
    },
  );
  const timedOut = exitCode === -1;

  if (opts.throwOnNonZero && exitCode !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`,
    );
  }

  return { exitCode, stdout, stderr, timedOut };
}

/**
 * Write `content` to `path` via `sudo tee`. Overwrites the file. If
 * the parent directory doesn't exist, tee fails — the caller is
 * responsible for creating it first via `sudoMkdirP` or similar.
 *
 * Throws on non-zero exit so callers don't silently continue after
 * a missing file landed only half-written.
 */
export async function sudoTee(path: string, content: string): Promise<void> {
  const { exitCode, stderr } = await sudoSpawn("tee", [path], {
    stdin: content,
    // tee echoes stdin to stdout too; we ignore stdout by not asserting.
  });
  if (exitCode !== 0) {
    throw new Error(`tee ${path} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

/** `mkdir -p path` — idempotent directory creation. */
export async function sudoMkdirP(path: string): Promise<void> {
  await sudoSpawn("mkdir", ["-p", path], { throwOnNonZero: true });
}

/** `rm -f path` — idempotent file removal, no error if missing. */
export async function sudoRmF(path: string): Promise<void> {
  await sudoSpawn("rm", ["-f", path], { throwOnNonZero: false });
}

/** `chmod mode path`. */
export async function sudoChmod(path: string, mode: string): Promise<void> {
  await sudoSpawn("chmod", [mode, path], { throwOnNonZero: true });
}
