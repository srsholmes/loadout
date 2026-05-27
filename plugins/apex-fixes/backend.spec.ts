/**
 * apex-fixes tests — scoped to pure logic + fs-mocked paths.
 *
 * Deliberately no coverage for spawn-dependent paths (modprobe,
 * rpm-ostree, systemctl, udevadm, lsusb, ostree unlock). Those only
 * make sense against a real system and are verified manually via the
 * smoke-test steps in the plan file. Mocking sudo output and then
 * asserting it would just test the mocks.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock node:fs/promises BEFORE importing anything that uses it.
// Each test sets `mockFiles` / `mockDirs`; the mocks dispatch on path.
const mockFiles = new Map<string, string>();
const mockDirs = new Map<string, string[]>();
const mockMissingPaths = new Set<string>();

const mockReadFile = mock(async (path: string) => {
  if (mockMissingPaths.has(path)) throw new Error(`ENOENT: ${path}`);
  if (!mockFiles.has(path)) throw new Error(`ENOENT: ${path}`);
  return mockFiles.get(path)!;
});

const mockAccess = mock(async (path: string) => {
  if (mockMissingPaths.has(path)) throw new Error(`ENOENT: ${path}`);
  if (mockFiles.has(path) || mockDirs.has(path)) return;
  throw new Error(`ENOENT: ${path}`);
});

const mockReaddir = mock(async (path: string) => {
  if (!mockDirs.has(path)) throw new Error(`ENOENT: ${path}`);
  return mockDirs.get(path)!;
});

const mockStat = mock(async (path: string) => {
  if (mockMissingPaths.has(path)) throw new Error(`ENOENT: ${path}`);
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
  access: mockAccess,
  readdir: mockReaddir,
  stat: mockStat,
}));

import { isApexDmi } from "./src/dmi";
import { cmdlineContainsKarg, getStatus as lightSleepStatus } from "./src/light-sleep";
import { getStatus as sleepEnableStatus } from "./src/sleep-enable";

function resetMocks(): void {
  mockFiles.clear();
  mockDirs.clear();
  mockMissingPaths.clear();
  mockReadFile.mockClear();
  mockAccess.mockClear();
  mockReaddir.mockClear();
  mockStat.mockClear();
}

// ---------------------------------------------------------------------------
// DMI guard
// ---------------------------------------------------------------------------

describe("isApexDmi()", () => {
  it("accepts the canonical APEX DMI", () => {
    expect(
      isApexDmi({
        sysVendor: "ONE-NETBOOK",
        productName: "ONEXPLAYER APEX",
        productFamily: "",
        boardName: "",
      }),
    ).toBe(true);
  });

  it("accepts future APEX revisions with suffixed product_name", () => {
    expect(
      isApexDmi({
        sysVendor: "ONE-NETBOOK",
        productName: "ONEXPLAYER APEX 2",
        productFamily: "",
        boardName: "",
      }),
    ).toBe(true);
  });

  it("rejects other OneXPlayer models", () => {
    expect(
      isApexDmi({
        sysVendor: "ONE-NETBOOK",
        productName: "ONEXPLAYER X1",
        productFamily: "",
        boardName: "",
      }),
    ).toBe(false);
  });

  it("rejects non-OneXPlayer hardware", () => {
    expect(
      isApexDmi({
        sysVendor: "Valve",
        productName: "Jupiter",
        productFamily: "",
        boardName: "",
      }),
    ).toBe(false);
  });

  it("rejects empty DMI (VM or unreadable)", () => {
    expect(
      isApexDmi({
        sysVendor: "",
        productName: "",
        productFamily: "",
        boardName: "",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Light sleep — kargs parsing
// ---------------------------------------------------------------------------

describe("cmdlineContainsKarg()", () => {
  it("matches a karg as a whole token", () => {
    const cl =
      "BOOT_IMAGE=/ostree/default root=UUID=abc mem_sleep_default=s2idle amd_iommu=off ro";
    expect(cmdlineContainsKarg(cl, "mem_sleep_default=s2idle")).toBe(true);
    expect(cmdlineContainsKarg(cl, "amd_iommu=off")).toBe(true);
  });

  it("does NOT match a karg whose prefix happens to appear", () => {
    // `amd_iommu=off` is present, `amd_iommu=on` is not. The naive
    // `cmdline.includes("amd_iommu=on")` would return true (because
    // "amd_iommu=off" contains "amd_iommu=o" then "n" elsewhere,
    // though actually that particular pair is safe). The real trap
    // is `amd_iommu=on` being a substring of something like
    // `amd_iommu=on_demand`, which doesn't exist in Linux but
    // illustrates the reason for tokenising.
    const cl = "root=UUID=abc amd_iommu=off ro";
    expect(cmdlineContainsKarg(cl, "amd_iommu=on")).toBe(false);
    expect(cmdlineContainsKarg(cl, "amd_iommu=off")).toBe(true);
  });

  it("handles tabs and multiple spaces between kargs", () => {
    const cl = "a\t\tb   c\nd";
    expect(cmdlineContainsKarg(cl, "a")).toBe(true);
    expect(cmdlineContainsKarg(cl, "b")).toBe(true);
    expect(cmdlineContainsKarg(cl, "c")).toBe(true);
    expect(cmdlineContainsKarg(cl, "d")).toBe(true);
    expect(cmdlineContainsKarg(cl, "e")).toBe(false);
  });

  it("returns false on empty cmdline", () => {
    expect(cmdlineContainsKarg("", "anything")).toBe(false);
  });
});

describe("lightSleep.getStatus()", () => {
  beforeEach(() => resetMocks());

  it("reports applied when both desired kargs present and no legacy kargs", async () => {
    mockFiles.set(
      "/proc/cmdline",
      "BOOT_IMAGE=/ostree/default root=UUID=abc mem_sleep_default=s2idle amd_iommu=off ro\n",
    );
    const s = await lightSleepStatus();
    expect(s.applied).toBe(true);
    expect(s.desiredMissing).toEqual([]);
    expect(s.problematicFound).toEqual([]);
  });

  it("flags partial application when only one karg is present", async () => {
    mockFiles.set("/proc/cmdline", "root=UUID=abc mem_sleep_default=s2idle ro");
    const s = await lightSleepStatus();
    expect(s.applied).toBe(false);
    expect(s.desiredPresent).toEqual(["mem_sleep_default=s2idle"]);
    expect(s.desiredMissing).toEqual(["amd_iommu=off"]);
  });

  it("flags problematic kargs even when desired are present", async () => {
    mockFiles.set(
      "/proc/cmdline",
      "mem_sleep_default=s2idle amd_iommu=off acpi.ec_no_wakeup=1",
    );
    const s = await lightSleepStatus();
    expect(s.applied).toBe(false);
    expect(s.problematicFound).toEqual(["acpi.ec_no_wakeup=1"]);
  });

  it("handles an unreadable /proc/cmdline as all-missing", async () => {
    mockMissingPaths.add("/proc/cmdline");
    const s = await lightSleepStatus();
    expect(s.applied).toBe(false);
    expect(s.desiredMissing.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Sleep enable — fw-fanctrl-suspend + udev rule detection
// ---------------------------------------------------------------------------

describe("sleepEnable.getStatus()", () => {
  const FW_SCRIPT = "/usr/lib/systemd/system-sleep/fw-fanctrl-suspend";
  const RULE = "/etc/udev/rules.d/91-oxp-fingerprint-no-wakeup.rules";

  beforeEach(() => resetMocks());

  it("reports applied when script is a no-op AND udev rule exists", async () => {
    mockFiles.set(
      FW_SCRIPT,
      "#!/bin/bash\n# Neutralized by Apex Fixes\nexit 0\n",
    );
    mockFiles.set(RULE, "# present\n");
    const s = await sleepEnableStatus();
    expect(s.applied).toBe(true);
    expect(s.fwScriptNeutralized).toBe(true);
    expect(s.fingerprintRuleInstalled).toBe(true);
  });

  it("reports applied when fw-fanctrl-suspend is missing entirely", async () => {
    // No FW_SCRIPT mock = missing. Udev rule still needed.
    mockFiles.set(RULE, "present");
    const s = await sleepEnableStatus();
    expect(s.fwScriptExists).toBe(false);
    expect(s.fwScriptNeutralized).toBe(true);
    expect(s.applied).toBe(true);
  });

  it("reports NOT neutralized when script is a real Framework script", async () => {
    // Simulate the real Framework script — anything 100+ bytes and
    // not ending with "exit 0".
    mockFiles.set(FW_SCRIPT, "#!/bin/bash\n" + "echo foo; ".repeat(50) + "echo done\n");
    mockFiles.set(RULE, "present");
    const s = await sleepEnableStatus();
    expect(s.fwScriptNeutralized).toBe(false);
    expect(s.applied).toBe(false);
  });

  it("treats short script (<100 bytes) as already neutralized", async () => {
    mockFiles.set(FW_SCRIPT, "#!/bin/bash\n");
    mockFiles.set(RULE, "present");
    const s = await sleepEnableStatus();
    expect(s.fwScriptNeutralized).toBe(true);
    expect(s.applied).toBe(true);
  });

  it("missing udev rule is flagged", async () => {
    mockFiles.set(FW_SCRIPT, "#!/bin/bash\nexit 0\n");
    // No RULE mock.
    const s = await sleepEnableStatus();
    expect(s.fingerprintRuleInstalled).toBe(false);
    expect(s.applied).toBe(false);
    expect(s.summary.toLowerCase()).toContain("fingerprint");
  });
});

// ---------------------------------------------------------------------------
// Backend DMI guard
// ---------------------------------------------------------------------------
//
// We can't easily run the full ApexFixesBackend.onLoad without also
// mocking Bun.spawn + all the privileged helpers, which would just
// test the mocks. Instead we verify the observable guard: apply/revert
// on non-APEX hardware returns a specific error without calling into
// the per-fix modules.

describe("ApexFixesBackend DMI guard", () => {
  beforeEach(() => resetMocks());

  it("applyFix returns non-APEX error when DMI does not match", async () => {
    // Mock DMI sysfs to return a Valve Steam Deck.
    mockFiles.set("/sys/class/dmi/id/sys_vendor", "Valve");
    mockFiles.set("/sys/class/dmi/id/product_name", "Jupiter");
    mockFiles.set("/sys/class/dmi/id/product_family", "");
    mockFiles.set("/sys/class/dmi/id/board_name", "Jupiter");

    // Import AFTER mocks are set so onLoad reads the mocked DMI.
    // Fresh require each time to pick up mocks.
    const mod = await import("./backend");
    const backend = new mod.default();
    // Intentionally do NOT call onLoad (it sets a periodic timer we'd
    // have to clear). Instead seed the DMI state directly — mirrors
    // what onLoad would set.
    (backend as unknown as { isApex: boolean }).isApex = false;

    const outcome = await backend.applyFix("oxpec");
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("non-APEX hardware");

    const status = await backend.getStatus();
    expect(status.isApex).toBe(false);
    for (const k of ["oxpec", "lightSleep", "sleepEnable", "xhciRecovery"] as const) {
      expect(status.fixes[k].state).toBe("n_a");
    }
  });
});
