import { describe, it, expect } from "bun:test";
import {
  parseNmDeviceStatus,
  findWifiDevice,
  modulesForDriver,
  findModuleHolders,
  readRfkill,
  detectDriverInfo,
  getWifiDevice,
  nmRadioEnabled,
  recover,
  initialWatchdogState,
  evaluateWatchdog,
  recordRecoveryOutcome,
  DEFAULT_WATCHDOG,
  type RecoveryDeps,
  type DriverInfo,
  type WatchdogSample,
} from "./recovery";

/**
 * In-memory harness: a fake clock (sleep advances it — no real waiting),
 * scripted modprobe results, a mutable nmcli snapshot the test flips to
 * simulate the radio dying/recovering, and sysfs files/links as records.
 */
function makeHarness(init?: { rfkillAbsent?: boolean }) {
  const ok = { stdout: "", stderr: "", exitCode: 0 };
  const h = {
    calls: [] as string[][],
    writes: [] as Array<[string, string]>,
    files: {} as Record<string, string>,
    links: {} as Record<string, string>,
    /** Current `nmcli -t ... device status` output. */
    nmState: "",
    rfkill: { soft: "0", hard: "0", present: !init?.rfkillAbsent },
    onModprobe: undefined as
      | ((cmd: string[]) => { stdout: string; stderr: string; exitCode: number })
      | undefined,
    /** Override nmcli results (default: exit 0 with h.nmState). */
    onNmcli: undefined as
      | ((cmd: string[]) => { stdout: string; stderr: string; exitCode: number })
      | undefined,
    onWrite: undefined as ((path: string) => void) | undefined,
    time: 0,
    deps: undefined as unknown as RecoveryDeps,
  };
  h.deps = {
    run: async (cmd) => {
      h.calls.push(cmd);
      if (cmd[0] === "nmcli")
        return h.onNmcli?.(cmd) ?? { stdout: h.nmState, stderr: "", exitCode: 0 };
      if (cmd[0] === "modprobe") return h.onModprobe?.(cmd) ?? ok;
      return ok;
    },
    readFile: async (path) => {
      if (h.rfkill.present) {
        if (path === "/sys/class/rfkill/rfkill0/type") return "wlan\n";
        if (path === "/sys/class/rfkill/rfkill0/soft") return `${h.rfkill.soft}\n`;
        if (path === "/sys/class/rfkill/rfkill0/hard") return `${h.rfkill.hard}\n`;
      }
      const content = h.files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path, content) => {
      h.writes.push([path, content]);
      h.onWrite?.(path);
    },
    readlink: async (path) => {
      const target = h.links[path];
      if (target === undefined) throw new Error(`ENOENT: ${path}`);
      return target;
    },
    listDir: async (path) => {
      if (path === "/sys/class/rfkill") {
        if (!h.rfkill.present) throw new Error("ENOENT: /sys/class/rfkill");
        return ["rfkill0"];
      }
      throw new Error(`ENOENT: ${path}`);
    },
    sleep: async (ms) => {
      h.time += ms;
    },
    now: () => h.time,
  };
  return h;
}

type Harness = ReturnType<typeof makeHarness>;

/** Wire up /sys links for a live Intel card on `iface`. */
function linkIntel(h: Harness, iface = "wlan0") {
  h.links[`/sys/class/net/${iface}/device/driver`] = "../../../bus/pci/drivers/iwlwifi";
  h.links[`/sys/class/net/${iface}/device`] = "../../../devices/pci0000:00/0000:62:00.0";
}

const modprobeCalls = (h: Harness) => h.calls.filter((c) => c[0] === "modprobe");

const INTEL_KNOWN: DriverInfo = {
  driver: "iwlwifi",
  pciAddress: "0000:62:00.0",
  iface: "wlan0",
  updatedAt: 0,
};

// --- pure helpers ------------------------------------------------------------

