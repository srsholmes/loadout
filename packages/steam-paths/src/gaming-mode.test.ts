import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock /proc access. isGamescopeRunning reads readdirSync("/proc") and
// readFileSync("/proc/<pid>/comm") — same shape as the overlay's
// process-control test harness.
type FsState = {
  procEntries: string[];
  commByPid: Record<string, string>;
};
let fsState: FsState;

mock.module("node:fs", () => ({
  readdirSync: (path: string) => {
    if (path === "/proc") return fsState.procEntries;
    throw new Error(`unexpected readdirSync: ${path}`);
  },
  readFileSync: (path: string) => {
    const m = String(path).match(/^\/proc\/(\d+)\/comm$/);
    if (!m) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    const name = fsState.commByPid[m[1]];
    if (name == null)
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return name + "\n";
  },
}));

const { isGamescopeRunning } = await import("./gaming-mode");

beforeEach(() => {
  fsState = { procEntries: [], commByPid: {} };
});

describe("isGamescopeRunning", () => {
  it("returns true for the real SteamOS compositor comm 'gamescope-wl'", () => {
    fsState.procEntries = ["1", "3068", "13784"];
    fsState.commByPid["1"] = "systemd";
    fsState.commByPid["3068"] = "gamescope-wl";
    fsState.commByPid["13784"] = "steam";
    expect(isGamescopeRunning()).toBe(true);
  });

  it("also matches a bare 'gamescope' comm (other hosts)", () => {
    fsState.procEntries = ["3068"];
    fsState.commByPid["3068"] = "gamescope";
    expect(isGamescopeRunning()).toBe(true);
  });

  it("returns false in desktop mode (KDE/Plasma, no gamescope)", () => {
    fsState.procEntries = ["1", "42", "13784", "99"];
    fsState.commByPid["1"] = "systemd";
    fsState.commByPid["42"] = "plasmashell";
    fsState.commByPid["13784"] = "steam";
    // xdg-desktop-portal-gamescope truncates to "xdg-desktop-por" — must NOT match.
    fsState.commByPid["99"] = "xdg-desktop-por";
    expect(isGamescopeRunning()).toBe(false);
  });

  it("ignores non-numeric /proc entries and tolerates a vanished process", () => {
    fsState.procEntries = ["self", "cpuinfo", "777", "3068"];
    // 777 has no comm entry (race) — skip; 3068 is gamescope.
    fsState.commByPid["3068"] = "gamescope-wl";
    expect(isGamescopeRunning()).toBe(true);
  });
});
