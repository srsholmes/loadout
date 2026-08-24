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
import {
  FAN_CURVES,
  clampPercent,
  interpolateCurve,
  percentToPwm,
  pwmToPercent,
  type FanCurvePoint,
  type PresetName,
} from "./lib/fan-curves";
import { DEFAULT_CUSTOM_CURVE, sanitiseCurve } from "./lib/custom-curve";
import { sanitiseGlobalMode, type GlobalFanMode } from "./lib/global-mode";
import { readPluginStorage, mutatePluginStorage } from "@loadout/plugin-storage";
import {
  classifyTempZone,
  cpuChipPriority,
  parsePwmMode,
  zoneSortWeight,
} from "./lib/sensors";

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
  /**
   * Absolute path to fanN_target (writable RPM target). Used by drivers
   * that don't expose a standard pwmN node and instead take a target RPM
   * — Valve's `steamdeck_hwmon` on the Steam Deck does exactly this.
   * `null` if the file is missing or not owner-writable.
   */
  rpmTargetPath: string | null;
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
  /**
   * Whether the device exposes the RPM-target write path (any fan has a
   * writable fanN_target) — the alternative when there's no pwmN. Mutually
   * informative with hasPwmControl: a device usually has one or the other.
   * On the Steam Deck (steamdeck_hwmon) this is true and hasPwmControl is false.
   */
  hasRpmTargetControl: boolean;
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

/**
 * How long the curve loop may go without completing a write before the safety
 * watchdog stops deferring to it and writes itself.
 *
 * Ticks that overrun skip rather than queue (see `curveTickBusy`), so the gap
 * between completed writes quantises to 4s, 6s, 8s… — this trips on the first
 * gap of 6s, i.e. one tick that ran long enough to miss the next two.
 *
 * The backstop, not the fix: a write that hangs is bounded by
 * WRITE_TIMEOUT_MS, so the loop recovers on its own. This covers a loop that
 * is merely slow, at the cost of the watchdog briefly writing the same node —
 * a fan that flaps beats a fan that stops at 85 °C.
 */
const CURVE_STALE_MS = 5000;

/** Ceiling on a single sysfs fan write. Generous — these normally take
 *  microseconds; this is only to stop a wedged EC holding the lock forever. */
const WRITE_TIMEOUT_MS = 5000;

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
  /** Whether the user's custom fan curve is the active control mode. */
  customCurveActive: boolean;
  /** Whether ectool fallback is being used */
  usingEctool: boolean;
  /** Safety warning message, if any */
  warning: string | null;
  /** True while the safety watchdog has overridden user fan control.
   *  Sticky: stays true through the WARM_C → release-hysteresis band so
   *  the UI banner doesn't flicker as temp wobbles around 75 °C. */
  safetyEngaged: boolean;
  /**
   * Whether `fans[].percent` is a real reading. False on hardware that has
   * no PWM to read back — ectool, and the Deck's RPM-target path, where the
   * field is hard 0. A UI showing duty must use {@link commandedPercent}
   * there instead, or it reads out 0% while the fan is plainly spinning.
   */
  reportsDuty: boolean;
  /**
   * The duty we last *told* the fan to run at, as a percent — including the
   * curve loop's, a per-game profile's and the safety floor's writes, since
   * those are as real as the user's. Null before anything has been
   * commanded, and cleared when the fan is handed back to auto.
   */
  commandedPercent: number | null;
}

interface TempResult {
  label: string;
  zone: string;
  tempC: number;
  chipName: string;
}

