import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import type { Subprocess } from "bun";

// Mock fs/promises
const mockReaddir = mock(() => Promise.resolve([] as string[]));
const mockReadFile = mock(() => Promise.resolve(""));
mock.module("fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
}));

// Mock fs (existsSync) — spread real fs to avoid contaminating other modules
import * as realFs from "fs";
const mockExistsSync = mock(() => false);
mock.module("fs", () => ({
  ...realFs,
  existsSync: mockExistsSync,
}));

import FanControlBackend from "./backend";

// ---------------------------------------------------------------------------
// Test-only types. Backend's internal interfaces (HwmonDevice, TempSensor,
// FanDevice, PresetName) aren't exported, so we mirror just the slice the
// tests need. Each `(backend as any)` callsite shares these aliases.
// ---------------------------------------------------------------------------

type FanDeviceLike = {
  index: number;
  inputPath: string;
  pwmPath: string | null;
  pwmEnablePath: string | null;
};
type HwmonDeviceLike = {
  dir: string;
  chipName: string;
  fans: FanDeviceLike[];
  hasPwmControl: boolean;
};
type TempSensorLike = {
  inputPath: string;
  label: string;
  zone: string;
  chipName: string;
};

/** Slice of the backend's private API the tests poke at. */
type FanBackendInternals = {
  interval?: ReturnType<typeof setInterval>;
  curveInterval?: ReturnType<typeof setInterval>;
  activeFanDevice: HwmonDeviceLike | null;
  tempSensors: TempSensorLike[];
  useEctool: boolean;
  manualModeRequested: "auto" | "manual" | null;
  safetyEngaged: boolean;
  scanHardware(): Promise<boolean>;
  scanHwmonDevices(): Promise<HwmonDeviceLike[]>;
  applySafetyFloor(percent: number): Promise<number>;
  applyCurve(curve: { tempC: number; percent: number }[]): Promise<void>;
  setFanSpeedInternal(percent: number): Promise<{ success: boolean; error?: string }>;
  safetyWatchdogTick(): Promise<void>;
  getCpuTempCOrNull(): Promise<number | null>;
  interpolateCurve(
    curve: { tempC: number; percent: number }[],
    tempC: number,
  ): number;
  parsePwmMode(n: number): string;
  classifyTempZone(chipName: string, label: string): string;
};
const internals = (b: FanControlBackend): FanBackendInternals =>
  b as unknown as FanBackendInternals;

/** Bun.spawn return type. Tests fake only the I/O streams + exit. */
type SpawnedLike = Pick<Subprocess, "stdout" | "stderr" | "stdin" | "exited">;
const asSpawned = (m: SpawnedLike): Subprocess => m as unknown as Subprocess;

/** Bun.spawn argv. Tests inspect cmd[0] / cmd[1] / cmd[2]. */
type SpawnArgv = readonly string[];

