/**
 * sleep-enable helper tests — focuses on `apply()` and `revert()`,
 * which exercise the ostree unlock path, fw-fanctrl-suspend
 * neutralization, and udev rule install. The pure status reader is
 * already covered in `../backend.spec.ts`.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── fs/promises mock ───────────────────────────────────────────────

const mockFiles = new Map<string, string>();
const mockDirs = new Map<string, string[]>();
const mockMissing = new Set<string>();

const mockReadFile = mock(async (path: string) => {
  if (mockMissing.has(path)) throw new Error(`ENOENT: ${path}`);
  if (!mockFiles.has(path)) throw new Error(`ENOENT: ${path}`);
  return mockFiles.get(path)!;
});

const mockStat = mock(async (path: string) => {
  if (mockMissing.has(path)) throw new Error(`ENOENT: ${path}`);
  if (mockFiles.has(path)) {
    return { size: mockFiles.get(path)!.length, isFile: () => true, isDirectory: () => false };
  }
  if (mockDirs.has(path)) {
    return { size: 0, isFile: () => false, isDirectory: () => true };
  }
  throw new Error(`ENOENT: ${path}`);
});

mock.module("node:fs/promises", () => ({
  readFile: mockReadFile,
  stat: mockStat,
}));

// ── privileged mock ────────────────────────────────────────────────

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

// sudoTee mock can succeed or throw based on `teeShouldFail`.
let teeShouldFail = false;
const mockSudoTee = mock(async (_path: string, _content: string) => {
  if (teeShouldFail) throw new Error(`sudo tee ${_path} failed: permission denied`);
});

const mockSudoMkdirP = mock(async (_path: string) => {});
const mockSudoRmF = mock(async (_path: string) => {});
const mockSudoChmod = mock(async (_path: string, _mode: string) => {});

mock.module("./privileged", () => ({
  sudoSpawn: mockSudoSpawn,
  sudoTee: mockSudoTee,
  sudoMkdirP: mockSudoMkdirP,
  sudoRmF: mockSudoRmF,
  sudoChmod: mockSudoChmod,
}));

import { apply, revert } from "./sleep-enable";

const FW_SCRIPT = "/usr/lib/systemd/system-sleep/fw-fanctrl-suspend";
const FINGERPRINT_RULE = "/etc/udev/rules.d/91-oxp-fingerprint-no-wakeup.rules";

function resetMocks(): void {
  mockFiles.clear();
  mockDirs.clear();
  mockMissing.clear();
  mockReadFile.mockClear();
  mockStat.mockClear();
  mockSudoSpawn.mockClear();
  mockSudoTee.mockClear();
  mockSudoMkdirP.mockClear();
  mockSudoRmF.mockClear();
  mockSudoChmod.mockClear();
  spawnCalls.length = 0;
  teeShouldFail = false;
  spawnResolver = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
}

// ────────────────────────────────────────────────────────────────────
// apply()
// ────────────────────────────────────────────────────────────────────

describe("sleepEnable.apply()", () => {
  beforeEach(() => resetMocks());

  it("short-circuits when both fixes are already in place", async () => {
    // No FW_SCRIPT (missing = neutralized) and rule already installed.
    mockFiles.set(FINGERPRINT_RULE, "# rule\n");
    const res = await apply();
    expect(res.success).toBe(true);
    expect(res.steps).toEqual(["already applied"]);
    // No sudo calls should have happened.
    expect(spawnCalls.length).toBe(0);
  });

  it("happy path: neutralizes fw-fanctrl-suspend and installs udev rule", async () => {
    // Real Framework script present, no rule.
    mockFiles.set(FW_SCRIPT, "#!/bin/bash\n" + "echo foo; ".repeat(50) + "echo done\n");

    spawnResolver = ({ cmd, args }) => {
      // `test -w /usr/lib/...` — first probe says read-only, then writable after unlock.
      if (cmd === "test" && args[0] === "-w") {
        // Count test calls — first one (probe) returns RO; rest return writable.
        const testCalls = spawnCalls.filter((c) => c.cmd === "test").length;
        return testCalls <= 1
          ? { exitCode: 1, stdout: "", stderr: "", timedOut: false }
          : { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      if (cmd === "ostree") {
        return { exitCode: 0, stdout: "Unlocked", stderr: "", timedOut: false };
      }
      // After tee succeeds, fw-fanctrl-suspend becomes the no-op script.
      // Simulate the side effect so isScriptNeutralized would return true.
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await apply();
    expect(res.success).toBe(true);
    expect(res.oneWayWarning).toBe(true);
    const stepsStr = res.steps.join("|");
    expect(stepsStr).toContain("neutralized fw-fanctrl-suspend");
    expect(stepsStr).toContain(`installed ${FINGERPRINT_RULE}`);
    expect(stepsStr).toContain("reloaded udev rules");

    // udevadm should have been triggered.
    const udevCmds = spawnCalls.filter((c) => c.cmd === "udevadm").map((c) => c.args[0]);
    expect(udevCmds).toContain("control");
    expect(udevCmds).toContain("trigger");
  });

  it("fails with oneWayWarning when ostree unlock never makes /usr/lib writable", async () => {
    mockFiles.set(FW_SCRIPT, "#!/bin/bash\n" + "echo bar; ".repeat(50));

    spawnResolver = ({ cmd }) => {
      if (cmd === "test") {
        // Never becomes writable -> unlockOstree returns false after retries.
        return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
      }
      if (cmd === "ostree") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "ostree admin unlock not supported",
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await apply();
    expect(res.success).toBe(false);
    expect(res.oneWayWarning).toBe(true);
    expect(res.error).toContain("ostree unlock failed");
  }, 30_000); // unlockOstree retries 6 times with up to 2s waits

  it("fails when sudoTee throws while writing the udev rule", async () => {
    // fw-fanctrl is already neutralized so we skip the unlock path.
    mockFiles.set(FW_SCRIPT, "#!/bin/bash\nexit 0\n");
    // No rule installed.
    teeShouldFail = true;

    const res = await apply();
    expect(res.success).toBe(false);
    expect(res.oneWayWarning).toBe(true);
    expect(res.error).toContain("fingerprint rule install failed");
    expect(res.error).toContain("permission denied");
  });
});

// ────────────────────────────────────────────────────────────────────
// revert()
// ────────────────────────────────────────────────────────────────────

describe("sleepEnable.revert()", () => {
  beforeEach(() => resetMocks());

  it("removes the udev rule and reloads when present", async () => {
    mockFiles.set(FINGERPRINT_RULE, "# rule\n");

    const res = await revert();
    expect(res.success).toBe(true);
    expect(res.oneWayWarning).toBe(true);
    expect(res.steps.join("|")).toContain(`removed ${FINGERPRINT_RULE}`);

    // sudoRmF should have been called for the rule.
    expect(mockSudoRmF).toHaveBeenCalledWith(FINGERPRINT_RULE);

    // udevadm reload should run.
    const udevReload = spawnCalls.find(
      (c) => c.cmd === "udevadm" && c.args[0] === "control",
    );
    expect(udevReload).toBeTruthy();
  });

  it("notes the one-way caveat when neutralized fw-fanctrl-suspend still exists", async () => {
    // FW script present and neutralized (short), no udev rule.
    mockFiles.set(FW_SCRIPT, "#!/bin/bash\nexit 0\n");

    const res = await revert();
    expect(res.success).toBe(true);
    expect(res.oneWayWarning).toBe(true);
    const stepsStr = res.steps.join("|");
    expect(stepsStr).toContain("restored on next Bazzite update");
    expect(stepsStr).toContain("fingerprint rule already absent");
  });

  it("is idempotent when nothing was applied", async () => {
    // No FW script, no rule.
    const res = await revert();
    expect(res.success).toBe(true);
    expect(res.steps.join("|")).toContain("fingerprint rule already absent");
    expect(mockSudoRmF).not.toHaveBeenCalled();
  });
});
