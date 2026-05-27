/**
 * Privileged command helpers.
 *
 * Every fix in this plugin reaches system state that a normal user
 * can't modify: loading kernel modules, writing to /etc, reading
 * /var/lib, installing systemd units. These helpers centralise:
 *
 *  - The `sudo …` invocation (via `@loadout/exec`).
 *  - A 30s default timeout so a stuck sudo doesn't hang the plugin.
 *  - Env hygiene — strip LD_LIBRARY_PATH and LD_PRELOAD so the child
 *    sees a clean dynamic-linker environment (Decky's sibling code
 *    does this in xhci_recovery.py:_clean_env; we've seen Bun
 *    preserve LD_LIBRARY_PATH from its own runtime into spawned
 *    children, which trips up some system utilities).
 *  - A single path for file writes via `sudo tee`, which is the
 *    simplest way to land content at a root-only path without
 *    shelling out to bash -c.
 */

import { runFull, spawn } from "@loadout/exec";

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
 * Run a command under sudo with captured stdio. Safe to call from
 * any fix module. Never throws on non-zero unless `throwOnNonZero`
 * is set — callers typically want to inspect exit code + stderr to
 * build their own error message.
 */
export async function sudoSpawn(
  cmd: string,
  args: string[],
  opts: SudoSpawnOptions = {},
): Promise<SudoSpawnResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const { stdout, stderr, exitCode } = await runFull(
    ["sudo", cmd, ...args],
    {
      env: CLEAN_ENV,
      stdin: opts.stdin,
      timeoutMs,
    },
  );
  const timedOut = exitCode === -1;

  if (opts.throwOnNonZero && exitCode !== 0) {
    throw new Error(
      `sudo ${cmd} ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`,
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
    throw new Error(`sudo tee ${path} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

/** `sudo mkdir -p path` — idempotent directory creation. */
export async function sudoMkdirP(path: string): Promise<void> {
  await sudoSpawn("mkdir", ["-p", path], { throwOnNonZero: true });
}

/** `sudo rm -f path` — idempotent file removal, no error if missing. */
export async function sudoRmF(path: string): Promise<void> {
  await sudoSpawn("rm", ["-f", path], { throwOnNonZero: false });
}

/** `sudo chmod mode path`. */
export async function sudoChmod(path: string, mode: string): Promise<void> {
  await sudoSpawn("chmod", [mode, path], { throwOnNonZero: true });
}

// ---------------------------------------------------------------------------
// Streaming variant
// ---------------------------------------------------------------------------

export interface SudoSpawnStreamOptions {
  /** Kill after this many ms. Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Called for each stdout chunk (decoded utf-8). */
  onStdout?: (chunk: string) => void;
  /** Called for each stderr chunk (decoded utf-8). */
  onStderr?: (chunk: string) => void;
  /** Populated with a cancellation handle so callers can kill a running child. */
  signal?: { cancel: () => void };
}

export interface SudoSpawnStreamResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `sudo cmd args…` and stream stdout/stderr chunks to the supplied
 * callbacks as they arrive. Unlike `sudoSpawn`, this does not buffer
 * everything before returning — necessary for the InputPlumber migration
 * script which prints section markers over several minutes and which the
 * UI surfaces live.
 *
 * The accumulated stdout/stderr is still returned for callers that want
 * to log the final outcome. Default timeout is 10 minutes; callers that
 * invoke `rpm-ostree`, `cargo build`, or `dnf download` should stick with
 * it or extend further.
 */
export async function sudoSpawnStreamed(
  cmd: string,
  args: string[],
  opts: SudoSpawnStreamOptions = {},
): Promise<SudoSpawnStreamResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  let timedOut = false;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k === "LD_LIBRARY_PATH" || k === "LD_PRELOAD") continue;
    env[k] = v;
  }
  const proc = spawn(["sudo", cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, timeoutMs);

  if (opts.signal) {
    opts.signal.cancel = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already exited */
      }
    };
  }

  const decoder = new TextDecoder();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const pump = async (
    stream: typeof proc.stdout,
    sink: string[],
    cb?: (chunk: string) => void,
  ): Promise<void> => {
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.length > 0) {
          sink.push(text);
          cb?.(text);
        }
      }
      const tail = decoder.decode();
      if (tail.length > 0) {
        sink.push(tail);
        cb?.(tail);
      }
    } finally {
      reader.releaseLock();
    }
  };

  const [exitCode] = await Promise.all([
    proc.exited,
    pump(proc.stdout, stdoutChunks, opts.onStdout),
    pump(proc.stderr, stderrChunks, opts.onStderr),
  ]);
  clearTimeout(timer);

  return {
    exitCode,
    timedOut,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}
