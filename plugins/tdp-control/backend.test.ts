import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmitPayload } from "@loadout/types";
import TdpControlBackend from "./backend";
import { readSavedTdp } from "./lib/saved-tdp";

/**
 * TdpControlBackend tests.
 *
 * The backend reads/writes sysfs paths that don't exist outside Linux.
 * We test the RPC methods' validation logic, error paths, and the
 * state management that can be exercised without real hardware.
 *
 * For methods that write to sysfs, we verify they reject invalid input
 * correctly and return the expected { success, error? } shape.
 * The actual sysfs writes will fail in test (no /sys), exercising the
 * error handling path.
 */

describe("TdpControlBackend", () => {
  let backend: TdpControlBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(() => {
    backend = new TdpControlBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
    // Do NOT call onLoad() — it probes sysfs which doesn't exist in test.
    // Instead, test methods individually against the uninitialized state.
  });

  // ── setEpp ────────────────────────────────────────────────────────

  describe("setEpp", () => {
    it("rejects EPP value not in eppOptions", async () => {
      // eppOptions is empty by default (no onLoad)
      const result = await backend.setEpp("performance");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not available");
      expect(result.error).toContain("performance");
    });
  });

  // ── setGovernor ───────────────────────────────────────────────────

  describe("setGovernor", () => {
    it("rejects governor not in governorOptions", async () => {
      const result = await backend.setGovernor("powersave");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not available");
      expect(result.error).toContain("powersave");
    });
  });

  // ── setPlatformProfile ────────────────────────────────────────────

  describe("setPlatformProfile", () => {
    it("rejects profile not in platformProfileChoices", async () => {
      const result = await backend.setPlatformProfile("balanced");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not available");
      expect(result.error).toContain("balanced");
    });
  });

  // ── setSmt ────────────────────────────────────────────────────────

  describe("setSmt", () => {
    it("returns error when SMT is not supported", async () => {
      // supportsSmt is false by default
      const result = await backend.setSmt(true);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
    });

    it("returns error for disable when SMT is not supported", async () => {
      const result = await backend.setSmt(false);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
    });
  });

  // ── setCpuBoost ───────────────────────────────────────────────────

  describe("setCpuBoost", () => {
    it("returns error when CPU boost is not supported", async () => {
      // supportsCpuBoost is false by default
      const result = await backend.setCpuBoost(true);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
    });

    it("returns error for disable when CPU boost is not supported", async () => {
      const result = await backend.setCpuBoost(false);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
    });
  });

  // ── getGpuInfo ────────────────────────────────────────────────────

  describe("getGpuInfo", () => {
    it("returns null when no GPU is detected", async () => {
      const info = await backend.getGpuInfo();
      expect(info).toBeNull();
    });
  });

  // ── setGpuMode ────────────────────────────────────────────────────

  describe("setGpuMode", () => {
    it("returns error when no GPU is detected", async () => {
      const result = await backend.setGpuMode("auto");
      expect(result.success).toBe(false);
      expect(result.error).toContain("No GPU detected");
    });
  });

  // ── setGpuFreqRange ───────────────────────────────────────────────

  describe("setGpuFreqRange", () => {
    it("returns error when no GPU is detected", async () => {
      const result = await backend.setGpuFreqRange(200, 1600);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No GPU detected");
    });
  });

  // ── setChargeLimit ────────────────────────────────────────────────

  describe("setChargeLimit", () => {
    it("rejects percent below 20", async () => {
      const result = await backend.setChargeLimit(10);
      expect(result.success).toBe(false);
      expect(result.error).toContain("between 20 and 100");
    });

    it("rejects percent above 100", async () => {
      const result = await backend.setChargeLimit(110);
      expect(result.success).toBe(false);
      expect(result.error).toContain("between 20 and 100");
    });

    it("rejects boundary value 19", async () => {
      const result = await backend.setChargeLimit(19);
      expect(result.success).toBe(false);
    });

    it("returns error when charge limit sysfs path does not exist", async () => {
      // On non-Linux or test env, the sysfs path won't exist
      const result = await backend.setChargeLimit(80);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not supported");
    });
  });

  // ── getChargeLimit ────────────────────────────────────────────────

  describe("getChargeLimit", () => {
    it("returns null percent when sysfs path doesn't exist", async () => {
      const result = await backend.getChargeLimit();
      expect(result.percent).toBeNull();
    });
  });

  // ── getAcPowerStatus ──────────────────────────────────────────────

  describe("getAcPowerStatus", () => {
    it("returns null online status when AC power is not detected", async () => {
      const result = await backend.getAcPowerStatus();
      expect(result.online).toBeNull();
    });
  });

  // ── onSuspend ─────────────────────────────────────────────────────

  describe("onSuspend", () => {
    it("returns success (no-op on non-ROG-Ally)", async () => {
      const result = await backend.onSuspend();
      expect(result.success).toBe(true);
    });
  });

  // ── onResume ──────────────────────────────────────────────────────

  describe("onResume", () => {
    it("returns success even without tracked TDP", async () => {
      const result = await backend.onResume();
      expect(result.success).toBe(true);
    });
  });

  // ── setTdp ────────────────────────────────────────────────────────

  describe("setTdp", () => {
    it("returns error when method is none", async () => {
      // method is "none" by default (no onLoad)
      const result = await backend.setTdp(15);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No TDP control method");
    });

    it("short-circuits on method=none before clamping (any value)", async () => {
      // setTdp no longer rejects out-of-range values — it clamps. But with no
      // control method it still can't write, so the none-guard fires first.
      expect((await backend.setTdp(1)).error).toContain("No TDP control method");
      expect((await backend.setTdp(100)).error).toContain(
        "No TDP control method",
      );
    });
  });

  // ── power-state TDP limits (plugged vs battery) ───────────────────
  //
  // setTdp clamps to a *power-state-aware* ceiling and remembers the raw
  // request (desiredTdp) so an AC transition can re-apply it. We stub the
  // hardware write so we can assert the clamp math without /sys.

  describe("power-state limits", () => {
    function configure(opts: { ac: boolean | null }) {
      const b = backend as unknown as {
        method: string;
        minWatts: number;
        maxWatts: number;
        batteryMaxWatts: number;
        acPowerOnline: boolean | null;
        desiredTdp: number | null;
        currentTdp: number | null;
        setTdpViaRyzenadj: (w: number) => Promise<void>;
      };
      b.method = "ryzenadj";
      b.minWatts = 5;
      b.maxWatts = 80;
      b.batteryMaxWatts = 55;
      b.acPowerOnline = opts.ac;
      b.setTdpViaRyzenadj = async () => {}; // stub the SMU write
      return b;
    }

    it("applies the full value when plugged in", async () => {
      const b = configure({ ac: true });
      const result = await backend.setTdp(70);
      expect(result.success).toBe(true);
      expect(b.currentTdp).toBe(70);
      expect(b.desiredTdp).toBe(70);
    });

    it("clamps the applied value to the battery cap on battery", async () => {
      const b = configure({ ac: false });
      const result = await backend.setTdp(70);
      expect(result.success).toBe(true);
      // Cap wins over the request, but the intent is preserved for spring-back.
      expect(b.currentTdp).toBe(55);
      expect(b.desiredTdp).toBe(70);
      const changed = emittedEvents.find((e) => e.event === "tdpChanged");
      expect((changed?.data as { currentTdp: number }).currentTdp).toBe(55);
    });

    it("treats unknown AC state as plugged (no over-restriction)", async () => {
      const b = configure({ ac: null });
      await backend.setTdp(70);
      expect(b.currentTdp).toBe(70);
    });

    it("getTdpInfo reports the effective cap plus both ceilings", async () => {
      configure({ ac: false });
      const info = await backend.getTdpInfo();
      expect(info.maxWatts).toBe(55); // effective (on battery)
      expect(info.pluggedMaxWatts).toBe(80);
      expect(info.batteryMaxWatts).toBe(55);
    });
  });

  // ── manual TDP persistence ────────────────────────────────────────
  //
  // The user's chosen TDP must survive a shutdown: setTdp() persists it to
  // the plugin config file, and automatic applies (per-game/AC/resume, which
  // route through the private applyTdp()) must NOT overwrite it.

  describe("manual TDP persistence", () => {
    let dir: string;
    let prevXdg: string | undefined;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tdp-persist-test-"));
      prevXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = dir;
    });

    afterEach(() => {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      rmSync(dir, { recursive: true, force: true });
    });

    function configure() {
      const b = backend as unknown as {
        method: string;
        minWatts: number;
        maxWatts: number;
        batteryMaxWatts: number;
        acPowerOnline: boolean | null;
        setTdpViaRyzenadj: (w: number) => Promise<void>;
        applyTdp: (w: number) => Promise<{ success: boolean }>;
      };
      b.method = "ryzenadj";
      b.minWatts = 5;
      b.maxWatts = 80;
      b.batteryMaxWatts = 55;
      b.acPowerOnline = true;
      b.setTdpViaRyzenadj = async () => {}; // stub the SMU write
      return b;
    }

    it("setTdp persists the user's chosen value", async () => {
      configure();
      const result = await backend.setTdp(28);
      expect(result.success).toBe(true);
      expect(await readSavedTdp("tdp-control")).toBe(28);
    });

    it("applyProfile persists the preset value", async () => {
      const b = configure();
      // Seed a known preset so applyProfile has something to apply.
      (b as unknown as { profiles: Record<string, number> }).profiles = {
        Silent: 10,
        Balanced: 18,
        Performance: 40,
      };
      const result = await backend.applyProfile("Balanced");
      expect(result.success).toBe(true);
      expect(await readSavedTdp("tdp-control")).toBe(18);
    });

    it("automatic applyTdp does NOT overwrite the saved value", async () => {
      const b = configure();
      await backend.setTdp(28);
      expect(await readSavedTdp("tdp-control")).toBe(28);
      // Simulate an automatic re-apply (per-game profile / AC / resume).
      await b.applyTdp(12);
      expect(await readSavedTdp("tdp-control")).toBe(28);
    });

    it("setTdp does NOT overwrite the saved value while a per-game profile governs TDP", async () => {
      const b = configure();
      // Establish the manual "no game" value (no engine → nothing governs).
      await backend.setTdp(35);
      expect(await readSavedTdp("tdp-control")).toBe(35);

      // Now a per-game profile is actively governing TDP: the frontend routes
      // the slider to setGameProfile, and the parallel setTdp must NOT clobber
      // the manual no-game value with the in-game watts.
      (b as unknown as { profileEngine: unknown }).profileEngine = {
        getCurrentState: () => ({
          activeProfile: null,
          currentTdp: 35,
          isGameRunning: true,
          perGameEnabled: true,
        }),
      };
      const result = await backend.setTdp(20);
      expect(result.success).toBe(true); // still applied to hardware
      expect(await readSavedTdp("tdp-control")).toBe(35); // saved value intact
    });

    it("setTdp DOES persist when a game runs but per-game is disabled", async () => {
      const b = configure();
      // Per-game off → setTdp is the only TDP control, so it must persist even
      // if a game happens to be tracked as running.
      (b as unknown as { profileEngine: unknown }).profileEngine = {
        getCurrentState: () => ({
          activeProfile: null,
          currentTdp: 15,
          isGameRunning: true,
          perGameEnabled: false,
        }),
      };
      await backend.setTdp(22);
      expect(await readSavedTdp("tdp-control")).toBe(22);
    });
  });

  // ── getProfiles ───────────────────────────────────────────────────

  describe("getProfiles", () => {
    it("returns default profile map", async () => {
      const profiles = await backend.getProfiles();
      expect(profiles).toHaveProperty("Silent");
      expect(profiles).toHaveProperty("Balanced");
      expect(profiles).toHaveProperty("Performance");
      expect(typeof profiles.Silent).toBe("number");
      expect(typeof profiles.Balanced).toBe("number");
      expect(typeof profiles.Performance).toBe("number");
    });

    it("returns a copy (mutation-safe)", async () => {
      const p1 = await backend.getProfiles();
      p1.Silent = 999;
      const p2 = await backend.getProfiles();
      expect(p2.Silent).not.toBe(999);
    });
  });

  // ── applyProfile ──────────────────────────────────────────────────

  describe("applyProfile", () => {
    it("rejects unknown profile name", async () => {
      const result = await backend.applyProfile("Turbo");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown profile");
    });
  });

  // ── Per-game TDP profile methods (without engine initialized) ─────

  describe("getGameProfiles (uninitialized)", () => {
    it("returns empty array when engine is not initialized", async () => {
      const profiles = await backend.getGameProfiles();
      expect(profiles).toEqual([]);
    });
  });

  describe("setGameProfile (uninitialized)", () => {
    it("returns error when engine is not initialized", async () => {
      const result = await backend.setGameProfile(730, "CS2", 15);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not initialized");
    });
  });

  describe("removeGameProfile (uninitialized)", () => {
    it("returns error when engine is not initialized", async () => {
      const result = await backend.removeGameProfile(730);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not initialized");
    });
  });

  describe("getGameDefaultTdp (uninitialized)", () => {
    it("returns fallback of 15 when engine is not initialized", async () => {
      const watts = await backend.getGameDefaultTdp();
      expect(watts).toBe(15);
    });
  });

  describe("setGameDefaultTdp (uninitialized)", () => {
    it("returns error when engine is not initialized", async () => {
      const result = await backend.setGameDefaultTdp(20);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not initialized");
    });
  });

  describe("getCurrentProfileState (uninitialized)", () => {
    it("returns null when engine is not initialized", async () => {
      const state = await backend.getCurrentProfileState();
      expect(state).toBeNull();
    });
  });

  describe("handleGameLaunch (uninitialized)", () => {
    it("returns error when engine is not initialized", async () => {
      const result = await backend.handleGameLaunch(730, "CS2");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not initialized");
    });
  });

  describe("handleGameExit (uninitialized)", () => {
    it("returns error when engine is not initialized", async () => {
      const result = await backend.handleGameExit(730);
      expect(result.success).toBe(false);
      expect(result.error).toContain("not initialized");
    });
  });

  // ── getTdpInfo ────────────────────────────────────────────────────

  describe("getTdpInfo", () => {
    it("returns complete TdpInfo structure", async () => {
      const info = await backend.getTdpInfo();
      expect(info).toHaveProperty("currentTdp");
      expect(info).toHaveProperty("tdpReadSource");
      expect(info).toHaveProperty("minWatts");
      expect(info).toHaveProperty("maxWatts");
      expect(info).toHaveProperty("platform");
      expect(info).toHaveProperty("deviceName");
      expect(info).toHaveProperty("method");
      expect(info).toHaveProperty("profiles");
      expect(info).toHaveProperty("cpuVendor");
      expect(info).toHaveProperty("supportsSmt");
      expect(info).toHaveProperty("supportsCpuBoost");
      expect(info).toHaveProperty("gpuInfo");
      expect(info).toHaveProperty("smtEnabled");
      expect(info).toHaveProperty("cpuBoostEnabled");
      expect(info).toHaveProperty("acPowerOnline");
      expect(info).toHaveProperty("chargeLimitPercent");
    });

    it("method is none when not initialized", async () => {
      const info = await backend.getTdpInfo();
      expect(info.method).toBe("none");
    });
  });

  // ── getSystemInfo ─────────────────────────────────────────────────

  describe("getSystemInfo", () => {
    it("returns complete SystemInfo structure", async () => {
      const info = await backend.getSystemInfo();
      expect(info).toHaveProperty("deviceName");
      expect(info).toHaveProperty("dmiProductName");
      expect(info).toHaveProperty("cpuVendor");
      expect(info).toHaveProperty("cpuModel");
      expect(info).toHaveProperty("scalingDriver");
      expect(info).toHaveProperty("tdpMethod");
      expect(info).toHaveProperty("platformProfile");
      expect(info).toHaveProperty("platformProfileChoices");
      expect(info).toHaveProperty("eppOptions");
      expect(info).toHaveProperty("governorOptions");
      expect(info).toHaveProperty("supportsSmt");
      expect(info).toHaveProperty("supportsCpuBoost");
      expect(info).toHaveProperty("ryzenadjAvailable");
      expect(info).toHaveProperty("intelRaplAvailable");
      expect(info).toHaveProperty("gpuVendor");
      expect(info).toHaveProperty("supportsGpuControl");
      expect(info).toHaveProperty("supportsChargeLimit");
    });
  });
});
