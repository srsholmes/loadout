import { describe, it, expect } from "bun:test";
import {
  detectController,
  getStatus,
  apply,
  revert,
  addKargToGrubSteamos,
  removeKargFromGrubSteamos,
  KARG,
  UDEV_RULE_PATH,
  type FingerprintDeps,
} from "./fingerprint";
import type { RunResult } from "./xhci";

/**
 * Fingerprint-wake-block tests. All hardware/OS access is injected, so these
 * are pure unit tests of detection, status, the grub edit, and the apply/
 * revert orchestration — no root, sysfs, USB, or real bootloader.
 */

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (): RunResult => ({ stdout: "", stderr: "", exitCode: 1 });

const CTRL = "0000:67:00.0";

const GRUB_SAMPLE = [
  'GRUB_CMDLINE_LINUX="${GRUB_CMDLINE_LINUX} \\',
  "amd_iommu=off \\",
  "fsck.repair=preen \\",
  '"',
  "",
].join("\n");

interface FakeOpts {
  fpPresent?: boolean;
  controller?: string;
  files?: Record<string, string>;
  cmdline?: string;
  distro?: string;
  commands?: string[];
  /** Force update-grub to fail, to exercise the rollback path. */
  updateGrubFails?: boolean;
}

function makeFpDeps(o: FakeOpts = {}): { deps: FingerprintDeps; files: Record<string, string>; commands: string[] } {
  const files: Record<string, string> = { ...(o.files ?? {}) };
  const commands = o.commands ?? [];
  const fpPresent = o.fpPresent ?? true;
  const controller = o.controller ?? CTRL;

  const deps: FingerprintDeps = {
    run: async (cmd) => {
      commands.push(cmd.join(" "));
      if (cmd[0] === "lsusb") return fpPresent ? ok("Bus 003 Device 004: ID 2808:c652") : fail();
      if (cmd[0] === "sh") return fpPresent ? ok(`${controller}\n`) : ok("");
      if (cmd[0] === "tee") {
        // model `tee path` writing stdin into the file
        files[cmd[1]] = "(sysfs)";
        return ok();
      }
      if (cmd[0] === "update-grub") return o.updateGrubFails ? fail() : ok();
      return ok();
    },
    pathExists: async (p) => p in files,
    readFile: async (p) => {
      if (p in files) return files[p];
      throw new Error("ENOENT");
    },
    writeFile: async (p, c) => {
      files[p] = c;
    },
    removeFile: async (p) => {
      delete files[p];
    },
    readCmdline: async () => o.cmdline ?? "",
    distroId: async () => o.distro ?? "steamos",
  };
  return { deps, files, commands };
}

describe("grub karg edit", () => {
  it("inserts the karg as a continued line before the closing quote", () => {
    const out = addKargToGrubSteamos(GRUB_SAMPLE);
    expect(out).toContain(KARG);
    // The karg line is continued (\) and the block still closes with a quote.
    expect(out).toMatch(new RegExp(`${KARG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\\\\\n"`));
  });

  it("is idempotent — doesn't double-add", () => {
    const once = addKargToGrubSteamos(GRUB_SAMPLE);
    const twice = addKargToGrubSteamos(once);
    expect(twice).toBe(once);
  });

  it("removes the karg line cleanly", () => {
    const withKarg = addKargToGrubSteamos(GRUB_SAMPLE);
    const removed = removeKargFromGrubSteamos(withKarg);
    expect(removed).not.toContain(KARG);
    expect(removed).toContain("amd_iommu=off");
  });
});

describe("detectController", () => {
  it("resolves the xHCI controller when the reader is present", async () => {
    const { deps } = makeFpDeps({ fpPresent: true, controller: CTRL });
    expect(await detectController(deps)).toBe(CTRL);
  });

  it("returns null when the reader is absent", async () => {
    const { deps } = makeFpDeps({ fpPresent: false });
    expect(await detectController(deps)).toBeNull();
  });
});

