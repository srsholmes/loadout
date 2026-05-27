/**
 * InputPlumber backend tests — focused on the install probe (getStatus
 * dispatches `which inputplumber` + `systemctl is-active/is-enabled`
 * via sudoSpawn) and the install cancellation path (the cancellation
 * handle wired into sudoSpawnStreamed sends SIGTERM to the running
 * script).
 *
 * Both code paths shell out via Bun.spawn, so we mock Bun.spawn at the
 * test boundary (same pattern as network-info/backend.spec.ts) and
 * dispatch on the argv to fake `which` / `systemctl` / install-script
 * output.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";

// ── node:fs/promises mock ────────────────────────────────────────
// install.ts probes the on-disk `/var/lib/inputplumber/bin/inputplumber`
// via `fs.access` to decide if WE installed it. Pin this to "missing"
// by default so tests on developer machines (where InputPlumber may
// actually be installed) don't get crosstalk from real filesystem
// state. Per-test cases can flip a path into `presentPaths`.

const presentPaths = new Set<string>();
const accessMock = mock(async (path: string) => {
  if (presentPaths.has(path)) return;
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
});

mock.module("node:fs/promises", () => ({ access: accessMock }));
mock.module("fs/promises", () => ({ access: accessMock }));

// ── Bun.spawn mock harness ────────────────────────────────────────
// sudoSpawn / sudoSpawnStreamed call `Bun.spawn(["sudo", cmd, …args])`.
// We provide a small process double that exposes the stdout/stderr
// ReadableStreams and `exited`, and a `kill()` we can observe (used by
// the timeout + cancellation paths).

type MockProc = ReturnType<typeof makeProc>;

interface ProcOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Resolve `exited` only after this many ms. Lets us simulate hangs. */
  exitedAfterMs?: number;
}

function makeProc(opts: ProcOptions = {}): {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  exitCode: number;
  pid: number;
  kill: (sig?: string | number) => void;
  killed: { count: number; lastSignal?: string | number };
} {
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(opts.stdout ?? ""));
      c.close();
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(opts.stderr ?? ""));
      c.close();
    },
  });

  const killed = { count: 0, lastSignal: undefined as string | number | undefined };
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const exitCode = opts.exitCode ?? 0;

  if (opts.exitedAfterMs !== undefined) {
    setTimeout(() => resolveExit(exitCode), opts.exitedAfterMs);
  } else {
    resolveExit(exitCode);
  }

  return {
    stdout,
    stderr,
    exited,
    exitCode,
    pid: 4242,
    kill: (sig?: string | number) => {
      killed.count += 1;
      killed.lastSignal = sig;
      // sudoSpawnStreamed expects the child to die after kill();
      // resolve `exited` with a non-zero code if it hadn't resolved.
      resolveExit(sig === "SIGKILL" ? 137 : 143);
    },
    killed,
  };
}

const spawnCalls: { argv: string[]; proc: MockProc }[] = [];
let spawnImpl: (argv: string[]) => MockProc = () => makeProc();

const mockSpawn = mock((argv: string[]) => {
  const proc = spawnImpl(argv);
  spawnCalls.push({ argv, proc });
  return proc;
});

const originalSpawn = Bun.spawn;

beforeEach(() => {
  spawnCalls.length = 0;
  mockSpawn.mockClear();
  spawnImpl = () => makeProc();
  presentPaths.clear();
  accessMock.mockClear();
  // @ts-expect-error -- override Bun.spawn for the duration of the suite
  Bun.spawn = mockSpawn;
});

afterEach(() => {
  Bun.spawn = originalSpawn;
});

// The backend imports `./src/install` which in turn imports `./privileged`
// which calls Bun.spawn. So we just need to swap Bun.spawn (done above)
// and the whole install.ts → privileged.ts → Bun.spawn chain becomes
// fully controllable.
import InputPlumberBackend from "./backend";
import * as installer from "./src/install";

// Helpers ───────────────────────────────────────────────────────────

/**
 * Dispatch spawn calls by inspecting argv. argv is always
 * `["sudo", cmd, ...args]` for sudoSpawn, so argv[1] is the command.
 */
function routeSpawn(
  router: (cmd: string, args: string[]) => ProcOptions | MockProc,
): void {
  spawnImpl = (argv: string[]) => {
    const cmd = argv[1] ?? "";
    const args = argv.slice(2);
    const out = router(cmd, args);
    // If router returned a full proc (has `.exited`), pass through.
    if (out && typeof (out as MockProc).kill === "function") {
      return out as MockProc;
    }
    return makeProc(out as ProcOptions);
  };
}

