import { describe, it, expect } from "bun:test";
import {
  parseDeadController,
  gamepadPresent,
  pickController,
  getStatus,
  recover,
  DEFAULT_XHCI_PCI,
  GAMEPAD_IDS,
  type XhciDeps,
  type RunResult,
} from "./xhci";

/**
 * xHCI recovery tests. All hardware access is injected, so these are
 * pure unit tests of the dead-controller parser, the controller picker,
 * the status snapshot, and the rebind orchestration — no root, no sysfs,
 * no real controller.
 */

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (): RunResult => ({ stdout: "", stderr: "", exitCode: 1 });

/** Build a deps double. `present` controls whether the gamepad IDs are
 *  reported by lsusb; `paths` is the set of existing fs paths; `commands`
 *  records every command line that goes out. */
function makeDeps(opts: {
  present?: boolean | boolean[];
  paths?: Set<string>;
  dmesg?: string;
  commands?: string[];
}): XhciDeps {
  const paths = opts.paths ?? new Set<string>();
  const commands = opts.commands ?? [];
  // `present` may be an array to model "absent then present" across the
  // recover() poll loop. A "sweep" is one gamepadPresent() call; since
  // every sweep starts by checking GAMEPAD_IDS[0], we latch that sweep's
  // presence there (gamepadPresent short-circuits, so we can't key off
  // the last ID).
  let sweep = 0;
  let sweepPresent = false;
  const presence = Array.isArray(opts.present) ? opts.present : [opts.present ?? false];

  return {
    run: async (cmd) => {
      commands.push(cmd.join(" "));
      if (cmd[0] === "dmesg") return ok(opts.dmesg ?? "");
      if (cmd[0] === "lsusb") {
        const id = cmd[2];
        if (id === GAMEPAD_IDS[0]) {
          sweepPresent = presence[Math.min(sweep, presence.length - 1)];
          sweep++;
        }
        return sweepPresent ? ok(id) : fail();
      }
      if (cmd[0] === "systemctl" && cmd[1] === "is-active") return ok("active");
      return ok();
    },
    pathExists: async (p) => paths.has(p),
    sleep: async () => {},
  };
}

describe("parseDeadController", () => {
  it("extracts the PCI address from an 'assume dead' line", () => {
    const log = "xhci_hcd 0000:65:00.4: xHCI host controller not responding, assume dead";
    expect(parseDeadController(log)).toBe("0000:65:00.4");
  });

  it("extracts from an 'HC died' line", () => {
    expect(parseDeadController("xhci_hcd 0000:01:00.3: HC died; cleaning up")).toBe("0000:01:00.3");
  });

  it("returns the LAST dead controller when several appear", () => {
    const log = [
      "xhci_hcd 0000:11:00.0: HC died; cleaning up",
      "xhci_hcd 0000:65:00.4: xHCI host controller not responding, assume dead",
    ].join("\n");
    expect(parseDeadController(log)).toBe("0000:65:00.4");
  });

  it("returns null when nothing died", () => {
    expect(parseDeadController("usb 1-1: new high-speed USB device")).toBeNull();
  });
});

describe("gamepadPresent", () => {
  it("is true only when every gamepad ID enumerates", async () => {
    const deps = makeDeps({ present: true });
    expect(await gamepadPresent(deps.run)).toBe(true);
  });

  it("is false when an ID is missing", async () => {
    const deps = makeDeps({ present: false });
    expect(await gamepadPresent(deps.run)).toBe(false);
  });
});

describe("pickController", () => {
  it("prefers an explicit override", async () => {
    const deps = makeDeps({ dmesg: "" });
    const r = await pickController(deps, "0000:aa:00.0");
    expect(r).toEqual({ controller: "0000:aa:00.0", deadInLog: false });
  });

  it("uses the dead controller from dmesg when present", async () => {
    const deps = makeDeps({
      dmesg: "xhci_hcd 0000:65:00.4: HC died; cleaning up",
    });
    const r = await pickController(deps);
    expect(r).toEqual({ controller: "0000:65:00.4", deadInLog: true });
  });

  it("falls back to the default when dmesg is clean", async () => {
    const deps = makeDeps({ dmesg: "all good" });
    const r = await pickController(deps);
    expect(r).toEqual({ controller: DEFAULT_XHCI_PCI, deadInLog: false });
  });
});

