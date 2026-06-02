/**
 * xhci-recovery helper tests — exercises rebind-now and the persistent
 * apply/revert flow. Note: rebindOnce/rebindNow contain real
 * `setTimeout` waits (500ms + 2s per attempt) that we can't override
 * without touching the helper. We test the early-exit paths and
 * apply/revert (no setTimeout) and only one happy-path rebind so the
 * suite stays fast.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── fs/promises mock ───────────────────────────────────────────────

const mockFiles = new Map<string, string>();
const mockMissing = new Set<string>();

const mockAccess = mock(async (path: string) => {
  if (mockMissing.has(path)) throw new Error(`ENOENT: ${path}`);
  if (mockFiles.has(path)) return;
  throw new Error(`ENOENT: ${path}`);
});

mock.module("node:fs/promises", () => ({
  access: mockAccess,
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

import { getStatus, rebindNow, checkAndRecover, apply, revert } from "./xhci-recovery";

const PCI_DEVICE = "0000:65:00.4";
const SCRIPT_PATH = "/usr/local/sbin/apex-resume-recover.sh";
const SERVICE_PATH = "/etc/systemd/system/apex-resume-recover.service";

function resetMocks(): void {
  mockFiles.clear();
  mockMissing.clear();
  mockAccess.mockClear();
  mockSudoSpawn.mockClear();
  mockSudoTee.mockClear();
  mockSudoMkdirP.mockClear();
  mockSudoRmF.mockClear();
  mockSudoChmod.mockClear();
  spawnCalls.length = 0;
  teeShouldFail = false;
  spawnResolver = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
}

function lsusbStdout(vidPid: string): string {
  return `Bus 003 Device 002: ID ${vidPid} OneXPlayer Device\n`;
}

// ────────────────────────────────────────────────────────────────────
// getStatus()
// ────────────────────────────────────────────────────────────────────

describe("xhciRecovery.getStatus()", () => {
  beforeEach(() => resetMocks());

  it("reports applied when service+script present, enabled, and gamepad enumerates", async () => {
    mockFiles.set(SCRIPT_PATH, "x");
    mockFiles.set(`/sys/bus/pci/devices/${PCI_DEVICE}`, "x");
    mockFiles.set(`/sys/bus/pci/devices/${PCI_DEVICE}/driver`, "x");
    mockFiles.set(SERVICE_PATH, "unit");

    spawnResolver = ({ cmd, args }) => {
      if (cmd === "systemctl" && args[0] === "is-active") {
        return { exitCode: 0, stdout: "active\n", stderr: "", timedOut: false };
      }
      if (cmd === "systemctl" && args[0] === "is-enabled") {
        return { exitCode: 0, stdout: "enabled\n", stderr: "", timedOut: false };
      }
      if (cmd === "lsusb") {
        return {
          exitCode: 0,
          stdout: lsusbStdout(args[1]),
          stderr: "",
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const s = await getStatus();
    expect(s.applied).toBe(true);
    expect(s.scriptExists).toBe(true);
    expect(s.serviceActive).toBe(true);
    expect(s.serviceEnabled).toBe(true);
    expect(s.gamepadPresent).toBe(true);
    expect(s.summary).toContain("Recovery service active");
  });

  it("flags missing PCI device when /sys/bus/pci/devices/<addr> is absent", async () => {
    // Nothing in mockFiles -> all access calls fail with ENOENT.
    spawnResolver = ({ cmd }) => {
      if (cmd === "lsusb") {
        return { exitCode: 1, stdout: "", stderr: "no device", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const s = await getStatus();
    expect(s.pciDeviceExists).toBe(false);
    expect(s.applied).toBe(false);
    expect(s.summary).toContain(`PCI device ${PCI_DEVICE} missing`);
  });
});

// ────────────────────────────────────────────────────────────────────
// rebindNow() / checkAndRecover()
// ────────────────────────────────────────────────────────────────────

describe("xhciRecovery.rebindNow()", () => {
  beforeEach(() => resetMocks());

  it("returns early without rebinding when PCI device is absent", async () => {
    // No PCI device in mockFiles.
    const r = await rebindNow();
    expect(r.success).toBe(false);
    expect(r.attempts).toBe(0);
    expect(r.error).toContain(`PCI device ${PCI_DEVICE} not present`);
    // No sudoSpawn calls should have been made.
    expect(spawnCalls.length).toBe(0);
  });
});

describe("xhciRecovery.checkAndRecover()", () => {
  beforeEach(() => resetMocks());

  it("returns success without rebinding when both gamepad USB devices are already present", async () => {
    spawnResolver = ({ cmd, args }) => {
      if (cmd === "lsusb") {
        return {
          exitCode: 0,
          stdout: lsusbStdout(args[1]),
          stderr: "",
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const r = await checkAndRecover();
    expect(r.success).toBe(true);
    expect(r.gamepadPresent).toBe(true);
    expect(r.attempts).toBe(0);
    // Should only have called lsusb (twice — HID + Xbox pad).
    const cmds = spawnCalls.map((c) => c.cmd);
    expect(cmds.every((c) => c === "lsusb")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// apply()
// ────────────────────────────────────────────────────────────────────

describe("xhciRecovery.apply()", () => {
  beforeEach(() => resetMocks());

  it("short-circuits when service is already applied (active + enabled + script)", async () => {
    mockFiles.set(SCRIPT_PATH, "x");
    mockFiles.set(`/sys/bus/pci/devices/${PCI_DEVICE}`, "x");
    mockFiles.set(`/sys/bus/pci/devices/${PCI_DEVICE}/driver`, "x");
    mockFiles.set(SERVICE_PATH, "unit");

    spawnResolver = ({ cmd, args }) => {
      if (cmd === "systemctl" && args[0] === "is-active") {
        return { exitCode: 0, stdout: "active\n", stderr: "", timedOut: false };
      }
      if (cmd === "systemctl" && args[0] === "is-enabled") {
        return { exitCode: 0, stdout: "enabled\n", stderr: "", timedOut: false };
      }
      if (cmd === "lsusb") {
        return { exitCode: 0, stdout: lsusbStdout(args[1]), stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await apply();
    expect(res.success).toBe(true);
    expect(res.steps).toEqual(["already applied"]);
  });

  it("installs script+service and enables the unit on a clean system", async () => {
    // No SCRIPT_PATH/SERVICE_PATH in mockFiles -> getStatus.applied=false.
    spawnResolver = ({ cmd, args }) => {
      if (cmd === "systemctl") {
        // is-active/is-enabled before install return non-zero.
        if (args[0] === "enable") {
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        }
        if (args[0] === "daemon-reload") {
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        }
        return { exitCode: 3, stdout: "inactive\n", stderr: "", timedOut: false };
      }
      if (cmd === "lsusb") {
        return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await apply();
    expect(res.success).toBe(true);
    const stepsStr = res.steps.join("|");
    expect(stepsStr).toContain(`wrote ${SCRIPT_PATH}`);
    expect(stepsStr).toContain(`wrote ${SERVICE_PATH}`);
    expect(stepsStr).toContain("enabled apex-resume-recover.service");

    // mkdir -p /usr/local/sbin was called.
    expect(mockSudoMkdirP).toHaveBeenCalledWith("/usr/local/sbin");
    // chmod 755 on the script.
    expect(mockSudoChmod).toHaveBeenCalledWith(SCRIPT_PATH, "755");
  });

  it("propagates sudoTee error when writing the recovery script fails", async () => {
    teeShouldFail = true;
    spawnResolver = ({ cmd }) => {
      if (cmd === "systemctl") {
        return { exitCode: 3, stdout: "inactive\n", stderr: "", timedOut: false };
      }
      if (cmd === "lsusb") {
        return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await apply();
    expect(res.success).toBe(false);
    expect(res.error).toContain("permission denied");
  });

  it("returns error when systemctl enable --now fails", async () => {
    spawnResolver = ({ cmd, args }) => {
      if (cmd === "systemctl") {
        if (args[0] === "enable") {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Failed to enable unit: missing dependency",
            timedOut: false,
          };
        }
        if (args[0] === "daemon-reload") {
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
        }
        return { exitCode: 3, stdout: "inactive\n", stderr: "", timedOut: false };
      }
      if (cmd === "lsusb") {
        return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await apply();
    expect(res.success).toBe(false);
    expect(res.error).toContain("enable --now apex-resume-recover.service failed");
    expect(res.error).toContain("missing dependency");
  });
});

// ────────────────────────────────────────────────────────────────────
// revert()
// ────────────────────────────────────────────────────────────────────

describe("xhciRecovery.revert()", () => {
  beforeEach(() => resetMocks());

  it("disables service, removes files, and reloads systemd", async () => {
    mockFiles.set(SERVICE_PATH, "unit");
    spawnResolver = ({ cmd, args }) => {
      if (cmd === "systemctl" && args[0] === "disable") {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };

    const res = await revert();
    expect(res.success).toBe(true);
    const stepsStr = res.steps.join("|");
    expect(stepsStr).toContain("disabled apex-resume-recover.service");
    expect(stepsStr).toContain("removed service + script");
    expect(mockSudoRmF).toHaveBeenCalledWith(SERVICE_PATH);
    expect(mockSudoRmF).toHaveBeenCalledWith(SCRIPT_PATH);
  });
});
