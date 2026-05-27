export interface RunOptions {
  /** Kill the subprocess if it hasn't exited within this many ms.
   *  `run()` / `runFull()` return `{ stdout: "", stderr: "", exitCode: -1 }`
   *  on timeout. Useful when shelling out to X11 tools (xprop / xdotool)
   *  that can hang indefinitely on a stuck X server — without a timeout
   *  the await blocks Bun's event loop for the whole process. */
  timeoutMs?: number;
  /** Bytes (or a string, UTF-8 encoded) to pipe to the subprocess stdin
   *  before closing it. Use when you want to feed a value to `tee` /
   *  `sudo -S` / a tool that reads from stdin. For interactive stdin
   *  streams, use `spawn()` directly. */
  stdin?: Uint8Array | string;
  /** Extra env vars merged on top of `process.env`. Set a key to
   *  `undefined` to unset it. */
  env?: Record<string, string | undefined>;
  /** Working directory. Defaults to the process cwd. */
  cwd?: string;
}

export interface RunResult {
  /** Raw stdout. NOT trimmed — `runFull` preserves whitespace; `run`
   *  trims for ergonomic single-line outputs. */
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SpawnOpts {
  stdout: "pipe";
  stderr: "pipe";
  stdin?: ReadableStream<Uint8Array>;
  env?: Record<string, string>;
  cwd?: string;
}

/** Build the Bun.spawn options bag from our `RunOptions`. */
function buildOpts(opts: RunOptions): SpawnOpts {
  const out: SpawnOpts = { stdout: "pipe", stderr: "pipe" };
  if (opts.stdin !== undefined) {
    const bytes =
      typeof opts.stdin === "string" ? new TextEncoder().encode(opts.stdin) : opts.stdin;
    out.stdin = new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  }
  if (opts.env) {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") merged[k] = v;
    }
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    out.env = merged;
  }
  if (opts.cwd) out.cwd = opts.cwd;
  return out;
}

/**
 * Run a one-shot command and return trimmed stdout + exit code.
 * Drops stderr — use `runFull()` if you need it.
 */
export async function run(
  cmd: string[],
  opts: RunOptions = {},
): Promise<{ stdout: string; exitCode: number }> {
  const result = await runFull(cmd, opts);
  return { stdout: result.stdout.trim(), exitCode: result.exitCode };
}

/**
 * Run a one-shot command and return raw stdout, stderr, and exit code.
 * Use when you need to surface stderr (most subprocess errors live there).
 */
export async function runFull(
  cmd: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, buildOpts(opts));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
  }
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) return { stdout: "", stderr: "", exitCode: -1 };
    return { stdout, stderr, exitCode };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a command and return only the exit code. Stdout + stderr are
 * silenced (Bun.spawn with `"ignore"` on both).
 */
export async function runCode(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  return proc.exited;
}

/**
 * Run a command and stream every output line to a callback while it
 * executes. Use for long-running processes whose progress matters
 * to the UI — `make`, `cmake`, `git clone --progress`, etc. — where
 * waiting for `runFull()` to return at the end leaves the user
 * staring at a frozen progress bar for minutes.
 *
 * Both stdout AND stderr are merged into the same stream; most
 * build tools spew their actual progress info to stderr (e.g.
 * `make -j` runs and `gcc` compile lines), so anything else would
 * miss it. Lines are buffered until each `\n` so `onLine` always
 * receives a complete line (no partial fragments). The trailing
 * unterminated buffer is flushed on exit.
 *
 * Honours `timeoutMs` (kills the process), `env` (merged on top of
 * `process.env`), `cwd`. `stdin` is intentionally NOT supported —
 * if you need to pipe input AND stream output, use `spawn()`
 * directly.
 *
 * Returns the exit code; doesn't throw on non-zero. Caller decides
 * what's an error.
 */
export async function runStreaming(
  cmd: string[],
  opts: Omit<RunOptions, "stdin"> & {
    onLine: (line: string) => void;
    /**
     * Fired once with the spawned subprocess so the caller can stash
     * the handle and signal it later (e.g. SIGTERM on user-initiated
     * cancel). Optional — callers that don't need to cancel skip it
     * and behaviour is unchanged.
     */
    onSpawn?: (proc: ReturnType<typeof Bun.spawn>) => void;
  },
): Promise<{ exitCode: number }> {
  const proc = Bun.spawn(cmd, buildOpts({ env: opts.env, cwd: opts.cwd }));
  opts.onSpawn?.(proc);
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => proc.kill(), opts.timeoutMs);
  }
  // Drain a ReadableStream<Uint8Array> line-by-line, calling onLine
  // for each `\n`-terminated chunk and flushing whatever's left in
  // the buffer when the stream closes.
  const drain = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          opts.onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
    } finally {
      buf += decoder.decode();
      if (buf.length > 0) opts.onLine(buf);
    }
  };
  try {
    const [, , exitCode] = await Promise.all([
      drain(proc.stdout as ReadableStream<Uint8Array> | null),
      drain(proc.stderr as ReadableStream<Uint8Array> | null),
      proc.exited,
    ]);
    return { exitCode };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Check if a command exists on the system PATH.
 */
export async function commandExists(name: string): Promise<boolean> {
  try {
    const { exitCode } = await run(["which", name]);
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Wrapper around `Bun.spawn` for long-lived or streaming subprocesses
 * (e.g. mpv with an IPC socket, `flatpak update` with line-streamed
 * progress). For one-shot commands prefer `run()` / `runFull()` —
 * they handle stdin / env / cwd / timeout cleanly.
 *
 * The reason this wrapper exists at all: a lint rule (Q-006 in the
 * 2026-05 audit) forbids `Bun.spawn` outside `packages/exec`. Routing
 * the long-lived cases through this single export keeps "all subprocess
 * work goes through @loadout/exec" as one teachable rule.
 *
 * Implemented as a function (not `export const spawn = Bun.spawn`) so
 * test specs that re-assign `Bun.spawn` at test time still get
 * intercepted — the const form would capture the real `Bun.spawn` at
 * module-load and ignore later mocks.
 */
export const spawn: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) =>
  Bun.spawn(...args)) as typeof Bun.spawn;
