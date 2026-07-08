import { describe, test, expect, beforeEach, afterEach } from "bun:test";
// Use node:fs sync APIs instead of node:fs/promises to avoid contamination
// from mock.module("node:fs/promises", ...) in other test files.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTdpProfileEngine,
  type TdpProfile,
  type TdpProfileStore,
} from "./tdp-profiles";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let configPath: string;
let appliedTdpValues: number[];
let profileChangedCalls: Array<{
  profile: TdpProfile | null;
  gameName: string;
}>;
let onApplyTdp: (watts: number) => Promise<void>;
let onProfileChanged: (profile: TdpProfile | null, gameName: string) => void;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tdp-profiles-test-"));
  configPath = join(tempDir, "tdp-profiles.json");
  appliedTdpValues = [];
  profileChangedCalls = [];

  onApplyTdp = async (watts: number) => {
    appliedTdpValues.push(watts);
  };
  onProfileChanged = (profile: TdpProfile | null, gameName: string) => {
    profileChangedCalls.push({ profile, gameName });
  };
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createEngine() {
  return createTdpProfileEngine({
    configPath,
    onApplyTdp,
    onProfileChanged,
  });
}

// Engine wired with the backend's `getNoGameTdp` injection — mirrors
// production, where the user's persisted manual TDP is the authoritative
// "no game" value (ahead of the engine's stored `defaultTdp`).
function createEngineWithNoGameTdp(getNoGameTdp: () => number | null) {
  return createTdpProfileEngine({
    configPath,
    onApplyTdp,
    onProfileChanged,
    getNoGameTdp,
  });
}

async function writeConfig(store: Partial<TdpProfileStore> & {
  defaultTdp: number;
  profiles: Array<TdpProfile>;
}) {
  // Existing tests construct stores without `version` / `perGameEnabled`;
  // fill in the new fields with sensible defaults so the engine's
  // structural validator still accepts them.
  const full: TdpProfileStore = {
    version: 1,
    defaultTdp: store.defaultTdp,
    profiles: store.profiles,
    perGameEnabled: store.perGameEnabled ?? true,
  };
  await Bun.write(configPath, JSON.stringify(full, null, 2));
}

