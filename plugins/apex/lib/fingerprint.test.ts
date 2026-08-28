import { describe, it, expect } from "bun:test";
import {
  detectController,
  getStatus,
  apply,
  revert,
  addKargToGrubSteamos,
  removeKargFromGrubSteamos,
  KARG,
  shouldHeal,
  UDEV_RULE_PATH,
  FP_PRODUCTS,
  type FingerprintDeps,
} from "./fingerprint";
import type { RunResult } from "./xhci";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  /**
   * The cases above stub `sh` wholesale, so they never exercise the shell we
   * actually ship — a dropped product id would pass every one of them. These
   * run the emitted script for real against a fixture sysfs tree.
   *
   * The reader is not one part across the family: the Apex ships 2808:c652,
   * the X2 Mini Pro ships 2808:5952.
   */
  describe("the emitted sysfs scan (executed for real)", () => {
    async function runScanAgainst(
      devices: { name: string; vendor: string; product: string; busnum: string }[],
    ): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "loadout-fp-"));
      const devDir = join(root, "devices");
      // The bus's root hub resolves through a symlink to its PCI parent,
      // which is the whole point of the walk under test.
      await mkdir(join(root, "pci", CTRL, "usb3"), { recursive: true });
      await mkdir(devDir, { recursive: true });
      for (const d of devices) {
        await mkdir(join(devDir, d.name), { recursive: true });
        await writeFile(join(devDir, d.name, "idVendor"), d.vendor);
        await writeFile(join(devDir, d.name, "idProduct"), d.product);
        await writeFile(join(devDir, d.name, "busnum"), d.busnum);
      }
      await symlink(join(root, "pci", CTRL, "usb3"), join(devDir, "usb3"));

      // Capture the real command, then retarget it at the fixture.
      let script = "";
      const { deps } = makeFpDeps({});
      const capturing: FingerprintDeps = {
        ...deps,
        run: async (cmd) => {
          if (cmd[0] === "sh") {
            script = cmd[2]!;
            return { exitCode: 0, stdout: "", stderr: "" } as RunResult;
          }
          return deps.run(cmd);
        },
      };
      await detectController(capturing);
      expect(script).not.toBe("");

      const proc = Bun.spawn(["sh", "-c", script.replaceAll("/sys/bus/usb/devices", devDir)], {
        stdout: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await rm(root, { recursive: true, force: true });
      return out.trim();
    }

    it("pins the reader ids we've confirmed on real hardware", () => {
      // The parameterised case below derives from FP_PRODUCTS, so on its own
      // it would shrink silently if an id were dropped rather than fail.
      // These two are each attested by a device: c652 the Apex, 5952 the
      // X2 Mini Pro (doctor report, 2026-08-26).
      expect(FP_PRODUCTS).toContain("c652");
      expect(FP_PRODUCTS).toContain("5952");
    });

    it.each(FP_PRODUCTS.map((pid) => [pid]))("finds the reader with product id %s", async (pid) => {
      const found = await runScanAgainst([
        { name: "1-1", vendor: "1a86", product: "8091", busnum: "1" },
        { name: "3-3", vendor: "2808", product: pid, busnum: "3" },
      ]);
      expect(found).toBe(CTRL);
    });

    it("ignores a FocalTech device that isn't a known reader", async () => {
      // 2808 also covers FocalTech touch controllers. Disabling wakeup on one
      // of those would be the wrong device entirely.
      const found = await runScanAgainst([
        { name: "3-2", vendor: "2808", product: "1234", busnum: "3" },
      ]);
      expect(found).toBe("");
    });

    it("skips past a non-reader to find the real one on the same vendor", async () => {
      const found = await runScanAgainst([
        { name: "3-2", vendor: "2808", product: "1234", busnum: "3" },
        { name: "3-3", vendor: "2808", product: "5952", busnum: "3" },
      ]);
      expect(found).toBe(CTRL);
    });
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

describe("apply — board whose GPIO pin we haven't measured", () => {
  it("blocks the wake path it can derive, and won't stage a karg it can't verify", async () => {
    // KARG names a specific GPIO pin (AMDI0030:00@58) — board wiring, not a
    // family constant. On a sibling OneXPlayer that pin may be wrong, and
    // staging it into grub is worse than leaving the second path open. The
    // derived PME path still applies.
    const { deps, files, commands } = makeFpDeps({
      files: { "/etc/default/grub-steamos": GRUB_SAMPLE },
      cmdline: "BOOT_IMAGE=x quiet",
      distro: "steamos",
    });

    const r = await apply(deps, { autoKarg: false });

    // Path 2 — derived from the reader's own PCI parent — still applied.
    expect(r.steps).toContain("controller-wake-disabled");
    expect(r.steps).toContain("udev-rule-installed");
    // Path 1 — not staged, and the bootloader untouched.
    expect(r.steps).not.toContain("karg-staged");
    expect(files["/etc/default/grub-steamos"]).not.toContain(KARG);
    expect(commands).not.toContain("update-grub");
    // ...and we don't hand the pin over as an instruction either. Printing
    // "add gpiolib_acpi.ignore_wake=AMDI0030:00@58" to a user on a board we
    // haven't measured is the same act as staging it, with extra steps — and
    // the UI renders it as a flat instruction, not as a caveated example.
    expect(r.manualKarg).toBeUndefined();
    expect(r.steps).toContain("karg-not-applicable");
    // The operation still succeeded: PME blocking is the whole fix here, so
    // it must not report a half-failure the user would try to "fix".
    expect(r.success).toBe(true);
    expect(r.rebootRequired).toBe(false);
  });

  it("reports itself applied, rather than springing the switch back to off", async () => {
    // getStatus required kargActive for `applied`, but the karg is never
    // staged on this board — so the switch went on, PME *was* blocked, and
    // the next refresh flipped it back to off. Flipping again calls revert()
    // and undoes the one path that worked.
    const { deps } = makeFpDeps({
      files: {
        [UDEV_RULE_PATH]: "(rule)",
        [`/sys/bus/pci/devices/${CTRL}/power/wakeup`]: "disabled",
      },
      cmdline: "BOOT_IMAGE=x quiet",
      distro: "steamos",
    });

    const unmeasured = await getStatus(deps, false);
    expect(unmeasured.kargActive).toBe(false);
    expect(unmeasured.applied).toBe(true);

    // On a board we HAVE measured the karg is still genuinely required.
    const measured = await getStatus(deps, true);
    expect(measured.applied).toBe(false);
  });

  it("still stages the karg on the board we did measure", async () => {
    const { deps, files } = makeFpDeps({
      files: { "/etc/default/grub-steamos": GRUB_SAMPLE },
      cmdline: "BOOT_IMAGE=x quiet",
      distro: "steamos",
    });

    const r = await apply(deps, { autoKarg: true });

    expect(r.steps).toContain("karg-staged");
    expect(files["/etc/default/grub-steamos"]).toContain(KARG);
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

describe("rebootPending vs kargUnpersisted", () => {
  /**
   * `kargStaged !== kargActive` collapsed four distinct states into two, and
   * got one of them backwards: on a device where a SteamOS A/B update had
   * regenerated grub-steamos and dropped our line, the karg was still live
   * from the last boot, so the UI said "a kernel-parameter change is staged,
   * reboot to finish applying" — while nothing was staged, the block was
   * working, and rebooting was the single action that would undo it.
   */
  const blockOn = {
    [UDEV_RULE_PATH]: "(rule)",
    [`/sys/bus/pci/devices/${CTRL}/power/wakeup`]: "disabled",
  };

  it("staged but not live: a reboot applies it", async () => {
    const { deps } = makeFpDeps({
      // Staged in the bootloader, absent from the live cmdline.
      files: { ...blockOn, "/etc/default/grub-steamos": addKargToGrubSteamos(GRUB_SAMPLE) },
      cmdline: "BOOT_IMAGE=x quiet",
      distro: "steamos",
    });
    const s = await getStatus(deps, true);
    expect(s.kargActive).toBe(false);
    expect(s.rebootPending).toBe(true);
    expect(s.kargUnpersisted).toBe(false);
  });

  it("live and staged: nothing pending", async () => {
    const { deps } = makeFpDeps({
      files: { ...blockOn, "/etc/default/grub-steamos": addKargToGrubSteamos(GRUB_SAMPLE) },
      cmdline: `BOOT_IMAGE=x quiet ${KARG}`,
      distro: "steamos",
    });
    const s = await getStatus(deps, true);
    expect(s.rebootPending).toBe(false);
    expect(s.kargUnpersisted).toBe(false);
  });

  it("live but not staged, block still on: needs re-staging, NOT a reboot", async () => {
    // The real-device case. Rebooting here loses the protection.
    const { deps } = makeFpDeps({
      files: { ...blockOn, "/etc/default/grub-steamos": GRUB_SAMPLE },
      cmdline: `BOOT_IMAGE=x quiet ${KARG}`,
      distro: "steamos",
    });
    const s = await getStatus(deps, true);
    expect(s.kargActive).toBe(true);
    expect(s.rebootPending).toBe(false);
    expect(s.kargUnpersisted).toBe(true);
  });

  it("live but not staged, block reverted: a reboot finishes removing it", async () => {
    // No udev rule — the user turned it off, and the karg lingers until reboot.
    const { deps } = makeFpDeps({
      files: { "/etc/default/grub-steamos": GRUB_SAMPLE },
      cmdline: `BOOT_IMAGE=x quiet ${KARG}`,
      distro: "steamos",
    });
    const s = await getStatus(deps, true);
    expect(s.rebootPending).toBe(true);
    expect(s.kargUnpersisted).toBe(false);
  });
});

describe("re-staging a karg that is live but lost from the bootloader", () => {
  /**
   * The SteamOS-update state: the running kernel still has the karg, grub no
   * longer does. apply() used to return early on "it's already on the
   * cmdline" and never touch grub — so the remedy the UI offers ("switch it
   * off and on again") and the startup self-heal both reported success while
   * changing nothing, and the warning came straight back.
   */
  it("writes the karg back to grub", async () => {
    const { deps, files, commands } = makeFpDeps({
      files: {
        [UDEV_RULE_PATH]: "(rule)",
        [`/sys/bus/pci/devices/${CTRL}/power/wakeup`]: "disabled",
        "/etc/default/grub-steamos": GRUB_SAMPLE, // karg absent
      },
      cmdline: `BOOT_IMAGE=x quiet ${KARG}`, // but live
      distro: "steamos",
    });

    const r = await apply(deps, { autoKarg: true });

    expect(r.success).toBe(true);
    expect(r.steps).toContain("karg-staged");
    expect(files["/etc/default/grub-steamos"]).toContain(KARG);
    expect(commands).toContain("update-grub");
    // It is already live, so there is nothing for a reboot to achieve.
    expect(r.rebootRequired).toBe(false);
  });

  it("clears the warning it was meant to clear", async () => {
    const { deps } = makeFpDeps({
      files: {
        [UDEV_RULE_PATH]: "(rule)",
        [`/sys/bus/pci/devices/${CTRL}/power/wakeup`]: "disabled",
        "/etc/default/grub-steamos": GRUB_SAMPLE,
      },
      cmdline: `BOOT_IMAGE=x quiet ${KARG}`,
      distro: "steamos",
    });

    expect((await getStatus(deps, true)).kargUnpersisted).toBe(true);
    await apply(deps, { autoKarg: true });
    expect((await getStatus(deps, true)).kargUnpersisted).toBe(false);
  });

  it("still skips the bootloader when the karg is live and staged", async () => {
    const { deps, commands } = makeFpDeps({
      files: {
        [UDEV_RULE_PATH]: "(rule)",
        [`/sys/bus/pci/devices/${CTRL}/power/wakeup`]: "disabled",
        "/etc/default/grub-steamos": addKargToGrubSteamos(GRUB_SAMPLE),
      },
      cmdline: `BOOT_IMAGE=x quiet ${KARG}`,
      distro: "steamos",
    });

    const r = await apply(deps, { autoKarg: true });
    expect(r.steps).toContain("karg-already-active");
    expect(commands).not.toContain("update-grub");
  });
});

describe("distros whose bootloader we don't edit", () => {
  /**
   * kargStaged can only be read on SteamOS. Without gating on that, an
   * Arch/Bazzite user who followed our own manual-karg hint and rebooted got
   * a permanent alert describing a grub file they don't have.
   */
  const liveNotStaged = {
    files: {
      [UDEV_RULE_PATH]: "(rule)",
      [`/sys/bus/pci/devices/${CTRL}/power/wakeup`]: "disabled",
    },
    cmdline: `BOOT_IMAGE=x quiet ${KARG}`,
  };

  it("does not claim the karg is missing from a bootloader we never wrote", async () => {
    const { deps } = makeFpDeps({ ...liveNotStaged, distro: "arch" });
    const s = await getStatus(deps, true);
    expect(s.kargActive).toBe(true);
    expect(s.kargUnpersisted).toBe(false);
    expect(s.rebootPending).toBe(false);
  });

  it("does not claim a reboot is pending after a revert there either", async () => {
    const { deps } = makeFpDeps({
      files: {},
      cmdline: `BOOT_IMAGE=x quiet ${KARG}`,
      distro: "bazzite",
    });
    expect((await getStatus(deps, true)).rebootPending).toBe(false);
  });

  it("still reports the SteamOS case", async () => {
    const { deps } = makeFpDeps({ ...liveNotStaged, distro: "steamos" });
    expect((await getStatus(deps, true)).kargUnpersisted).toBe(true);
  });
});

describe("rebootPending and kargUnpersisted are mutually exclusive", () => {
  // The reboot button keys on rebootPending. If the two could ever be true
  // together, it would offer a reboot in the one state where rebooting is
  // what LOSES the karg.
  const cases = [
    { name: "staged, not live", cmdline: "quiet", grub: true, rule: true },
    { name: "staged and live", cmdline: `quiet ${KARG}`, grub: true, rule: true },
    { name: "live, not staged, block on", cmdline: `quiet ${KARG}`, grub: false, rule: true },
    { name: "live, not staged, reverted", cmdline: `quiet ${KARG}`, grub: false, rule: false },
    { name: "neither", cmdline: "quiet", grub: false, rule: false },
  ];

  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    const { deps } = makeFpDeps({
      files: {
        ...(c.rule ? { [UDEV_RULE_PATH]: "(rule)" } : {}),
        [`/sys/bus/pci/devices/${CTRL}/power/wakeup`]: "disabled",
        "/etc/default/grub-steamos": c.grub ? addKargToGrubSteamos(GRUB_SAMPLE) : GRUB_SAMPLE,
      },
      cmdline: c.cmdline,
      distro: "steamos",
    });
    const s = await getStatus(deps, true);
    expect(s.rebootPending && s.kargUnpersisted).toBe(false);
  });
});

describe("shouldHeal", () => {
  const ok = { supported: true, applied: true, kargUnpersisted: false };

  it("heals when the user wanted it and it is no longer applied", () => {
    // The case this exists for: a SteamOS A/B update regenerated /etc and
    // took the udev rule with it.
    expect(shouldHeal({ wanted: true, status: { ...ok, applied: false } })).toBe(true);
  });

  it("heals when the karg is live but no longer staged", () => {
    // `applied` is true here, but the karg is missing from the bootloader,
    // so the protection silently expires at the next grub regeneration.
    expect(shouldHeal({ wanted: true, status: { ...ok, kargUnpersisted: true } })).toBe(true);
  });

  it("does nothing when everything is already in effect", () => {
    expect(shouldHeal({ wanted: true, status: ok })).toBe(false);
  });

  it("never heals on a machine whose owner didn't ask for it", () => {
    // The important one. Every field in FingerprintStatus is derived from
    // /etc or the live kernel — exactly what an update wipes — so healing off
    // those would silently enable the block on devices that never had it.
    for (const wanted of [undefined, false]) {
      expect(shouldHeal({ wanted, status: { ...ok, applied: false } })).toBe(false);
      expect(shouldHeal({ wanted, status: { ...ok, kargUnpersisted: true } })).toBe(false);
    }
  });

  it("does not try on hardware with no reader", () => {
    // apply() would fail; there is nothing to re-apply.
    expect(shouldHeal({ wanted: true, status: { ...ok, supported: false, applied: false } })).toBe(
      false,
    );
  });
});
