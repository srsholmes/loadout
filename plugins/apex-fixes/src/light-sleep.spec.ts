/**
 * light-sleep helper tests — focuses on `apply()` and `revert()`,
 * which call `rpm-ostree kargs` via sudoSpawn. `getStatus()` and
 * `cmdlineContainsKarg()` are already covered in `../backend.spec.ts`.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── fs/promises mock ───────────────────────────────────────────────

const mockFiles = new Map<string, string>();
const mockMissing = new Set<string>();

const mockReadFile = mock(async (path: string) => {
  if (mockMissing.has(path)) throw new Error(`ENOENT: ${path}`);
  if (!mockFiles.has(path)) throw new Error(`ENOENT: ${path}`);
  return mockFiles.get(path)!;
});

mock.module("node:fs/promises", () => ({
  readFile: mockReadFile,
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

mock.module("./privileged", () => ({
  sudoSpawn: mockSudoSpawn,
  sudoTee: mock(async () => {}),
  sudoMkdirP: mock(async () => {}),
  sudoRmF: mock(async () => {}),
  sudoChmod: mock(async () => {}),
}));

import { apply, revert } from "./light-sleep";

function resetMocks(): void {
  mockFiles.clear();
  mockMissing.clear();
  mockReadFile.mockClear();
  mockSudoSpawn.mockClear();
  spawnCalls.length = 0;
  spawnResolver = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
}

// ────────────────────────────────────────────────────────────────────
// apply()
// ────────────────────────────────────────────────────────────────────

describe("lightSleep.apply()", () => {
  beforeEach(() => resetMocks());

  it("happy path: appends both desired kargs and deletes any legacy kargs", async () => {
    mockFiles.set(
      "/proc/cmdline",
      "BOOT_IMAGE=/ostree/default root=UUID=abc amdgpu.cwsr_enable=0 ro\n",
    );

    const res = await apply();
    expect(res.success).toBe(true);
    expect(res.rebootRequired).toBe(true);

    // Exactly one rpm-ostree call.
    const calls = spawnCalls.filter((c) => c.cmd === "rpm-ostree");
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(args[0]).toBe("kargs");
    expect(args).toContain("--append=mem_sleep_default=s2idle");
    expect(args).toContain("--append=amd_iommu=off");
    expect(args).toContain("--delete=amdgpu.cwsr_enable=0");
    // 300s timeout for rpm-ostree.
    expect(
      (calls[0]!.opts as { timeoutMs?: number } | undefined)?.timeoutMs,
    ).toBe(300_000);
  });

  it("no-op when /proc/cmdline already contains both kargs and no legacy ones", async () => {
    mockFiles.set("/proc/cmdline", "root=UUID=abc mem_sleep_default=s2idle amd_iommu=off ro");

    const res = await apply();
    expect(res.success).toBe(true);
    expect(res.rebootRequired).toBe(false);
    expect(res.steps).toEqual(["no changes — kargs already correct"]);
    // No rpm-ostree invocation needed.
    expect(spawnCalls.length).toBe(0);
  });

  it("surfaces the timeout-specific error when rpm-ostree kargs times out", async () => {
    mockFiles.set("/proc/cmdline", "root=UUID=abc ro");
    spawnResolver = ({ cmd }) => {
      if (cmd === "rpm-ostree") {
        return {
          exitCode: 124,
          stdout: "",
          stderr: "",
          timedOut: true,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await apply();
    expect(res.success).toBe(false);
    expect(res.rebootRequired).toBe(false);
    expect(res.error).toContain("rpm-ostree kargs timed out");
    expect(res.error).toContain("rpm-ostree status");
  });

  it("returns failure when rpm-ostree exits non-zero", async () => {
    mockFiles.set("/proc/cmdline", "root=UUID=abc ro");
    spawnResolver = ({ cmd }) => {
      if (cmd === "rpm-ostree") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "error: Transaction in progress: deploy",
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await apply();
    expect(res.success).toBe(false);
    expect(res.error).toContain("rpm-ostree kargs failed");
    expect(res.error).toContain("Transaction in progress");
  });
});

// ────────────────────────────────────────────────────────────────────
// revert()
// ────────────────────────────────────────────────────────────────────

describe("lightSleep.revert()", () => {
  beforeEach(() => resetMocks());

  it("deletes both desired kargs when both are present", async () => {
    mockFiles.set(
      "/proc/cmdline",
      "root=UUID=abc mem_sleep_default=s2idle amd_iommu=off ro",
    );

    const res = await revert();
    expect(res.success).toBe(true);
    expect(res.rebootRequired).toBe(true);
    const calls = spawnCalls.filter((c) => c.cmd === "rpm-ostree");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("--delete=mem_sleep_default=s2idle");
    expect(calls[0]!.args).toContain("--delete=amd_iommu=off");
  });

  it("is a no-op when no desired kargs are present", async () => {
    mockFiles.set("/proc/cmdline", "root=UUID=abc ro");

    const res = await revert();
    expect(res.success).toBe(true);
    expect(res.rebootRequired).toBe(false);
    expect(res.steps).toEqual(["no kargs to remove"]);
    expect(spawnCalls.length).toBe(0);
  });

  it("returns failure when rpm-ostree exits non-zero", async () => {
    mockFiles.set("/proc/cmdline", "root=UUID=abc mem_sleep_default=s2idle ro");
    spawnResolver = ({ cmd }) => {
      if (cmd === "rpm-ostree") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "error: not pristine",
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await revert();
    expect(res.success).toBe(false);
    expect(res.error).toContain("rpm-ostree kargs failed");
    expect(res.error).toContain("not pristine");
  });
});
