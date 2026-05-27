import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// --- Module-level mocks for node:fs ---------------------------------------
//
// display-detect reads /proc via readdirSync + readFileSync. Mock both so
// the test runs in a Bun sandbox without touching a real /proc. Mock order
// matters: set up mock.module BEFORE importing the module under test.

type FsState = {
  procEntries: string[];
  commByPid: Record<string, string>;
  environByPid: Record<string, string>;
};
let fsState: FsState;

mock.module("node:fs", () => ({
  readdirSync: (path: string) => {
    if (path === "/proc") return fsState.procEntries;
    throw new Error(`unexpected readdir: ${path}`);
  },
  readFileSync: (path: string) => {
    const m = path.match(/^\/proc\/(\d+)\/(comm|environ)$/);
    if (!m) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    const [, pid, what] = m;
    if (what === "comm") {
      const name = fsState.commByPid[pid];
      if (name == null) throw Object.assign(new Error(`ENOENT`), { code: "ENOENT" });
      return name + "\n";
    }
    const env = fsState.environByPid[pid];
    if (env == null) throw Object.assign(new Error(`ENOENT`), { code: "ENOENT" });
    return env;
  },
  // No-op for trace.ts (loaded transitively from other native/*.ts).
  appendFileSync: () => {},
}));

// Import AFTER the mock is registered. Use dynamic import so the mock
// is applied; each test can re-load if needed to reset module state.
const mod = await import("./display-detect");
const { detectOverlayDisplay } = mod;

// Keep a reference to the process.env so we can restore.
const savedEnv = { ...process.env };

function resetEnv() {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  delete process.env.GAMESCOPE_DISPLAY;
  delete process.env.DISPLAY;
}

function emptyFs(): FsState {
  return { procEntries: [], commByPid: {}, environByPid: {} };
}

describe("detectOverlayDisplay", () => {
  beforeEach(() => {
    resetEnv();
    fsState = emptyFs();
  });
  afterEach(() => {
    resetEnv();
  });

  it("prefers $GAMESCOPE_DISPLAY when it's set", () => {
    process.env.GAMESCOPE_DISPLAY = ":2";
    process.env.DISPLAY = ":1"; // should be ignored
    fsState.procEntries = ["1234", "self"];
    fsState.commByPid["1234"] = "steam";
    fsState.environByPid["1234"] = "GAMESCOPE_DISPLAY=:9\0"; // should be ignored

    expect(detectOverlayDisplay()).toBe(":2");
  });

  it("falls back to /proc/<steam-pid>/environ for GAMESCOPE_DISPLAY", () => {
    process.env.DISPLAY = ":1";
    // A second unrelated pid so we prove the scanner finds steam by comm.
    fsState.procEntries = ["999", "3372"];
    fsState.commByPid["999"] = "Xorg";
    fsState.commByPid["3372"] = "steam";
    fsState.environByPid["3372"] =
      "HOME=/home/test\0GAMESCOPE_DISPLAY=:0\0PATH=/usr/bin\0";

    expect(detectOverlayDisplay()).toBe(":0");
  });

  it("falls back to $DISPLAY when neither env var nor Steam proc yields a value", () => {
    process.env.DISPLAY = ":5";
    fsState.procEntries = ["100"];
    fsState.commByPid["100"] = "nothing-we-care-about";

    expect(detectOverlayDisplay()).toBe(":5");
  });

  it("defaults to :0 as a last resort", () => {
    // no GAMESCOPE_DISPLAY, no DISPLAY, no steam, no proc entries
    expect(detectOverlayDisplay()).toBe(":0");
  });

  it("ignores non-numeric /proc entries", () => {
    process.env.DISPLAY = ":1";
    fsState.procEntries = ["self", "cpuinfo", "1"]; // 1 is init, not steam
    fsState.commByPid["1"] = "systemd";
    // Should NOT crash on "self"/"cpuinfo", just skip them.
    expect(detectOverlayDisplay()).toBe(":1");
  });

  it("handles steam's environ with missing GAMESCOPE_DISPLAY gracefully", () => {
    process.env.DISPLAY = ":1";
    fsState.procEntries = ["3372"];
    fsState.commByPid["3372"] = "steam";
    fsState.environByPid["3372"] = "HOME=/home/test\0PATH=/usr/bin\0";

    // Bazzite's gamescope-session leaves GAMESCOPE_DISPLAY unset in Steam
    // env and only exports GAMESCOPE_WAYLAND_DISPLAY. Detection should
    // still produce a usable result by falling through to $DISPLAY.
    expect(detectOverlayDisplay()).toBe(":1");
  });

  it("treats empty GAMESCOPE_DISPLAY= as 'no value' in Steam's environ", () => {
    process.env.DISPLAY = ":1";
    fsState.procEntries = ["3372"];
    fsState.commByPid["3372"] = "steam";
    fsState.environByPid["3372"] = "GAMESCOPE_DISPLAY=\0PATH=/usr/bin\0";

    expect(detectOverlayDisplay()).toBe(":1");
  });
});
