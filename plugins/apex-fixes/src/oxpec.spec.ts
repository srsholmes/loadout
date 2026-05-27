/**
 * oxpec helper tests — covers the spawn-dependent paths that
 * `backend.spec.ts` deliberately skips. Both `./privileged` (sudoSpawn
 * et al.) and `node:fs/promises` are mocked so we can drive each
 * branch from the test.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── fs/promises mock ───────────────────────────────────────────────
// Mirrors backend.spec.ts. Tests populate the maps; the mocks read
// from them.

const mockFiles = new Map<string, string>();
const mockDirs = new Map<string, string[]>();
const mockMissing = new Set<string>();

const mockReadFile = mock(async (path: string) => {
  if (mockMissing.has(path)) throw new Error(`ENOENT: ${path}`);
  if (!mockFiles.has(path)) throw new Error(`ENOENT: ${path}`);
  return mockFiles.get(path)!;
});

const mockAccess = mock(async (path: string) => {
  if (mockMissing.has(path)) throw new Error(`ENOENT: ${path}`);
  if (mockFiles.has(path) || mockDirs.has(path)) return;
  throw new Error(`ENOENT: ${path}`);
});

const mockReaddir = mock(async (path: string, _opts?: unknown) => {
  if (!mockDirs.has(path)) throw new Error(`ENOENT: ${path}`);
  const names = mockDirs.get(path)!;
  // readdir is called with `{ withFileTypes: true }` for OXPEC_DIR. We
  // need to handle both call shapes.
  if (_opts && (_opts as { withFileTypes?: boolean }).withFileTypes) {
    return names.map((name) => ({
      name,
      isDirectory: () => true,
      isFile: () => false,
    }));
  }
  return names;
});

mock.module("node:fs/promises", () => ({
  readFile: mockReadFile,
  access: mockAccess,
  readdir: mockReaddir,
}));

// ── privileged mock ────────────────────────────────────────────────
//
// Each test sets a resolver that inspects the cmd+args and returns the
// sudoSpawn result. Helpers (sudoTee/sudoMkdirP/sudoRmF/sudoChmod) all
// route through sudoSpawn internally, but we also mock them directly
// since the helpers in oxpec.ts import them by name.

type SpawnArgs = { cmd: string; args: string[]; opts?: unknown };
type SpawnResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };

let spawnResolver: (a: SpawnArgs) => SpawnResult = () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
});
const spawnCalls: SpawnArgs[] = [];

const mockSudoSpawn = mock(async (cmd: string, args: string[], opts?: unknown) => {
  spawnCalls.push({ cmd, args, opts });
  return spawnResolver({ cmd, args, opts });
});

const mockSudoTee = mock(async (_path: string, _content: string) => {
  // mimic the real sudoTee — throw on non-zero exit from underlying spawn
  const r = spawnResolver({ cmd: "tee", args: [_path], opts: { stdin: _content } });
  if (r.exitCode !== 0) throw new Error(`sudo tee ${_path} failed: ${r.stderr}`);
});

const mockSudoMkdirP = mock(async (_path: string) => {
  /* default: succeed */
});

const mockSudoRmF = mock(async (_path: string) => {
  /* default: succeed */
});

mock.module("./privileged", () => ({
  sudoSpawn: mockSudoSpawn,
  sudoTee: mockSudoTee,
  sudoMkdirP: mockSudoMkdirP,
  sudoRmF: mockSudoRmF,
  sudoChmod: mock(async () => {}),
}));

// Imports must come AFTER mock.module calls.
import { ensure, getStatus, apply, revert } from "./oxpec";

function resetMocks(): void {
  mockFiles.clear();
  mockDirs.clear();
  mockMissing.clear();
  mockReadFile.mockClear();
  mockAccess.mockClear();
  mockReaddir.mockClear();
  mockSudoSpawn.mockClear();
  mockSudoTee.mockClear();
  mockSudoMkdirP.mockClear();
  mockSudoRmF.mockClear();
  spawnCalls.length = 0;
  spawnResolver = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
}

// ────────────────────────────────────────────────────────────────────
// getStatus()
// ────────────────────────────────────────────────────────────────────

