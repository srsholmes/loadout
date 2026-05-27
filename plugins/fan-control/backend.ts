import type { PluginBackend, EmitPayload, RetryScanner } from "@loadout/types";
import { createRetryScanner } from "@loadout/types";
import * as fsp from "fs/promises";
import * as fs from "fs";
import { run, runCode, runFull } from "@loadout/exec";
import {
  createPerGameEngine,
  createPluginStoragePersistence,
  type PerGameEngine,
} from "./lib/per-game-profiles";
import {
  computeSafetyFloor,
  SAFETY_THRESHOLDS,
  type SafetyFloorResult,
} from "./safety-floor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FanDevice {
  /** Index within the hwmon directory (1, 2, ...) */
  index: number;
  /** Absolute path to fanN_input */
  inputPath: string;
  /** Absolute path to pwmN (may not exist) */
  pwmPath: string | null;
  /** Absolute path to pwmN_enable (may not exist) */
  pwmEnablePath: string | null;
}

interface HwmonDevice {
  /** e.g. /sys/class/hwmon/hwmon5 */
  dir: string;
  /** Chip name from the `name` file (e.g. "oxpec", "k10temp", "amdgpu") */
  chipName: string;
  /** Fan devices found in this hwmon directory */
  fans: FanDevice[];
  /** Whether direct PWM write is supported (at least one fan has pwm + pwm_enable) */
  hasPwmControl: boolean;
}

interface TempSensor {
  /** Absolute path to tempN_input */
  inputPath: string;
  /** Human-readable label (from tempN_label or chip name) */
  label: string;
  /** Zone identifier, e.g. "cpu", "gpu", "soc", "unknown" */
  zone: string;
  /** Chip name of the hwmon device that owns this sensor */
  chipName: string;
}

interface FanCurvePoint {
  tempC: number;
  percent: number;
}

type PresetName = "silent" | "balanced" | "performance" | "custom";

const PLUGIN_ID = "fan-control";

/** The bit of a profile that varies per app — see GameProfile<FanProfilePayload>. */
export interface FanProfilePayload {
  mode: "auto" | "manual";
  /** Manual fan speed percent (0–100). Ignored when mode is "auto". */
  speed?: number;
}

/** Public shape returned to the UI — engine entry flattened for the RPC contract. */
export interface FanGameProfile extends FanProfilePayload {
  appId: number;
  gameName: string;
}

function toRpcProfile(entry: {
  appId: number;
  gameName: string;
  payload: FanProfilePayload;
}): FanGameProfile {
  return {
    appId: entry.appId,
    gameName: entry.gameName,
    mode: entry.payload.mode,
    speed: entry.payload.speed,
  };
}

interface FanModeSnapshot {
  mode: "auto" | "manual";
  speed: number | null;
}

interface FanInfoResult {
  /** Per-fan RPM readings */
  fans: { index: number; rpm: number; pwm: number; percent: number }[];
  /** Overall fan mode */
  mode: "auto" | "manual" | "full" | "unknown";
  /** All detected temperature readings */
  temps: { label: string; zone: string; tempC: number }[];
  /** Primary (CPU) temperature for quick display */
  cpuTempC: number;
  /** Detected chip name that owns the fans */
  chipName: string;
  /** Total number of controllable fans */
  fanCount: number;
  /** Whether fan control is available at all */
  available: boolean;
  /** Active preset name, if any */
  activePreset: PresetName | null;
  /** Whether ectool fallback is being used */
  usingEctool: boolean;
  /** Safety warning message, if any */
  warning: string | null;
  /** True while the safety watchdog has overridden user fan control.
   *  Sticky: stays true through the WARM_C → release-hysteresis band so
   *  the UI banner doesn't flicker as temp wobbles around 75 °C. */
  safetyEngaged: boolean;
}

interface TempResult {
  label: string;
  zone: string;
  tempC: number;
  chipName: string;
}

// ---------------------------------------------------------------------------
// Fan curve presets
// ---------------------------------------------------------------------------

const FAN_CURVES: Record<Exclude<PresetName, "custom">, FanCurvePoint[]> = {
  silent: [
    { tempC: 40, percent: 0 },
    { tempC: 50, percent: 20 },
    { tempC: 60, percent: 40 },
    { tempC: 70, percent: 60 },
    { tempC: 80, percent: 80 },
    { tempC: 90, percent: 100 },
  ],
  balanced: [
    { tempC: 30, percent: 15 },
    { tempC: 45, percent: 30 },
    { tempC: 55, percent: 50 },
    { tempC: 65, percent: 70 },
    { tempC: 75, percent: 85 },
    { tempC: 85, percent: 100 },
  ],
  performance: [
    { tempC: 30, percent: 30 },
    { tempC: 40, percent: 50 },
    { tempC: 50, percent: 60 },
    { tempC: 60, percent: 75 },
    { tempC: 70, percent: 90 },
    { tempC: 80, percent: 100 },
  ],
};

const HWMON_BASE = "/sys/class/hwmon";

/** Chip names known to host CPU temperature sensors */
const CPU_TEMP_CHIPS = ["k10temp", "coretemp", "zenpower"];

/** Chip names known to host GPU temperature sensors */
const GPU_TEMP_CHIPS = ["amdgpu", "nvidia", "nouveau", "radeon"];

/** Keywords that hint at a CPU-related temp label */
const CPU_LABEL_KEYWORDS = ["tctl", "tdie", "cpu", "soc", "package"];

// ---------------------------------------------------------------------------
// Plugin backend
// ---------------------------------------------------------------------------