describe("parseNmDeviceStatus / findWifiDevice", () => {
  it("parses terse multi-device output and finds the wifi row", () => {
    const out = [
      "lo:loopback:connected (externally)",
      "/net/connman/iwd/0:wifi-p2p:disconnected",
      "wlan0:wifi:unavailable",
      "eth0:ethernet:unavailable",
      "",
    ].join("\n");
    const rows = parseNmDeviceStatus(out);
    expect(rows).toHaveLength(4);
    expect(findWifiDevice(rows)).toEqual({ device: "wlan0", state: "unavailable" });
  });

  it("unescapes nmcli's \\: escapes and skips malformed lines", () => {
    const rows = parseNmDeviceStatus("odd\\:name:wifi:connected\njunk-line\n");
    expect(rows).toEqual([{ device: "odd:name", type: "wifi", state: "connected" }]);
  });

  it("returns null when no wifi device exists", () => {
    const rows = parseNmDeviceStatus("lo:loopback:connected (externally)\neth0:ethernet:unavailable");
    expect(findWifiDevice(rows)).toBeNull();
  });
});

describe("modulesForDriver", () => {
  it("unloads iwlmvm before iwlwifi for Intel (the 'in use' lesson)", () => {
    expect(modulesForDriver({ driver: "iwlwifi" })).toEqual({
      unload: ["iwlmvm", "iwlwifi"],
      load: "iwlwifi",
    });
  });

  it("falls back to the identity mapping for unmapped drivers", () => {
    expect(modulesForDriver({ driver: "mt7921e" })).toEqual({
      unload: ["mt7921e"],
      load: "mt7921e",
    });
  });
});

describe("findModuleHolders", () => {
  const PROC_MODULES = [
    "iwlmvm 851968 0 - Live 0x0000000000000000",
    "iwlwifi 479232 1 iwlmvm, Live 0x0000000000000000",
    "cfg80211 1323008 3 iwlmvm,iwlwifi,mac80211 Live 0x0000000000000000",
  ].join("\n");

  it("reads the 'used by' column", () => {
    expect(findModuleHolders({ procModules: PROC_MODULES, module: "iwlwifi" })).toEqual(["iwlmvm"]);
    expect(findModuleHolders({ procModules: PROC_MODULES, module: "cfg80211" })).toEqual([
      "iwlmvm",
      "iwlwifi",
      "mac80211",
    ]);
  });

  it("returns [] for '-' (unheld) and unknown modules", () => {
    expect(findModuleHolders({ procModules: PROC_MODULES, module: "iwlmvm" })).toEqual([]);
    expect(findModuleHolders({ procModules: PROC_MODULES, module: "nope" })).toEqual([]);
  });
});

// --- rfkill / driver detection -----------------------------------------------

describe("readRfkill", () => {
  it("reports unblocked when soft and hard are 0", async () => {
    const h = makeHarness();
    expect(await readRfkill({ deps: h.deps })).toEqual({ soft: false, hard: false, blocked: false });
  });

  it("reports a soft block", async () => {
    const h = makeHarness();
    h.rfkill.soft = "1";
    const r = await readRfkill({ deps: h.deps });
    expect(r.soft).toBe(true);
    expect(r.blocked).toBe(true);
  });

  it("reports a hard block", async () => {
    const h = makeHarness();
    h.rfkill.hard = "1";
    const r = await readRfkill({ deps: h.deps });
    expect(r.hard).toBe(true);
    expect(r.blocked).toBe(true);
  });

  it("treats a missing rfkill dir as unblocked", async () => {
    const h = makeHarness({ rfkillAbsent: true });
    expect((await readRfkill({ deps: h.deps })).blocked).toBe(false);
  });

  it("ignores non-wlan rfkill devices", async () => {
    const h = makeHarness({ rfkillAbsent: true });
    h.deps.listDir = async () => ["rfkill0"];
    h.files["/sys/class/rfkill/rfkill0/type"] = "bluetooth\n";
    h.files["/sys/class/rfkill/rfkill0/soft"] = "1\n";
    h.files["/sys/class/rfkill/rfkill0/hard"] = "0\n";
    expect((await readRfkill({ deps: h.deps })).blocked).toBe(false);
  });
});

