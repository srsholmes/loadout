import { describe, it, expect } from "bun:test";
import {
  buildNmDropIn,
  nmDropInActive,
  mergeIwdDriverQuirks,
  stripIwdDriverQuirks,
  iwdQuirkActive,
  parsePowerSave,
  detectWirelessIface,
  enable,
  disable,
  getStatus,
  reassertRuntime,
  NM_CONF,
  IWD_CONF,
  IWD_DIR,
  type PowerSaveDeps,
  type RunResult,
} from "./powersave";

/**
 * powersave tests. The pure config helpers are tested directly; the
 * enable/disable/getStatus orchestration runs against an in-memory fake
 * filesystem + run() so there's no root, real sysfs, or real radio.
 */

// --- pure helpers ------------------------------------------------------------

describe("buildNmDropIn / nmDropInActive", () => {
  it("emits the powersave-off connection setting", () => {
    const body = buildNmDropIn();
    expect(body).toContain("[connection]");
    expect(body).toContain("wifi.powersave = 2");
    expect(nmDropInActive(body)).toBe(true);
  });

  it("does not consider an empty/other config active", () => {
    expect(nmDropInActive("")).toBe(false);
    expect(nmDropInActive("[connection]\nwifi.powersave = 3\n")).toBe(false);
  });
});

describe("mergeIwdDriverQuirks", () => {
  it("creates the section in an empty file", () => {
    const out = mergeIwdDriverQuirks("");
    expect(out).toBe("[DriverQuirks]\nPowerSaveDisable=*\n");
    expect(iwdQuirkActive(out)).toBe(true);
  });

  it("appends the section without clobbering other sections", () => {
    const existing = "[General]\nEnableNetworkConfiguration=true\n";
    const out = mergeIwdDriverQuirks(existing);
    expect(out).toContain("[General]");
    expect(out).toContain("EnableNetworkConfiguration=true");
    expect(out).toContain("[DriverQuirks]");
    expect(out).toContain("PowerSaveDisable=*");
  });

  it("inserts the key into an existing DriverQuirks section", () => {
    const existing = "[DriverQuirks]\nDefaultInterface=true\n";
    const out = mergeIwdDriverQuirks(existing);
    expect(out).toContain("DefaultInterface=true");
    expect(out).toContain("PowerSaveDisable=*");
    // only one DriverQuirks header
    expect(out.match(/\[DriverQuirks\]/g)?.length).toBe(1);
  });

  it("replaces an existing PowerSaveDisable value and is idempotent", () => {
    const existing = "[DriverQuirks]\nPowerSaveDisable=0\n";
    const out = mergeIwdDriverQuirks(existing);
    expect(out).toContain("PowerSaveDisable=*");
    expect(out).not.toContain("PowerSaveDisable=0");
    expect(mergeIwdDriverQuirks(out)).toBe(out);
  });
});

describe("stripIwdDriverQuirks", () => {
  it("empties a file that only held our quirk", () => {
    const merged = mergeIwdDriverQuirks("");
    expect(stripIwdDriverQuirks(merged)).toBe("");
  });

  it("keeps other sections and other quirks", () => {
    const existing =
      "[General]\nEnableNetworkConfiguration=true\n\n[DriverQuirks]\nDefaultInterface=true\nPowerSaveDisable=*\n";
    const out = stripIwdDriverQuirks(existing);
    expect(out).toContain("[General]");
    expect(out).toContain("[DriverQuirks]");
    expect(out).toContain("DefaultInterface=true");
    expect(out).not.toContain("PowerSaveDisable");
  });

  it("drops the DriverQuirks header when it becomes empty but keeps siblings", () => {
    const existing = "[General]\nFoo=bar\n\n[DriverQuirks]\nPowerSaveDisable=*\n";
    const out = stripIwdDriverQuirks(existing);
    expect(out).toContain("[General]");
    expect(out).toContain("Foo=bar");
    expect(out).not.toContain("[DriverQuirks]");
  });
});

describe("parsePowerSave", () => {
  it("parses on/off", () => {
    expect(parsePowerSave("Power save: off")).toBe("off");
    expect(parsePowerSave("\tPower save: on")).toBe("on");
    expect(parsePowerSave("garbage")).toBeNull();
  });
});

// --- fake fs + run -----------------------------------------------------------