/**
 * Fan Control plugin backend -- multi-platform edition.
 *
 * Scans all /sys/class/hwmon/ directories to detect fan devices and
 * temperature sensors across many hardware platforms (OneXPlayer APEX,
 * Steam Deck, ASUS, Lenovo ThinkPad, AMD/Intel desktops, etc.).
 *
 * Supports:
 *  - Multiple fans per device
 *  - Multiple temperature zones (CPU, GPU, SoC, ...)
 *  - Direct hwmon PWM control
 *  - ectool fallback for EC-controlled fans
 *  - Fan curve presets (silent / balanced / performance / custom)
 *  - Hardware-safety override (non-disablable, fail-safe-to-MAX)
 *
 * Current fan loop, end-to-end:
 *   1. scanHardware()        — locate hwmon fan + temp sensors
 *   2. every 2 s:
 *      a. read temp sensors  (getTemperatures, sysfs tempN_input ÷ 1000)
 *      b. curve loop: interpolate user curve → desiredPercent
 *      c. SAFETY OVERRIDE:   applySafetyFloor(desiredPercent, cpuTemp)
 *         lifts the percent to a hardware-safe floor whenever temp ≥
 *         75 °C, forces 100 % at ≥ 85 °C, fails-safe to 100 % on any
 *         temp-read error. Non-disablable; runs after the user curve.
 *      d. writeHwmon          (sudo tee → /sys/class/hwmon/.../pwmN)
 *      e. emit fan-update     (UI tile + slider + warning chip)
 *
 * Issue #97 — the maintainer's device thermal-tripped (power-off) when a
 * misconfigured fan curve left PWM low above Tjunction. The safety
 * override (see `safety-floor.ts` + `applySafetyFloor` below) lives on
 * the write side so EVERY path — user slider, preset curve loop,
 * per-game profile apply — gets clamped upward before sysfs is touched.
 */