describe("oxpec.getStatus()", () => {
  beforeEach(() => resetMocks());

  it("reports loaded+persisted when module is present and service enabled", async () => {
    mockFiles.set("/proc/modules", "oxpec 12345 0 - Live 0x0\n");
    mockFiles.set("/etc/systemd/system/oxpec-load.service", "unit file");
    mockDirs.set("/sys/class/hwmon", ["hwmon0"]);
    mockFiles.set("/sys/class/hwmon/hwmon0/name", "oxp_ec\n");
    spawnResolver = ({ cmd, args }) => {
      if (cmd === "systemctl" && args[0] === "is-enabled") {
        return { exitCode: 0, stdout: "enabled\n", stderr: "", timedOut: false };
      }
      if (cmd === "uname") {
        return { exitCode: 0, stdout: "6.11.0-test\n", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const s = await getStatus();
    expect(s.moduleLoaded).toBe(true);
    expect(s.serviceEnabled).toBe(true);
    expect(s.hwmonPath).toBe("/sys/class/hwmon/hwmon0");
    expect(s.summary).toContain("loaded and persisted");
  });

  it("reports not-loaded summary when module absent and no bundled kernel", async () => {
    // /proc/modules missing -> isModuleLoaded false
    // /etc/systemd... missing -> serviceEnabled false
    // no kernel-modules directory -> bundledKernels empty
    spawnResolver = ({ cmd }) => {
      if (cmd === "uname") {
        return { exitCode: 0, stdout: "6.99.0-unknown\n", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const s = await getStatus();
    expect(s.moduleLoaded).toBe(false);
    expect(s.serviceEnabled).toBe(false);
    expect(s.bundledKernels).toEqual([]);
    expect(s.bundledKernelMatch).toBe(false);
    expect(s.summary).toContain("No bundled");
  });
});

// ────────────────────────────────────────────────────────────────────
// ensure()
// ────────────────────────────────────────────────────────────────────

describe("oxpec.ensure()", () => {
  beforeEach(() => resetMocks());

  it("short-circuits when module already loaded", async () => {
    mockFiles.set("/proc/modules", "oxpec 12345 0 - Live 0x0\n");
    const res = await ensure();
    expect(res.success).toBe(true);
    expect(res.alreadyLoaded).toBe(true);
    // No spawn calls should have been made because we exited early.
    expect(spawnCalls.length).toBe(0);
  });

  it("succeeds via modprobe when modprobe exits 0 AND module becomes loaded", async () => {
    let modprobed = false;
    spawnResolver = ({ cmd }) => {
      if (cmd === "modprobe") {
        modprobed = true;
        // After modprobe, /proc/modules should report it loaded.
        mockFiles.set("/proc/modules", "oxpec 12345 0 - Live 0x0\n");
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await ensure();
    expect(res.success).toBe(true);
    expect(res.method).toBe("modprobe");
    expect(modprobed).toBe(true);
  });

  it("returns failure with diagnostic when modprobe and no bundled .ko available", async () => {
    spawnResolver = ({ cmd }) => {
      if (cmd === "modprobe") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "modprobe: FATAL: Module oxpec not found.\n",
          timedOut: false,
        };
      }
      if (cmd === "uname") {
        return { exitCode: 0, stdout: "6.99.0-unknown\n", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await ensure();
    expect(res.success).toBe(false);
    expect(res.error).toContain("Failed to load oxpec");
    expect(res.error).toContain("not found");
    // getRunningKernel uses Bun.spawn directly (not sudoSpawn), so we
    // can't easily stub it — just assert the diagnostic shape.
    expect(res.error).toContain("Running kernel:");
    expect(res.error).toContain("Bundled .ko available for: none");
  });
});

// ────────────────────────────────────────────────────────────────────
// apply()
// ────────────────────────────────────────────────────────────────────

describe("oxpec.apply()", () => {
  beforeEach(() => resetMocks());

  it("short-circuits when service is enabled AND module is loaded", async () => {
    mockFiles.set("/proc/modules", "oxpec 12345 0 - Live 0x0\n");
    mockFiles.set("/etc/systemd/system/oxpec-load.service", "x");
    spawnResolver = ({ cmd, args }) => {
      if (cmd === "systemctl" && args[0] === "is-enabled") {
        return { exitCode: 0, stdout: "enabled\n", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await apply();
    expect(res.success).toBe(true);
    expect(res.steps).toEqual(["Already applied"]);
  });

  it("aborts with diagnostic when no bundled .ko and modprobe fails", async () => {
    spawnResolver = ({ cmd }) => {
      if (cmd === "modprobe") {
        return { exitCode: 1, stdout: "", stderr: "no such device", timedOut: false };
      }
      if (cmd === "uname") {
        return { exitCode: 0, stdout: "6.99.0-unknown\n", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await apply();
    expect(res.success).toBe(false);
    expect(res.error).toContain("No oxpec.ko");
    expect(res.error).toContain("Bundled: none");
  });
});

// ────────────────────────────────────────────────────────────────────
// revert()
// ────────────────────────────────────────────────────────────────────

describe("oxpec.revert()", () => {
  beforeEach(() => resetMocks());

  it("always reports success and records each cleanup step", async () => {
    mockFiles.set("/etc/systemd/system/oxpec-load.service", "x");
    mockFiles.set("/proc/modules", "oxpec 12345 0 - Live 0x0\n");
    spawnResolver = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    const res = await revert();
    expect(res.success).toBe(true);
    // Should have disabled service, rmmoded module, removed service path + INSTALL_DIR.
    const stepsStr = res.steps.join("|");
    expect(stepsStr).toContain("Disabled");
    expect(stepsStr).toContain("Unloaded");
    expect(stepsStr).toContain("Removed /etc/systemd/system/oxpec-load.service");
    expect(stepsStr).toContain("Removed /var/lib/oxpec");
  });

  it("continues past systemctl/rmmod failures and still removes files", async () => {
    mockFiles.set("/etc/systemd/system/oxpec-load.service", "x");
    mockFiles.set("/proc/modules", "oxpec 12345 0 - Live 0x0\n");
    spawnResolver = ({ cmd }) => {
      if (cmd === "systemctl" || cmd === "rmmod") {
        return { exitCode: 1, stdout: "", stderr: "module in use", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await revert();
    // revert is best-effort — should still succeed even when rmmod failed.
    expect(res.success).toBe(true);
    const stepsStr = res.steps.join("|");
    expect(stepsStr).toContain("disable failed (continuing)");
    expect(stepsStr).toContain("rmmod failed (continuing)");
  });
});
