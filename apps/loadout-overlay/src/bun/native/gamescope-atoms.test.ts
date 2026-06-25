import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock @loadout/exec so the atom class never shells out for real.
const mockCommandExists = mock((_name: string) => Promise.resolve(true));
const mockRun = mock(
  (_cmd: string[]) => Promise.resolve({ stdout: "", exitCode: 0 }),
);

mock.module("@loadout/exec", () => ({
  commandExists: mockCommandExists,
  run: mockRun,
}));

const { GamescopeAtoms } = await import("./gamescope-atoms");

/** Resolve an xdotool search call to a window id stdout string. Centralises
 *  the routing rules so individual tests' inline mockImplementations don't
 *  need to repeat the WM_NAME / WM_CLASS branching. Returns null if the
 *  command isn't an xdotool search. */
function mockXdotoolSearch(cmd: string[]): string | null {
  if (!cmd.includes("xdotool")) return null;
  if (cmd.includes("--class")) return "99\n";
  const nameIdx = cmd.indexOf("--name");
  const name = nameIdx >= 0 ? cmd[nameIdx + 1] : "";
  // findSteamWindow's WM_NAME path → Steam BPM (99). Anything else (e.g.
  // findWindow looking up "Loadout Overlay") → our overlay (10).
  if (name && name.includes("Steam Big Picture Mode")) return "99\n";
  return "10\n";
}