function makeDeps(opts?: {
  files?: Record<string, string>;
  dirs?: string[];
  net?: Record<string, boolean>; // iface -> isWireless
  powerSave?: "on" | "off";
}): {
  deps: PowerSaveDeps;
  files: Record<string, string>;
  runs: string[][];
} {
  const files: Record<string, string> = { ...(opts?.files ?? {}) };
  const dirs = new Set(opts?.dirs ?? []);
  const net = opts?.net ?? { wlan0: true, eth0: false };
  let powerSave = opts?.powerSave ?? "on";
  const runs: string[][] = [];

  const run = async (cmd: string[]): Promise<RunResult> => {
    runs.push(cmd);
    if (cmd[0] === "iw" && cmd.includes("get")) {
      return { stdout: `Power save: ${powerSave}`, stderr: "", exitCode: 0 };
    }
    if (cmd[0] === "iw" && cmd.includes("set")) {
      powerSave = cmd[cmd.length - 1] as "on" | "off";
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const deps: PowerSaveDeps = {
    run,
    readFile: async (path) => {
      if (path in files) return files[path];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFile: async (path, content) => {
      files[path] = content;
    },
    removeFile: async (path) => {
      delete files[path];
    },
    pathExists: async (path) => path in files || dirs.has(path),
    listNet: async () => Object.keys(net),
    isWireless: async (iface) => !!net[iface],
  };
  return { deps, files, runs };
}

describe("detectWirelessIface", () => {
  it("returns the first wireless interface", async () => {
    const { deps } = makeDeps({ net: { eth0: false, wlan0: true } });
    expect(await detectWirelessIface(deps)).toBe("wlan0");
  });

  it("returns null when there's no wireless interface", async () => {
    const { deps } = makeDeps({ net: { eth0: false } });
    expect(await detectWirelessIface(deps)).toBeNull();
  });
});

describe("enable", () => {
  it("writes the NM drop-in and applies runtime off (no iwd present)", async () => {
    const { deps, files, runs } = makeDeps();
    const res = await enable(deps);
    expect(res.success).toBe(true);
    expect(res.iface).toBe("wlan0");
    expect(nmDropInActive(files[NM_CONF])).toBe(true);
    expect(files[IWD_CONF]).toBeUndefined();
    expect(runs.some((c) => c.includes("set") && c.includes("off"))).toBe(true);
  });

  it("merges the iwd quirk when iwd is installed", async () => {
    const { deps, files } = makeDeps({
      dirs: [IWD_DIR],
      files: { [IWD_CONF]: "[General]\nFoo=bar\n" },
    });
    const res = await enable(deps);
    expect(res.success).toBe(true);
    expect(iwdQuirkActive(files[IWD_CONF])).toBe(true);
    expect(files[IWD_CONF]).toContain("Foo=bar");
  });
});

describe("disable", () => {
  it("removes the NM drop-in and applies runtime on", async () => {
    const { deps, files, runs } = makeDeps({
      files: { [NM_CONF]: buildNmDropIn() },
      powerSave: "off",
    });
    const res = await disable(deps);
    expect(res.success).toBe(true);
    expect(files[NM_CONF]).toBeUndefined();
    expect(runs.some((c) => c.includes("set") && c.includes("on"))).toBe(true);
  });

  it("strips the iwd quirk and deletes the file when nothing else remains", async () => {
    const { deps, files } = makeDeps({
      dirs: [IWD_DIR],
      files: { [IWD_CONF]: mergeIwdDriverQuirks("") },
    });
    await disable(deps);
    expect(files[IWD_CONF]).toBeUndefined();
  });
});

describe("getStatus", () => {
  it("reports configured when NM set and no iwd", async () => {
    const { deps } = makeDeps({ files: { [NM_CONF]: buildNmDropIn() }, powerSave: "off" });
    const s = await getStatus(deps);
    expect(s.iface).toBe("wlan0");
    expect(s.nmConfigured).toBe(true);
    expect(s.iwdPresent).toBe(false);
    expect(s.runtime).toBe("off");
    expect(s.configured).toBe(true);
  });

  it("needs both NM and iwd when iwd is present", async () => {
    const { deps } = makeDeps({ dirs: [IWD_DIR], files: { [NM_CONF]: buildNmDropIn() } });
    const s = await getStatus(deps);
    expect(s.iwdPresent).toBe(true);
    expect(s.iwdConfigured).toBe(false);
    expect(s.configured).toBe(false);
  });
});

describe("reassertRuntime", () => {
  it("sets power_save off on the wireless interface", async () => {
    const { deps, runs } = makeDeps({ powerSave: "on" });
    await reassertRuntime(deps);
    expect(runs.some((c) => c.includes("set") && c.includes("off"))).toBe(true);
  });
});