describe("detectDriverInfo", () => {
  it("resolves driver + PCI address from /sys links", async () => {
    const h = makeHarness();
    linkIntel(h);
    const info = await detectDriverInfo({ deps: h.deps, iface: "wlan0" });
    expect(info).toEqual({
      driver: "iwlwifi",
      pciAddress: "0000:62:00.0",
      iface: "wlan0",
      updatedAt: 0,
    });
  });

  it("leaves pciAddress null for non-PCI (e.g. USB) devices", async () => {
    const h = makeHarness();
    h.links["/sys/class/net/wlan0/device/driver"] = "../../../bus/usb/drivers/rtl8xxxu";
    h.links["/sys/class/net/wlan0/device"] = "../../../devices/usb1/1-3/1-3:1.0";
    const info = await detectDriverInfo({ deps: h.deps, iface: "wlan0" });
    expect(info?.driver).toBe("rtl8xxxu");
    expect(info?.pciAddress).toBeNull();
  });

  it("returns null when the driver link is missing", async () => {
    const h = makeHarness();
    expect(await detectDriverInfo({ deps: h.deps, iface: "wlan0" })).toBeNull();
  });
});

describe("getWifiDevice / nmRadioEnabled — nmcli failure paths", () => {
  it("getWifiDevice returns null when nmcli exits non-zero", async () => {
    const h = makeHarness();
    h.nmState = "wlan0:wifi:connected";
    h.onNmcli = () => ({ stdout: "", stderr: "NM not running", exitCode: 1 });
    expect(await getWifiDevice({ deps: h.deps })).toBeNull();
  });

  it("nmRadioEnabled reads the switch and treats a failing nmcli as disabled", async () => {
    const h = makeHarness();
    h.onNmcli = () => ({ stdout: "enabled\n", stderr: "", exitCode: 0 });
    expect(await nmRadioEnabled({ deps: h.deps })).toBe(true);
    h.onNmcli = () => ({ stdout: "disabled\n", stderr: "", exitCode: 0 });
    expect(await nmRadioEnabled({ deps: h.deps })).toBe(false);
    h.onNmcli = () => ({ stdout: "", stderr: "boom", exitCode: 1 });
    expect(await nmRadioEnabled({ deps: h.deps })).toBe(false);
  });
});

// --- recover() ---------------------------------------------------------------