describe("GamescopeAtoms", () => {
  beforeEach(() => {
    mockCommandExists.mockClear();
    mockRun.mockClear();
    mockCommandExists.mockImplementation(() => Promise.resolve(true));
    mockRun.mockImplementation(() =>
      Promise.resolve({ stdout: "", exitCode: 0 }),
    );
  });

  describe("findWindow", () => {
    it("returns null and warns when xdotool is missing", async () => {
      mockCommandExists.mockImplementation(() => Promise.resolve(false));
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      const id = await atoms.findWindow();
      expect(id).toBeNull();
    });

    it("converts xdotool decimal output to the 0x-prefixed hex xprop wants", async () => {
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("xdotool")) {
          return Promise.resolve({ stdout: "52428801\n", exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      const atoms = new GamescopeAtoms({
        display: ":0",
        windowName: "Loadout Overlay",
        forceXprop: true,
      });
      const id = await atoms.findWindow();
      expect(id).toBe("0x" + (52428801).toString(16));
    });

    it("returns null on xdotool failure exit", async () => {
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("xdotool")) {
          return Promise.resolve({ stdout: "", exitCode: 1 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      expect(await atoms.findWindow()).toBeNull();
    });
  });

  describe("prepare / show / hide sequencing", () => {
    // All three methods issue xprop calls via run(). We assert the exact
    // atom names + values match the overlay_display.rs constants.

    // Own overlay window id (decimal 10) vs Steam's BPM window (decimal 99)
    // so we can tell xprop writes on each apart in assertions.
    const OWN_WIN_ID = "0xa"; // 10
    const STEAM_WIN_ID = "0x63"; // 99

    function capturedXprops(): Array<{
      target: string;
      atom: string;
      value: string;
    }> {
      const calls: Array<{ target: string; atom: string; value: string }> = [];
      for (const c of mockRun.mock.calls) {
        const cmd = c[0] as string[];
        // Only per-window (`-id`) WRITES. The `-f` flag distinguishes a
        // write from a read (reads are just `xprop -id <hex> ATOM…`).
        // `-root` reads/writes have a different argv shape and are
        // covered by rootSets/rootReads in the STEAM_TOUCH_CLICK_MODE
        // block below.
        if (
          cmd[0] === "env" &&
          cmd[2] === "xprop" &&
          cmd[3] === "-id" &&
          cmd[5] === "-f"
        ) {
          // ["env", "DISPLAY=:0", "xprop", "-id", <hex>, "-f", ATOM, "32c",
          //  "-set", ATOM, VALUE]
          calls.push({ target: cmd[4], atom: cmd[6], value: cmd[10] });
        }
      }
      return calls;
    }

    /** Only xprop calls against our own overlay window. Keeps existing
     *  assertions honest when show()/hide() also write to Steam's. */
    function capturedOwnXprops(): Array<{ atom: string; value: string }> {
      return capturedXprops()
        .filter((c) => c.target === OWN_WIN_ID)
        .map(({ atom, value }) => ({ atom, value }));
    }

    beforeEach(() => {
      // Successful window lookup so atom methods proceed.
      //   --class steamwebhelper / steam → Steam BPM (99)
      //   --name "^Steam Big Picture Mode$" → Steam BPM (99)
      //   any other --name (e.g. "Loadout Overlay") → ours (10)
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("xdotool")) {
          if (cmd.includes("--class")) {
            return Promise.resolve({ stdout: "99\n", exitCode: 0 });
          }
          const nameIdx = cmd.indexOf("--name");
          const name = nameIdx >= 0 ? cmd[nameIdx + 1] : "";
          if (name && name.includes("Steam Big Picture Mode")) {
            return Promise.resolve({ stdout: "99\n", exitCode: 0 });
          }
          return Promise.resolve({ stdout: "10\n", exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
    });

    it("prepare() sets the permanent atoms (STEAM_GAME, BIGPICTURE, defaults) and zeroes the dynamic ones", async () => {
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.prepare();
      const map = Object.fromEntries(
        capturedOwnXprops().map((c) => [c.atom, c.value]),
      );
      expect(map.STEAM_GAME).toBe("21324"); // OVERLAY_APP_ID 0x534C
      expect(map.STEAM_BIGPICTURE).toBe("1");
      expect(map._NET_WM_WINDOW_OPACITY).toBe("0");
      expect(map.STEAM_OVERLAY).toBe("0");
      expect(map.STEAM_INPUT_FOCUS).toBe("0");
      // STEAM_NOTIFICATION and GAMESCOPE_NO_FOCUS are not gamescope-read
      // atoms (verified against steamcompmgr.cpp:7772-7811 May 2026).
      // We dropped them in the rewrite — assert they are NOT written.
      expect(map.STEAM_NOTIFICATION).toBeUndefined();
      expect(map.GAMESCOPE_NO_FOCUS).toBeUndefined();
    });

    it("show() flips opacity + STEAM_OVERLAY + STEAM_INPUT_FOCUS to their visible values", async () => {
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      const map = Object.fromEntries(
        capturedOwnXprops().map((c) => [c.atom, c.value]),
      );
      expect(map._NET_WM_WINDOW_OPACITY).toBe("4294967295"); // 0xFFFFFFFF
      expect(map.STEAM_OVERLAY).toBe("1");
      expect(map.STEAM_INPUT_FOCUS).toBe("1");
    });

    it("hide() zeroes STEAM_OVERLAY + STEAM_INPUT_FOCUS and drops opacity", async () => {
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.hide();
      const map = Object.fromEntries(
        capturedOwnXprops().map((c) => [c.atom, c.value]),
      );
      expect(map.STEAM_INPUT_FOCUS).toBe("0");
      expect(map.STEAM_OVERLAY).toBe("0");
      expect(map._NET_WM_WINDOW_OPACITY).toBe("0");
    });

    it("a show() right after a hide() re-opens the overlay", async () => {
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.hide();
      mockRun.mockClear();
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("xdotool")) {
          if (cmd.includes("--class"))
            return Promise.resolve({ stdout: "99\n", exitCode: 0 });
          // --name "^Steam Big Picture Mode$" → Steam BPM (99). Any
          // other --name → our overlay window (10).
          const nameIdx = cmd.indexOf("--name");
          const name = nameIdx >= 0 ? cmd[nameIdx + 1] : "";
          if (name && name.includes("Steam Big Picture Mode")) {
            return Promise.resolve({ stdout: "99\n", exitCode: 0 });
          }
          return Promise.resolve({ stdout: "10\n", exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      await atoms.show();
      const map = Object.fromEntries(
        capturedOwnXprops().map((c) => [c.atom, c.value]),
      );
      expect(map.STEAM_OVERLAY).toBe("1");
    });

    it("show() zeroes STEAM_INPUT_FOCUS/OVERLAY/NOTIFICATION on Steam's BPM window when Steam is asserting", async () => {
      // Make the snapshot read see Steam claiming overlay+input — that's
      // the case where the focus-fight zero pass actually has to fire.
      // (When Steam isn't asserting, show() correctly skips it as a
      // ~30ms latency optimisation; that path is covered by the next
      // test.)
      mockRun.mockImplementation((cmd: string[]) => {
        const xdotoolStdout = mockXdotoolSearch(cmd);
        if (xdotoolStdout !== null) {
          return Promise.resolve({ stdout: xdotoolStdout, exitCode: 0 });
        }
        // _readAtoms: xprop -id <hex> ATOM ATOM ATOM (no -f / no -set).
        if (
          cmd[2] === "xprop" &&
          cmd[3] === "-id" &&
          !cmd.includes("-f")
        ) {
          return Promise.resolve({
            stdout:
              "STEAM_OVERLAY(CARDINAL) = 1\nSTEAM_INPUT_FOCUS(CARDINAL) = 1\nSTEAM_NOTIFICATION(CARDINAL) = 0\n",
            exitCode: 0,
          });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      const steamWrites = capturedXprops().filter(
        (c) => c.target === STEAM_WIN_ID,
      );
      const map = Object.fromEntries(
        steamWrites.map((c) => [c.atom, c.value]),
      );
      // Only STEAM_OVERLAY is written. INPUT_FOCUS and NOTIFICATION
      // are Steam's CEF self-state — touching them broke its menu
      // input handling on hide. We compete with Steam exclusively via
      // STEAM_OVERLAY (gamescope's overlay-arbitration atom).
      expect(map.STEAM_OVERLAY).toBe("0");
      expect(map.STEAM_INPUT_FOCUS).toBeUndefined();
      expect(map.STEAM_NOTIFICATION).toBeUndefined();
    });

    it("show() skips the Steam-zero pass when Steam isn't asserting (latency optimisation)", async () => {
      // Default mock returns stdout="" for xprop reads → snapshot is
      // empty → _steamSnapshotIsAsserted() is false. show() must skip
      // the 3 xprop -set calls on Steam's window. Reclaim watcher will
      // catch any subsequent re-assertion within 100ms.
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      const steamWrites = capturedXprops().filter(
        (c) => c.target === STEAM_WIN_ID,
      );
      expect(steamWrites).toHaveLength(0);
    });

    it("hide() force-zeroes Steam's atoms when no game is running", async () => {
      // No-game scenario: BPM home + Steam menu open + open/close our
      // overlay. Restoring overlay=1 here would trap gamescope in
      // focusWindow=null state (BPM excluded from focus, no game to
      // be focusWindow). Force-zero so BPM stays a focusWindow
      // candidate and inputs route to it.
      mockRun.mockImplementation((cmd: string[]) => {
        const xdotoolStdout = mockXdotoolSearch(cmd);
        if (xdotoolStdout !== null) {
          return Promise.resolve({ stdout: xdotoolStdout, exitCode: 0 });
        }
        // Per-window atom read: pretend Steam menu was open at show.
        if (
          cmd[2] === "xprop" &&
          cmd[3] === "-id" &&
          !cmd.includes("-f")
        ) {
          return Promise.resolve({
            stdout:
              "STEAM_OVERLAY(CARDINAL) = 1\nSTEAM_INPUT_FOCUS(CARDINAL) = 1\nSTEAM_NOTIFICATION(CARDINAL) = 0\n",
            exitCode: 0,
          });
        }
        // Root atom reads (xprop -root). STEAM_GAMES_RUNNING absent →
        // _getRootAtom returns null → no-game path.
        if (cmd[2] === "xprop" && cmd[3] === "-root") {
          return Promise.resolve({
            stdout: `${cmd[4]}:  not found.\n`,
            exitCode: 0,
          });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });

      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      const mark = mockRun.mock.calls.length;
      await atoms.hide();

      const steamWrites: Array<{ atom: string; value: string }> = [];
      for (let i = mark; i < mockRun.mock.calls.length; i++) {
        const cmd = mockRun.mock.calls[i][0] as string[];
        if (
          cmd[0] === "env" &&
          cmd[2] === "xprop" &&
          cmd[3] === "-id" &&
          cmd[4] === STEAM_WIN_ID &&
          cmd[5] === "-f"
        ) {
          steamWrites.push({ atom: cmd[6], value: cmd[10] });
        }
      }
      const finalSteam = Object.fromEntries(
        steamWrites.map((w) => [w.atom, w.value]),
      );
      // Only STEAM_OVERLAY is touched. INPUT_FOCUS and NOTIFICATION
      // are Steam's CEF self-state — never written.
      expect(finalSteam.STEAM_OVERLAY).toBe("0");
      expect(finalSteam.STEAM_INPUT_FOCUS).toBeUndefined();
      expect(finalSteam.STEAM_NOTIFICATION).toBeUndefined();
    });

    it("hide() restores Steam's snapshot when a game is running (BPM-on-game scenario)", async () => {
      // Game in baselayer + user back in BPM with QAM open + open/close
      // our overlay. Force-zeroing BPM here would make game the only
      // focusWindow candidate → gamescope routes inputs to game →
      // BPM/QAM dead. Restore so BPM keeps the overlay slot.
      mockRun.mockImplementation((cmd: string[]) => {
        const xdotoolStdout = mockXdotoolSearch(cmd);
        if (xdotoolStdout !== null) {
          return Promise.resolve({ stdout: xdotoolStdout, exitCode: 0 });
        }
        if (
          cmd[2] === "xprop" &&
          cmd[3] === "-id" &&
          !cmd.includes("-f")
        ) {
          return Promise.resolve({
            stdout:
              "STEAM_OVERLAY(CARDINAL) = 1\nSTEAM_INPUT_FOCUS(CARDINAL) = 1\nSTEAM_NOTIFICATION(CARDINAL) = 0\n",
            exitCode: 0,
          });
        }
        // STEAM_GAMES_RUNNING=1 → game alive → restore path.
        if (cmd[2] === "xprop" && cmd[3] === "-root" && cmd[4] === "STEAM_GAMES_RUNNING") {
          return Promise.resolve({
            stdout: "STEAM_GAMES_RUNNING(CARDINAL) = 1\n",
            exitCode: 0,
          });
        }
        if (cmd[2] === "xprop" && cmd[3] === "-root") {
          return Promise.resolve({
            stdout: `${cmd[4]}:  not found.\n`,
            exitCode: 0,
          });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });

      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      const mark = mockRun.mock.calls.length;
      await atoms.hide();

      const steamWrites: Array<{ atom: string; value: string }> = [];
      for (let i = mark; i < mockRun.mock.calls.length; i++) {
        const cmd = mockRun.mock.calls[i][0] as string[];
        if (
          cmd[0] === "env" &&
          cmd[2] === "xprop" &&
          cmd[3] === "-id" &&
          cmd[4] === STEAM_WIN_ID &&
          cmd[5] === "-f"
        ) {
          steamWrites.push({ atom: cmd[6], value: cmd[10] });
        }
      }
      const finalSteam = Object.fromEntries(
        steamWrites.map((w) => [w.atom, w.value]),
      );
      // STEAM_OVERLAY=1 restored (game in baselayer makes this safe).
      // INPUT_FOCUS/NOTIFICATION never touched by us — Steam's own
      // state machine manages them.
      expect(finalSteam.STEAM_OVERLAY).toBe("1");
      expect(finalSteam.STEAM_INPUT_FOCUS).toBeUndefined();
      expect(finalSteam.STEAM_NOTIFICATION).toBeUndefined();
    });

    it("show() still succeeds when Steam isn't running (xdotool --class finds nothing)", async () => {
      // --class returns exit 1; --name still returns our own window.
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("xdotool")) {
          if (cmd.includes("--class")) {
            return Promise.resolve({ stdout: "", exitCode: 1 });
          }
          return Promise.resolve({ stdout: "10\n", exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      // Own window still gets atoms set.
      const map = Object.fromEntries(
        capturedOwnXprops().map((c) => [c.atom, c.value]),
      );
      expect(map.STEAM_OVERLAY).toBe("1");
      // No xprop writes against a Steam window because there isn't one.
      const steamWrites = capturedXprops().filter(
        (c) => c.target !== OWN_WIN_ID,
      );
      expect(steamWrites).toHaveLength(0);
    });
  });

  describe("reclaim watcher", () => {
    // Reclaim watcher runs while the overlay is shown. Each tick reads
    // Steam's STEAM_OVERLAY + STEAM_INPUT_FOCUS on Steam's BPM window;
    // if either is 1, it re-zeroes Steam's trio and re-asserts ours.
    // We drive ticks synchronously via the private method to avoid
    // depending on setInterval timing in tests.

    const OWN_WIN_ID = "0xa"; // 10
    const STEAM_WIN_ID = "0x63"; // 99

    function captureWritesSince(
      mark: number,
    ): Array<{ target: string; atom: string; value: string }> {
      const out: Array<{ target: string; atom: string; value: string }> = [];
      for (let i = mark; i < mockRun.mock.calls.length; i++) {
        const cmd = mockRun.mock.calls[i][0] as string[];
        // `-f` flag marks a write (vs a bare read with just atom names).
        if (
          cmd[0] === "env" &&
          cmd[2] === "xprop" &&
          cmd[3] === "-id" &&
          cmd[5] === "-f"
        ) {
          out.push({ target: cmd[4], atom: cmd[6], value: cmd[10] });
        }
      }
      return out;
    }

    it("counter-asserts when Steam re-sets STEAM_OVERLAY=1 on its own window", async () => {
      // xdotool search by --name → us (10); --class → Steam (99).
      // xprop -id 0x63 STEAM_OVERLAY STEAM_INPUT_FOCUS → Steam is re-asserting.
      mockRun.mockImplementation((cmd: string[]) => {
        const xdotoolStdout = mockXdotoolSearch(cmd);
        if (xdotoolStdout !== null) {
          return Promise.resolve({ stdout: xdotoolStdout, exitCode: 0 });
        }
        // Atom-read call: 5 positional args to xprop with NO "-f" flag
        // (writes always include "-f"). Mock returns STEAM_OVERLAY=1.
        if (
          cmd[2] === "xprop" &&
          cmd[3] === "-id" &&
          !cmd.includes("-f")
        ) {
          return Promise.resolve({
            stdout: "STEAM_OVERLAY(CARDINAL) = 1\nSTEAM_INPUT_FOCUS(CARDINAL) = 0\n",
            exitCode: 0,
          });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });

      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      const mark = mockRun.mock.calls.length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (atoms as any)._reclaimTick();
      const writes = captureWritesSince(mark);

      // Steam's STEAM_OVERLAY got zeroed (the only thing reclaim
      // touches now). INPUT_FOCUS / NOTIFICATION are never written.
      const steamWrites = writes.filter((w) => w.target === STEAM_WIN_ID);
      const steamMap = Object.fromEntries(
        steamWrites.map((w) => [w.atom, w.value]),
      );
      expect(steamMap.STEAM_OVERLAY).toBe("0");
      expect(steamMap.STEAM_INPUT_FOCUS).toBeUndefined();
      expect(steamMap.STEAM_NOTIFICATION).toBeUndefined();

      // Ours overlay re-asserted (focus stays at 1 from show, no need
      // to re-write).
      const ownWrites = writes.filter((w) => w.target === OWN_WIN_ID);
      const ownMap = Object.fromEntries(
        ownWrites.map((w) => [w.atom, w.value]),
      );
      expect(ownMap.STEAM_OVERLAY).toBe("1");
    });

    it("is a no-op tick when Steam has not reclaimed", async () => {
      mockRun.mockImplementation((cmd: string[]) => {
        const xdotoolStdout = mockXdotoolSearch(cmd);
        if (xdotoolStdout !== null) {
          return Promise.resolve({ stdout: xdotoolStdout, exitCode: 0 });
        }
        if (
          cmd[2] === "xprop" &&
          cmd[3] === "-id" &&
          !cmd.includes("-f")
        ) {
          return Promise.resolve({
            stdout: "STEAM_OVERLAY(CARDINAL) = 0\nSTEAM_INPUT_FOCUS(CARDINAL) = 0\n",
            exitCode: 0,
          });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });

      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      const mark = mockRun.mock.calls.length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (atoms as any)._reclaimTick();
      const writes = captureWritesSince(mark);

      // Neither window got any atom writes — the read showed 0/0.
      expect(writes).toHaveLength(0);
    });

    it("hide() stops the watcher so later ticks no-op", async () => {
      mockRun.mockImplementation((cmd: string[]) => {
        const xdotoolStdout = mockXdotoolSearch(cmd);
        if (xdotoolStdout !== null) {
          return Promise.resolve({ stdout: xdotoolStdout, exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      await atoms.hide();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((atoms as any).reclaimTimer).toBeNull();
    });
  });

  describe("_positionOnPrimary (via show())", () => {
    // xrandr --query output with a primary + secondary monitor. show()
    // should pick the one marked "primary" and windowmove there.
    const XRANDR_MULTI = `Screen 0: minimum 16 x 16, current 3840 x 1080, maximum 32767 x 32767
eDP-1 connected 1920x1080+1920+0 (normal left inverted right x axis y axis) 290mm x 170mm
   1920x1080     60.00*+
HDMI-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 600mm x 340mm
   1920x1080     60.00*+
`;

    it("moves the window to the primary output's position + centers", async () => {
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("xdotool") && cmd.includes("search")) {
          return Promise.resolve({ stdout: "10\n", exitCode: 0 });
        }
        if (cmd.includes("xrandr")) {
          return Promise.resolve({ stdout: XRANDR_MULTI, exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      const windowmove = mockRun.mock.calls
        .map((c) => c[0] as string[])
        .find((c) => c.includes("windowmove"));
      expect(windowmove).toBeDefined();
      // HDMI-1 is primary at 1920x1080+0+0; window is 1280x800; center
      // -> x = 0 + (1920 - 1280) / 2 = 320, y = 0 + (1080 - 800) / 2 = 140.
      expect(windowmove).toContain("320");
      expect(windowmove).toContain("140");
    });

    it("falls back to the first connected output when none is marked primary", async () => {
      const noneConnectedPrimary = `eDP-1 connected 1920x1080+100+200 (normal) 290mm x 170mm
`;
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("xdotool") && cmd.includes("search")) {
          return Promise.resolve({ stdout: "10\n", exitCode: 0 });
        }
        if (cmd.includes("xrandr")) {
          return Promise.resolve({
            stdout: noneConnectedPrimary,
            exitCode: 0,
          });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      const windowmove = mockRun.mock.calls
        .map((c) => c[0] as string[])
        .find((c) => c.includes("windowmove"));
      // 100 + (1920-1280)/2 = 420; 200 + (1080-800)/2 = 340.
      expect(windowmove).toContain("420");
      expect(windowmove).toContain("340");
    });

    it("is a silent no-op when xrandr is missing", async () => {
      mockCommandExists.mockImplementation((name: string) =>
        Promise.resolve(name === "xdotool"),
      );
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("xdotool"))
          return Promise.resolve({ stdout: "10\n", exitCode: 0 });
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      // show() should still set atoms even when positioning is skipped.
      const ranXprop = mockRun.mock.calls.some(
        (c) => (c[0] as string[])[2] === "xprop",
      );
      expect(ranXprop).toBe(true);
    });
  });

  describe("STEAM_TOUCH_CLICK_MODE routing (root atom)", () => {
    // Argv shapes:
    //   read:  ["env", "DISPLAY=:0", "xprop", "-root", ATOM]
    //   set:   ["env", "DISPLAY=:0", "xprop", "-root", "-f", ATOM, "32c",
    //          "-set", ATOM, VALUE]
    function rootSets(): Array<{ atom: string; value: string }> {
      const out: Array<{ atom: string; value: string }> = [];
      for (const c of mockRun.mock.calls) {
        const cmd = c[0] as string[];
        if (cmd[2] === "xprop" && cmd[3] === "-root" && cmd[7] === "-set") {
          out.push({ atom: cmd[5], value: cmd[9] });
        }
      }
      return out;
    }

    function rootReads(): string[] {
      const out: string[] = [];
      for (const c of mockRun.mock.calls) {
        const cmd = c[0] as string[];
        if (
          cmd[2] === "xprop" &&
          cmd[3] === "-root" &&
          cmd.length === 5 &&
          cmd[4] !== "-f"
        ) {
          out.push(cmd[4]);
        }
      }
      return out;
    }

    /** Helper: respond to find-window + a scripted value for the root read.
     *  priorTouchMode=null mimics "not found" on root. */
    function mockWithPriorTouchMode(priorTouchMode: number | null) {
      mockRun.mockImplementation((cmd: string[]) => {
        const xdotoolStdout = mockXdotoolSearch(cmd);
        if (xdotoolStdout !== null) {
          return Promise.resolve({ stdout: xdotoolStdout, exitCode: 0 });
        }
        if (
          cmd[2] === "xprop" &&
          cmd[3] === "-root" &&
          cmd[4] === "STEAM_TOUCH_CLICK_MODE" &&
          cmd.length === 5
        ) {
          if (priorTouchMode === null) {
            return Promise.resolve({
              stdout: "STEAM_TOUCH_CLICK_MODE:  not found.\n",
              exitCode: 0,
            });
          }
          return Promise.resolve({
            stdout: `STEAM_TOUCH_CLICK_MODE(CARDINAL) = ${priorTouchMode}\n`,
            exitCode: 0,
          });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
    }

    it("show() reads root STEAM_TOUCH_CLICK_MODE and writes 4 on root when prior value was set", async () => {
      mockWithPriorTouchMode(1);
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      expect(rootReads()).toContain("STEAM_TOUCH_CLICK_MODE");
      const writes = rootSets().filter(
        (s) => s.atom === "STEAM_TOUCH_CLICK_MODE",
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].value).toBe("4");
    });

    it("show() writes 4 on root even when prior atom is 'not found' (fresh gamescope session)", async () => {
      mockWithPriorTouchMode(null);
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      const writes = rootSets().filter(
        (s) => s.atom === "STEAM_TOUCH_CLICK_MODE",
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].value).toBe("4");
    });

    it("hide() restores the snapshotted prior value on root", async () => {
      mockWithPriorTouchMode(2);
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      mockRun.mockClear();
      // After show(), Gamescope sees our value on root; the read during
      // hide() isn't needed — we restore from the in-memory snapshot.
      mockRun.mockImplementation((cmd: string[]) => {
        const xdotoolStdout = mockXdotoolSearch(cmd);
        if (xdotoolStdout !== null) {
          return Promise.resolve({ stdout: xdotoolStdout, exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      await atoms.hide();
      const writes = rootSets().filter(
        (s) => s.atom === "STEAM_TOUCH_CLICK_MODE",
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].value).toBe("2");
    });

    it("hide() does not write touch mode when show() found nothing to snapshot", async () => {
      mockWithPriorTouchMode(null);
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      mockRun.mockClear();
      mockRun.mockImplementation((cmd: string[]) => {
        const xdotoolStdout = mockXdotoolSearch(cmd);
        if (xdotoolStdout !== null) {
          return Promise.resolve({ stdout: xdotoolStdout, exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      await atoms.hide();
      const writes = rootSets().filter(
        (s) => s.atom === "STEAM_TOUCH_CLICK_MODE",
      );
      expect(writes).toHaveLength(0);
    });

    it("hide() restores TOUCH_MODE verbatim even when prior was already 4", async () => {
      // Pairs with the Steam-atoms-restore behaviour: if Steam's menu
      // was open at show() time (Steam set TOUCH_MODE=4 for
      // passthrough), we must restore it to 4 on hide so Steam's
      // menu touch routing keeps working. Earlier we tried writing 1
      // here as a "safe default" — that broke menu input when Steam's
      // menu was genuinely still open (user-reported).
      mockWithPriorTouchMode(4);
      const atoms = new GamescopeAtoms({ display: ":0", windowName: "X", forceXprop: true });
      await atoms.show();
      mockRun.mockClear();
      mockRun.mockImplementation((cmd: string[]) => {
        const xdotoolStdout = mockXdotoolSearch(cmd);
        if (xdotoolStdout !== null) {
          return Promise.resolve({ stdout: xdotoolStdout, exitCode: 0 });
        }
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      await atoms.hide();
      const writes = rootSets().filter(
        (s) => s.atom === "STEAM_TOUCH_CLICK_MODE",
      );
      expect(writes).toHaveLength(1);
      expect(writes[0].value).toBe("4");
    });
  });

  describe("raiseAboveDesktop / lowerFromDesktop", () => {
    // Desktop-mode front-and-focus: there's no gamescope to composite us, so
    // we lean on the WM. windowactivate raises + focuses; _NET_WM_STATE_ABOVE
    // pins us above the (now non-active) fullscreen Big Picture window.

    /** Find the `xdotool windowactivate <id>` call, if any. */
    function activateCall(): string[] | null {
      for (const c of mockRun.mock.calls) {
        const cmd = c[0] as string[];
        if (cmd.includes("xdotool") && cmd.includes("windowactivate")) {
          return cmd;
        }
      }
      return null;
    }

    /** Find the `xprop … -set _NET_WM_STATE <value>` write, if any. */
    function wmStateSet(): { target: string; value: string } | null {
      for (const c of mockRun.mock.calls) {
        const cmd = c[0] as string[];
        if (
          cmd[2] === "xprop" &&
          cmd[3] === "-id" &&
          cmd.includes("-set") &&
          cmd.includes("_NET_WM_STATE")
        ) {
          // ["env", "DISPLAY=:0", "xprop", "-id", <hex>, "-f",
          //  "_NET_WM_STATE", "32a", "-set", "_NET_WM_STATE", VALUE]
          return { target: cmd[4], value: cmd[cmd.length - 1] };
        }
      }
      return null;
    }

    it("activates the overlay window and pins it above on raise", async () => {
      // findWindow → our overlay (decimal 10 → 0xa).
      mockRun.mockImplementation((cmd: string[]) => {
        const stdout = mockXdotoolSearch(cmd);
        if (stdout !== null) return Promise.resolve({ stdout, exitCode: 0 });
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      const atoms = new GamescopeAtoms({
        display: ":0",
        windowName: "Loadout Overlay",
        forceXprop: true,
      });
      await atoms.raiseAboveDesktop();

      const activate = activateCall();
      expect(activate).not.toBeNull();
      expect(activate).toContain("0xa");

      const state = wmStateSet();
      expect(state).not.toBeNull();
      expect(state?.target).toBe("0xa");
      expect(state?.value).toBe("_NET_WM_STATE_ABOVE");
    });

    it("does nothing when xdotool is unavailable", async () => {
      mockCommandExists.mockImplementation(() => Promise.resolve(false));
      const atoms = new GamescopeAtoms({
        display: ":0",
        windowName: "Loadout Overlay",
        forceXprop: true,
      });
      await atoms.raiseAboveDesktop();
      expect(activateCall()).toBeNull();
    });

    it("clears _NET_WM_STATE on lower (only after a window is resolved)", async () => {
      mockRun.mockImplementation((cmd: string[]) => {
        const stdout = mockXdotoolSearch(cmd);
        if (stdout !== null) return Promise.resolve({ stdout, exitCode: 0 });
        return Promise.resolve({ stdout: "", exitCode: 0 });
      });
      const atoms = new GamescopeAtoms({
        display: ":0",
        windowName: "Loadout Overlay",
        forceXprop: true,
      });
      // Resolve the window id first (lowerFromDesktop no-ops without one).
      await atoms.findWindow();
      mockRun.mockClear();
      await atoms.lowerFromDesktop();

      const state = wmStateSet();
      expect(state).not.toBeNull();
      expect(state?.target).toBe("0xa");
      expect(state?.value).toBe("");
    });
  });
});
