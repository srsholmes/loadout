import { describe, it, expect, beforeEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import TdpControlBackend from "./backend";

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

    it("rejects TDP below minimum", async () => {
      // Default min is 5
      const result = await backend.setTdp(1);
      expect(result.success).toBe(false);
      expect(result.error).toContain("must be between");
    });

    it("rejects TDP above maximum", async () => {
      // Default max is 35
      const result = await backend.setTdp(100);
      expect(result.success).toBe(false);
      expect(result.error).toContain("must be between");
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