function pickEvent<T = unknown>(
  events: EmitPayload[],
  name: string,
): T | undefined {
  const ev = events.find((e) => e.event === name);
  return ev?.data as T | undefined;
}

// ── install probe (getStatus) ─────────────────────────────────────

describe("installer.getStatus() — install probe", () => {
  it("reports installed + service active when which + is-active succeed", async () => {
    routeSpawn((cmd, args) => {
      if (cmd === "which" && args[0] === "inputplumber") {
        return { stdout: "/usr/bin/inputplumber\n", exitCode: 0 };
      }
      if (cmd === "/usr/bin/inputplumber" && args[0] === "--version") {
        return { stdout: "inputplumber 0.43.0\n", exitCode: 0 };
      }
      if (cmd === "systemctl" && args[0] === "is-active") {
        return { stdout: "active\n", exitCode: 0 };
      }
      if (cmd === "systemctl" && args[0] === "is-enabled") {
        return { stdout: "enabled\n", exitCode: 0 };
      }
      return { stdout: "", exitCode: 0 };
    });

    const status = await installer.getStatus();

    expect(status.installed).toBe(true);
    expect(status.binaryPath).toBe("/usr/bin/inputplumber");
    expect(status.managedBy).toBe("distro");
    expect(status.version).toBe("0.43.0");
    expect(status.serviceActive).toBe(true);
    expect(status.serviceEnabled).toBe(true);
    expect(status.summary).toContain("active");
  });

  it("reports installed-but-not-running when which finds it but service is inactive", async () => {
    routeSpawn((cmd, args) => {
      if (cmd === "which" && args[0] === "inputplumber") {
        return { stdout: "/usr/bin/inputplumber\n", exitCode: 0 };
      }
      if (cmd === "/usr/bin/inputplumber" && args[0] === "--version") {
        return { stdout: "inputplumber 0.43.0\n", exitCode: 0 };
      }
      if (cmd === "systemctl" && args[0] === "is-active") {
        // systemctl is-active returns non-zero + "inactive" on stdout
        return { stdout: "inactive\n", exitCode: 3 };
      }
      if (cmd === "systemctl" && args[0] === "is-enabled") {
        return { stdout: "disabled\n", exitCode: 1 };
      }
      return { stdout: "", exitCode: 0 };
    });

    const status = await installer.getStatus();

    expect(status.installed).toBe(true);
    expect(status.serviceActive).toBe(false);
    expect(status.serviceEnabled).toBe(false);
    expect(status.summary).toContain("isn't running");
  });

  it("reports not installed when which fails entirely (binary missing)", async () => {
    routeSpawn((cmd) => {
      if (cmd === "which") {
        // which exits 1 with empty stdout when the binary is absent.
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      if (cmd === "systemctl") {
        return { stdout: "inactive\n", exitCode: 3 };
      }
      return { stdout: "", exitCode: 0 };
    });

    const status = await installer.getStatus();

    expect(status.installed).toBe(false);
    expect(status.binaryPath).toBeNull();
    expect(status.managedBy).toBe("none");
    expect(status.version).toBeNull();
    expect(status.summary).toBe("InputPlumber is not installed.");
  });

  it("survives systemctl exiting non-zero (probe stays graceful, no throw)", async () => {
    routeSpawn((cmd) => {
      if (cmd === "which") return { stdout: "", exitCode: 1 };
      if (cmd === "systemctl") {
        // Whatever systemctl says, getStatus must not throw.
        return { stdout: "", stderr: "Failed to connect to bus", exitCode: 1 };
      }
      return { stdout: "", exitCode: 0 };
    });

    await expect(installer.getStatus()).resolves.toMatchObject({
      installed: false,
      serviceActive: false,
      serviceEnabled: false,
    });
  });
});

// ── backend onLoad emits the probe result ─────────────────────────

describe("InputPlumberBackend.onLoad — initial status broadcast", () => {
  it("broadcasts input-plumber-status after onLoad", async () => {
    routeSpawn((cmd) => {
      if (cmd === "which") return { stdout: "/usr/bin/inputplumber\n", exitCode: 0 };
      if (cmd === "/usr/bin/inputplumber") {
        return { stdout: "inputplumber 0.43.0\n", exitCode: 0 };
      }
      if (cmd === "systemctl") return { stdout: "active\n", exitCode: 0 };
      return { stdout: "", exitCode: 0 };
    });

    const backend = new InputPlumberBackend();
    const events: EmitPayload[] = [];
    backend.emit = (p) => events.push(p);

    await backend.onLoad();
    // broadcastStatus is fired via `void` → wait a tick for the
    // probe promises to settle before asserting.
    await new Promise((r) => setTimeout(r, 20));
    await backend.onUnload();

    const status = pickEvent<{ installed: boolean; serviceActive: boolean }>(
      events,
      "input-plumber-status",
    );
    expect(status).toBeDefined();
    expect(status!.installed).toBe(true);
    expect(status!.serviceActive).toBe(true);
  });
});

// ── cancellation path ─────────────────────────────────────────────

describe("InputPlumberBackend.cancelInstall — cancellation path", () => {
  it("returns no-op when no install is running", () => {
    const backend = new InputPlumberBackend();
    const result = backend.cancelInstall();
    expect(result.cancelled).toBe(false);
    expect(result.error).toBe("no install in progress");
  });

  it("kills the install child via SIGTERM and resolves the awaiting caller", async () => {
    // install() short-circuits if the script is missing from disk —
    // mark it present so the spawn actually fires. install.ts
    // resolves the script path as join(import.meta.dir, "..", "scripts", …)
    // from inside src/install.ts, which lands at the repo path below.
    const { resolve } = await import("node:path");
    presentPaths.add(
      resolve(__dirname, "scripts", "install-inputplumber.sh"),
    );

    // Track the install-script spawn so we can assert kill was called.
    let installProc: MockProc | undefined;
    routeSpawn((cmd) => {
      if (cmd === "bash") {
        // Long-running install script — only resolves after a long
        // timeout, giving cancelInstall() time to fire SIGTERM.
        installProc = makeProc({
          stdout: "",
          stderr: "",
          exitCode: 0,
          exitedAfterMs: 5_000,
        });
        return installProc;
      }
      // Probes that broadcastStatus fires off after install finishes.
      if (cmd === "which") return { stdout: "", exitCode: 1 };
      if (cmd === "systemctl") return { stdout: "", exitCode: 3 };
      return { stdout: "", exitCode: 0 };
    });

    const backend = new InputPlumberBackend();
    const events: EmitPayload[] = [];
    backend.emit = (p) => events.push(p);

    const startResult = await backend.startInstall();
    expect(startResult.started).toBe(true);
    expect(backend.isInstallRunning().running).toBe(true);

    // Give the spawn a moment to be issued.
    await new Promise((r) => setTimeout(r, 10));
    expect(installProc).toBeDefined();

    const cancelResult = backend.cancelInstall();
    expect(cancelResult.cancelled).toBe(true);

    // The kill() handle wired into sudoSpawnStreamed should have fired
    // with SIGTERM (the streaming variant uses SIGTERM, the timeout
    // path uses SIGKILL).
    expect(installProc!.killed.count).toBeGreaterThanOrEqual(1);
    expect(installProc!.killed.lastSignal).toBe("SIGTERM");

    // After cancellation, the awaiting install() promise must resolve
    // (not hang) and the backend's running flag must clear. Poll
    // briefly — the .finally() callback in startInstall runs after
    // `exited` resolves from kill().
    for (let i = 0; i < 50 && backend.isInstallRunning().running; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(backend.isInstallRunning().running).toBe(false);

    // And an install-state running:false event should have been
    // emitted — proving the awaiting promise chain didn't leak.
    const finalState = events
      .filter((e) => e.event === "install-state")
      .pop()?.data as { running: boolean } | undefined;
    expect(finalState).toBeDefined();
    expect(finalState!.running).toBe(false);
  });

  it("rejects a second startInstall while one is in flight", async () => {
    const { resolve } = await import("node:path");
    presentPaths.add(
      resolve(__dirname, "scripts", "install-inputplumber.sh"),
    );

    routeSpawn((cmd) => {
      if (cmd === "bash") {
        return makeProc({ stdout: "", exitCode: 0, exitedAfterMs: 200 });
      }
      if (cmd === "which") return { stdout: "", exitCode: 1 };
      if (cmd === "systemctl") return { stdout: "", exitCode: 3 };
      return { stdout: "", exitCode: 0 };
    });

    const backend = new InputPlumberBackend();
    backend.emit = () => {};

    const first = await backend.startInstall();
    expect(first.started).toBe(true);

    const second = await backend.startInstall();
    expect(second.started).toBe(false);
    expect(second.error).toContain("already in progress");

    // Drain.
    for (let i = 0; i < 50 && backend.isInstallRunning().running; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });
});