describe("recover", () => {
  it("reloads the driver and handles the interface coming back RENAMED", async () => {
    const h = makeHarness();
    h.nmState = "wlan0:wifi:unavailable";
    linkIntel(h);
    h.onModprobe = (cmd) => {
      // Unload removes the device entirely; load brings it back renamed —
      // exactly what happened live on the Apex (wlan0 → wlan1).
      h.nmState = cmd[1] === "-r" ? "" : "wlan1:wifi:disconnected";
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const res = await recover({ deps: h.deps, lastKnown: null });
    expect(res.ok).toBe(true);
    expect(res.stage).toBe("done");
    expect(res.tier).toBe("modprobe");
    expect(res.driver).toBe("iwlwifi");
    expect(res.iface).toBe("wlan1");
    expect(modprobeCalls(h)).toEqual([
      ["modprobe", "-r", "iwlmvm", "iwlwifi"],
      ["modprobe", "iwlwifi"],
    ]);
  });

  it("refuses to run while rfkill blocks the radio", async () => {
    const h = makeHarness();
    h.rfkill.soft = "1";
    h.nmState = "wlan0:wifi:unavailable";
    linkIntel(h);

    const res = await recover({ deps: h.deps, lastKnown: null });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("precheck");
    expect(res.detail).toContain("switched off");
    expect(modprobeCalls(h)).toEqual([]);
  });

  it("falls back to the persisted driver when the interface has vanished", async () => {
    const h = makeHarness();
    h.nmState = "lo:loopback:connected (externally)"; // no wifi row at all
    h.onModprobe = (cmd) => {
      if (cmd[1] !== "-r") h.nmState = "wlan0:wifi:disconnected";
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const res = await recover({ deps: h.deps, lastKnown: INTEL_KNOWN });
    expect(res.ok).toBe(true);
    expect(res.driver).toBe("iwlwifi");
    expect(modprobeCalls(h)[0]).toEqual(["modprobe", "-r", "iwlmvm", "iwlwifi"]);
  });

  it("fails the precheck when no device exists and nothing is persisted", async () => {
    const h = makeHarness();
    h.nmState = "";
    const res = await recover({ deps: h.deps, lastKnown: null });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("precheck");
    expect(res.detail).toContain("No WiFi driver known");
    expect(modprobeCalls(h)).toEqual([]);
  });

  it("retries an 'in use' unload with the /proc/modules holders", async () => {
    const h = makeHarness();
    h.nmState = "";
    h.files["/proc/modules"] =
      "ath99k 16384 1 ath99k_helper, Live 0x0\nath99k_helper 8192 0 - Live 0x0";
    let unloads = 0;
    h.onModprobe = (cmd) => {
      if (cmd[1] === "-r") {
        unloads += 1;
        if (unloads === 1) {
          return { stdout: "", stderr: "modprobe: FATAL: Module ath99k is in use.", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      h.nmState = "wlan0:wifi:disconnected";
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const res = await recover({
      deps: h.deps,
      lastKnown: { driver: "ath99k", pciAddress: null, iface: "wlan0", updatedAt: 0 },
    });
    expect(res.ok).toBe(true);
    expect(modprobeCalls(h)).toEqual([
      ["modprobe", "-r", "ath99k"],
      ["modprobe", "-r", "ath99k_helper", "ath99k"],
      ["modprobe", "ath99k"],
    ]);
  });

  it("reports a load failure at the load stage", async () => {
    const h = makeHarness();
    h.nmState = "wlan0:wifi:unavailable";
    linkIntel(h);
    h.onModprobe = (cmd) =>
      cmd[1] === "-r"
        ? { stdout: "", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "modprobe: FATAL: could not insert", exitCode: 1 };

    const res = await recover({ deps: h.deps, lastKnown: null });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("load");
    expect(res.detail).toContain("could not insert");
  });

  it("escalates to a PCI function reset when the reload isn't enough", async () => {
    const h = makeHarness();
    h.nmState = "wlan0:wifi:unavailable";
    linkIntel(h);
    // Module reload never helps; the sysfs reset write revives the card.
    h.onWrite = (path) => {
      if (path.endsWith("/reset")) h.nmState = "wlan1:wifi:disconnected";
    };

    const res = await recover({
      deps: h.deps,
      lastKnown: null,
      waitTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe("pci-reset");
    expect(res.iface).toBe("wlan1");
    expect(h.writes).toContainEqual(["/sys/bus/pci/devices/0000:62:00.0/reset", "1"]);
  });

  it("escalates to PCI remove + rescan when the reset isn't enough either", async () => {
    const h = makeHarness();
    h.nmState = "wlan0:wifi:unavailable";
    linkIntel(h);
    h.onWrite = (path) => {
      if (path === "/sys/bus/pci/rescan") h.nmState = "wlan0:wifi:disconnected";
    };

    const res = await recover({
      deps: h.deps,
      lastKnown: null,
      waitTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    expect(res.ok).toBe(true);
    expect(res.tier).toBe("pci-rescan");
    const paths = h.writes.map(([p]) => p);
    expect(paths).toContain("/sys/bus/pci/devices/0000:62:00.0/reset");
    expect(paths).toContain("/sys/bus/pci/devices/0000:62:00.0/remove");
    expect(paths).toContain("/sys/bus/pci/rescan");
  });

  it("reports exhaustion when every tier fails", async () => {
    const h = makeHarness();
    h.nmState = "wlan0:wifi:unavailable";
    linkIntel(h);

    const res = await recover({
      deps: h.deps,
      lastKnown: null,
      waitTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("pci-rescan");
    expect(res.detail).toContain("power-off");
  });

  it("resolves (never rejects) when a dep throws, reporting the dying stage", async () => {
    const h = makeHarness();
    h.deps.run = async () => {
      throw new Error("spawn failed: nmcli ENOENT");
    };
    const res = await recover({ deps: h.deps, lastKnown: INTEL_KNOWN });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("precheck");
    expect(res.detail).toContain("spawn failed");
  });

  it("rejects an invalid stored driver name at precheck (root argv hygiene)", async () => {
    const h = makeHarness();
    h.nmState = ""; // vanished interface → the storage fallback is used
    const res = await recover({
      deps: h.deps,
      lastKnown: { driver: "-C /evil.conf", pciAddress: null, iface: "wlan0", updatedAt: 0 },
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("precheck");
    expect(res.detail).toContain("invalid");
    expect(modprobeCalls(h)).toEqual([]);
  });

  it("ignores an invalid stored PCI address instead of writing sysfs with it", async () => {
    const h = makeHarness();
    h.nmState = "";
    const res = await recover({
      deps: h.deps,
      lastKnown: {
        driver: "iwlwifi",
        pciAddress: "../../../etc/somewhere",
        iface: "wlan0",
        updatedAt: 0,
      },
      waitTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    // Treated exactly like "no PCI address known": tier 1 only, no writes.
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("wait");
    expect(h.writes).toEqual([]);
  });

  it("skips the PCI tiers when no PCI address is known", async () => {
    const h = makeHarness();
    h.nmState = "";
    const res = await recover({
      deps: h.deps,
      lastKnown: { driver: "rtl8xxxu", pciAddress: null, iface: "wlan0", updatedAt: 0 },
      waitTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
    });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("wait");
    expect(res.detail).toContain("power-off");
    expect(h.writes).toEqual([]);
  });
});

// --- watchdog reducer --------------------------------------------------------

const HEALTHY: WatchdogSample = {
  wifiPresent: true,
  state: "connected",
  rfkillBlocked: false,
  radioEnabled: true,
  hasKnownDriver: true,
};
const UNAVAILABLE: WatchdogSample = { ...HEALTHY, state: "unavailable" };
const VANISHED: WatchdogSample = { ...HEALTHY, wifiPresent: false, state: null };

describe("watchdog reducer", () => {
  it("debounces: one bad poll never fires, the second does", () => {
    const state = initialWatchdogState();
    const first = evaluateWatchdog({ state, sample: UNAVAILABLE, now: 0, config: DEFAULT_WATCHDOG });
    expect(first.fire).toBe(false);
    expect(first.reason).toBe("debouncing");

    const second = evaluateWatchdog({
      state: first.next,
      sample: UNAVAILABLE,
      now: 12_000,
      config: DEFAULT_WATCHDOG,
    });
    expect(second.fire).toBe(true);
    expect(second.next.lastAttemptAt).toBe(12_000);
    expect(second.next.consecutiveBad).toBe(0);
  });

  it("treats 'unmanaged' as healthy — NM config, not a crash", () => {
    const r = evaluateWatchdog({
      state: { consecutiveBad: 1, consecutiveFailures: 2, lastAttemptAt: 5, suspended: true },
      sample: { ...HEALTHY, state: "unmanaged" },
      now: 100_000,
      config: DEFAULT_WATCHDOG,
    });
    expect(r.fire).toBe(false);
    expect(r.reason).toBe("healthy");
    expect(r.next).toEqual(initialWatchdogState());
  });

  it("a vanished device with a known driver counts as bad", () => {
    let state = initialWatchdogState();
    state = evaluateWatchdog({ state, sample: VANISHED, now: 0, config: DEFAULT_WATCHDOG }).next;
    const r = evaluateWatchdog({ state, sample: VANISHED, now: 12_000, config: DEFAULT_WATCHDOG });
    expect(r.fire).toBe(true);
    expect(r.reason).toBe("device-missing");
  });

  it("a vanished device with NO known driver is not actionable", () => {
    const sample = { ...VANISHED, hasKnownDriver: false };
    let state = initialWatchdogState();
    for (const now of [0, 12_000, 24_000]) {
      const r = evaluateWatchdog({ state, sample, now, config: DEFAULT_WATCHDOG });
      expect(r.fire).toBe(false);
      state = r.next;
    }
    expect(state.consecutiveBad).toBe(0);
  });

  it("cooldown blocks a refire within 60s of the last attempt", () => {
    let state = initialWatchdogState();
    state = evaluateWatchdog({ state, sample: UNAVAILABLE, now: 0, config: DEFAULT_WATCHDOG }).next;
    state = evaluateWatchdog({ state, sample: UNAVAILABLE, now: 12_000, config: DEFAULT_WATCHDOG }).next; // fired

    // Debounce refills, but the cooldown gate holds.
    state = evaluateWatchdog({ state, sample: UNAVAILABLE, now: 24_000, config: DEFAULT_WATCHDOG }).next;
    const blocked = evaluateWatchdog({ state, sample: UNAVAILABLE, now: 36_000, config: DEFAULT_WATCHDOG });
    expect(blocked.fire).toBe(false);
    expect(blocked.reason).toBe("cooldown");

    const after = evaluateWatchdog({
      state: blocked.next,
      sample: UNAVAILABLE,
      now: 80_000,
      config: DEFAULT_WATCHDOG,
    });
    expect(after.fire).toBe(true);
  });

  it("never fires while rfkill blocks or the radio switch is off, and resets debounce", () => {
    let state = initialWatchdogState();
    state = evaluateWatchdog({ state, sample: UNAVAILABLE, now: 0, config: DEFAULT_WATCHDOG }).next;
    expect(state.consecutiveBad).toBe(1);

    const rfkilled = evaluateWatchdog({
      state,
      sample: { ...UNAVAILABLE, rfkillBlocked: true },
      now: 12_000,
      config: DEFAULT_WATCHDOG,
    });
    expect(rfkilled.fire).toBe(false);
    expect(rfkilled.next.consecutiveBad).toBe(0);

    const radioOff = evaluateWatchdog({
      state,
      sample: { ...UNAVAILABLE, radioEnabled: false },
      now: 12_000,
      config: DEFAULT_WATCHDOG,
    });
    expect(radioOff.fire).toBe(false);
    expect(radioOff.next.consecutiveBad).toBe(0);
  });

  it("suspends after 3 failed recoveries and stays quiet until healthy", () => {
    let state = initialWatchdogState();
    for (let i = 0; i < DEFAULT_WATCHDOG.maxFailures; i++) {
      state = recordRecoveryOutcome({ state, ok: false, config: DEFAULT_WATCHDOG });
    }
    expect(state.suspended).toBe(true);

    // Bad polls while suspended never fire, even past debounce + cooldown.
    for (const now of [200_000, 212_000, 224_000]) {
      const r = evaluateWatchdog({ state, sample: UNAVAILABLE, now, config: DEFAULT_WATCHDOG });
      expect(r.fire).toBe(false);
      state = r.next;
    }
    expect(state.suspended).toBe(true);

    // A healthy poll clears everything.
    const healed = evaluateWatchdog({ state, sample: HEALTHY, now: 300_000, config: DEFAULT_WATCHDOG });
    expect(healed.next).toEqual(initialWatchdogState());
  });

  it("a successful recovery resets the failure count and suspension", () => {
    let state = initialWatchdogState();
    state = recordRecoveryOutcome({ state, ok: false, config: DEFAULT_WATCHDOG });
    state = recordRecoveryOutcome({ state, ok: false, config: DEFAULT_WATCHDOG });
    state = recordRecoveryOutcome({ state, ok: true, config: DEFAULT_WATCHDOG });
    expect(state.consecutiveFailures).toBe(0);
    expect(state.suspended).toBe(false);
  });
});