const HWMON_BASE = "/sys/class/hwmon";

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
 *  - Fan curve presets (silent / balanced / performance)
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
 *      d. writeHwmon          (tee → /sys/class/hwmon/.../pwmN)
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
  // The user's editable fan curve (graph editor). Loaded from plugin
  // storage in onLoad; seeded from DEFAULT_CUSTOM_CURVE until then.
  private customCurve: FanCurvePoint[] = DEFAULT_CUSTOM_CURVE.map((p) => ({ ...p }));
  // True while the custom curve is the active control mode — mutually
  // exclusive with activePreset (both drive the same curve loop, only one
  // at a time). Surfaced to the UI so the editor can reflect/restore state.
  private customCurveActive = false;
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

  /**
   * The duty last written to the fan by *anyone* — the user, the curve loop,
   * a per-game profile, the safety floor. Distinct from lastUserSpeedPwm,
   * which the watchdog reads as "what the user asked for" and
   * restoreOriginalModes rewrites; reusing that one would have both meanings
   * fighting over one field. This is what hardware that can't report its own
   * duty shows in the UI.
   */
  private lastCommandedPwm: number | null = null;
  // Paths we've already warned about for missing pwm_enable. Without
  // this the watchdog tick spams the journal every 2 s on the rare
  // legacy hwmon driver that exposes pwm but not pwm_enable.
  private missingEnableWarned: Set<string> = new Set();
  // Tracks user-requested mode when running through the ectool fallback, which
  // has no sysfs "manual/auto" toggle to read back from. Without this the UI
  // could never switch out of "unknown" mode and the slider/presets would
  // stay hidden.
  private manualModeRequested: "auto" | "manual" | null = null;

  /**
   * Tail of the fan-operation queue. Everything that expresses a fan intent
   * runs its critical section through {@link _serialize}, so no two can
   * interleave.
   *
   * They otherwise do: `handleGameLaunch`/`handleGameExit` are fire-and-forget
   * chains from the injector's fan-out, RPC calls aren't serialized per
   * plugin, and each intent awaits several `tee` spawns. On device that let a
   * game *switch* interleave the exit-restore with the next profile's apply —
   * the restore's `startCurveLoop` landing after the profile had stopped it,
   * so the curve drove the fan while the profile was supposed to own it.
   *
   * The rule: **public entry points serialize, private methods assume the
   * lock is held.** An internal caller that goes through a public method
   * instead deadlocks on re-entry.
   *
   * Same pattern (and reasoning) as plugins/disable-controller-input.
   */
  private opLock: Promise<void> = Promise.resolve();

  /** True while the curve tick is running, so ticks slower than the 2s
   *  interval skip rather than queue up behind each other. */
  private curveTickBusy = false;

  /**
   * Bumped whenever the curve loop starts or stops. A tick checks its flags
   * synchronously at *enqueue* time, then waits for the lock — by the time it
   * runs, the mode may have been replaced and its loop stopped, but
   * clearInterval cannot recall a tick that is already queued. It would then
   * write the old curve's duty over the new mode's, with no loop left running
   * to correct it. The generation it captured tells it to stand down.
   */
  private curveGen = 0;

  /**
   * When the curve loop last completed a write. The safety watchdog defers to
   * the curve loop while a curve is driving — but that write now goes through
   * the op lock, so a stalled operation would silence both. If the loop looks
   * stalled, the watchdog stops deferring and writes itself.
   */
  private lastCurveWriteAt = 0;

  /**
   * The user's global choice as we last knew it — read from storage at load,
   * or recorded by the last persist. Kept explicitly rather than inferred
   * from activePreset/customCurveActive/manualModeRequested, because those
   * describe *what is driving the fan right now*, which is a different
   * question: during an apply they still describe the previous mode, and
   * while a per-game profile is bound they describe the game's setting.
   * Inferring from them made the per-game snapshot capture the wrong mode.
   */
  private globalModeIntent: GlobalFanMode | null = null;

  /**
   * Which write path the saved mode has been applied to. Not a boolean:
   * ectool is the fallback used when no hwmon control exists *yet*, and on a
   * host with a late-loading driver the scanner finds one 30s later. A latch
   * would mean that device — the one that ends up owning the fan — never
   * receives the saved mode, and for manual/auto there is no periodic writer
   * to correct it. So an ectool restore is provisional: a hwmon device
   * appearing afterwards gets its own.
   */
  private restoredVia: "none" | "ectool" | "hwmon" = "none";

  /** Whether the user has expressed a choice this session, as opposed to one
   *  we restored. A user choice always wins over the stored value. */
  private userChoseThisSession = false;

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
      // The private, unlocked forms: this is the *game's* profile, not the
      // user's choice, so nothing is recorded — and the public methods would
      // deadlock, since handleGameLaunch already holds the lock.
      if (payload.mode === "manual" && typeof payload.speed === "number") {
        await this.applyUserFanSpeed(payload.speed);
      } else {
        await this.applyUserFanMode(payload.mode);
      }
      console.log(
        `[fan-control] Applied per-game profile for ${ctx.gameName || `App ${ctx.appId}`}: ${payload.mode}` +
          (payload.mode === "manual" && typeof payload.speed === "number"
            ? ` ${payload.speed}%`
            : ""),
      );
    },
    onRestore: async (snap) => {
      // Re-apply the user's *current* global choice, not a copy taken at
      // launch: a preset or custom curve has to come back as a running curve,
      // which a mode+speed snapshot can't express — and reading the live
      // intent means a mode changed mid-game survives the game exiting.
      // Not a user choice, so nothing is written to storage.
      if (this.globalModeIntent) {
        await this.applyGlobalMode(this.globalModeIntent);
        return;
      }
      if (snap.mode === "manual" && typeof snap.speed === "number") {
        await this.applyUserFanSpeed(snap.speed);
      } else {
        await this.applyUserFanMode("auto");
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

    // Load the user's saved custom curve so the graph editor and any
    // applyCustomCurve call have it ready. Sanitised on read — storage is
    // user-editable JSON, so we never trust the shape.
    try {
      const stored = await readPluginStorage<{ customCurve?: unknown }>(PLUGIN_ID);
      if (stored.customCurve !== undefined) {
        this.customCurve = sanitiseCurve(stored.customCurve);
      }
    } catch (err) {
      console.error("[fan-control] Failed to load custom curve:", err);
    }

    // Kernel modules like oxpec can be loaded after user services start.
    // If the first scan misses them, keep retrying every 30s until fan
    // hardware shows up, so we don't stay broken until the next restart.
    this.hardwareScanner = createRetryScanner({
      label: "fan-control",
      scan: () => this.scanHardware(),
      intervalMs: 30_000,
      onFound: async () => {
        // Restore before the first emit so the UI's opening state already
        // reflects the saved mode rather than the driver's power-on default.
        await this.restoreGlobalMode();
        this.emit?.({ event: "fan-update", data: await this.getFanInfo() });
      },
    });
    await this.hardwareScanner.start();

    // scanHardware() reports "found" only for a hwmon PWM or RPM-target
    // device — deliberately not for ectool (see its comment). So on a host
    // where ectool is the only write path, onFound never fires and the
    // restore above never runs, while every user choice still persists.
    // restoreGlobalMode's own guard makes the double call a no-op.
    if (this.useEctool) await this.restoreGlobalMode();

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
    // stopCurveLoop, not a bare clearInterval: a tick already queued on the
    // op lock survives clearInterval, and would otherwise pass its generation
    // check and write pwm_enable=1 plus a duty *after* restoreOriginalModes
    // had handed the fan back — leaving it pinned in manual with no loop.
    this.stopCurveLoop();
    this.activePreset = null;
    this.customCurveActive = false;
    this.hardwareScanner?.stop();

    // Drain: anything mid-flight finishes before we restore, so the teardown
    // is the last writer rather than racing one.
    await this._serialize(async () => {});

    // Safety: restore auto mode on unload
    await this.restoreOriginalModes();

    // RPM-target devices: ensure Valve's jupiter-fan-control daemon is
    // running again even if the user left us in manual or a curve was
    // active. systemctl start on an already-running unit is a no-op, so
    // this is safe to call unconditionally on devices that have the
    // service; non-Deck devices get a logged warning and no harm done.
    if (this.activeFanDevice?.hasRpmTargetControl) {
      await this.setJupiterFanControl(true);
    }

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

    // Pick the best fan device. Preference order:
    //   1. PWM + pwm_enable — the standard hwmon write path.
    //   2. fanN_target (RPM target) — the Steam Deck (steamdeck_hwmon) path.
    //   3. Any device with at least one fan (read-only — ectool may still
    //      provide a write path below).
    this.activeFanDevice =
      this.hwmonDevices.find((d) => d.hasPwmControl && d.fans.length > 0) ??
      this.hwmonDevices.find((d) => d.hasRpmTargetControl && d.fans.length > 0) ??
      this.hwmonDevices.find((d) => d.fans.length > 0) ??
      null;

    if (this.activeFanDevice && !this.fanDeviceLogged) {
      console.log(
        `[fan-control] Fan device: ${this.activeFanDevice.chipName} at ${this.activeFanDevice.dir} ` +
          `(${this.activeFanDevice.fans.length} fan(s), pwm=${this.activeFanDevice.hasPwmControl}, rpm-target=${this.activeFanDevice.hasRpmTargetControl})`,
      );
      await this.saveOriginalModes();
      this.fanDeviceLogged = true;
    }

    // Check for ectool availability as a fallback (only needed when hwmon
    // has neither direct PWM control nor an RPM-target write path).
    if (
      !this.activeFanDevice?.hasPwmControl &&
      !this.activeFanDevice?.hasRpmTargetControl &&
      !this.useEctool
    ) {
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

    // "Found" when ANY hwmon write path is available — PWM or RPM-target.
    // ectool alone is not enough to stop retries — see the OXP APEX race
    // where `which ectool` succeeds but the binary can't acquire the EC
    // lock, and oxpec's hwmon node registers milliseconds after plugin
    // init. RPM-target counts because it's a first-class write path
    // (steamdeck_hwmon).
    return (
      this.activeFanDevice?.hasPwmControl === true ||
      this.activeFanDevice?.hasRpmTargetControl === true
    );
  }

  // -----------------------------------------------------------------------
  // RPC Methods
  // -----------------------------------------------------------------------

  /** The "no controllable fan hardware" snapshot — returned when neither a
   *  hwmon device nor ectool is available, and as the fail-safe when a device
   *  we expected has gone away. */
  private unavailableFanInfo(): FanInfoResult {
    return {
      fans: [],
      mode: "unknown",
      temps: [],
      cpuTempC: 0,
      chipName: "none",
      fanCount: 0,
      available: false,
      activePreset: this.activePreset,
      customCurveActive: this.customCurveActive,
      usingEctool: false,
      reportsDuty: false,
      commandedPercent: null,
      warning: null,
      safetyEngaged: false,
    };
  }

  /** Returns comprehensive fan status. */
  /**
   * Record the user's global choice. Best-effort: a storage failure must not
   * fail the fan operation the user actually asked for, so it logs and
   * continues. mutatePluginStorage is used (not a bare write) so a concurrent
   * custom-curve save into the same file can't lost-update it.
   */
  private async persistGlobalMode(mode: GlobalFanMode): Promise<void> {
    this.globalModeIntent = mode;
    this.userChoseThisSession = true;
    try {
      await mutatePluginStorage<Record<string, unknown>>(PLUGIN_ID, (existing) => ({
        ...existing,
        globalMode: mode,
      }));
    } catch (err) {
      console.error("[fan-control] Failed to persist fan mode:", err);
    }
  }

  /**
   * Re-apply the persisted global choice. Called from the hardware
   * scanner's onFound, not from onLoad directly: a preset means writing
   * PWM, and on hosts where the driver module (oxpec and friends) lands
   * after our service starts there is nothing to write to yet.
   *
   * Deliberately does nothing when no mode was saved — an install that has
   * never chosen one keeps the pre-#265 behaviour of leaving the fans to
   * whatever the firmware set.
   */
  private async restoreGlobalMode(): Promise<void> {
    return this._serialize(() => this.restoreGlobalModeLocked());
  }

  private async restoreGlobalModeLocked(): Promise<void> {
    const via: "ectool" | "hwmon" =
      this.activeFanDevice?.hasPwmControl || this.activeFanDevice?.hasRpmTargetControl
        ? "hwmon"
        : "ectool";
    // hwmon is final; a second ectool pass has nothing new to say.
    if (this.restoredVia === "hwmon" || this.restoredVia === via) return;
    this.restoredVia = via;

    // A choice the user made this session outranks the stored one — but it
    // still has to be applied to a device that appeared afterwards. Bailing
    // outright here re-opened the very hole this method's tri-state closes:
    // the user taps Manual during the ectool window, the hwmon driver loads
    // 30s later, and nothing ever writes their duty to the device that ends
    // up owning the fan.
    let mode: GlobalFanMode | null;
    if (this.userChoseThisSession) {
      mode = this.globalModeIntent;
    } else {
      const stored = await readPluginStorage<{ globalMode?: unknown }>(PLUGIN_ID);
      mode = sanitiseGlobalMode(stored.globalMode);
      if (mode) this.globalModeIntent = mode;
    }
    if (!mode) return;

    // A game whose profile is already bound owns the fan. Restoring over it
    // would hand the fan back to the global curve mid-game; the intent
    // recorded above is what puts the user back on it at exit.
    if (this.profileEngine.getActiveAppId() !== null) {
      console.log(
        "[fan-control] Deferring saved-mode restore — a per-game profile is active",
      );
      return;
    }

    if (mode.kind === "manual" && mode.percent === null) {
      // "Manual" with no duty. Asserting it would stop Valve's
      // jupiter-fan-control on the RPM-target path without writing a target
      // to replace it — and that hardware has no safety watchdog either
      // (see safetyWatchdogTick's guard), so nothing would own the fan.
      // There is no duty worth restoring, so leave the firmware's default.
      console.log(
        "[fan-control] Saved mode is manual with no speed — leaving the fan as the firmware set it",
      );
      return;
    }

    await this.applyGlobalMode(mode);
  }

  /**
   * Re-assert a global mode without recording it — shared by the on-load
   * restore and by the per-game engine's onRestore when a game exits.
   *
   * Records nothing: neither caller is a fresh user choice, and writing here
   * would let a game exit overwrite what the user picked. Assumes the op
   * lock is held.
   */
  private async applyGlobalMode(mode: GlobalFanMode): Promise<void> {
    try {
      switch (mode.kind) {
        case "preset":
          console.log(`[fan-control] Restoring saved preset: ${mode.name}`);
          await this.applyPresetLocked(mode.name);
          break;
        case "custom":
          console.log("[fan-control] Restoring saved custom curve");
          await this.applyCustomCurveLocked();
          break;
        case "manual":
          console.log(
            `[fan-control] Restoring manual mode${mode.percent !== null ? ` at ${mode.percent}%` : ""}`,
          );
          if (mode.percent !== null) {
            await this.applyUserFanSpeed(mode.percent);
          } else {
            await this.applyUserFanMode("manual");
          }
          break;
        case "auto":
          console.log("[fan-control] Restoring auto mode");
          await this.applyUserFanMode("auto");
          break;
      }
    } catch (err) {
      console.error("[fan-control] Failed to apply fan mode:", err);
    }
  }

  /**
   * Run `fn` as the sole holder of the fan-operation lock. The next caller
   * waits on the promise we publish to `opLock`. We swap `opLock` before
   * awaiting the previous tail so the queue chains correctly even if several
   * callers arrive synchronously.
   */
  private async _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.opLock;
    let release: () => void = () => {};
    this.opLock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async getFanInfo(): Promise<FanInfoResult> {
    if (!this.activeFanDevice && !this.useEctool) {
      return this.unavailableFanInfo();
    }

    const temps = await this.getTemperatures();
    const cpuTemp = temps.find((t) => t.zone === "cpu");
    const cpuTempC = cpuTemp?.tempC ?? temps[0]?.tempC ?? 0;

    // Surface safety override state to the UI. Mirrors the thresholds
    // in safety-floor.ts so the warning chip lines up with what the
    // override is actually doing. Always include the release temp +
    // the "you can manually set higher" hint — the floor only RAISES,
    // never caps, so the user can crank fans above it.
    const releaseC =
      SAFETY_THRESHOLDS.WARM_C - SAFETY_THRESHOLDS.RELEASE_HYSTERESIS_C;
    let warning: string | null = null;
    if (cpuTempC >= SAFETY_THRESHOLDS.CRITICAL_C) {
      warning = `CRITICAL: ${Math.round(cpuTempC)}°C ≥ ${SAFETY_THRESHOLDS.CRITICAL_C}°C — fans forced to MAX to prevent thermal shutdown. Releases when CPU drops below ${releaseC}°C.`;
    } else if (cpuTempC >= SAFETY_THRESHOLDS.FORCE_MAX_C) {
      warning = `HOT: ${Math.round(cpuTempC)}°C ≥ ${SAFETY_THRESHOLDS.FORCE_MAX_C}°C — safety floor at 100%. Releases when CPU drops below ${releaseC}°C.`;
    } else if (cpuTempC >= SAFETY_THRESHOLDS.WARM_C) {
      warning = `WARM: ${Math.round(cpuTempC)}°C ≥ ${SAFETY_THRESHOLDS.WARM_C}°C — safety floor at ${SAFETY_THRESHOLDS.HOT_FLOOR_PCT}% (you can manually set higher). Releases when CPU drops below ${releaseC}°C.`;
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
        customCurveActive: this.customCurveActive,
        usingEctool: true,
        // ectool gives us RPM only; percent above is a placeholder.
        reportsDuty: false,
        commandedPercent: this.commandedPercent(),
        warning,
        safetyEngaged: this.safetyEngaged,
      };
    }

    // Unreachable: the both-null early return above and the ectool branch
    // (which fires whenever hasPwmControl is false — including when
    // activeFanDevice is null) guarantee a device here. Guard rather than
    // assert, degrading to the unavailable snapshot instead of crashing.
    const device = this.activeFanDevice;
    if (!device) {
      return this.unavailableFanInfo();
    }
    const fanReadings: FanInfoResult["fans"] = [];
    let mode: FanInfoResult["mode"] = "unknown";

    for (const fan of device.fans) {
      const rpm = await this.readIntFile(fan.inputPath).catch(() => 0);
      let pwm = 0;
      let percent = 0;

      if (fan.pwmPath) {
        pwm = await this.readIntFile(fan.pwmPath).catch(() => 0);
        percent = pwmToPercent(pwm);
      }

      if (fan.pwmEnablePath && mode === "unknown") {
        const modeRaw = await this.readIntFile(fan.pwmEnablePath).catch(() => -1);
        mode = parsePwmMode(modeRaw);
      }

      fanReadings.push({ index: fan.index, rpm, pwm, percent });
    }

    // RPM-target devices (e.g. steamdeck_hwmon) have no pwm_enable to
    // read the mode from — fall back to the user's last requested mode,
    // mirroring the ectool branch above. Without this the UI's
    // `sliderDisabled = mode !== "manual"` gate would stay permanently
    // disabled on the Deck even after the user clicked Manual.
    if (mode === "unknown" && device.hasRpmTargetControl) {
      mode = this.manualModeRequested ?? "auto";
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
      customCurveActive: this.customCurveActive,
      usingEctool: false,
      // Only a device with a pwm path reads its duty back; an RPM-target
      // device (steamdeck_hwmon) leaves percent at 0.
      reportsDuty: device.hasPwmControl === true,
      commandedPercent: this.commandedPercent(),
      warning,
      safetyEngaged: this.safetyEngaged,
    };
  }

  /** The duty last written to the fan, as a percent — the only duty figure
   *  available on hardware that can't report its own. */
  private commandedPercent(): number | null {
    return this.lastCommandedPwm === null ? null : pwmToPercent(this.lastCommandedPwm);
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
  /**
   * Set a manual fan duty. `persist` is false for writes we make on the
   * user's behalf (per-game profiles, restoring a saved mode) so they can't
   * be mistaken for a new global choice — see {@link persistGlobalMode}.
   */
  async setFanSpeed(percent: number): Promise<{ success: boolean; error?: string }> {
    return this._serialize(async () => {
      // The *requested* percent, not the safety-floor-raised one applied in
      // applyUserFanSpeed: baking a hot-moment override into the saved
      // preference would have the user come back to fans they never asked for.
      await this.persistGlobalMode({
        kind: "manual",
        percent: clampPercent(percent),
      });
      return this.applyUserFanSpeed(percent);
    });
  }

  /** The user-facing write: safety floor, curve-loop teardown, mode flip.
   *  Distinct from setFanSpeedInternal below, which is the bare duty write
   *  the safety watchdog and curve loop use. */
  private async applyUserFanSpeed(percent: number): Promise<{ success: boolean; error?: string }> {
    // Safety override (issue #97): user's value first, then the floor
    // can only RAISE it. Fails safe to 100% on any temp-read error.
    const safePercent = await this.applySafetyFloor(percent);
    const clamped = clampPercent(safePercent);
    const pwmValue = percentToPwm(clamped);

    // Stop any active curve loop
    this.stopCurveLoop();
    this.activePreset = null;
    this.customCurveActive = false;
    // Setting a specific speed implies manual mode.
    this.manualModeRequested = "manual";
    this.lastUserSpeedPwm = pwmValue;
    // Also the last commanded duty — this path writes the fan directly
    // rather than going through setFanSpeedInternal.
    this.lastCommandedPwm = pwmValue;

    // RPM-target path (steamdeck_hwmon): stop Valve's jupiter-fan-control
    // daemon first so our write isn't overwritten by its PID loop within
    // ~2s, then write fanN_target. Take this branch before ectool so the
    // Deck doesn't fall through to a path that doesn't apply.
    if (
      !this.activeFanDevice?.hasPwmControl &&
      this.activeFanDevice?.hasRpmTargetControl
    ) {
      await this.setJupiterFanControl(false);
      const res = await this.setFanSpeedViaRpmTarget(clamped);
      if (res.success) {
        console.log(
          `[fan-control] Set fan target to ${this.percentToRpmTarget(clamped)} RPM (${clamped}%)`,
        );
      }
      return res;
    }

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

  /** Sets fan mode: "auto" (kernel-controlled) or "manual" (user-controlled).
   *  See {@link setFanSpeed} for what `persist` is doing here. */
  async setFanMode(mode: "auto" | "manual"): Promise<{ success: boolean; error?: string }> {
    return this._serialize(async () => {
      await this.persistGlobalMode(
        mode === "auto"
          ? { kind: "auto" }
          : {
              kind: "manual",
              // Flipping to manual without naming a speed carries the duty
              // the *user* last asked for. Read from the recorded intent,
              // never from what was last written to hardware — that includes
              // a per-game profile's duty and the safety floor.
              percent:
                this.globalModeIntent?.kind === "manual"
                  ? this.globalModeIntent.percent
                  : null,
            },
      );
      return this.applyUserFanMode(mode);
    });
  }

  private async applyUserFanMode(
    mode: "auto" | "manual",
  ): Promise<{ success: boolean; error?: string }> {
    // Both directions end curve control: "auto" hands the fan to the
    // kernel/EC, "manual" hands it to the user's own duty. Leaving the loop
    // running under "manual" meant tapping Manual while a preset was active
    // rewrote storage to {manual, ...} while the preset kept driving the fan
    // and the UI kept showing it selected.
    this.stopCurveLoop();
    this.activePreset = null;
    this.customCurveActive = false;
    this.manualModeRequested = mode;
    // In auto the EC owns the duty; a stale figure here would have the UI
    // showing a fabricated value for a fan we are no longer driving.
    if (mode === "auto") this.lastCommandedPwm = null;

    // RPM-target path: no pwm_enable to flip — "manual" means we own
    // fan1_target, "auto" means hand it back to Valve's daemon.
    if (
      !this.activeFanDevice?.hasPwmControl &&
      this.activeFanDevice?.hasRpmTargetControl
    ) {
      await this.setJupiterFanControl(mode === "auto");
      console.log(
        `[fan-control] Set fan mode to ${mode} (jupiter-fan-control ${mode === "auto" ? "started" : "stopped"})`,
      );
      return { success: true };
    }

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
  async applyPreset(name: PresetName): Promise<{ success: boolean; error?: string }> {
    if (!FAN_CURVES[name]) {
      return { success: false, error: `Unknown preset: ${name}` };
    }
    return this._serialize(async () => {
      // Persist before applying: the record is of what the user chose, which
      // stands whether or not the hardware write then succeeds.
      await this.persistGlobalMode({ kind: "preset", name });
      return this.applyPresetLocked(name);
    });
  }

  /** Apply a preset without recording it. Assumes the op lock is held. */
  private async applyPresetLocked(
    name: PresetName,
  ): Promise<{ success: boolean; error?: string }> {
    const curve = FAN_CURVES[name];
    if (!curve) return { success: false, error: `Unknown preset: ${name}` };
    console.log(`[fan-control] Applying preset: ${name}`);

    // Set to manual mode first
    const modeResult = await this.setFanModeInternal("manual");
    if (!modeResult.success) return modeResult;

    await this.applyCurve(curve);

    // Flags and the loop are set together, in one synchronous block with no
    // await between them. The safety watchdog skips its own write whenever
    // either flag is set, on the understanding that the curve loop owns the
    // fan — and it runs on a timer outside this lock, so a flag set with no
    // loop running would mute the safety floor entirely.
    this.activePreset = name;
    this.customCurveActive = false;
    this.startCurveLoop(curve);

    return { success: true };
  }

  // -----------------------------------------------------------------------
  // Custom fan curve (user-editable, graph editor)
  // -----------------------------------------------------------------------

  /** Returns the user's saved custom fan curve (always a valid curve). */
  async getCustomCurve(): Promise<FanCurvePoint[]> {
    return this.customCurve.map((p) => ({ ...p }));
  }

  /**
   * Persists a new custom curve. Input is sanitised (untrusted UI/storage
   * shape) before it's stored, so the returned curve is the canonical one
   * the caller should render. If the custom curve is the active control
   * mode, the curve loop is restarted so edits take effect immediately.
   */
  async setCustomCurve(
    points: unknown,
  ): Promise<{ success: boolean; error?: string; curve: FanCurvePoint[] }> {
    return this._serialize(() => this.setCustomCurveLocked(points));
  }

  private async setCustomCurveLocked(
    points: unknown,
  ): Promise<{ success: boolean; error?: string; curve: FanCurvePoint[] }> {
    const curve = sanitiseCurve(points);
    this.customCurve = curve;

    try {
      // Serialized read-modify-write so a concurrent per-game-profile save
      // (same storage file) can't lost-update the curve, and vice versa.
      await mutatePluginStorage<Record<string, unknown>>(PLUGIN_ID, (existing) => ({
        ...existing,
        customCurve: curve,
      }));
    } catch (err) {
      console.error("[fan-control] Failed to persist custom curve:", err);
    }

    if (this.customCurveActive) {
      await this.applyCurve(curve);
      this.startCurveLoop(curve);
    }

    return { success: true, curve: curve.map((p) => ({ ...p })) };
  }

  /**
   * Makes the saved custom curve the active control mode. Same shape as
   * applyPreset — switch to manual, apply once, then run the curve loop.
   */
  async applyCustomCurve(): Promise<{ success: boolean; error?: string }> {
    return this._serialize(async () => {
      await this.persistGlobalMode({ kind: "custom" });
      return this.applyCustomCurveLocked();
    });
  }

  /** Apply the saved custom curve without recording it. Lock must be held. */
  private async applyCustomCurveLocked(): Promise<{ success: boolean; error?: string }> {
    const curve = this.customCurve;
    console.log("[fan-control] Applying custom fan curve");

    const modeResult = await this.setFanModeInternal("manual");
    if (!modeResult.success) return modeResult;

    await this.applyCurve(curve);

    // Same commit ordering as applyPresetLocked, for the same reason.
    this.activePreset = null;
    this.customCurveActive = true;
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
        let hasRpmTargetControl = false;

        // Check for fan1 through fan8
        for (let i = 1; i <= 8; i++) {
          const inputPath = `${dir}/fan${i}_input`;
          if (!fs.existsSync(inputPath)) continue;

          const pwmPath = fs.existsSync(`${dir}/pwm${i}`) ? `${dir}/pwm${i}` : null;
          const pwmEnablePath = fs.existsSync(`${dir}/pwm${i}_enable`) ? `${dir}/pwm${i}_enable` : null;

          if (pwmPath && pwmEnablePath) {
            hasPwmControl = true;
          }

          // fanN_target — drivers like steamdeck_hwmon expose this as a
          // writable target RPM instead of a standard pwmN. Only treat it
          // as controllable if the owner-write bit is set; some drivers
          // ship it as read-only.
          let rpmTargetPath: string | null = null;
          const rpmCandidate = `${dir}/fan${i}_target`;
          try {
            if (fs.existsSync(rpmCandidate)) {
              const stat = fs.statSync(rpmCandidate);
              if ((stat.mode & 0o200) !== 0) {
                rpmTargetPath = rpmCandidate;
                hasRpmTargetControl = true;
              }
            }
          } catch {
            // ignore — treat as not-writable
          }

          fans.push({ index: i, inputPath, pwmPath, pwmEnablePath, rpmTargetPath });
        }

        if (fans.length > 0) {
          devices.push({ dir, chipName, fans, hasPwmControl, hasRpmTargetControl });
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

          const zone = classifyTempZone(chipName, label);
          sensors.push({ inputPath, label, zone, chipName: chipName || entry });
        }
      }
    } catch (err) {
      console.error("[fan-control] Error scanning temp sensors:", err);
    }

    // Sort so CPU sensors come first, then GPU, then others. Within a zone,
    // prefer a real CPU die sensor (k10temp/coretemp/zenpower) over the
    // acpitz fallback — otherwise hwmon enumeration order decides, and acpitz
    // (a slow board sensor that lags the die by tens of degrees) wins on
    // AMD handhelds where it enumerates before k10temp.
    sensors.sort((a, b) => {
      const byZone = zoneSortWeight(a.zone) - zoneSortWeight(b.zone);
      if (byZone !== 0) return byZone;
      return cpuChipPriority(a.chipName) - cpuChipPriority(b.chipName);
    });

    return sensors;
  }

  // -----------------------------------------------------------------------
  // Fan curve logic
  // -----------------------------------------------------------------------

  /** Applies a fan curve once based on current temperature. */
  private async applyCurve(curve: FanCurvePoint[]): Promise<void> {
    const temps = await this.getTemperatures();
    const cpuTemp = temps.find((t) => t.zone === "cpu")?.tempC ?? temps[0]?.tempC ?? 0;
    let targetPercent = interpolateCurve(curve, cpuTemp);

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

    await this.setFanSpeedInternal(clampPercent(targetPercent));
  }

  /** Starts the curve evaluation loop (every 2 seconds). */
  private startCurveLoop(curve: FanCurvePoint[]): void {
    this.stopCurveLoop();
    const gen = ++this.curveGen;
    this.lastCurveWriteAt = Date.now();
    this.curveInterval = setInterval(() => {
      // Synchronous bail first: by the time a queued tick runs, the mode may
      // have changed and this curve is no longer the one driving the fan.
      if (!this.activePreset && !this.customCurveActive) return;
      // Ticks slower than the interval skip rather than pile up.
      if (this.curveTickBusy) return;
      this.curveTickBusy = true;
      void this._serialize(() => this.runCurveTick(gen, curve)).finally(() => {
        this.curveTickBusy = false;
      });
    }, 2000);
  }

  /** Stops the curve evaluation loop. */
  /** One curve tick. Runs under the op lock, so `gen` is re-checked here
   *  rather than at enqueue time — see {@link curveGen}. */
  private async runCurveTick(gen: number, curve: FanCurvePoint[]): Promise<void> {
    if (gen !== this.curveGen) return;
    await this.applyCurve(curve);
    this.lastCurveWriteAt = Date.now();
  }

  private stopCurveLoop(): void {
    // Bumped even when no interval is armed: a tick queued by a previous loop
    // may still be waiting on the lock, and this is what tells it to stand down.
    this.curveGen++;
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
    // RPM-target hardware (steamdeck_hwmon) is covered too: persisting a
    // manual mode means the fan can now come up unattended at boot with
    // jupiter-fan-control stopped, where before this plugin only held manual
    // while the user was in the UI. setFanSpeedInternal already routes to
    // setFanSpeedViaRpmTarget, so the floor reaches that hardware unchanged.
    if (
      !this.activeFanDevice?.hasPwmControl &&
      !this.activeFanDevice?.hasRpmTargetControl &&
      !this.useEctool
    ) {
      return;
    }

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

    this.safetyEngaged = true;

    // Curve loop is the authority on the fan write when a preset OR the
    // custom curve is active — it already calls applySafetyFloor on every
    // tick, and having the watchdog write in parallel races (curve writes
    // the curve target, watchdog writes the bare floor, fans flap). Just
    // flag engaged and let the curve loop do the write. (customCurveActive
    // matters because applyCustomCurve sets activePreset=null while still
    // running startCurveLoop.)
    //
    // Only while the loop is demonstrably still writing, though. Its write
    // goes through the op lock, so a stalled operation — a `tee` blocked on a
    // wedged EC, `systemctl stop` waiting out a unit timeout — silences it,
    // and deferring unconditionally would silence the safety floor with it.
    // This watchdog is deliberately outside the lock; that is worth nothing
    // if it hands its job to something that is inside.
    const curveWriting =
      Date.now() - this.lastCurveWriteAt < CURVE_STALE_MS;
    if ((this.activePreset !== null || this.customCurveActive) && curveWriting) {
      return;
    }

    // Manual mode (or pure-auto with no user intent): the watchdog is
    // the only periodic writer, so it owns the write here. Pass the
    // user's last-requested percent as userPercent so the floor RAISES
    // it (the contract of computeSafetyFloor) instead of capping it —
    // the user can still set fans ABOVE the floor.
    const userPct =
      this.lastUserSpeedPwm !== null
        ? pwmToPercent(this.lastUserSpeedPwm)
        : 0;
    const result = computeSafetyFloor(userPct, tempC);
    console.warn(
      `[fan-control] Safety watchdog engaging: temp=${tempC}°C — ` +
        `forcing fan to ${result.percent}% (${result.reason})`,
    );
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
    // Recorded for every writer, not just the user's — see lastCommandedPwm.
    this.lastCommandedPwm = percentToPwm(clampPercent(percent));
    const clamped = clampPercent(percent);
    const pwmValue = percentToPwm(clamped);

    // RPM-target (steamdeck_hwmon). The public setFanMode("manual") or
    // applyPreset() should already have stopped jupiter-fan-control, so
    // this hot path (curve loop / safety watchdog) just writes the target
    // RPM directly. Don't re-toggle the service from here — that's the
    // public path's responsibility.
    if (
      !this.activeFanDevice?.hasPwmControl &&
      this.activeFanDevice?.hasRpmTargetControl
    ) {
      return this.setFanSpeedViaRpmTarget(clamped);
    }

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

    // RPM-target (steamdeck_hwmon): manual = stop jupiter-fan-control,
    // auto = let it resume. Same shape as the public setFanMode branch.
    if (
      !this.activeFanDevice?.hasPwmControl &&
      this.activeFanDevice?.hasRpmTargetControl
    ) {
      await this.setJupiterFanControl(mode === "auto");
      return { success: true };
    }

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
  // RPM-target fallback (drivers without standard pwmN — Steam Deck)
  // -----------------------------------------------------------------------
  //
  // Aerith/Sephiroth fan range, empirically: 0–7000 RPM. The kernel may
  // clamp values below a hardware minimum but doesn't reject the write.
  // If we ever see a device with different limits we'll read them from
  // fanN_target_max/min, but steamdeck_hwmon doesn't expose those.
  private static readonly RPM_TARGET_MIN = 0;
  private static readonly RPM_TARGET_MAX = 7000;

  // Valve's userspace fan controller — runs a PID loop that re-writes
  // fan1_target every ~2s. To take manual control on the Deck we must
  // stop it (otherwise our writes get overwritten almost immediately).
  // Restarted on return to auto and on plugin unload. Best-effort: a
  // non-Deck device that happens to expose fanN_target won't have this
  // service, and systemctl will just return non-zero — we log and move on.
  private static readonly JUPITER_FAN_CONTROL = "jupiter-fan-control.service";

  private percentToRpmTarget(percent: number): number {
    const p = clampPercent(percent);
    return Math.round(
      FanControlBackend.RPM_TARGET_MIN +
        (p / 100) *
          (FanControlBackend.RPM_TARGET_MAX - FanControlBackend.RPM_TARGET_MIN),
    );
  }

  private async setJupiterFanControl(enabled: boolean): Promise<void> {
    const action = enabled ? "start" : "stop";
    try {
      await runCode([
        "systemctl",
        action,
        FanControlBackend.JUPITER_FAN_CONTROL,
      ]);
    } catch (err) {
      console.warn(
        `[fan-control] systemctl ${action} ${FanControlBackend.JUPITER_FAN_CONTROL} failed:`,
        err,
      );
    }
  }

  private async setFanSpeedViaRpmTarget(
    percent: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.activeFanDevice?.hasRpmTargetControl) {
      return { success: false, error: "No RPM-target control available" };
    }
    const targetRpm = this.percentToRpmTarget(percent);
    try {
      for (const fan of this.activeFanDevice.fans) {
        if (!fan.rpmTargetPath) continue;
        await this.writeHwmon(fan.rpmTargetPath, String(targetRpm));
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
      const digits = stdout.match(/(\d+)/)?.[1];
      return digits ? parseInt(digits, 10) : 0;
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

  /** Writes a value to a hwmon sysfs file via tee. The backend runs as
   *  root (system service), so no sudo/pkexec is needed. */
  private async writeHwmon(path: string, value: string): Promise<void> {
    // Bounded: a sysfs write to a wedged EC can block in the kernel, and this
    // runs under the op lock — an unbounded one would stall every fan
    // operation behind it for the life of the process, including the curve
    // loop the safety watchdog defers to.
    const { stderr, exitCode } = await runFull(["tee", path], {
      stdin: value,
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    if (exitCode !== 0) {
      throw new Error(`Failed to write "${value}" to ${path}: ${stderr.trim()}`);
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
          ? clampPercent(profile.speed)
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
  // Serialized here rather than inside PerGameEngine so the engine's
  // snapshot-then-apply is atomic against a user tap, and so a game *switch*
  // (exit of one, launch of the next — independent fire-and-forget chains
  // from the injector) can't interleave.
  async handleGameLaunch(appId: number, gameName: string): Promise<void> {
    await this._serialize(() => this.profileEngine.handleGameLaunch(appId, gameName));
  }

  async handleGameExit(appId: number): Promise<void> {
    await this._serialize(() => this.profileEngine.handleGameExit(appId));
  }

  private async captureModeSnapshot(): Promise<FanModeSnapshot> {
    const info = await this.getFanInfo();
    const mode = info.mode === "manual" ? "manual" : "auto";
    const percent = info.fans[0]?.percent ?? null;
    return { mode, speed: percent };
  }
}