describe("getStatus", () => {
  it("reports applied when both paths are closed", async () => {
    const { deps } = makeFpDeps({
      files: {
        [`/sys/bus/pci/devices/${CTRL}/power/wakeup`]: "disabled\n",
        [UDEV_RULE_PATH]: "rule",
        // Applied steady state: karg both staged in grub AND live on cmdline.
        "/etc/default/grub-steamos": addKargToGrubSteamos(GRUB_SAMPLE),
      },
      cmdline: `BOOT_IMAGE=x ${KARG} quiet`,
    });
    const s = await getStatus(deps);
    expect(s.supported).toBe(true);
    expect(s.controllerWakeDisabled).toBe(true);
    expect(s.udevRuleInstalled).toBe(true);
    expect(s.kargActive).toBe(true);
    expect(s.applied).toBe(true);
    expect(s.rebootPending).toBe(false);
  });

  it("flags rebootPending when the karg is staged but not yet live", async () => {
    const { deps } = makeFpDeps({
      files: { "/etc/default/grub-steamos": addKargToGrubSteamos(GRUB_SAMPLE) },
      cmdline: "BOOT_IMAGE=x quiet", // karg not active yet
    });
    const s = await getStatus(deps);
    expect(s.kargStaged).toBe(true);
    expect(s.kargActive).toBe(false);
    expect(s.rebootPending).toBe(true);
    expect(s.applied).toBe(false);
  });
});

describe("apply / revert (SteamOS)", () => {
  it("closes path 2 immediately and stages the karg (reboot required)", async () => {
    const { deps, files, commands } = makeFpDeps({
      files: { "/etc/default/grub-steamos": GRUB_SAMPLE },
      cmdline: "BOOT_IMAGE=x quiet",
      distro: "steamos",
    });
    const r = await apply(deps);
    expect(r.success).toBe(true);
    expect(r.rebootRequired).toBe(true);
    expect(r.steps).toContain("controller-wake-disabled");
    expect(r.steps).toContain("udev-rule-installed");
    expect(r.steps).toContain("karg-staged");
    expect(files[UDEV_RULE_PATH]).toContain(CTRL);
    expect(files["/etc/default/grub-steamos"]).toContain(KARG);
    expect(commands).toContain("update-grub");
  });

  it("rolls back grub if update-grub fails", async () => {
    const { deps, files } = makeFpDeps({
      files: { "/etc/default/grub-steamos": GRUB_SAMPLE },
      cmdline: "BOOT_IMAGE=x quiet",
      distro: "steamos",
      updateGrubFails: true,
    });
    const r = await apply(deps);
    expect(r.success).toBe(false);
    expect(r.error).toContain("karg");
    // grub-steamos restored to the original (no karg left behind).
    expect(files["/etc/default/grub-steamos"]).not.toContain(KARG);
  });

  it("revert re-enables the controller and removes the karg", async () => {
    const { deps, files, commands } = makeFpDeps({
      files: {
        [`/sys/bus/pci/devices/${CTRL}/power/wakeup`]: "disabled",
        [UDEV_RULE_PATH]: "rule",
        "/etc/default/grub-steamos": addKargToGrubSteamos(GRUB_SAMPLE),
      },
      cmdline: `BOOT_IMAGE=x ${KARG}`,
      distro: "steamos",
    });
    const r = await revert(deps);
    expect(r.success).toBe(true);
    expect(r.steps).toContain("controller-wake-enabled");
    expect(r.steps).toContain("udev-rule-removed");
    expect(files[UDEV_RULE_PATH]).toBeUndefined();
    expect(files["/etc/default/grub-steamos"]).not.toContain(KARG);
    expect(commands).toContain("update-grub");
  });
});

describe("apply (non-SteamOS)", () => {
  it("closes path 2 but surfaces a manual karg for the GPIO path", async () => {
    const { deps, files } = makeFpDeps({
      cmdline: "BOOT_IMAGE=x quiet",
      distro: "cachyos",
    });
    const r = await apply(deps);
    expect(r.success).toBe(true);
    expect(r.manualKarg).toBe(KARG);
    expect(r.rebootRequired).toBe(true);
    expect(files[UDEV_RULE_PATH]).toContain(CTRL); // path 2 still applied
  });
});