describe("getStatus", () => {
  it("reports healthy when the gamepad enumerates", async () => {
    const deps = makeDeps({
      present: true,
      paths: new Set([
        `/sys/bus/pci/devices/${DEFAULT_XHCI_PCI}`,
        `/sys/bus/pci/devices/${DEFAULT_XHCI_PCI}/driver`,
      ]),
    });
    const s = await getStatus(deps);
    expect(s.gamepadPresent).toBe(true);
    expect(s.driverBound).toBe(true);
    expect(s.summary).toContain("healthy");
  });

  it("reports the controller-died case from the kernel log", async () => {
    const deps = makeDeps({
      present: false,
      dmesg: "xhci_hcd 0000:65:00.4: assume dead",
      paths: new Set([`/sys/bus/pci/devices/0000:65:00.4`]),
    });
    const s = await getStatus(deps);
    expect(s.gamepadPresent).toBe(false);
    expect(s.deadInLog).toBe(true);
    expect(s.summary).toContain("died on resume");
  });

  it("flags a missing PCI device", async () => {
    const deps = makeDeps({ present: false, paths: new Set() });
    const s = await getStatus(deps);
    expect(s.pciDeviceExists).toBe(false);
    expect(s.summary).toContain("not present");
  });
});

describe("recover", () => {
  it("errors out when the PCI device does not exist", async () => {
    const deps = makeDeps({ paths: new Set() });
    const r = await recover(deps, { override: "0000:99:00.0" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("does not exist");
    expect(r.steps).toHaveLength(0);
  });

  it("no-ops when the gamepad is already present (loop guard)", async () => {
    const commands: string[] = [];
    const pci = DEFAULT_XHCI_PCI;
    const deps = makeDeps({
      present: true,
      dmesg: `xhci_hcd ${pci}: assume dead`,
      paths: new Set([`/sys/bus/pci/devices/${pci}`, `/sys/bus/pci/devices/${pci}/driver`]),
      commands,
    });
    const r = await recover(deps);
    expect(r.success).toBe(true);
    expect(r.alreadyHealthy).toBe(true);
    expect(r.steps).toHaveLength(0);
    // Critically: no rebind, no InputPlumber touch — nothing that could
    // re-trigger this call.
    expect(commands).not.toContain("tee /sys/bus/pci/drivers/xhci_hcd/bind");
    expect(commands.some((c) => c.startsWith("systemctl"))).toBe(false);
  });

  it("forces a rebind even when the gamepad is present", async () => {
    const commands: string[] = [];
    const pci = DEFAULT_XHCI_PCI;
    const deps = makeDeps({
      present: true,
      dmesg: `xhci_hcd ${pci}: assume dead`,
      paths: new Set([`/sys/bus/pci/devices/${pci}`, `/sys/bus/pci/devices/${pci}/driver`]),
      commands,
    });
    const r = await recover(deps, { force: true });
    expect(r.success).toBe(true);
    expect(r.alreadyHealthy).toBeUndefined();
    expect(commands).toContain("tee /sys/bus/pci/drivers/xhci_hcd/bind");
  });

  it("unbinds and binds on a genuine recovery, never restarting InputPlumber", async () => {
    const commands: string[] = [];
    const pci = DEFAULT_XHCI_PCI;
    const deps = makeDeps({
      // absent at the guard check, present once the bus re-enumerates
      present: [false, true],
      dmesg: `xhci_hcd ${pci}: assume dead`,
      paths: new Set([`/sys/bus/pci/devices/${pci}`, `/sys/bus/pci/devices/${pci}/driver`]),
      commands,
    });
    const r = await recover(deps);
    expect(r.success).toBe(true);
    expect(r.controller).toBe(pci);
    expect(r.steps).toEqual(["unbind", "bind"]);
    expect(commands).toContain(`tee /sys/bus/pci/drivers/xhci_hcd/unbind`);
    expect(commands).toContain(`tee /sys/bus/pci/drivers/xhci_hcd/bind`);
    // The plugin must NOT restart InputPlumber — that restart is what
    // caused the re-press feedback loop.
    expect(commands.some((c) => c.startsWith("systemctl"))).toBe(false);
  });

  it("reports failure when the gamepad never comes back", async () => {
    const pci = DEFAULT_XHCI_PCI;
    const deps = makeDeps({
      present: false,
      dmesg: `xhci_hcd ${pci}: assume dead`,
      paths: new Set([`/sys/bus/pci/devices/${pci}`]),
    });
    const r = await recover(deps);
    expect(r.success).toBe(false);
    expect(r.gamepadPresent).toBe(false);
    expect(r.error).toContain("still missing");
  });

  it("retries the bind when the driver doesn't re-attach", async () => {
    const commands: string[] = [];
    const pci = DEFAULT_XHCI_PCI;
    // Absent at the guard, present after rebind. Driver link never
    // present → no initial unbind, and the post-bind check fails → a
    // retry bind is issued.
    const deps = makeDeps({
      present: [false, true],
      dmesg: `xhci_hcd ${pci}: assume dead`,
      paths: new Set([`/sys/bus/pci/devices/${pci}`]),
      commands,
    });
    const r = await recover(deps);
    expect(r.steps).toContain("bind-retry");
    expect(r.steps).not.toContain("unbind");
    expect(r.success).toBe(true);
  });
});
