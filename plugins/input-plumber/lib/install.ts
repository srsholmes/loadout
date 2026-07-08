/**
 * InputPlumber install driver.
 *
 * Thin wrapper around the bundled `scripts/install-inputplumber.sh`.
 * The script does the actual work (pacman/dnf fast path, otherwise a
 * tarball install under /var/lib/inputplumber); this module adds:
 *
 *   - Status probe — is the binary on disk? Is the service active /
 *     enabled? Where did it come from (system package vs our /var install)?
 *   - A run helper that streams stdout/stderr to a callback so the UI
 *     can show a live log.
 *
 * The loadout backend runs as root, so subprocesses go straight through
 * `@loadout/exec` — no sudo / pkexec wrapper.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { runFull, spawn } from "@loadout/exec";
import type { InstallRunResult, InstallStatus, ManagedBy } from "../shared";

// Re-export so existing callers (backend.ts, tests) keep working without
// caring whether the type lives here or in ../shared. The source of truth
// is ../shared so the frontend can import it without dragging in fs/exec.
export type { InstallRunResult, InstallStatus, ManagedBy };

const PLUGIN_ROOT = join(import.meta.dir, "..");
const INSTALL_SCRIPT = join(PLUGIN_ROOT, "scripts", "install-inputplumber.sh");

const VAR_BIN = "/var/lib/inputplumber/bin/inputplumber";

export interface RunnerOptions {
  onLog?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Populated with a cancel handle when the run starts. */
  cancellation?: { cancel: () => void };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function which(cmd: string): Promise<string | null> {
  const r = await runFull(["which", cmd], { timeoutMs: 3_000 });
  if (r.exitCode !== 0) return null;
  const path = r.stdout.trim().split("\n")[0];
  return path || null;
}

async function inputplumberVersion(binary: string): Promise<string | null> {
  const r = await runFull([binary, "--version"], { timeoutMs: 5_000 });
  if (r.exitCode !== 0) return null;
  const m = r.stdout.trim().match(/(\d+\.\d+\.\d+(?:-\S+)?)/);
  // Capture group 1 is mandatory, so on a match it is always present.
  return m ? m[1]! : r.stdout.trim() || null;
}

async function isUnitActive(unit: string): Promise<boolean> {
  const { exitCode, stdout } = await runFull(["systemctl", "is-active", unit], {
    timeoutMs: 5_000,
  });
  return exitCode === 0 && stdout.trim() === "active";
}

async function isUnitEnabled(unit: string): Promise<boolean> {
  const { stdout } = await runFull(["systemctl", "is-enabled", unit], {
    timeoutMs: 5_000,
  });
  const s = stdout.trim();
  return s === "enabled" || s === "enabled-runtime" || s === "static";
}

export async function getStatus(): Promise<InstallStatus> {
  const onPath = await which("inputplumber");
  let binaryPath: string | null = null;
  let managedBy: ManagedBy = "none";

  if (onPath) {
    binaryPath = onPath;
    managedBy = onPath === VAR_BIN ? "us" : "distro";
  } else if (await exists(VAR_BIN)) {
    binaryPath = VAR_BIN;
    managedBy = "us";
  }

  const installed = binaryPath !== null;
  const [version, serviceActive, serviceEnabled, scriptPresent] = await Promise.all([
    binaryPath ? inputplumberVersion(binaryPath) : Promise.resolve(null),
    isUnitActive("inputplumber.service"),
    isUnitEnabled("inputplumber.service"),
    exists(INSTALL_SCRIPT),
  ]);

  let summary: string;
  if (!installed) {
    summary = "InputPlumber is not installed.";
  } else if (!serviceActive) {
    summary = `InputPlumber installed (${managedBy === "us" ? "/var" : "system"}) but the service isn't running.`;
  } else {
    summary = `InputPlumber active${version ? ` (v${version})` : ""}, managed by ${managedBy === "us" ? "this plugin" : "system package"}.`;
  }

  return {
    installed,
    binaryPath,
    managedBy,
    version,
    serviceActive,
    serviceEnabled,
    scriptPresent,
    summary,
  };
}

export async function install(opts: RunnerOptions = {}): Promise<InstallRunResult> {
  if (!(await exists(INSTALL_SCRIPT))) {
    return {
      success: false,
      exitCode: -1,
      timedOut: false,
      durationSeconds: 0,
      error: `script not found at ${INSTALL_SCRIPT}`,
    };
  }

  const started = Date.now();

  // 10 min cap. Tarball + libiio download is typically <1 min;
  // pacman/dnf can be a bit slower on first install. Plenty of margin.
  const TIMEOUT_MS = 10 * 60_000;

  // Strip LD_LIBRARY_PATH / LD_PRELOAD so the bash child sees a clean
  // dynamic-linker env. Decky's xhci_recovery.py does the same — Bun
  // can preserve LD_LIBRARY_PATH from its own runtime into children,
  // which trips up some system utilities.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k === "LD_LIBRARY_PATH" || k === "LD_PRELOAD") continue;
    env[k] = v;
  }

  const proc = spawn(["bash", INSTALL_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, TIMEOUT_MS);

  if (opts.cancellation) {
    opts.cancellation.cancel = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already exited */
      }
    };
  }

  const decoder = new TextDecoder();
  const stderrChunks: string[] = [];

  const pump = async (
    stream: typeof proc.stdout,
    isStderr: boolean,
  ): Promise<void> => {
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.length > 0) {
          if (isStderr) stderrChunks.push(text);
          opts.onLog?.(text, isStderr ? "stderr" : "stdout");
        }
      }
      const tail = decoder.decode();
      if (tail.length > 0) {
        if (isStderr) stderrChunks.push(tail);
        opts.onLog?.(tail, isStderr ? "stderr" : "stdout");
      }
    } finally {
      reader.releaseLock();
    }
  };

  const [exitCode] = await Promise.all([
    proc.exited,
    pump(proc.stdout, false),
    pump(proc.stderr, true),
  ]);
  clearTimeout(timer);

  const durationSeconds = Math.round((Date.now() - started) / 1000);

  if (timedOut) {
    return {
      success: false,
      exitCode: -1,
      timedOut: true,
      durationSeconds,
      error: "install timed out after 10 minutes",
    };
  }
  if (exitCode !== 0) {
    const stderr = stderrChunks.join("");
    return {
      success: false,
      exitCode,
      timedOut: false,
      durationSeconds,
      error:
        stderr.trim().split("\n").slice(-5).join("\n") ||
        `script exited ${exitCode}`,
    };
  }

  return {
    success: true,
    exitCode: 0,
    timedOut: false,
    durationSeconds,
  };
}