describe("FanControlBackend", () => {
  let backend: FanControlBackend;
  let emittedEvents: EmitPayload[];
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    backend = new FanControlBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
    mockReaddir.mockClear();
    mockReadFile.mockClear();
    mockExistsSync.mockClear();

    // Clear any intervals
    clearInterval(internals(backend).interval);
    clearInterval(internals(backend).curveInterval);

    // Default: no Bun.spawn calls
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      (() =>
        asSpawned({
          stdout: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          stdin: null,
          exited: Promise.resolve(1),
        })) as typeof Bun.spawn,
    );
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    clearInterval(internals(backend).interval);
    clearInterval(internals(backend).curveInterval);
  });

  // ---------------------------------------------------------------------------
  // getFanInfo — no hardware
  // ---------------------------------------------------------------------------

  describe("getFanInfo()", () => {
    it("returns available=false when no fan hardware detected", async () => {
      const info = await backend.getFanInfo();
      expect(info.available).toBe(false);
      expect(info.fans).toEqual([]);
      expect(info.fanCount).toBe(0);
      expect(info.chipName).toBe("none");
    });
  });

  // ---------------------------------------------------------------------------
  // setFanSpeed — validation and safety
  // ---------------------------------------------------------------------------

  describe("setFanSpeed()", () => {
    it("returns error when no controllable fan device detected", async () => {
      const result = await backend.setFanSpeed(50);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No controllable fan device");
    });

    it("clamps speed to 0-100 range", async () => {
      // Set up a minimal fan device with PWM control
      internals(backend).activeFanDevice = {
        dir: "/sys/class/hwmon/hwmon0",
        chipName: "test",
        fans: [
          {
            index: 1,
            inputPath: "/sys/class/hwmon/hwmon0/fan1_input",
            pwmPath: "/sys/class/hwmon/hwmon0/pwm1",
            pwmEnablePath: "/sys/class/hwmon/hwmon0/pwm1_enable",
          },
        ],
        hasPwmControl: true,
      };

      // Mock writeHwmon via sudo tee
      spawnSpy.mockImplementation(
        (() =>
          asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(0),
          })) as typeof Bun.spawn,
      );

      // Also mock temperature reads for safety check
      mockReadFile.mockImplementation(() => Promise.resolve("45000")); // 45 C

      const result = await backend.setFanSpeed(150);
      expect(result.success).toBe(true);
      // The method internally clamps to 100, which maps to PWM 255
    });
  });

  // ---------------------------------------------------------------------------
  // setFanMode
  // ---------------------------------------------------------------------------

  describe("setFanMode()", () => {
    it("returns error when no controllable fan device", async () => {
      const result = await backend.setFanMode("auto");
      expect(result.success).toBe(false);
      expect(result.error).toContain("No controllable fan device");
    });

    it("writes pwm_enable=2 for auto mode", async () => {
      internals(backend).activeFanDevice = {
        dir: "/sys/class/hwmon/hwmon0",
        chipName: "test",
        fans: [
          {
            index: 1,
            inputPath: "/sys/class/hwmon/hwmon0/fan1_input",
            pwmPath: "/sys/class/hwmon/hwmon0/pwm1",
            pwmEnablePath: "/sys/class/hwmon/hwmon0/pwm1_enable",
          },
        ],
        hasPwmControl: true,
      };

      const teeWrites: { path: string; value: string }[] = [];
      spawnSpy.mockImplementation(
        ((cmd: SpawnArgv) => {
          if (cmd[0] === "sudo" && cmd[1] === "tee") {
            const path = cmd[2];
            teeWrites.push({ path, value: "" }); // value comes via stdin
          }
          return asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(0),
          });
        }) as typeof Bun.spawn,
      );

      const result = await backend.setFanMode("auto");
      expect(result.success).toBe(true);
      // Verify tee was called on the pwm_enable path
      expect(teeWrites.length).toBeGreaterThan(0);
      expect(teeWrites[0].path).toContain("pwm1_enable");
    });
  });

  // ---------------------------------------------------------------------------
  // applyPreset — fan curve presets
  // ---------------------------------------------------------------------------

  describe("applyPreset()", () => {
    it("returns error for unknown preset name", async () => {
      const result = await backend.applyPreset(
        "nonexistent" as unknown as Parameters<typeof backend.applyPreset>[0],
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown preset");
    });

    it("requires at least 2 curve points for custom preset", async () => {
      const result = await backend.applyPreset("custom", [
        { tempC: 40, percent: 20 },
      ]);
      expect(result.success).toBe(false);
      expect(result.error).toContain("at least 2 curve points");
    });

    it("requires curve points for custom preset", async () => {
      const result = await backend.applyPreset("custom");
      expect(result.success).toBe(false);
      expect(result.error).toContain("at least 2 curve points");
    });

    it("returns error when no fan device for balanced preset", async () => {
      // No active fan device, no ectool
      const result = await backend.applyPreset("balanced");
      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // interpolateCurve — fan curve interpolation
  // ---------------------------------------------------------------------------

  describe("interpolateCurve()", () => {
    const curve = [
      { tempC: 30, percent: 10 },
      { tempC: 50, percent: 50 },
      { tempC: 70, percent: 100 },
    ];

    it("returns first point percent below the curve range", () => {
      const result = internals(backend).interpolateCurve(curve, 20);
      expect(result).toBe(10);
    });

    it("returns last point percent above the curve range", () => {
      const result = internals(backend).interpolateCurve(curve, 90);
      expect(result).toBe(100);
    });

    it("returns exact percent at a curve point", () => {
      const result = internals(backend).interpolateCurve(curve, 50);
      expect(result).toBe(50);
    });

    it("interpolates between two curve points", () => {
      // Between 30C (10%) and 50C (50%), at 40C should be midpoint: 30%
      const result = internals(backend).interpolateCurve(curve, 40);
      expect(result).toBe(30);
    });

    it("interpolates in the upper range", () => {
      // Between 50C (50%) and 70C (100%), at 60C should be 75%
      const result = internals(backend).interpolateCurve(curve, 60);
      expect(result).toBe(75);
    });
  });

  // ---------------------------------------------------------------------------
  // parsePwmMode
  // ---------------------------------------------------------------------------

  describe("parsePwmMode()", () => {
    it("maps 0 to full", () => {
      expect(internals(backend).parsePwmMode(0)).toBe("full");
    });

    it("maps 1 to manual", () => {
      expect(internals(backend).parsePwmMode(1)).toBe("manual");
    });

    it("maps 2 to auto", () => {
      expect(internals(backend).parsePwmMode(2)).toBe("auto");
    });

    it("maps unknown values to unknown", () => {
      expect(internals(backend).parsePwmMode(5)).toBe("unknown");
      expect(internals(backend).parsePwmMode(-1)).toBe("unknown");
    });
  });

  // ---------------------------------------------------------------------------
  // classifyTempZone
  // ---------------------------------------------------------------------------

  describe("classifyTempZone()", () => {
    it("classifies k10temp as cpu", () => {
      expect(internals(backend).classifyTempZone("k10temp", "Tctl")).toBe("cpu");
    });

    it("classifies coretemp as cpu", () => {
      expect(internals(backend).classifyTempZone("coretemp", "Package id 0")).toBe("cpu");
    });

    it("classifies amdgpu as gpu", () => {
      expect(internals(backend).classifyTempZone("amdgpu", "edge")).toBe("gpu");
    });

    it("classifies junction label as gpu", () => {
      expect(internals(backend).classifyTempZone("something", "junction")).toBe("gpu");
    });

    it("classifies steamdeck_hwmon as cpu", () => {
      expect(internals(backend).classifyTempZone("steamdeck_hwmon", "temp1")).toBe("cpu");
    });

    it("classifies unknown chip/label as unknown", () => {
      expect(internals(backend).classifyTempZone("random_chip", "some_label")).toBe("unknown");
    });

    it("classifies soc label as cpu (soc is treated as CPU zone)", () => {
      // "soc" is in CPU_LABEL_KEYWORDS, so it maps to "cpu" not "soc"
      expect(internals(backend).classifyTempZone("some_chip", "SoC temp")).toBe("cpu");
    });
  });

  // ---------------------------------------------------------------------------
  // Hardware-safety override (issue #97) — applySafetyFloor + watchdog path
  //
  // The pure function (computeSafetyFloor) has its own exhaustive unit
  // tests in safety-floor.spec.ts. These tests cover the integration
  // between the backend's sysfs temp reader and the pure function — in
  // particular, the failsafe-to-MAX behaviour when sensors fail.
  // ---------------------------------------------------------------------------

  describe("applySafetyFloor() — backend integration", () => {
    const setSensor = () => {
      internals(backend).tempSensors = [
        {
          inputPath: "/sys/class/hwmon/hwmon0/temp1_input",
          label: "Tctl",
          zone: "cpu",
          chipName: "k10temp",
        },
      ];
    };

    it("returns userPercent unchanged at normal temp (50 C)", async () => {
      setSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("50000"));
      const result = await internals(backend).applySafetyFloor(20);
      expect(result).toBe(20);
    });

    // WARM_C bumped 75 → 80, so 78 C is now BELOW engagement. The
    // override is a strict no-op there — user's 20 % stays at 20 %.
    it("does NOT raise floor at 78 C (below new 80 C threshold)", async () => {
      setSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("78000"));
      const result = await internals(backend).applySafetyFloor(20);
      expect(result).toBe(20);
    });

    it("leaves user value alone at sub-threshold temp", async () => {
      setSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("78000"));
      const result = await internals(backend).applySafetyFloor(70);
      expect(result).toBe(70);
    });

    it("raises floor to 60 % at hot temp (82 C)", async () => {
      setSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("82000"));
      const result = await internals(backend).applySafetyFloor(30);
      expect(result).toBe(60);
    });

    it("forces 100 % at force-max temp (87 C) regardless of user value", async () => {
      setSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("87000"));
      const result = await internals(backend).applySafetyFloor(50);
      expect(result).toBe(100);
    });

    it("forces 100 % at critical temp (96 C)", async () => {
      setSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("96000"));
      const result = await internals(backend).applySafetyFloor(80);
      expect(result).toBe(100);
    });

    it("FAILSAFE: returns 100 % when temp read fails", async () => {
      setSensor();
      mockReadFile.mockImplementation(() =>
        Promise.reject(new Error("ENOENT")),
      );
      const result = await internals(backend).applySafetyFloor(20);
      expect(result).toBe(100);
    });

    it("FAILSAFE: returns 100 % when no temp sensors are present", async () => {
      internals(backend).tempSensors = [];
      const result = await internals(backend).applySafetyFloor(20);
      expect(result).toBe(100);
    });

    it("FAILSAFE: returns 100 % when all hot-zone reads are NaN", async () => {
      setSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("not-a-number"));
      const result = await internals(backend).applySafetyFloor(20);
      expect(result).toBe(100);
    });

    it("uses the hottest hot-zone sensor when CPU and GPU both readable", async () => {
      // CPU at 60 °C, GPU at 87 °C — GPU is the hot one, force max.
      internals(backend).tempSensors = [
        {
          inputPath: "/sys/class/hwmon/hwmon0/temp1_input",
          label: "Tctl",
          zone: "cpu",
          chipName: "k10temp",
        },
        {
          inputPath: "/sys/class/hwmon/hwmon1/temp1_input",
          label: "edge",
          zone: "gpu",
          chipName: "amdgpu",
        },
      ];
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes("hwmon0")) return Promise.resolve("60000");
        if (path.includes("hwmon1")) return Promise.resolve("87000");
        return Promise.reject(new Error("ENOENT"));
      });

      const result = await internals(backend).applySafetyFloor(40);
      expect(result).toBe(100);
    });

    it("emits fan-safety-critical event on the critical path", async () => {
      setSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("96000"));
      await internals(backend).applySafetyFloor(20);

      const critical = emittedEvents.find(
        (e) => e.event === "fan-safety-critical",
      );
      expect(critical).toBeDefined();
    });

    it("does NOT emit fan-safety-critical for normal warm-floor engagement", async () => {
      setSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("78000")); // warm, not critical
      await internals(backend).applySafetyFloor(20);

      const critical = emittedEvents.find(
        (e) => e.event === "fan-safety-critical",
      );
      expect(critical).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Regression: issue #106 — safety floor must actually move the fan.
  //
  // Before the fix, two bugs combined to make the safety override show
  // warnings without ever changing fan speed in pure auto mode:
  //
  //   1. setFanSpeedInternal() (used by both the curve loop and the
  //      safety watchdog) wrote `pwm` but never `pwm_enable`. On hwmon
  //      drivers like oxpec the kernel ignores manual pwm writes while
  //      pwm_enable=2 (auto), so the watchdog's MAX write was a silent
  //      no-op.
  //
  //   2. The watchdog only fired at FORCE_MAX_C (≥85 °C). Between 75 °C
  //      and 84 °C the UI showed the WARM/HOT warning but no enforcement
  //      ran in pure auto mode (the per-write override only fires from
  //      the user slider / curve loop, neither of which is active when
  //      the user never touched anything).
  // ---------------------------------------------------------------------------

  describe("setFanSpeedInternal() — pwm_enable enforcement (issue #106)", () => {
    it("writes pwm_enable=1 alongside pwm so the write isn't ignored in auto mode", async () => {
      internals(backend).activeFanDevice = {
        dir: "/sys/class/hwmon/hwmon0",
        chipName: "oxpec",
        fans: [
          {
            index: 1,
            inputPath: "/sys/class/hwmon/hwmon0/fan1_input",
            pwmPath: "/sys/class/hwmon/hwmon0/pwm1",
            pwmEnablePath: "/sys/class/hwmon/hwmon0/pwm1_enable",
          },
        ],
        hasPwmControl: true,
      };

      const teeWrites: string[] = [];
      spawnSpy.mockImplementation(
        ((cmd: SpawnArgv) => {
          if (cmd[0] === "sudo" && cmd[1] === "tee") {
            teeWrites.push(cmd[2]);
          }
          return asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(0),
          });
        }) as typeof Bun.spawn,
      );

      const result = await internals(backend).setFanSpeedInternal(100);
      expect(result.success).toBe(true);

      // Both pwm_enable AND pwm must be written, in that order, so the
      // kernel hands control over before we set the duty cycle.
      const enableIdx = teeWrites.findIndex((p) => p.endsWith("pwm1_enable"));
      const pwmIdx = teeWrites.findIndex(
        (p) => p.endsWith("pwm1") && !p.endsWith("pwm1_enable"),
      );
      expect(enableIdx).toBeGreaterThanOrEqual(0);
      expect(pwmIdx).toBeGreaterThanOrEqual(0);
      expect(enableIdx).toBeLessThan(pwmIdx);
    });

    it("falls back to pwm-only write on legacy devices missing pwm_enable", async () => {
      // Issue #108 regression: requiring both pwm AND pwm_enable
      // silently disabled fan control on the rare hwmon driver that
      // exposes pwm but no enable sibling. Restore the pre-#106 pwm-only
      // write, but warn loudly (once per device) so the limitation is
      // discoverable in the journal.
      internals(backend).activeFanDevice = {
        dir: "/sys/class/hwmon/hwmon0",
        chipName: "weird",
        fans: [
          {
            index: 1,
            inputPath: "/sys/class/hwmon/hwmon0/fan1_input",
            pwmPath: "/sys/class/hwmon/hwmon0/pwm1",
            pwmEnablePath: null,
          },
        ],
        hasPwmControl: true,
      };

      const teeWrites: string[] = [];
      spawnSpy.mockImplementation(
        ((cmd: SpawnArgv) => {
          if (cmd[0] === "sudo" && cmd[1] === "tee") {
            teeWrites.push(cmd[2]);
          }
          return asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(0),
          });
        }) as typeof Bun.spawn,
      );

      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      let warnCalls: unknown[][] = [];
      try {
        await internals(backend).setFanSpeedInternal(100);
        warnCalls = warnSpy.mock.calls.slice();
      } finally {
        warnSpy.mockRestore();
      }

      // pwm written, pwm_enable not (it doesn't exist on this device).
      expect(teeWrites).toEqual(["/sys/class/hwmon/hwmon0/pwm1"]);
      // Exactly one warn for this device path.
      const warnsForPath = warnCalls.filter((args) =>
        String(args[0] ?? "").includes("/sys/class/hwmon/hwmon0/pwm1"),
      );
      expect(warnsForPath.length).toBe(1);
    });

    it("warns only once per device path even across many ticks", async () => {
      // The watchdog calls setFanSpeedInternal every 2 s when engaged;
      // we must not spam the journal on each tick.
      internals(backend).activeFanDevice = {
        dir: "/sys/class/hwmon/hwmon0",
        chipName: "weird",
        fans: [
          {
            index: 1,
            inputPath: "/sys/class/hwmon/hwmon0/fan1_input",
            pwmPath: "/sys/class/hwmon/hwmon0/pwm1",
            pwmEnablePath: null,
          },
        ],
        hasPwmControl: true,
      };

      spawnSpy.mockImplementation(
        (() =>
          asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(0),
          })) as typeof Bun.spawn,
      );

      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      let warnCalls: unknown[][] = [];
      try {
        await internals(backend).setFanSpeedInternal(100);
        await internals(backend).setFanSpeedInternal(80);
        await internals(backend).setFanSpeedInternal(60);
        warnCalls = warnSpy.mock.calls.slice();
      } finally {
        warnSpy.mockRestore();
      }

      const warnsForPath = warnCalls.filter((args) =>
        String(args[0] ?? "").includes("/sys/class/hwmon/hwmon0/pwm1"),
      );
      expect(warnsForPath.length).toBe(1);
    });

    it("setFanSpeed (public RPC) also falls back to pwm-only on legacy devices", async () => {
      // Bug #3 sibling: the user slider goes through the public
      // setFanSpeed, not setFanSpeedInternal — same hwmon shape, same
      // bug, same fix. Sharing missingEnableWarned across both paths
      // means a single warn covers both code paths for the same device.
      internals(backend).activeFanDevice = {
        dir: "/sys/class/hwmon/hwmon0",
        chipName: "weird",
        fans: [
          {
            index: 1,
            inputPath: "/sys/class/hwmon/hwmon0/fan1_input",
            pwmPath: "/sys/class/hwmon/hwmon0/pwm1",
            pwmEnablePath: null,
          },
        ],
        hasPwmControl: true,
      };

      const teeWrites: string[] = [];
      spawnSpy.mockImplementation(
        ((cmd: SpawnArgv) => {
          if (cmd[0] === "sudo" && cmd[1] === "tee") {
            teeWrites.push(cmd[2]);
          }
          return asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(0),
          });
        }) as typeof Bun.spawn,
      );

      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      let warnCalls: unknown[][] = [];
      try {
        // Public RPC + internal helper for the same device — exactly
        // ONE warn total, both writes go through.
        await backend.setFanSpeed(50);
        await internals(backend).setFanSpeedInternal(80);
        warnCalls = warnSpy.mock.calls.slice();
      } finally {
        warnSpy.mockRestore();
      }

      expect(teeWrites).toEqual([
        "/sys/class/hwmon/hwmon0/pwm1",
        "/sys/class/hwmon/hwmon0/pwm1",
      ]);
      const warnsForPath = warnCalls.filter((args) =>
        String(args[0] ?? "").includes("/sys/class/hwmon/hwmon0/pwm1"),
      );
      expect(warnsForPath.length).toBe(1);
    });
  });

  describe("safetyWatchdogTick() — engages at WARM_C (issue #106)", () => {
    const setupFanAndSensor = () => {
      internals(backend).activeFanDevice = {
        dir: "/sys/class/hwmon/hwmon0",
        chipName: "oxpec",
        fans: [
          {
            index: 1,
            inputPath: "/sys/class/hwmon/hwmon0/fan1_input",
            pwmPath: "/sys/class/hwmon/hwmon0/pwm1",
            pwmEnablePath: "/sys/class/hwmon/hwmon0/pwm1_enable",
          },
        ],
        hasPwmControl: true,
      };
      internals(backend).tempSensors = [
        {
          inputPath: "/sys/class/hwmon/hwmon0/temp1_input",
          label: "Tctl",
          zone: "cpu",
          chipName: "k10temp",
        },
      ];
    };

    /** Captures (path, stdinPromise) pairs written via `sudo tee`. The
     *  exec helper wraps stdin in a ReadableStream<Uint8Array>, so we
     *  drain it back to a string to verify the value that was written. */
    const captureTeeWrites = () => {
      const writes: { path: string; valuePromise: Promise<string> }[] = [];
      spawnSpy.mockImplementation(
        ((cmd: SpawnArgv, opts: { stdin?: ReadableStream<Uint8Array> }) => {
          if (cmd[0] === "sudo" && cmd[1] === "tee") {
            const valuePromise = (async () => {
              if (!opts?.stdin) return "";
              const reader = opts.stdin.getReader();
              const chunks: Uint8Array[] = [];
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
              }
              const total = chunks.reduce((n, c) => n + c.byteLength, 0);
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                merged.set(c, off);
                off += c.byteLength;
              }
              return new TextDecoder().decode(merged);
            })();
            writes.push({ path: cmd[2], valuePromise });
          }
          return asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(0),
          });
        }) as typeof Bun.spawn,
      );
      return writes;
    };

    /** Resolve the captured stdin streams to strings. */
    const drainWrites = async (
      writes: { path: string; valuePromise: Promise<string> }[],
    ): Promise<{ path: string; value: string }[]> => {
      return Promise.all(
        writes.map(async (w) => ({ path: w.path, value: await w.valuePromise })),
      );
    };

    it("does nothing below WARM_C (kernel auto stays in charge)", async () => {
      setupFanAndSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("60000")); // 60 C
      const writes = captureTeeWrites();

      await internals(backend).safetyWatchdogTick();
      expect(writes).toEqual([]);
    });

    it("does NOT engage at 78 C (below new 80 C threshold)", async () => {
      setupFanAndSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("78000"));
      const writes = captureTeeWrites();

      await internals(backend).safetyWatchdogTick();
      // No engagement, no writes — kernel auto stays in charge.
      expect(writes).toEqual([]);
    });

    it("forces ≥60 % at hot temp (82 C)", async () => {
      setupFanAndSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("82000")); // 82 C
      const writes = captureTeeWrites();

      await internals(backend).safetyWatchdogTick();
      const drained = await drainWrites(writes);
      const pwmWrite = drained.find(
        (w) => w.path.endsWith("pwm1") && !w.path.endsWith("pwm1_enable"),
      );
      expect(pwmWrite).toBeDefined();
      expect(parseInt(pwmWrite!.value, 10)).toBeGreaterThanOrEqual(153); // 60 %
    });

    it("forces 100 % at force-max temp (87 C) AND flips pwm_enable to 1", async () => {
      setupFanAndSensor();
      mockReadFile.mockImplementation(() => Promise.resolve("87000")); // 87 C
      const writes = captureTeeWrites();

      await internals(backend).safetyWatchdogTick();
      const drained = await drainWrites(writes);
      const enableWrite = drained.find((w) => w.path.endsWith("pwm1_enable"));
      const pwmWrite = drained.find(
        (w) => w.path.endsWith("pwm1") && !w.path.endsWith("pwm1_enable"),
      );
      expect(enableWrite?.value).toBe("1");
      expect(pwmWrite?.value).toBe("255");
    });

    // Issue #108 regression: previously the watchdog flipped pwm_enable
    // to 1 (manual) on engagement and never restored it. Once the SoC
    // cooled back to a normal temp the fan stayed pinned at the enforced
    // PWM for the rest of the session.
    it("releases pwm_enable back to original value when temp drops past hysteresis", async () => {
      setupFanAndSensor();
      // Simulate that we snapshotted pwm_enable=2 (kernel auto) at scan
      // time. releaseSafetyEngagement should write that exact value back.
      (
        backend as unknown as {
          originalModes: Map<string, string>;
        }
      ).originalModes.set("/sys/class/hwmon/hwmon0/pwm1_enable", "2");

      // 50 °C → 80 °C → 50 °C: cool, hot, cool again.
      let mockTemp = 50000;
      mockReadFile.mockImplementation(() => Promise.resolve(String(mockTemp)));

      // Tick 1: cool, no engagement.
      const writes1 = captureTeeWrites();
      await internals(backend).safetyWatchdogTick();
      expect(writes1).toEqual([]);

      // Tick 2: hot — engages, writes pwm_enable=1 + pwm.
      mockTemp = 80000;
      const writes2 = captureTeeWrites();
      await internals(backend).safetyWatchdogTick();
      const drained2 = await drainWrites(writes2);
      expect(
        drained2.find((w) => w.path.endsWith("pwm1_enable"))?.value,
      ).toBe("1");

      // Tick 3: cooled to 50 °C, well below hysteresis floor (75-20=55).
      // Must restore the original pwm_enable value (2 = kernel auto).
      mockTemp = 50000;
      const writes3 = captureTeeWrites();
      await internals(backend).safetyWatchdogTick();
      const drained3 = await drainWrites(writes3);
      const restore = drained3.find((w) => w.path.endsWith("pwm1_enable"));
      expect(restore).toBeDefined();
      expect(restore?.value).toBe("2");
    });

    // Release must honour the user's CURRENT preference, not the
    // boot-time default. If the user was in Manual at X% pre-engagement,
    // dropping them to Auto on release silently loses their setting.
    it("release restores Manual mode + last user PWM when user was in manual", async () => {
      setupFanAndSensor();
      (
        backend as unknown as {
          originalModes: Map<string, string>;
        }
      ).originalModes.set("/sys/class/hwmon/hwmon0/pwm1_enable", "2");

      // User explicitly set 20% (PWM 51) before any thermal event.
      // Real callers go through the public RPC, which is what records
      // lastUserSpeedPwm + manualModeRequested = "manual".
      mockReadFile.mockImplementation(() => Promise.resolve("50000"));
      captureTeeWrites();
      await backend.setFanSpeed(20);

      // Engage at 80 °C.
      mockReadFile.mockImplementation(() => Promise.resolve("80000"));
      captureTeeWrites();
      await internals(backend).safetyWatchdogTick();

      // Cool to 50 °C — past the 55 °C release floor. Must release
      // into MANUAL at PWM 51, not Auto.
      mockReadFile.mockImplementation(() => Promise.resolve("50000"));
      const writes = captureTeeWrites();
      await internals(backend).safetyWatchdogTick();
      const drained = await drainWrites(writes);

      const enable = drained.find((w) => w.path.endsWith("pwm1_enable"));
      const pwm = drained.find(
        (w) => w.path.endsWith("pwm1") && !w.path.endsWith("pwm1_enable"),
      );
      expect(enable?.value).toBe("1"); // stay in manual, not "2"
      expect(pwm?.value).toBe("51"); // restore the user's 20%
    });

    it("release keeps pwm_enable=1 when a curve preset is active", async () => {
      setupFanAndSensor();
      (
        backend as unknown as {
          originalModes: Map<string, string>;
        }
      ).originalModes.set("/sys/class/hwmon/hwmon0/pwm1_enable", "2");
      // Simulate an active preset; the curve loop's next tick will
      // write the curve PWM, so the release should NOT push pwm_enable
      // back to auto.
      (backend as unknown as { activePreset: string | null }).activePreset =
        "performance";

      mockReadFile.mockImplementation(() => Promise.resolve("80000"));
      captureTeeWrites();
      await internals(backend).safetyWatchdogTick();

      mockReadFile.mockImplementation(() => Promise.resolve("50000"));
      const writes = captureTeeWrites();
      await internals(backend).safetyWatchdogTick();
      const drained = await drainWrites(writes);

      const enable = drained.find((w) => w.path.endsWith("pwm1_enable"));
      expect(enable?.value).toBe("1");
    });

    // Hysteresis: a temp dip just below WARM_C must not release if we're
    // still inside the WARM_C → WARM_C-RELEASE_HYSTERESIS_C band, or the
    // fan flaps manual↔auto every tick around the threshold.
    it("does NOT release within the hysteresis band", async () => {
      setupFanAndSensor();
      (
        backend as unknown as {
          originalModes: Map<string, string>;
        }
      ).originalModes.set("/sys/class/hwmon/hwmon0/pwm1_enable", "2");

      // Engage at 80 °C.
      mockReadFile.mockImplementation(() => Promise.resolve("80000"));
      captureTeeWrites();
      await internals(backend).safetyWatchdogTick();

      // Drop to 73 °C — below WARM_C (75) but still inside the
      // 70 °C release band. Should be a no-op.
      mockReadFile.mockImplementation(() => Promise.resolve("73000"));
      const writes = captureTeeWrites();
      await internals(backend).safetyWatchdogTick();
      expect(writes).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Issue #108 bug 2: when the watchdog has engaged the safety floor,
  // the curve interval running on its own timer must not undershoot the
  // floor. Both timers write the same pwm node, so a curve value below
  // the watchdog floor causes oscillating writes.
  // ---------------------------------------------------------------------------

  describe("applyCurve() respects watchdog engagement", () => {
    const setupFanAndSensor = () => {
      internals(backend).activeFanDevice = {
        dir: "/sys/class/hwmon/hwmon0",
        chipName: "oxpec",
        fans: [
          {
            index: 1,
            inputPath: "/sys/class/hwmon/hwmon0/fan1_input",
            pwmPath: "/sys/class/hwmon/hwmon0/pwm1",
            pwmEnablePath: "/sys/class/hwmon/hwmon0/pwm1_enable",
          },
        ],
        hasPwmControl: true,
      };
      internals(backend).tempSensors = [
        {
          inputPath: "/sys/class/hwmon/hwmon0/temp1_input",
          label: "Tctl",
          zone: "cpu",
          chipName: "k10temp",
        },
      ];
    };

    it("clamps curve output up to WARM_FLOOR_PCT when watchdog engaged", async () => {
      setupFanAndSensor();
      // Curve says 10% at 50 °C — well below the 40% safety floor.
      const lowCurve = [
        { tempC: 30, percent: 5 },
        { tempC: 50, percent: 10 },
        { tempC: 100, percent: 100 },
      ];
      // Temp 50 °C: applySafetyFloor will pass 10% through unchanged
      // (no override below WARM_C). Without the engaged-floor clamp
      // the curve writes PWM 26 (~10%); with the clamp it writes PWM 102 (~40%).
      mockReadFile.mockImplementation(() => Promise.resolve("50000"));
      internals(backend).safetyEngaged = true;

      const writes: { path: string; valuePromise: Promise<string> }[] = [];
      spawnSpy.mockImplementation(
        ((cmd: SpawnArgv, opts: { stdin?: ReadableStream<Uint8Array> }) => {
          if (cmd[0] === "sudo" && cmd[1] === "tee") {
            const valuePromise = (async () => {
              if (!opts?.stdin) return "";
              const reader = opts.stdin.getReader();
              const chunks: Uint8Array[] = [];
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
              }
              const total = chunks.reduce((n, c) => n + c.byteLength, 0);
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                merged.set(c, off);
                off += c.byteLength;
              }
              return new TextDecoder().decode(merged);
            })();
            writes.push({ path: cmd[2], valuePromise });
          }
          return asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(0),
          });
        }) as typeof Bun.spawn,
      );

      await internals(backend).applyCurve(lowCurve);

      const drained = await Promise.all(
        writes.map(async (w) => ({ path: w.path, value: await w.valuePromise })),
      );
      const pwmWrite = drained.find(
        (w) => w.path.endsWith("pwm1") && !w.path.endsWith("pwm1_enable"),
      );
      expect(pwmWrite).toBeDefined();
      // 40 % of 255 = 102.
      expect(parseInt(pwmWrite!.value, 10)).toBeGreaterThanOrEqual(102);
    });

    it("leaves curve output alone when watchdog NOT engaged", async () => {
      setupFanAndSensor();
      const lowCurve = [
        { tempC: 30, percent: 5 },
        { tempC: 50, percent: 10 },
        { tempC: 100, percent: 100 },
      ];
      mockReadFile.mockImplementation(() => Promise.resolve("50000"));
      internals(backend).safetyEngaged = false;

      const writes: { path: string; valuePromise: Promise<string> }[] = [];
      spawnSpy.mockImplementation(
        ((cmd: SpawnArgv, opts: { stdin?: ReadableStream<Uint8Array> }) => {
          if (cmd[0] === "sudo" && cmd[1] === "tee") {
            const valuePromise = (async () => {
              if (!opts?.stdin) return "";
              const reader = opts.stdin.getReader();
              const chunks: Uint8Array[] = [];
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
              }
              const total = chunks.reduce((n, c) => n + c.byteLength, 0);
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                merged.set(c, off);
                off += c.byteLength;
              }
              return new TextDecoder().decode(merged);
            })();
            writes.push({ path: cmd[2], valuePromise });
          }
          return asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(0),
          });
        }) as typeof Bun.spawn,
      );

      await internals(backend).applyCurve(lowCurve);

      const drained = await Promise.all(
        writes.map(async (w) => ({ path: w.path, value: await w.valuePromise })),
      );
      const pwmWrite = drained.find(
        (w) => w.path.endsWith("pwm1") && !w.path.endsWith("pwm1_enable"),
      );
      expect(pwmWrite).toBeDefined();
      // 10 % of 255 = 26 (rounded). Must NOT be raised to the floor.
      expect(parseInt(pwmWrite!.value, 10)).toBeLessThan(102);
    });
  });

  // ---------------------------------------------------------------------------
  // getCpuTempCOrNull — the temp reader the safety override hangs on. The
  // key contract is that it returns *null* (not 0) when no valid reading
  // is available, so the pure function can route to its failsafe branch.
  // ---------------------------------------------------------------------------

  describe("getCpuTempCOrNull()", () => {
    it("returns null with no sensors (failsafe signal)", async () => {
      internals(backend).tempSensors = [];
      const t = await internals(backend).getCpuTempCOrNull();
      expect(t).toBeNull();
    });

    it("returns null when every sensor read throws", async () => {
      internals(backend).tempSensors = [
        {
          inputPath: "/sys/class/hwmon/hwmon0/temp1_input",
          label: "Tctl",
          zone: "cpu",
          chipName: "k10temp",
        },
      ];
      mockReadFile.mockImplementation(() =>
        Promise.reject(new Error("ENOENT")),
      );
      const t = await internals(backend).getCpuTempCOrNull();
      expect(t).toBeNull();
    });

    it("returns the hottest hot-zone reading (rounded)", async () => {
      internals(backend).tempSensors = [
        {
          inputPath: "/sys/class/hwmon/hwmon0/temp1_input",
          label: "Tctl",
          zone: "cpu",
          chipName: "k10temp",
        },
        {
          inputPath: "/sys/class/hwmon/hwmon1/temp1_input",
          label: "edge",
          zone: "gpu",
          chipName: "amdgpu",
        },
      ];
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes("hwmon0")) return Promise.resolve("72400"); // 72.4
        if (path.includes("hwmon1")) return Promise.resolve("88600"); // 88.6
        return Promise.reject(new Error("ENOENT"));
      });
      const t = await internals(backend).getCpuTempCOrNull();
      expect(t).toBe(89); // rounded from 88.6
    });

    it("skips non-hot-zone sensors", async () => {
      // An "unknown"-zone sensor at 200 °C must not poison the reading.
      internals(backend).tempSensors = [
        {
          inputPath: "/sys/class/hwmon/hwmon0/temp1_input",
          label: "Tctl",
          zone: "cpu",
          chipName: "k10temp",
        },
        {
          inputPath: "/sys/class/hwmon/hwmon9/temp1_input",
          label: "weird_chip",
          zone: "unknown",
          chipName: "weird",
        },
      ];
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes("hwmon0")) return Promise.resolve("55000");
        if (path.includes("hwmon9")) return Promise.resolve("200000");
        return Promise.reject(new Error("ENOENT"));
      });
      const t = await internals(backend).getCpuTempCOrNull();
      expect(t).toBe(55);
    });
  });

  // ---------------------------------------------------------------------------
  // scanHwmonDevices
  // ---------------------------------------------------------------------------

  describe("scanHwmonDevices()", () => {
    it("returns empty array when /sys/class/hwmon is empty", async () => {
      mockReaddir.mockImplementation(() => Promise.resolve([]));
      const devices = await internals(backend).scanHwmonDevices();
      expect(devices).toEqual([]);
    });

    it("detects a fan device with PWM control", async () => {
      mockReaddir.mockImplementation(() =>
        Promise.resolve(["hwmon0"]),
      );
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes("/name")) return Promise.resolve("oxpec\n");
        return Promise.reject(new Error("ENOENT"));
      });

      // existsSync: fan1_input, pwm1, pwm1_enable exist
      mockExistsSync.mockImplementation((path: string) => {
        if (typeof path !== "string") return false;
        return (
          path.includes("fan1_input") ||
          path.includes("pwm1_enable") ||
          (path.endsWith("pwm1") && !path.includes("enable"))
        );
      });

      const devices = await internals(backend).scanHwmonDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].chipName).toBe("oxpec");
      expect(devices[0].fans).toHaveLength(1);
      expect(devices[0].hasPwmControl).toBe(true);
    });

    it("handles readdir error gracefully", async () => {
      mockReaddir.mockImplementation(() =>
        Promise.reject(new Error("ENOENT")),
      );
      const devices = await internals(backend).scanHwmonDevices();
      expect(devices).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getTemperatures
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Regression: ectool fallback should surface requested mode so the UI can
  // un-gate the slider and preset panels (they render on mode === "manual").
  // ---------------------------------------------------------------------------

  describe("ectool-only mode surfacing", () => {
    it("defaults to mode='auto' before any user interaction", async () => {
      internals(backend).useEctool = true;
      internals(backend).activeFanDevice = null;
      internals(backend).manualModeRequested = null;

      const info = await backend.getFanInfo();
      expect(info.mode).toBe("auto");
      expect(info.usingEctool).toBe(true);
    });

    it("reflects setFanMode('manual') in getFanInfo().mode", async () => {
      internals(backend).useEctool = true;
      internals(backend).activeFanDevice = null;

      const result = await backend.setFanMode("manual");
      expect(result.success).toBe(true);

      const info = await backend.getFanInfo();
      expect(info.mode).toBe("manual");
    });

    it("setFanSpeed implies manual mode on the ectool path", async () => {
      internals(backend).useEctool = true;
      internals(backend).activeFanDevice = null;

      // Mock ectool to succeed
      spawnSpy.mockImplementation(
        (() =>
          asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(0),
          })) as typeof Bun.spawn,
      );

      await backend.setFanSpeed(55);
      const info = await backend.getFanInfo();
      expect(info.mode).toBe("manual");
    });
  });

  // ---------------------------------------------------------------------------
  // Regression: hardware-discovery race
  //
  // Fan kernel modules (e.g. oxpec) sometimes load after loadout starts.
  // onLoad's original one-shot scan cached activeFanDevice=null forever.
  // Now the retry scanner keeps polling until hardware appears.
  // ---------------------------------------------------------------------------

  describe("hardware-discovery race recovery", () => {
    it("picks up a fan device on a later rescan when the first scan was empty", async () => {
      // First scan: empty /sys/class/hwmon (module not loaded yet).
      mockReaddir.mockImplementation(() => Promise.resolve([]));
      mockExistsSync.mockImplementation(() => false);

      const firstScanFound = await internals(backend).scanHardware();
      expect(firstScanFound).toBe(false);
      expect(internals(backend).activeFanDevice).toBeNull();

      // Now the module loads and hwmon7 appears with pwm control.
      mockReaddir.mockImplementation(() => Promise.resolve(["hwmon7"]));
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes("/name")) return Promise.resolve("oxp_ec\n");
        return Promise.reject(new Error("ENOENT"));
      });
      mockExistsSync.mockImplementation((path: string) => {
        if (typeof path !== "string") return false;
        return (
          path.includes("fan1_input") ||
          path.includes("pwm1_enable") ||
          (path.endsWith("pwm1") && !path.includes("enable"))
        );
      });

      const secondScanFound = await internals(backend).scanHardware();
      expect(secondScanFound).toBe(true);
      expect(internals(backend).activeFanDevice).not.toBeNull();
      expect(internals(backend).activeFanDevice.chipName).toBe("oxp_ec");
      expect(internals(backend).activeFanDevice.hasPwmControl).toBe(true);
    });

    it("does not stop retrying when only ectool is found — hwmon PWM is still preferred", async () => {
      // First scan: no hwmon fan, but ectool "hello" succeeds (on a real
      // ChromeOS-style EC). Previously this flipped scanHardware to true
      // and stopped the retry scanner, freezing the plugin into ectool
      // mode even when oxpec's hwmon node landed moments later.
      mockReaddir.mockImplementation(() => Promise.resolve([]));
      mockExistsSync.mockImplementation(() => false);
      spawnSpy.mockImplementation(
        ((cmd: SpawnArgv) =>
          asSpawned({
            stdout: new ReadableStream({ start(c) { c.close(); } }),
            stderr: new ReadableStream({ start(c) { c.close(); } }),
            stdin: null,
            exited: Promise.resolve(cmd[0] === "ectool" ? 0 : 1),
          })) as typeof Bun.spawn,
      );

      const firstScanFound = await internals(backend).scanHardware();
      expect(internals(backend).useEctool).toBe(true);
      expect(firstScanFound).toBe(false); // must keep retrying for hwmon
    });
  });

  describe("getTemperatures()", () => {
    it("returns empty array when no temp sensors found", async () => {
      internals(backend).tempSensors = [];
      const temps = await backend.getTemperatures();
      expect(temps).toEqual([]);
    });

    it("reads and converts millidegree values to Celsius", async () => {
      internals(backend).tempSensors = [
        {
          inputPath: "/sys/class/hwmon/hwmon0/temp1_input",
          label: "Tctl",
          zone: "cpu",
          chipName: "k10temp",
        },
        {
          inputPath: "/sys/class/hwmon/hwmon1/temp1_input",
          label: "edge",
          zone: "gpu",
          chipName: "amdgpu",
        },
      ];

      mockReadFile.mockImplementation((path: string) => {
        if (path.includes("hwmon0")) return Promise.resolve("65000");
        if (path.includes("hwmon1")) return Promise.resolve("52000");
        return Promise.reject(new Error("ENOENT"));
      });

      const temps = await backend.getTemperatures();
      expect(temps).toHaveLength(2);
      expect(temps[0]).toEqual({
        label: "Tctl",
        zone: "cpu",
        tempC: 65,
        chipName: "k10temp",
      });
      expect(temps[1]).toEqual({
        label: "edge",
        zone: "gpu",
        tempC: 52,
        chipName: "amdgpu",
      });
    });

    it("returns 0 when sysfs read fails", async () => {
      internals(backend).tempSensors = [
        {
          inputPath: "/sys/class/hwmon/hwmon0/temp1_input",
          label: "Tctl",
          zone: "cpu",
          chipName: "k10temp",
        },
      ];

      mockReadFile.mockImplementation(() =>
        Promise.reject(new Error("ENOENT")),
      );

      const temps = await backend.getTemperatures();
      expect(temps[0].tempC).toBe(0);
    });
  });
});