export default class FanControlBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private hwmonDevices: HwmonDevice[] = [];
  private activeFanDevice: HwmonDevice | null = null;
  private tempSensors: TempSensor[] = [];
  private interval?: Timer;
  private curveInterval?: Timer;
  private activePreset: PresetName | null = null;
  private customCurve: FanCurvePoint[] = [];
  private useEctool = false;
  private originalModes: Map<string, string> = new Map();
  private hardwareScanner?: RetryScanner;
  private fanDeviceLogged = false;
  private tempSensorsLogged = false;
  // Watchdog state: true once we've flipped pwm_enable to manual due to
  // a high-temp event. Stays true through the WARM_C → WARM_C-hysteresis
  // band so a single noisy temp dip doesn't cause auto/manual flapping;
  // released once temps fall clearly below the engagement threshold.
  private safetyEngaged = false;
  // Last PWM value the USER asked for via the public setFanSpeed RPC
  // (slider / per-game profile). The watchdog uses this on release to
  // restore the user's preference instead of the boot-time pwm_enable
  // — without it the release silently drops the user from Manual at X%
  // back to Auto.
  private lastUserSpeedPwm: number | null = null;
  // Paths we've already warned about for missing pwm_enable. Without
  // this the watchdog tick spams the journal every 2 s on the rare
  // legacy hwmon driver that exposes pwm but not pwm_enable.
  private missingEnableWarned: Set<string> = new Set();
  // Tracks user-requested mode when running through the ectool fallback, which
  // has no sysfs "manual/auto" toggle to read back from. Without this the UI
  // could never switch out of "unknown" mode and the slider/presets would
  // stay hidden.
  private manualModeRequested: "auto" | "manual" | null = null;

  // Per-game state. The engine owns the {profiles, perGameEnabled, snapshot,
  // boundAppId} state machine — we just wire in the apply/snapshot/restore
  // operations and delegate the RPC surface.
  private profileEngine: PerGameEngine<FanProfilePayload> = createPerGameEngine<
    FanProfilePayload,
    FanModeSnapshot
  >({
    // profilesKey preserves the legacy field name fan-control's existing
    // users have on disk so we don't strand their per-game settings.
    persistence: createPluginStoragePersistence(PLUGIN_ID, { profilesKey: "profiles" }),
    guard: () => Boolean(this.activeFanDevice?.hasPwmControl) || this.useEctool,
    onSnapshot: () => this.captureModeSnapshot(),
    onApply: async (payload, ctx) => {
      if (payload.mode === "manual" && typeof payload.speed === "number") {
        await this.setFanSpeed(payload.speed);
      } else {
        await this.setFanMode(payload.mode);
      }
      console.log(
        `[fan-control] Applied per-game profile for ${ctx.gameName || `App ${ctx.appId}`}: ${payload.mode}` +
          (payload.mode === "manual" && typeof payload.speed === "number"
            ? ` ${payload.speed}%`
            : ""),
      );
    },
    onRestore: async (snap) => {
      if (snap.mode === "manual" && typeof snap.speed === "number") {
        await this.setFanSpeed(snap.speed);
      } else {
        await this.setFanMode("auto");
      }
    },
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async onLoad(): Promise<void> {
    console.log("[fan-control] Plugin loading -- scanning hardware...");

    // Load persisted per-game profiles before the first hardware scan so
    // a launch event arriving immediately after onLoad has settings to
    // apply.
    try {
      await this.profileEngine.load();
    } catch (err) {
      console.error("[fan-control] Failed to load per-game profiles:", err);
    }

    // Kernel modules like oxpec can be loaded after user services start.
    // If the first scan misses them, keep retrying every 30s until fan
    // hardware shows up, so we don't stay broken until the next restart.
    this.hardwareScanner = createRetryScanner({
      label: "fan-control",
      scan: () => this.scanHardware(),
      intervalMs: 30_000,
      onFound: async () => {
        this.emit?.({ event: "fan-update", data: await this.getFanInfo() });
      },
    });
    await this.hardwareScanner.start();

    // Emit fan status updates every 2 seconds. Also runs the safety
    // watchdog on the same cadence — independent of the curve loop and
    // independent of mode (auto/manual). If kernel auto-fan fails and
    // the SoC hits ≥85 °C while we're "doing nothing", this is what
    // forces fans to MAX before thermal-trip.
    this.interval = setInterval(async () => {
      try {
        const info = await this.getFanInfo();
        this.emit?.({ event: "fan-update", data: info });
      } catch (err) {
        console.error("[fan-control] Error emitting fan update:", err);
      }
      try {
        await this.safetyWatchdogTick();
      } catch (err) {
        console.error("[fan-control] Safety watchdog tick failed:", err);
      }
    }, 2000);

    console.log("[fan-control] Plugin loaded");
  }

  async onUnload(): Promise<void> {
    clearInterval(this.interval);
    clearInterval(this.curveInterval);
    this.hardwareScanner?.stop();

    // Safety: restore auto mode on unload
    await this.restoreOriginalModes();

    console.log("[fan-control] Plugin unloaded -- fan modes restored");
  }

  /**
   * Runs one pass of hwmon + temp sensor + ectool detection.
   * Returns true only when hwmon direct PWM control is available — the
   * preferred backend. ectool is still probed as a fallback, but does
   * NOT stop the retry scanner: if oxpec (or another driver) loads
   * after plugin init, we want to pick up the hwmon node instead of
   * getting stuck on ectool forever.
   */
  private async scanHardware(): Promise<boolean> {
    this.hwmonDevices = await this.scanHwmonDevices();
    this.tempSensors = await this.scanTempSensors();

    // Pick the best fan device (prefer one with PWM control)
    this.activeFanDevice =
      this.hwmonDevices.find((d) => d.hasPwmControl && d.fans.length > 0) ??
      this.hwmonDevices.find((d) => d.fans.length > 0) ??
      null;

    if (this.activeFanDevice && !this.fanDeviceLogged) {
      console.log(
        `[fan-control] Fan device: ${this.activeFanDevice.chipName} at ${this.activeFanDevice.dir} ` +
          `(${this.activeFanDevice.fans.length} fan(s), pwm=${this.activeFanDevice.hasPwmControl})`,
      );
      await this.saveOriginalModes();
      this.fanDeviceLogged = true;
    }

    // Check for ectool availability as a fallback (only needed when hwmon
    // has no direct PWM control).
    if (!this.activeFanDevice?.hasPwmControl && !this.useEctool) {
      this.useEctool = await this.detectEctool();
      if (this.useEctool) {
        console.log("[fan-control] ectool detected -- using EC fan control fallback");
      }
    }

    if (this.tempSensors.length > 0 && !this.tempSensorsLogged) {
      console.log(
        `[fan-control] ${this.tempSensors.length} temp sensor(s) detected: ` +
          this.tempSensors.map((s) => `${s.label} (${s.zone})`).join(", "),
      );
      this.tempSensorsLogged = true;
    }

    // Only "found" when direct hwmon PWM control is available. ectool
    // alone is not enough to stop retries — see the OXP APEX race where
    // `which ectool` succeeds but the binary can't acquire the EC lock,
    // and oxpec's hwmon node registers milliseconds after plugin init.
    return this.activeFanDevice?.hasPwmControl === true;
  }

  // -----------------------------------------------------------------------
  // RPC Methods
  // -----------------------------------------------------------------------

  /** Returns comprehensive fan status. */
  async getFanInfo(): Promise<FanInfoResult> {
    if (!this.activeFanDevice && !this.useEctool) {
      return {
        fans: [],
        mode: "unknown",
        temps: [],
        cpuTempC: 0,
        chipName: "none",
        fanCount: 0,
        available: false,
        activePreset: this.activePreset,
        usingEctool: false,
        warning: null,
        safetyEngaged: false,
      };
    }

    const temps = await this.getTemperatures();
    const cpuTemp = temps.find((t) => t.zone === "cpu");
    const cpuTempC = cpuTemp?.tempC ?? temps[0]?.tempC ?? 0;

    // Surface safety override state to the UI. Mirrors the thresholds
    // in safety-floor.ts so the warning chip lines up with what the
    // override is actually doing.
    let warning: string | null = null;
    if (cpuTempC >= SAFETY_THRESHOLDS.CRITICAL_C) {
      warning = `CRITICAL: ${cpuTempC} C >= ${SAFETY_THRESHOLDS.CRITICAL_C} C -- fans forced to MAX to prevent thermal shutdown`;
    } else if (cpuTempC >= SAFETY_THRESHOLDS.FORCE_MAX_C) {
      warning = `HOT: ${cpuTempC} C >= ${SAFETY_THRESHOLDS.FORCE_MAX_C} C -- safety override forcing fans to MAX`;
    } else if (cpuTempC >= SAFETY_THRESHOLDS.WARM_C) {
      warning = `WARM: ${cpuTempC} C >= ${SAFETY_THRESHOLDS.WARM_C} C -- safety floor raised`;
    }

    if (this.useEctool && !this.activeFanDevice?.hasPwmControl) {
      // ectool path -- limited info. Reflect the user's last mode request so
      // the UI can un-gate the slider/presets once Manual is pressed.
      const rpm = await this.readEctoolFanRpm();
      return {
        fans: [{ index: 1, rpm, pwm: 0, percent: 0 }],
        mode: this.manualModeRequested ?? "auto",
        temps: temps.map(({ label, zone, tempC }) => ({ label, zone, tempC })),
        cpuTempC,
        chipName: "ec",
        fanCount: 1,
        available: true,
        activePreset: this.activePreset,
        usingEctool: true,
        warning,
        safetyEngaged: this.safetyEngaged,
      };
    }

    const device = this.activeFanDevice!;
    const fanReadings: FanInfoResult["fans"] = [];
    let mode: FanInfoResult["mode"] = "unknown";

    for (const fan of device.fans) {
      const rpm = await this.readIntFile(fan.inputPath).catch(() => 0);
      let pwm = 0;
      let percent = 0;

      if (fan.pwmPath) {
        pwm = await this.readIntFile(fan.pwmPath).catch(() => 0);
        percent = Math.round((pwm / 255) * 100);
      }

      if (fan.pwmEnablePath && mode === "unknown") {
        const modeRaw = await this.readIntFile(fan.pwmEnablePath).catch(() => -1);
        mode = this.parsePwmMode(modeRaw);
      }

      fanReadings.push({ index: fan.index, rpm, pwm, percent });
    }

    return {
      fans: fanReadings,
      mode,
      temps: temps.map(({ label, zone, tempC }) => ({ label, zone, tempC })),
      cpuTempC,
      chipName: device.chipName,
      fanCount: device.fans.length,
      available: true,
      activePreset: this.activePreset,
      usingEctool: false,
      warning,
      safetyEngaged: this.safetyEngaged,
    };
  }

  /** Returns all detected temperature sensors with current readings. */
  async getTemperatures(): Promise<TempResult[]> {
    const results: TempResult[] = [];

    for (const sensor of this.tempSensors) {
      const raw = await this.readIntFile(sensor.inputPath).catch(() => 0);
      const tempC = Math.round(raw / 1000);
      results.push({
        label: sensor.label,
        zone: sensor.zone,
        tempC,
        chipName: sensor.chipName,
      });
    }

    return results;
  }

  /** Sets fan speed as a percentage (0-100). Enforces safety limits. */
  async setFanSpeed(percent: number): Promise<{ success: boolean; error?: string }> {
    // Safety override (issue #97): user's value first, then the floor
    // can only RAISE it. Fails safe to 100% on any temp-read error.
    const safePercent = await this.applySafetyFloor(percent);
    const clamped = Math.max(0, Math.min(100, safePercent));
    const pwmValue = Math.round((clamped / 100) * 255);

    // Stop any active curve loop
    this.stopCurveLoop();
    this.activePreset = null;
    // Setting a specific speed implies manual mode.
    this.manualModeRequested = "manual";
    this.lastUserSpeedPwm = pwmValue;

    if (this.useEctool && !this.activeFanDevice?.hasPwmControl) {
      return this.setEctoolFanSpeed(clamped);
    }

    if (!this.activeFanDevice?.hasPwmControl) {
      return { success: false, error: "No controllable fan device detected" };
    }

    try {
      for (const fan of this.activeFanDevice.fans) {
        if (!fan.pwmPath) continue;
        if (fan.pwmEnablePath) {
          await this.writeHwmon(fan.pwmEnablePath, "1");
          await this.writeHwmon(fan.pwmPath, String(pwmValue));
        } else {
          // Legacy hwmon (pwm exposed without pwm_enable): same warn-once
          // + pwm-only fallback as setFanSpeedInternal. The user slider
          // would otherwise silently no-op on these devices.
          if (!this.missingEnableWarned.has(fan.pwmPath)) {
            console.warn(
              `[fan-control] ${fan.pwmPath}: no pwm_enable sibling — ` +
                `writing pwm directly. Fan control may be limited; the ` +
                `kernel auto driver can override these writes.`,
            );
            this.missingEnableWarned.add(fan.pwmPath);
          }
          await this.writeHwmon(fan.pwmPath, String(pwmValue));
        }
      }
      console.log(`[fan-control] Set fan speed to ${clamped}% (PWM ${pwmValue})`);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[fan-control] Failed to set fan speed:", msg);
      return { success: false, error: msg };
    }
  }

  /** Sets fan mode: "auto" (kernel-controlled) or "manual" (user-controlled). */
  async setFanMode(mode: "auto" | "manual"): Promise<{ success: boolean; error?: string }> {
    if (mode === "auto") {
      this.stopCurveLoop();
      this.activePreset = null;
    }
    this.manualModeRequested = mode;

    if (this.useEctool && !this.activeFanDevice?.hasPwmControl) {
      if (mode === "auto") {
        return this.runEctool(["fanduty", "auto"]);
      }
      // ectool doesn't have a distinct "manual" toggle -- it's implicit when setting duty
      return { success: true };
    }

    if (!this.activeFanDevice?.hasPwmControl) {
      return { success: false, error: "No controllable fan device detected" };
    }

    const value = mode === "auto" ? "2" : "1";

    try {
      for (const fan of this.activeFanDevice.fans) {
        if (fan.pwmEnablePath) {
          await this.writeHwmon(fan.pwmEnablePath, value);
        }
      }
      console.log(`[fan-control] Set fan mode to ${mode} (pwm_enable=${value})`);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[fan-control] Failed to set fan mode:", msg);
      return { success: false, error: msg };
    }
  }

  /** Applies a fan curve preset. Starts a loop that adjusts speed based on temperature. */
  async applyPreset(
    name: PresetName,
    customCurve?: FanCurvePoint[],
  ): Promise<{ success: boolean; error?: string }> {
    if (name === "custom") {
      if (!customCurve || customCurve.length < 2) {
        return { success: false, error: "Custom preset requires at least 2 curve points" };
      }
      this.customCurve = customCurve.sort((a, b) => a.tempC - b.tempC);
    }

    const curve = name === "custom" ? this.customCurve : FAN_CURVES[name];
    if (!curve) {
      return { success: false, error: `Unknown preset: ${name}` };
    }

    this.activePreset = name;
    console.log(`[fan-control] Applying preset: ${name}`);

    // Set to manual mode first
    const modeResult = await this.setFanModeInternal("manual");
    if (!modeResult.success) return modeResult;

    // Apply curve immediately, then start a loop
    await this.applyCurve(curve);
    this.startCurveLoop(curve);

    return { success: true };
  }

  // -----------------------------------------------------------------------
  // Hardware scanning
  // -----------------------------------------------------------------------

  /** Scans all hwmon directories for fan devices. */
  private async scanHwmonDevices(): Promise<HwmonDevice[]> {
    const devices: HwmonDevice[] = [];

    try {
      const entries = await fsp.readdir(HWMON_BASE);

      for (const entry of entries) {
        const dir = `${HWMON_BASE}/${entry}`;
        const chipName = await this.readStringFile(`${dir}/name`);
        const fans: FanDevice[] = [];
        let hasPwmControl = false;

        // Check for fan1 through fan8
        for (let i = 1; i <= 8; i++) {
          const inputPath = `${dir}/fan${i}_input`;
          if (!fs.existsSync(inputPath)) continue;

          const pwmPath = fs.existsSync(`${dir}/pwm${i}`) ? `${dir}/pwm${i}` : null;
          const pwmEnablePath = fs.existsSync(`${dir}/pwm${i}_enable`) ? `${dir}/pwm${i}_enable` : null;

          if (pwmPath && pwmEnablePath) {
            hasPwmControl = true;
          }

          fans.push({ index: i, inputPath, pwmPath, pwmEnablePath });
        }

        if (fans.length > 0) {
          devices.push({ dir, chipName, fans, hasPwmControl });
        }
      }
    } catch (err) {
      console.error("[fan-control] Error scanning hwmon devices:", err);
    }

    return devices;
  }

  /** Scans all hwmon directories for temperature sensors. */
  private async scanTempSensors(): Promise<TempSensor[]> {
    const sensors: TempSensor[] = [];

    try {
      const entries = await fsp.readdir(HWMON_BASE);

      for (const entry of entries) {
        const dir = `${HWMON_BASE}/${entry}`;
        const chipName = await this.readStringFile(`${dir}/name`);

        // Check for temp1 through temp12
        for (let i = 1; i <= 12; i++) {
          const inputPath = `${dir}/temp${i}_input`;
          if (!fs.existsSync(inputPath)) continue;

          // Read the label for this specific temp channel
          let label = await this.readStringFile(`${dir}/temp${i}_label`);
          if (!label) {
            // Fall back to chip name + index
            label = chipName ? `${chipName}/temp${i}` : `hwmon/${entry}/temp${i}`;
          }

          const zone = this.classifyTempZone(chipName, label);
          sensors.push({ inputPath, label, zone, chipName: chipName || entry });
        }
      }
    } catch (err) {
      console.error("[fan-control] Error scanning temp sensors:", err);
    }

    // Sort so CPU sensors come first, then GPU, then others
    const zoneOrder: Record<string, number> = { cpu: 0, gpu: 1, soc: 2, unknown: 3 };
    sensors.sort((a, b) => (zoneOrder[a.zone] ?? 3) - (zoneOrder[b.zone] ?? 3));

    return sensors;
  }

  /** Classifies a temperature sensor into a zone based on chip name and label. */
  private classifyTempZone(chipName: string, label: string): string {
    const lower = (chipName + " " + label).toLowerCase();

    if (CPU_TEMP_CHIPS.some((c) => lower.includes(c))) return "cpu";
    if (CPU_LABEL_KEYWORDS.some((kw) => lower.includes(kw))) return "cpu";
    if (GPU_TEMP_CHIPS.some((c) => lower.includes(c))) return "gpu";
    if (lower.includes("gpu") || lower.includes("junction") || lower.includes("edge")) return "gpu";
    if (lower.includes("soc")) return "soc";

    // steamdeck_hwmon has CPU temp
    if (lower.includes("steamdeck")) return "cpu";

    return "unknown";
  }

  // -----------------------------------------------------------------------
  // Fan curve logic
  // -----------------------------------------------------------------------

  /** Interpolates the target fan percent for a given temperature using a curve. */
  private interpolateCurve(curve: FanCurvePoint[], tempC: number): number {
    if (tempC <= curve[0].tempC) return curve[0].percent;
    if (tempC >= curve[curve.length - 1].tempC) return curve[curve.length - 1].percent;

    for (let i = 0; i < curve.length - 1; i++) {
      const lo = curve[i];
      const hi = curve[i + 1];
      if (tempC >= lo.tempC && tempC <= hi.tempC) {
        const ratio = (tempC - lo.tempC) / (hi.tempC - lo.tempC);
        return Math.round(lo.percent + ratio * (hi.percent - lo.percent));
      }
    }

    return curve[curve.length - 1].percent;
  }

  /** Applies a fan curve once based on current temperature. */
  private async applyCurve(curve: FanCurvePoint[]): Promise<void> {
    const temps = await this.getTemperatures();
    const cpuTemp = temps.find((t) => t.zone === "cpu")?.tempC ?? temps[0]?.tempC ?? 0;
    let targetPercent = this.interpolateCurve(curve, cpuTemp);

    // Safety override (issue #97). Runs AFTER the user's curve so the
    // curve's intent is preserved on normal temps, then clamped upward
    // when the SoC heads into thermal-trip range.
    targetPercent = await this.applySafetyFloor(targetPercent);

    // Issue #108: when the watchdog has engaged the safety floor, the
    // curve loop must respect it even if the curve's own sysfs read
    // landed inside the hysteresis band (computeSafetyFloor returns
    // no override below WARM_C, but safetyEngaged is still true).
    // Without this clamp, two timers race the same pwm node and the
    // curve can write a value below the floor the watchdog enforced.
    if (this.safetyEngaged) {
      targetPercent = Math.max(
        targetPercent,
        SAFETY_THRESHOLDS.WARM_FLOOR_PCT,
      );
    }

    await this.setFanSpeedInternal(Math.max(0, Math.min(100, targetPercent)));
  }

  /** Starts the curve evaluation loop (every 2 seconds). */
  private startCurveLoop(curve: FanCurvePoint[]): void {
    this.stopCurveLoop();
    this.curveInterval = setInterval(() => this.applyCurve(curve), 2000);
  }

  /** Stops the curve evaluation loop. */
  private stopCurveLoop(): void {
    if (this.curveInterval) {
      clearInterval(this.curveInterval);
      this.curveInterval = undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Safety — hardware-protection override (issue #97)
  // -----------------------------------------------------------------------

  /**
   * Returns the hot-side CPU/SoC temperature in °C, or `null` if no
   * valid reading is available.
   *
   * **null is load-bearing.** computeSafetyFloor treats null as
   * "failsafe to MAX". We MUST NOT collapse a sysfs error into 0 °C
   * (the way getTemperatures does, which is fine for UI display but
   * fatal for safety logic — 0 °C would mean "no override needed",
   * which is exactly the opposite of what we want when the sensor
   * went dark).
   */
  private async getCpuTempCOrNull(): Promise<number | null> {
    if (this.tempSensors.length === 0) return null;

    // Prefer the CPU sensor; fall back to any sensor reading. The
    // critical reading is the hottest one we can see — we take the
    // max across CPU + GPU because either being hot risks shutdown.
    let hottest = -Infinity;
    let sawAny = false;

    for (const sensor of this.tempSensors) {
      if (sensor.zone !== "cpu" && sensor.zone !== "gpu" && sensor.zone !== "soc") continue;
      try {
        const raw = await this.readIntFile(sensor.inputPath);
        if (!Number.isFinite(raw)) continue;
        const tempC = raw / 1000;
        if (tempC > hottest) hottest = tempC;
        sawAny = true;
      } catch {
        // Ignore individual sensor failures; we'll fall back to null
        // below if NONE of the hot-zone sensors were readable.
      }
    }

    if (!sawAny) return null;
    return Math.round(hottest);
  }

  /**
   * Applies the hardware-safety override to a user-requested percent.
   *
   * Pipeline: read temp → computeSafetyFloor (pure) → log if engaged
   *           → optionally emit a UI event on critical → return final
   *           percent for the caller to write.
   *
   * Every failure path collapses to "force MAX":
   *   - tempSensors empty               → null → MAX
   *   - all sensor reads throw          → null → MAX
   *   - getTemperatures itself throws   → caught here → MAX
   *   - computeSafetyFloor throws       → defensive catch → MAX
   *
   * **This override is not user-disablable.** A future "I want quieter
   * fans" preference can lower the floor but MUST NOT remove it.
   */
  private async applySafetyFloor(userPercent: number): Promise<number> {
    let result: SafetyFloorResult;
    try {
      const tempC = await this.getCpuTempCOrNull();
      result = computeSafetyFloor(userPercent, tempC);
    } catch (err) {
      // Defensive: any exception in the safety path = MAX. Better a
      // loud fan than a thermal-trip shutdown.
      console.error(
        "[fan-control] Safety override threw — defaulting to MAX:",
        err,
      );
      result = {
        percent: 100,
        engaged: true,
        critical: true,
        reason: "safety pipeline exception — failsafe to MAX",
      };
    }

    if (result.engaged) {
      const level = result.critical ? "CRITICAL" : "engaged";
      console.warn(
        `[fan-control] Safety override ${level}: ${result.reason}, ` +
          `forced PWM=${Math.round((result.percent / 100) * 255)} ` +
          `(user curve wanted ${Math.round(userPercent)}%)`,
      );

      // Surface to the UI on the critical path so the user sees the
      // warning chip even if they happen to be on this plugin's page.
      // Non-critical engagements are noisy enough through journalctl;
      // we don't want to flap the UI every 2 s while temps hover at
      // the 75 °C floor.
      if (result.critical) {
        try {
          this.emit?.({
            event: "fan-safety-critical",
            data: {
              percent: result.percent,
              reason: result.reason,
            },
          });
        } catch {
          // emit is best-effort; never let UI plumbing leak back into
          // the fan-write path.
        }
      }
    }

    return result.percent;
  }

  /**
   * Watchdog tick: runs on the same 2 s cadence as the status emit.
   *
   * In Auto mode (kernel-controlled fans) we normally don't touch PWM.
   * But once we cross the WARM_C threshold the safety floor needs to
   * actually move the fans — the per-write override only fires from
   * the user slider / curve loop, neither of which is running in pure
   * auto mode. This is the path that actually enforces the floor for
   * users who never touched the slider.
   *
   * Issue #106: the previous implementation only fired at ≥85 °C and
   * called setFanSpeedInternal(100), which (a) ignored the 75 °C and
   * 80 °C floor steps the UI was already warning about, and (b)
   * silently no-op'd because pwm_enable was still in auto. The fix is
   * to (1) engage at WARM_C so the user-visible warning matches reality
   * and (2) trust setFanSpeedInternal — now fixed — to flip pwm_enable
   * to manual before writing pwm.
   */
  private async safetyWatchdogTick(): Promise<void> {
    if (!this.activeFanDevice?.hasPwmControl && !this.useEctool) return;

    const tempC = await this.getCpuTempCOrNull();
    if (tempC === null) {
      // No temp = no signal to force on. Per-write override will still
      // catch any subsequent user request. We don't gratuitously
      // force MAX from the watchdog (only the write path does), so
      // an unplugged temp sensor doesn't pin fans to 100 % forever.
      return;
    }

    const releaseAt =
      SAFETY_THRESHOLDS.WARM_C - SAFETY_THRESHOLDS.RELEASE_HYSTERESIS_C;

    if (tempC < SAFETY_THRESHOLDS.WARM_C) {
      // Below engagement threshold — but if we're already engaged we
      // need to wait for hysteresis before releasing, otherwise the
      // fan will flap manual↔auto every time temp wobbles around 75 °C.
      if (this.safetyEngaged && tempC < releaseAt) {
        await this.releaseSafetyEngagement(tempC);
      }
      return;
    }

    // Compute the required floor from the same pure function the rest
    // of the safety pipeline uses. We pass userPercent=0 so the floor
    // is the only thing driving the result — we want the *minimum* the
    // safety policy demands at this temperature, not whatever the user
    // last asked for.
    const result = computeSafetyFloor(0, tempC);
    console.warn(
      `[fan-control] Safety watchdog engaging: temp=${tempC}°C — ` +
        `forcing fan to ${result.percent}% (${result.reason})`,
    );
    this.safetyEngaged = true;
    await this.setFanSpeedInternal(result.percent).catch((err) => {
      console.error("[fan-control] Watchdog safety write failed:", err);
    });
  }

  /**
   * Releases the watchdog's manual-mode override.
   *
   * Honour the user's CURRENT preference, not the boot-time default:
   * if they had explicitly chosen Manual (slider) or activated a curve
   * preset, keep pwm_enable at 1 and rewrite their last requested PWM
   * to undo the safety floor's clamp. Only release back to the saved
   * original (typically "2" for kernel auto) when the user hadn't
   * touched the slider at all. Without this the release silently drops
   * the user from Manual at X% to Auto, losing their setting.
   *
   * Some hwmon drivers default to "0" or "1" — `originalModes` honours
   * whatever was at scan time so the auto path doesn't clobber them.
   */
  private async releaseSafetyEngagement(tempC: number): Promise<void> {
    if (!this.activeFanDevice) {
      this.safetyEngaged = false;
      return;
    }

    const userIntentManual =
      this.manualModeRequested === "manual" || this.activePreset !== null;

    console.log(
      `[fan-control] Safety watchdog releasing: temp=${tempC}°C — ` +
        (userIntentManual
          ? `restoring user's manual mode${this.lastUserSpeedPwm !== null ? ` at PWM ${this.lastUserSpeedPwm}` : ""}`
          : `restoring original pwm_enable mode`),
    );

    for (const fan of this.activeFanDevice.fans) {
      if (!fan.pwmEnablePath) continue;
      try {
        if (userIntentManual) {
          // Stay in manual; rewrite the user's last requested PWM so the
          // floor's clamp gets undone immediately. If a curve preset is
          // active and lastUserSpeedPwm is null, the curve loop's next
          // tick will write the curve value — we just need pwm_enable
          // to remain at 1 (already is, from engagement).
          await this.writeHwmon(fan.pwmEnablePath, "1");
          if (this.lastUserSpeedPwm !== null && fan.pwmPath) {
            await this.writeHwmon(fan.pwmPath, String(this.lastUserSpeedPwm));
          }
        } else {
          const original = this.originalModes.get(fan.pwmEnablePath) ?? "2";
          await this.writeHwmon(fan.pwmEnablePath, original);
        }
      } catch (err) {
        console.error(
          `[fan-control] Failed to restore mode for ${fan.pwmEnablePath}:`,
          err,
        );
      }
    }
    this.safetyEngaged = false;
  }

  /** Saves the current pwm_enable values so they can be restored on unload. */
  private async saveOriginalModes(): Promise<void> {
    if (!this.activeFanDevice) return;
    for (const fan of this.activeFanDevice.fans) {
      if (fan.pwmEnablePath) {
        try {
          const val = await fsp.readFile(fan.pwmEnablePath, "utf-8");
          this.originalModes.set(fan.pwmEnablePath, val.trim());
        } catch {
          // Ignore read errors -- we'll default to auto (2) on restore
        }
      }
    }
  }

  /** Restores the original pwm_enable values (or defaults to auto). */
  private async restoreOriginalModes(): Promise<void> {
    if (!this.activeFanDevice) {
      if (this.useEctool) {
        await this.runEctool(["fanduty", "auto"]);
      }
      return;
    }

    for (const fan of this.activeFanDevice.fans) {
      if (fan.pwmEnablePath) {
        const original = this.originalModes.get(fan.pwmEnablePath) ?? "2";
        try {
          await this.writeHwmon(fan.pwmEnablePath, original);
        } catch (err) {
          console.error(`[fan-control] Failed to restore mode for ${fan.pwmEnablePath}:`, err);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal control helpers (no preset/curve reset)
  // -----------------------------------------------------------------------

  /**
   * Sets fan speed without resetting preset state. Used by both the curve
   * loop and the safety watchdog.
   *
   * Issue #106: writing pwm while pwm_enable=2 (kernel auto) is a no-op
   * on hwmon drivers like oxpec — the kernel immediately re-overrides
   * our value. The safety watchdog kept "writing" 100 % to pwm and the
   * fan never moved because nobody flipped pwm_enable to 1 (manual)
   * first. Now we always write pwm_enable=1 alongside pwm so the write
   * actually takes effect, regardless of whether the user is in auto
   * mode or running a preset curve.
   */
  private async setFanSpeedInternal(percent: number): Promise<{ success: boolean; error?: string }> {
    const clamped = Math.max(0, Math.min(100, percent));
    const pwmValue = Math.round((clamped / 100) * 255);

    if (this.useEctool && !this.activeFanDevice?.hasPwmControl) {
      return this.setEctoolFanSpeed(clamped);
    }

    if (!this.activeFanDevice?.hasPwmControl) {
      return { success: false, error: "No controllable fan device detected" };
    }

    try {
      for (const fan of this.activeFanDevice.fans) {
        if (!fan.pwmPath) continue;
        if (fan.pwmEnablePath) {
          await this.writeHwmon(fan.pwmEnablePath, "1");
          await this.writeHwmon(fan.pwmPath, String(pwmValue));
        } else {
          // Legacy hwmon driver: pwm exposed without pwm_enable. Pre-#106
          // behaviour was to write pwm directly. Restore that path so
          // these devices don't lose all fan control, but warn loudly
          // (once per device) so the limitation is visible. The kernel
          // auto driver may stomp on us, but doing nothing is worse.
          if (!this.missingEnableWarned.has(fan.pwmPath)) {
            console.warn(
              `[fan-control] ${fan.pwmPath}: no pwm_enable sibling — ` +
                `writing pwm directly. Fan control may be limited; the ` +
                `kernel auto driver can override these writes.`,
            );
            this.missingEnableWarned.add(fan.pwmPath);
          }
          await this.writeHwmon(fan.pwmPath, String(pwmValue));
        }
      }
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /** Sets fan mode without resetting preset state. */
  private async setFanModeInternal(
    mode: "auto" | "manual",
  ): Promise<{ success: boolean; error?: string }> {
    this.manualModeRequested = mode;

    if (this.useEctool && !this.activeFanDevice?.hasPwmControl) {
      if (mode === "auto") {
        return this.runEctool(["fanduty", "auto"]);
      }
      return { success: true };
    }

    if (!this.activeFanDevice?.hasPwmControl) {
      return { success: false, error: "No controllable fan device detected" };
    }

    const value = mode === "auto" ? "2" : "1";
    try {
      for (const fan of this.activeFanDevice.fans) {
        if (fan.pwmEnablePath) {
          await this.writeHwmon(fan.pwmEnablePath, value);
        }
      }
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // ectool fallback
  // -----------------------------------------------------------------------

  /**
   * Checks if ectool is both installed AND functional.
   *
   * A plain `which ectool` passes on devices where the binary exists
   * but can't actually talk to the EC — e.g. OXP APEX, where ectool
   * fails with "Could not acquire GEC lock" because there's no
   * ChromeOS-style EC behind it. Probing with `ectool hello` forces
   * the real handshake; a zero exit means we can trust the fallback.
   */
  private async detectEctool(): Promise<boolean> {
    try {
      return (await runCode(["ectool", "hello"])) === 0;
    } catch {
      return false;
    }
  }

  /** Reads fan RPM via ectool. */
  private async readEctoolFanRpm(): Promise<number> {
    try {
      const { stdout } = await run(["ectool", "pwmgetfanrpm"]);
      // Output format: "Current fan RPM: 3200"
      const match = stdout.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }

  /** Sets fan speed via ectool as a percentage. */
  private async setEctoolFanSpeed(
    percent: number,
  ): Promise<{ success: boolean; error?: string }> {
    return this.runEctool(["fanduty", String(percent)]);
  }

  /** Runs an ectool command. */
  private async runEctool(
    args: string[],
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { stderr, exitCode } = await runFull(["ectool", ...args]);
      if (exitCode !== 0) {
        return { success: false, error: `ectool ${args.join(" ")} failed: ${stderr.trim()}` };
      }
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // Low-level I/O helpers
  // -----------------------------------------------------------------------

  /** Reads an integer value from a sysfs file. */
  private async readIntFile(path: string): Promise<number> {
    const content = await fsp.readFile(path, "utf-8");
    return parseInt(content.trim(), 10);
  }

  /** Reads a string value from a sysfs file. Returns empty string on failure. */
  private async readStringFile(path: string): Promise<string> {
    try {
      return (await fsp.readFile(path, "utf-8")).trim();
    } catch {
      return "";
    }
  }

  /** Writes a value to a hwmon sysfs file using sudo tee. */
  private async writeHwmon(path: string, value: string): Promise<void> {
    const { stderr, exitCode } = await runFull(["sudo", "tee", path], {
      stdin: value,
    });
    if (exitCode !== 0) {
      throw new Error(`Failed to write "${value}" to ${path}: ${stderr.trim()}`);
    }
  }

  /** Parses a pwm_enable integer into a human-readable mode string. */
  private parsePwmMode(value: number): "auto" | "manual" | "full" | "unknown" {
    switch (value) {
      case 0:
        return "full";
      case 1:
        return "manual";
      case 2:
        return "auto";
      default:
        return "unknown";
    }
  }

  // -----------------------------------------------------------------------
  // Per-game profiles
  // -----------------------------------------------------------------------

  async getPerGameEnabled(): Promise<boolean> {
    return this.profileEngine.isPerGameEnabled();
  }

  async setPerGameEnabled(
    enabled: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    await this.profileEngine.setPerGameEnabled(Boolean(enabled));
    this.emit?.({
      event: "perGameEnabledChanged",
      data: { enabled: this.profileEngine.isPerGameEnabled() },
    });
    return { success: true };
  }

  async getGameProfiles(): Promise<FanGameProfile[]> {
    return this.profileEngine.getProfiles().map(toRpcProfile);
  }

  async getGameProfile(appId: number): Promise<FanGameProfile | null> {
    const found = this.profileEngine.getProfile(appId);
    return found ? toRpcProfile(found) : null;
  }

  async setGameProfile(
    appId: number,
    gameName: string,
    profile: { mode: "auto" | "manual"; speed?: number },
  ): Promise<{ success: boolean; error?: string }> {
    if (typeof appId !== "number" || !Number.isFinite(appId)) {
      return { success: false, error: "Invalid appId" };
    }
    const payload: FanProfilePayload = {
      mode: profile.mode === "manual" ? "manual" : "auto",
      speed:
        typeof profile.speed === "number"
          ? Math.max(0, Math.min(100, Math.round(profile.speed)))
          : undefined,
    };
    const next = await this.profileEngine.setProfile(appId, gameName ?? "", payload);
    this.emit?.({
      event: "gameProfileChanged",
      data: { appId, profile: toRpcProfile(next) },
    });
    return { success: true };
  }

  async removeGameProfile(
    appId: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.profileEngine.getProfile(appId)) {
      await this.profileEngine.removeProfile(appId);
      this.emit?.({ event: "gameProfileChanged", data: { appId, profile: null } });
    }
    return { success: true };
  }

  // Game lifecycle — invoked by the loader's __broadcast fan-out from the
  // injector. Delegates to the engine; the apply/snapshot/restore wiring
  // is on the engine instance (see private profileEngine above).
  async handleGameLaunch(appId: number, gameName: string): Promise<void> {
    await this.profileEngine.handleGameLaunch(appId, gameName);
  }

  async handleGameExit(appId: number): Promise<void> {
    await this.profileEngine.handleGameExit(appId);
  }

  private async captureModeSnapshot(): Promise<FanModeSnapshot> {
    const info = await this.getFanInfo();
    const mode = info.mode === "manual" ? "manual" : "auto";
    const percent = info.fans[0]?.percent ?? null;
    return { mode, speed: percent };
  }
}