async function readConfig(): Promise<TdpProfileStore> {
  const file = Bun.file(configPath);
  return JSON.parse(await file.text());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TDP Profile Engine", () => {
  // -------------------------------------------------------------------------
  // Loading profiles
  // -------------------------------------------------------------------------

  describe("loadProfiles", () => {
    test("returns defaults when config file does not exist", async () => {
      const engine = createEngine();
      await engine.loadProfiles();

      expect(engine.getDefaultTdp()).toBe(15);
      expect(engine.getAllProfiles()).toEqual([]);
    });

    test("returns defaults when config file is empty", async () => {
      await Bun.write(configPath, "");

      const engine = createEngine();
      await engine.loadProfiles();

      expect(engine.getDefaultTdp()).toBe(15);
      expect(engine.getAllProfiles()).toEqual([]);
    });

    test("returns defaults when config file has invalid JSON", async () => {
      await Bun.write(configPath, "not valid json {{{");

      const engine = createEngine();
      await engine.loadProfiles();

      expect(engine.getDefaultTdp()).toBe(15);
      expect(engine.getAllProfiles()).toEqual([]);
    });

    test("returns defaults when config has wrong structure", async () => {
      await Bun.write(configPath, JSON.stringify({ foo: "bar" }));

      const engine = createEngine();
      await engine.loadProfiles();

      expect(engine.getDefaultTdp()).toBe(15);
      expect(engine.getAllProfiles()).toEqual([]);
    });

    test("loads profiles from valid file", async () => {
      await writeConfig({
        defaultTdp: 12,
        profiles: [
          { appId: 730, gameName: "CS2", tdpWatts: 20 },
          { appId: 570, gameName: "Dota 2", tdpWatts: 18 },
        ],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      expect(engine.getDefaultTdp()).toBe(12);
      expect(engine.getAllProfiles()).toEqual([
        { appId: 730, gameName: "CS2", tdpWatts: 20 },
        { appId: 570, gameName: "Dota 2", tdpWatts: 18 },
      ]);
    });

    test("filters out invalid profile entries", async () => {
      await Bun.write(
        configPath,
        JSON.stringify({
          defaultTdp: 15,
          profiles: [
            { appId: 730, gameName: "CS2", tdpWatts: 20 },
            { appId: "not-a-number", gameName: "Bad", tdpWatts: 15 },
            { appId: 570 }, // missing fields
            null,
            42,
            { appId: 440, gameName: "TF2", tdpWatts: 10 },
          ],
        }),
      );

      const engine = createEngine();
      await engine.loadProfiles();

      expect(engine.getAllProfiles()).toEqual([
        { appId: 730, gameName: "CS2", tdpWatts: 20 },
        { appId: 440, gameName: "TF2", tdpWatts: 10 },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Saving profiles (round-trip)
  // -------------------------------------------------------------------------

  describe("saveProfiles / round-trip", () => {
    test("save and load round-trip preserves data", async () => {
      const engine1 = createEngine();
      await engine1.loadProfiles();
      await engine1.setProfile(730, "CS2", 20);
      await engine1.setProfile(570, "Dota 2", 18);
      await engine1.setDefaultTdp(12);

      // Load in a fresh engine
      const engine2 = createEngine();
      await engine2.loadProfiles();

      expect(engine2.getDefaultTdp()).toBe(12);
      expect(engine2.getAllProfiles()).toEqual([
        { appId: 730, gameName: "CS2", tdpWatts: 20 },
        { appId: 570, gameName: "Dota 2", tdpWatts: 18 },
      ]);
    });

    test("atomic write uses temp file then rename", async () => {
      const engine = createEngine();
      await engine.loadProfiles();
      await engine.setProfile(730, "CS2", 20);

      // Verify the final file exists and the .tmp does not
      const finalFile = Bun.file(configPath);
      const tmpFile = Bun.file(configPath + ".tmp");

      expect(await finalFile.exists()).toBe(true);
      expect(await tmpFile.exists()).toBe(false);

      // Verify content is valid JSON
      const content = JSON.parse(await finalFile.text());
      expect(content.profiles).toHaveLength(1);
      expect(content.profiles[0].appId).toBe(730);
    });
  });

  // -------------------------------------------------------------------------
  // handleGameLaunch
  // -------------------------------------------------------------------------

  describe("commit queue (regression: AMD SMU mailbox race on focus swap)", () => {
    test("rapid exit→launch collapses to a single hardware write at the new target", async () => {
      // Repro: Konsole has focus, user switches to Cyberpunk. The poller
      // fires exit(Konsole) + launch(Cyberpunk) within milliseconds.
      // Pre-fix this issued two concurrent ryzenadj calls, one for the
      // default and one for Cyberpunk's profile, racing for /dev/mem.
      // Post-fix, the debounce/serialize queue collapses them into a
      // single write of the launch's target.
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 1091500, gameName: "Cyberpunk", tdpWatts: 22 }],
      });
      const engine = createEngine();
      await engine.loadProfiles();
      // Seed a running app so handleGameExit has something to clear.
      await engine.handleGameLaunch(3576336406, "Konsole");
      appliedTdpValues = [];

      // Fire exit + launch back-to-back, do NOT await between them — this
      // mirrors how the CDP binding callback dispatches.
      const p1 = engine.handleGameExit(3576336406);
      const p2 = engine.handleGameLaunch(1091500, "Cyberpunk");
      await Promise.all([p1, p2]);

      expect(appliedTdpValues).toEqual([22]);
    });

    test("each focus change writes once (no last-watt cache, debounce only)", async () => {
      // We deliberately don't dedupe against a cached "last applied"
      // because the backend's setTdp (slider path) bypasses this queue.
      // Caching here would silently skip writes the user wanted —
      // see the bug where slider-set 50W + focus change to a no-profile
      // game incorrectly stayed at 50W. A redundant ryzenadj per focus
      // change is cheap; staleness is a real correctness bug.
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 15 }],
      });
      const engine = createEngine();
      await engine.loadProfiles();
      await engine.handleGameLaunch(730, "CS2"); // applies 15
      appliedTdpValues = [];

      // Exit goes back to defaultTdp (also 15) — still writes.
      await engine.handleGameExit(730);

      expect(appliedTdpValues).toEqual([15]);
    });
  });

  describe("handleGameLaunch", () => {
    test("applies correct TDP when game has a profile", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 22 }],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      await engine.handleGameLaunch(730, "CS2");

      expect(appliedTdpValues).toEqual([22]);
      expect(profileChangedCalls).toEqual([
        {
          profile: { appId: 730, gameName: "CS2", tdpWatts: 22 },
          gameName: "CS2",
        },
      ]);

      const state = engine.getCurrentState();
      expect(state.isGameRunning).toBe(true);
      expect(state.currentTdp).toBe(22);
      expect(state.activeProfile).toEqual({
        appId: 730,
        gameName: "CS2",
        tdpWatts: 22,
      });
    });

    test("applies default TDP when game has no profile", async () => {
      await writeConfig({
        defaultTdp: 12,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 22 }],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      await engine.handleGameLaunch(999, "Unknown Game");

      expect(appliedTdpValues).toEqual([12]);
      expect(profileChangedCalls).toEqual([
        { profile: null, gameName: "Unknown Game" },
      ]);

      const state = engine.getCurrentState();
      expect(state.isGameRunning).toBe(true);
      expect(state.currentTdp).toBe(12);
      expect(state.activeProfile).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // handleGameExit
  // -------------------------------------------------------------------------

  describe("handleGameExit", () => {
    test("restores default TDP when game exits", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      // Launch game — applies 25W
      await engine.handleGameLaunch(730, "CS2");
      appliedTdpValues = []; // reset
      profileChangedCalls = [];

      // Exit game — should restore 15W default
      await engine.handleGameExit(730);

      expect(appliedTdpValues).toEqual([15]);
      expect(profileChangedCalls).toEqual([{ profile: null, gameName: "" }]);

      const state = engine.getCurrentState();
      expect(state.isGameRunning).toBe(false);
      expect(state.currentTdp).toBe(15);
      expect(state.activeProfile).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getNoGameTdp — the manual "no game" TDP takes precedence over defaultTdp
  // -------------------------------------------------------------------------

  describe("getNoGameTdp (manual no-game TDP)", () => {
    test("handleGameExit restores the manual TDP, not defaultTdp", async () => {
      await writeConfig({
        defaultTdp: 12,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
      });
      // User's persisted manual TDP is 35W; engine default is 12W.
      const engine = createEngineWithNoGameTdp(() => 35);
      await engine.loadProfiles();

      await engine.handleGameLaunch(730, "CS2"); // 25W (profile)
      appliedTdpValues = [];

      await engine.handleGameExit(730);

      expect(appliedTdpValues).toEqual([35]); // manual, not the 12W default
    });

    test("falls back to defaultTdp when getNoGameTdp returns null", async () => {
      await writeConfig({
        defaultTdp: 12,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
      });
      const engine = createEngineWithNoGameTdp(() => null);
      await engine.loadProfiles();

      await engine.handleGameLaunch(730, "CS2");
      appliedTdpValues = [];

      await engine.handleGameExit(730);

      expect(appliedTdpValues).toEqual([12]);
    });

    test("falls back to defaultTdp when the callback is not provided", async () => {
      await writeConfig({
        defaultTdp: 12,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
      });
      const engine = createEngine(); // no getNoGameTdp injection
      await engine.loadProfiles();

      await engine.handleGameLaunch(730, "CS2");
      appliedTdpValues = [];

      await engine.handleGameExit(730);

      expect(appliedTdpValues).toEqual([12]);
    });

    test("launching a game WITHOUT a profile applies the manual TDP", async () => {
      await writeConfig({ defaultTdp: 12, profiles: [] });
      const engine = createEngineWithNoGameTdp(() => 35);
      await engine.loadProfiles();

      await engine.handleGameLaunch(999, "Unprofiled Game");

      expect(appliedTdpValues).toEqual([35]);
    });

    test("a recognized per-game profile still wins over the manual TDP", async () => {
      await writeConfig({
        defaultTdp: 12,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
      });
      const engine = createEngineWithNoGameTdp(() => 35);
      await engine.loadProfiles();

      await engine.handleGameLaunch(730, "CS2");

      expect(appliedTdpValues).toEqual([25]); // profile precedence intact
    });

    test("removing the running game's profile falls back to the manual TDP", async () => {
      await writeConfig({
        defaultTdp: 12,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
      });
      const engine = createEngineWithNoGameTdp(() => 35);
      await engine.loadProfiles();

      await engine.handleGameLaunch(730, "CS2"); // 25W
      appliedTdpValues = [];

      await engine.removeProfile(730);

      expect(appliedTdpValues).toEqual([35]); // manual, consistent with exit
    });

    test("enabling per-game while an unprofiled game runs applies the manual TDP", async () => {
      await writeConfig({
        defaultTdp: 12,
        profiles: [],
        perGameEnabled: false,
      });
      const engine = createEngineWithNoGameTdp(() => 35);
      await engine.loadProfiles();

      await engine.handleGameLaunch(999, "Unprofiled Game"); // no apply (off)
      appliedTdpValues = [];

      await engine.setPerGameEnabled(true);

      expect(appliedTdpValues).toEqual([35]);
    });
  });

  // -------------------------------------------------------------------------
  // setProfile
  // -------------------------------------------------------------------------

  describe("setProfile", () => {
    test("creates a new profile", async () => {
      const engine = createEngine();
      await engine.loadProfiles();

      await engine.setProfile(730, "CS2", 20);

      expect(engine.getProfile(730)).toEqual({
        appId: 730,
        gameName: "CS2",
        tdpWatts: 20,
      });
      expect(engine.getAllProfiles()).toHaveLength(1);

      // Verify persisted to disk
      const saved = await readConfig();
      expect(saved.profiles).toHaveLength(1);
      expect(saved.profiles[0]).toEqual({
        appId: 730,
        gameName: "CS2",
        tdpWatts: 20,
      });
    });

    test("updates an existing profile", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 20 }],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      await engine.setProfile(730, "Counter-Strike 2", 25);

      expect(engine.getProfile(730)).toEqual({
        appId: 730,
        gameName: "Counter-Strike 2",
        tdpWatts: 25,
      });
      // Still only one profile
      expect(engine.getAllProfiles()).toHaveLength(1);
    });

    test("applies TDP immediately if the game is currently running", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 20 }],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      // Launch the game
      await engine.handleGameLaunch(730, "CS2");
      appliedTdpValues = [];

      // Update the profile while game is running
      await engine.setProfile(730, "CS2", 28);

      // Should have applied 28W immediately
      expect(appliedTdpValues).toEqual([28]);

      const state = engine.getCurrentState();
      expect(state.currentTdp).toBe(28);
      expect(state.activeProfile?.tdpWatts).toBe(28);
    });
  });

  // -------------------------------------------------------------------------
  // removeProfile
  // -------------------------------------------------------------------------

  describe("removeProfile", () => {
    test("deletes an existing profile", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [
          { appId: 730, gameName: "CS2", tdpWatts: 20 },
          { appId: 570, gameName: "Dota 2", tdpWatts: 18 },
        ],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      await engine.removeProfile(730);

      expect(engine.getProfile(730)).toBeUndefined();
      expect(engine.getAllProfiles()).toHaveLength(1);
      expect(engine.getAllProfiles()[0].appId).toBe(570);

      // Verify persisted
      const saved = await readConfig();
      expect(saved.profiles).toHaveLength(1);
    });

    test("reverts to default if the removed game is currently running", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      await engine.handleGameLaunch(730, "CS2");
      appliedTdpValues = [];

      await engine.removeProfile(730);

      // Should revert to 15W default
      expect(appliedTdpValues).toEqual([15]);
      const state = engine.getCurrentState();
      expect(state.currentTdp).toBe(15);
      expect(state.activeProfile).toBeNull();
    });

    test("removing a non-existent profile is a no-op for applied TDP", async () => {
      const engine = createEngine();
      await engine.loadProfiles();

      // Should not throw
      await engine.removeProfile(99999);

      expect(engine.getAllProfiles()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Default TDP
  // -------------------------------------------------------------------------

  describe("setDefaultTdp", () => {
    test("updates default and applies when no game is running", async () => {
      const engine = createEngine();
      await engine.loadProfiles();

      await engine.setDefaultTdp(20);

      expect(engine.getDefaultTdp()).toBe(20);
      expect(appliedTdpValues).toEqual([20]);

      const state = engine.getCurrentState();
      expect(state.currentTdp).toBe(20);
    });

    test("does not apply during game if a game is running", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      await engine.handleGameLaunch(730, "CS2");
      appliedTdpValues = [];

      // Change default while game is running
      await engine.setDefaultTdp(10);

      // Should NOT apply 10W — game is still running at its profile TDP
      expect(appliedTdpValues).toEqual([]);
      expect(engine.getDefaultTdp()).toBe(10);

      // But after game exits, new default applies
      await engine.handleGameExit(730);
      expect(appliedTdpValues).toEqual([10]);
    });
  });

  // -------------------------------------------------------------------------
  // TDP clamping
  // -------------------------------------------------------------------------

  describe("TDP clamping", () => {
    test("clamps TDP below minimum (3W) to 3", async () => {
      const engine = createEngine();
      await engine.loadProfiles();

      await engine.setProfile(100, "Low Game", 1);
      expect(engine.getProfile(100)?.tdpWatts).toBe(3);
    });

    test("clamps TDP above maximum (80W) to 80", async () => {
      const engine = createEngine();
      await engine.loadProfiles();

      await engine.setProfile(200, "High Game", 100);
      expect(engine.getProfile(200)?.tdpWatts).toBe(80);
    });

    test("clamps default TDP to valid range", async () => {
      const engine = createEngine();
      await engine.loadProfiles();

      await engine.setDefaultTdp(0);
      expect(engine.getDefaultTdp()).toBe(3);

      await engine.setDefaultTdp(100);
      expect(engine.getDefaultTdp()).toBe(80);
    });

    test("clamps values loaded from config file", async () => {
      await writeConfig({
        defaultTdp: 999,
        profiles: [
          { appId: 1, gameName: "Low", tdpWatts: -5 },
          { appId: 2, gameName: "High", tdpWatts: 100 },
        ],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      expect(engine.getDefaultTdp()).toBe(80);
      expect(engine.getProfile(1)?.tdpWatts).toBe(3);
      expect(engine.getProfile(2)?.tdpWatts).toBe(80);
    });
  });

  // -------------------------------------------------------------------------
  // getCurrentState
  // -------------------------------------------------------------------------

  describe("getCurrentState", () => {
    test("returns correct initial state", async () => {
      const engine = createEngine();
      await engine.loadProfiles();

      const state = engine.getCurrentState();
      expect(state.activeProfile).toBeNull();
      expect(state.currentTdp).toBe(15);
      expect(state.isGameRunning).toBe(false);
    });

    test("returns a copy, not a reference", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 20 }],
      });

      const engine = createEngine();
      await engine.loadProfiles();
      await engine.handleGameLaunch(730, "CS2");

      const state1 = engine.getCurrentState();
      const state2 = engine.getCurrentState();

      // Should be equal but not the same reference
      expect(state1).toEqual(state2);
      expect(state1.activeProfile).not.toBe(state2.activeProfile);
    });
  });

  // -------------------------------------------------------------------------
  // getProfile / getAllProfiles
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // perGameEnabled toggle
  // -------------------------------------------------------------------------

  describe("perGameEnabled", () => {
    test("defaults to false on a fresh engine", async () => {
      const engine = createEngine();
      await engine.loadProfiles();
      expect(engine.getPerGameEnabled()).toBe(false);
    });

    test("when off, handleGameLaunch does not call onApplyTdp", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
        perGameEnabled: false,
      });
      const engine = createEngine();
      await engine.loadProfiles();

      await engine.handleGameLaunch(730, "CS2");

      expect(appliedTdpValues).toEqual([]);
      // Engine still tracks the game so the UI can offer "save current TDP".
      expect(engine.getCurrentState().isGameRunning).toBe(true);
    });

    test("when off, handleGameExit does not call onApplyTdp", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
        perGameEnabled: false,
      });
      const engine = createEngine();
      await engine.loadProfiles();
      await engine.handleGameLaunch(730, "CS2");
      appliedTdpValues = [];

      await engine.handleGameExit(730);

      expect(appliedTdpValues).toEqual([]);
      expect(engine.getCurrentState().isGameRunning).toBe(false);
    });

    test("setPerGameEnabled persists across reloads", async () => {
      const engine1 = createEngine();
      await engine1.loadProfiles();
      await engine1.setPerGameEnabled(true);

      const engine2 = createEngine();
      await engine2.loadProfiles();
      expect(engine2.getPerGameEnabled()).toBe(true);
    });

    test("toggling on while a game is running applies that game's profile", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 25 }],
        perGameEnabled: false,
      });
      const engine = createEngine();
      await engine.loadProfiles();
      await engine.handleGameLaunch(730, "CS2");
      appliedTdpValues = [];

      await engine.setPerGameEnabled(true);

      expect(appliedTdpValues).toEqual([25]);
      expect(engine.getCurrentState().activeProfile?.tdpWatts).toBe(25);
    });
  });

  describe("getProfile / getAllProfiles", () => {
    test("getProfile returns undefined for non-existent appId", async () => {
      const engine = createEngine();
      await engine.loadProfiles();

      expect(engine.getProfile(99999)).toBeUndefined();
    });

    test("getAllProfiles returns a copy", async () => {
      await writeConfig({
        defaultTdp: 15,
        profiles: [{ appId: 730, gameName: "CS2", tdpWatts: 20 }],
      });

      const engine = createEngine();
      await engine.loadProfiles();

      const profiles1 = engine.getAllProfiles();
      const profiles2 = engine.getAllProfiles();

      expect(profiles1).toEqual(profiles2);
      // Arrays should be different references
      expect(profiles1).not.toBe(profiles2);
    });
  });
});
