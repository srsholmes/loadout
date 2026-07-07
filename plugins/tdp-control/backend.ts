import type { PluginBackend, EmitPayload } from "@loadout/types";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runFull, commandExists } from "@loadout/exec";
import {
  createTdpProfileEngine,
  type TdpProfileEngine,
  type TdpProfile,
  type TdpProfileEngineState,
} from "./lib/tdp-profiles";
import {
  matchDevice,
  matchProfileName,
  PLATFORM_PROFILE_TDP_MAP,
  type CpuVendor,
} from "@loadout/devices";
import {
  readCustomDevice,
  writeCustomDevice,
  clearCustomDevice,
  validateCustomDevice,
  type CustomDevice,
} from "./lib/custom-device";

// ---------------------------------------------------------------------------
// Constants: sysfs paths
// ---------------------------------------------------------------------------

const DMI_PRODUCT_NAME = "/sys/class/dmi/id/product_name";
const CPUINFO_PATH = "/proc/cpuinfo";
const PLATFORM_PROFILE_PATH = "/sys/firmware/acpi/platform_profile";
const PLATFORM_PROFILE_CHOICES_PATH =
  "/sys/firmware/acpi/platform_profile_choices";
const SMT_PATH = "/sys/devices/system/cpu/smt/control";
const AMD_LEGACY_CPU_BOOST_PATH = "/sys/devices/system/cpu/cpufreq/boost";
const INTEL_CPU_BOOST_PATH = "/sys/devices/system/cpu/intel_pstate/no_turbo";
const CPU_ONLINE_PATH = "/sys/devices/system/cpu/online";

const INTEL_RAPL_PATHS = [
  "/sys/devices/virtual/powercap/intel-rapl-mmio/intel-rapl-mmio:0/constraint_0_power_limit_uw",
  "/sys/devices/virtual/powercap/intel-rapl/intel-rapl:0/constraint_0_power_limit_uw",
  "/sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw",
];

const ROG_ALLY_WMI_PATHS = {
  legacy: {
    fppt: "/sys/devices/platform/asus-nb-wmi/ppt_fppt",
    sppt: "/sys/devices/platform/asus-nb-wmi/ppt_pl2_sppt",
    spl: "/sys/devices/platform/asus-nb-wmi/ppt_pl1_spl",
  },
  armoury: {
    fppt: "/sys/class/firmware-attributes/asus-armoury/attributes/ppt_fppt/current_value",
    sppt: "/sys/class/firmware-attributes/asus-armoury/attributes/ppt_pl2_sppt/current_value",
    spl: "/sys/class/firmware-attributes/asus-armoury/attributes/ppt_pl1_spl/current_value",
  },
};

const LEGION_GO_WMI_PATHS = {
  fppt: "/sys/class/firmware-attributes/lenovo-wmi-other-0/attributes/ppt_pl3_fppt/current_value",
  sppt: "/sys/class/firmware-attributes/lenovo-wmi-other-0/attributes/ppt_pl2_sppt/current_value",
  spl: "/sys/class/firmware-attributes/lenovo-wmi-other-0/attributes/ppt_pl1_spl/current_value",
};

const CHARGE_LIMIT_PATH =
  "/sys/class/power_supply/BAT0/charge_control_end_threshold";

// ---------------------------------------------------------------------------
// Enums (the device database + matching live in @loadout/devices)
// ---------------------------------------------------------------------------

type TdpMethod = "ryzenadj" | "intel-rapl" | "platform_profile" | "wmi" | "none";

/** How we obtained the current TDP reading. */
type TdpReadSource = "read" | "tracked" | "estimated";

interface GpuInfo {
  vendor: "AMD" | "Intel" | "Unknown";
  minFreqMhz: number;
  maxFreqMhz: number;
  currentMode: string;
  cardPath: string | null;
}

type GpuMode = "auto" | "high" | "low" | "manual";

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

async function readFileText(path: string): Promise<string | null> {
  // No explicit `file.exists()` gate — /proc pseudo-files report stat size 0
  // and Bun's `.exists()` short-circuits to false on them, which is why
  // `/proc/cpuinfo` reads as null and `cpuVendor` ends up "Unknown" on
  // every device. Letting `.text()` throw on a genuinely missing file is
  // both simpler and one fewer syscall.
  try {
    return (await Bun.file(path).text()).trim();
  } catch {
    return null;
  }
}

async function writeSysfs(path: string, value: string): Promise<void> {
  // The backend runs as root (system service), so a direct write to the
  // sysfs node succeeds — no sudo/pkexec. `tee` is a fallback for the rare
  // node that rejects a plain write() but accepts a fresh open via tee.
  try {
    await Bun.write(path, value);
    return;
  } catch {
    // fall through to tee
  }
  const { stderr, exitCode } = await runFull(["tee", path], { stdin: value });
  if (exitCode !== 0) {
    throw new Error(`Failed to write ${path}: ${stderr}`);
  }
}

const runCommand = runFull;

/**
 * Quick CPU-vendor probe — duplicates the work `detectCpu()` does later, but
 * we need to know the vendor inside `detectMethod()` (which runs first) so we
 * don't try `ryzenadj` on an Intel CPU. The full `detectCpu()` also fills in
 * model + writes to `this.cpuVendor`; this helper is just a local read.
 */
async function isAmdCpu(): Promise<boolean> {
  try {
    const t = await Bun.file(CPUINFO_PATH).text();
    return /\bAuthenticAMD\b/.test(t);
  } catch {
    return false;
  }
}

/**
 * Resolve the bundled `ryzenadj` binary shipped with this plugin, if one is
 * present for the current architecture. Returns the absolute path or `null`.
 *
 * Convention (see docs/plugin-development.md / `bundled_bins` in plugin.json):
 *   plugins/<id>/bin/<linux-x64|linux-arm64>/<binary>
 *
 * We try multiple candidates because the plugin's backend.ts is bundled at
 * runtime by the loadout server (Bun.build → `.cache/backend.bundle.js`),
 * so `import.meta.dir` doesn't reliably point at the plugin root:
 *   1. PLUGINS_DIR/tdp-control/bin/<arch>/ryzenadj — production install
 *      (the unit sets PLUGINS_DIR=~/.local/share/loadout/plugins).
 *   2. <import.meta.dir>/../bin/<arch>/ryzenadj — bundled output in
 *      .cache/backend.bundle.js (parent is the plugin root).
 *   3. <import.meta.dir>/bin/<arch>/ryzenadj — source tree, no bundling.
 */
function resolveBundledRyzenadj(): string | null {
  const arch = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  const pluginsDir = process.env.PLUGINS_DIR;
  const candidates = [
    pluginsDir
      ? join(pluginsDir, "tdp-control", "bin", arch, "ryzenadj")
      : null,
    join(import.meta.dir, "..", "bin", arch, "ryzenadj"),
    join(import.meta.dir, "bin", arch, "ryzenadj"),
  ].filter((p): p is string => p !== null);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Parse /sys/devices/system/cpu/online into a list of CPU numbers.
 * Handles ranges like "0-15" and comma-separated values like "0-2,4,6-8".
 */
async function getOnlineCpus(): Promise<number[]> {
  const text = await readFileText(CPU_ONLINE_PATH);
  if (!text) return [0];
  const result: number[] = [];
  for (const part of text.split(",")) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let i = start; i <= end; i++) result.push(i);
    } else {
      result.push(Number(part));
    }
  }
  return result.length > 0 ? result : [0];
}

// ---------------------------------------------------------------------------
// Types exposed via RPC
// ---------------------------------------------------------------------------

interface TdpInfo {
  currentTdp: number | null;
  /** How the current TDP was obtained. */
  tdpReadSource: TdpReadSource;
  minWatts: number;
  /** TDP ceiling that currently applies (power-state aware). */
  maxWatts: number;
  /** Full ceiling when plugged into AC. */
  pluggedMaxWatts: number;
  /** Ceiling when on battery (<= pluggedMaxWatts). */
  batteryMaxWatts: number;
  platform: string;
  deviceName: string;
  method: TdpMethod;
  profiles: Record<string, number>;
  activeProfile: string | null;
  cpuVendor: CpuVendor;
  cpuModel: string;
  scalingDriver: string;
  platformProfile: string | null;
  platformProfileChoices: string[];
  eppOptions: string[];
  currentEpp: string | null;
  governorOptions: string[];
  currentGovernor: string | null;
  supportsSmt: boolean;
  supportsCpuBoost: boolean;
  /** Whether the active device is a user-defined custom device (vs auto-detected). */
  usingCustomDevice: boolean;
  gpuInfo: GpuInfo | null;
  smtEnabled: boolean | null;
  cpuBoostEnabled: boolean | null;
  acPowerOnline: boolean | null;
  chargeLimitPercent: number | null;
}

interface SystemInfo {
  deviceName: string;
  dmiProductName: string;
  cpuVendor: CpuVendor;
  cpuModel: string;
  scalingDriver: string;
  tdpMethod: TdpMethod;
  platformProfile: string | null;
  platformProfileChoices: string[];
  eppOptions: string[];
  governorOptions: string[];
  supportsSmt: boolean;
  supportsCpuBoost: boolean;
  ryzenadjAvailable: boolean;
  intelRaplAvailable: boolean;
  ryzenadjCanRead: boolean;
  gpuVendor: "AMD" | "Intel" | "Unknown";
  supportsGpuControl: boolean;
  supportsChargeLimit: boolean;
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

export default class TdpControlBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  // Device & CPU detection cache
  private dmiProductName = "Unknown";
  private deviceName = "Unknown";
  private cpuVendor: CpuVendor = "Unknown";
  private cpuModel = "Unknown";
  /**
   * User-defined device override. When set it takes precedence over DMI
   * auto-detection for the TDP range + presets. Loaded on startup and
   * mutated by the setCustomDevice/clearCustomDevice RPCs. Only one is ever
   * stored — this is a single override, not a profiles feature.
   */
  private customDevice: CustomDevice | null = null;

  // TDP method & state
  private method: TdpMethod = "none";
  private minWatts = 5;
  /** Max TDP when plugged into AC (the device's full ceiling). */
  private maxWatts = 35;
  /** Max TDP when on battery (<= maxWatts). See effectiveMaxWatts(). */
  private batteryMaxWatts = 35;
  private profiles: Record<string, number> = {
    Silent: 10,
    Balanced: 18,
    Performance: 35,
  };
  private currentTdp: number | null = null;
  /**
   * The last *requested* wattage, stored unclamped — the standing intent.
   * setTdp() applies a power-state-clamped value to hardware but remembers
   * the raw request here so an AC transition can re-apply it (clamp down on
   * battery, spring back up on AC) without ever mutating saved profiles.
   */
  private desiredTdp: number | null = null;
  private tdpReadSource: TdpReadSource = "estimated";
  private activeProfile: string | null = null;
  private trackedTdp: number | null = null;

  // Capabilities
  private ryzenadjAvailable = false;
  private ryzenadjCanRead = false;
  /**
   * Path used to exec ryzenadj. Either the bundled binary
   * (plugins/tdp-control/bin/<arch>/ryzenadj) or "ryzenadj" if it's on
   * $PATH from a system install (Bazzite, Arch with AUR, etc.). Set by
   * detectMethod(); used by setTdpViaRyzenadj() + testRyzenadjRead().
   */
  private ryzenadjPath = "ryzenadj";
  private intelRaplPath: string | null = null;
  private scalingDriver = "";
  private platformProfile: string | null = null;
  private platformProfileChoices: string[] = [];
  private eppOptions: string[] = [];
  private governorOptions: string[] = [];
  private supportsSmt = false;
  private supportsCpuBoost = false;

  private pollInterval?: Timer;

  // WMI TDP paths (for ROG Ally / Legion Go)
  private wmiPaths: { fppt: string; sppt: string; spl: string } | null = null;

  // CPU boost detection
  private cpuBoostPath: string | null = null;

  // GPU control
  private gpuCardPath: string | null = null;
  private gpuVendor: "AMD" | "Intel" | "Unknown" = "Unknown";

  // AC power monitoring
  private acPowerOnline: boolean | null = null;
  private acPowerPath: string | null = null;

  // Per-game TDP profile engine
  private profileEngine?: TdpProfileEngine;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async onLoad(): Promise<void> {
    console.log("[tdp-control] Loading...");

    await Promise.all([
      this.detectDevice(),
      this.detectCpuInfo(),
    ]);

    // Load the user's custom device (if any) BEFORE applying defaults so it
    // takes precedence over DMI auto-detection.
    this.customDevice = await readCustomDevice("tdp-control");

    // Apply device-specific ranges (custom device wins when present)
    this.applyDeviceDefaults();

    // Detect capabilities in parallel
    await Promise.all([
      this.detectTdpMethod(),
      this.detectScalingDriver(),
      this.detectPlatformProfile(),
      this.detectSmtSupport(),
      this.detectCpuBoostSupport(),
      this.detectGpu(),
      this.detectAcPower(),
    ]);

    // After scaling driver is known, detect EPP/governor options
    await Promise.all([
      this.detectEppOptions(),
      this.detectGovernorOptions(),
    ]);

    // Read initial TDP
    const initialReading = await this.readCurrentTdp();
    if (initialReading !== null) {
      this.currentTdp = initialReading.watts;
      this.tdpReadSource = initialReading.source;
    } else {
      // Fall back to silent profile value (conservative default)
      this.currentTdp = this.profiles["Silent"];
      this.tdpReadSource = "estimated";
    }
    this.activeProfile = this.matchProfile(this.currentTdp);

    // Start polling (always — even if we can only track, we still want
    // to detect platform_profile changes)
    this.pollInterval = setInterval(() => this.pollTdp(), 5000);

    // Initialize per-game TDP profile engine. Storage lives at
    // ~/.config/loadout/plugins/tdp-control.json via the inlined
    // plugin-storage helper.
    this.profileEngine = createTdpProfileEngine({
      pluginId: "tdp-control",
      onApplyTdp: async (watts: number) => {
        await this.setTdp(watts);
      },
      onProfileChanged: (profile: TdpProfile | null, gameName: string) => {
        this.emit?.({
          event: "gameProfileChanged",
          data: {
            profile,
            gameName,
            state: this.profileEngine?.getCurrentState() ?? null,
          },
        });
      },
    });
    await this.profileEngine.loadProfiles();
    console.log("[tdp-control] Per-game TDP profile engine initialized");

    // Apply the profile engine's default TDP on startup when we can't
    // directly read the hardware (estimated/fallback) AND per-game
    // profiles is enabled. Otherwise leave the user's manual TDP alone.
    if (
      this.tdpReadSource === "estimated" &&
      this.method !== "none" &&
      this.profileEngine.getPerGameEnabled()
    ) {
      const defaultTdp = this.profileEngine.getDefaultTdp();
      console.log(
        `[tdp-control] Applying default TDP ${defaultTdp}W (source was estimated, per-game enabled)`,
      );
      await this.setTdp(defaultTdp);
    }

    console.log(
      `[tdp-control] Loaded: device=${this.deviceName}, cpu=${this.cpuVendor} ${this.cpuModel}, method=${this.method}, range=${this.minWatts}-${this.maxWatts}W, driver=${this.scalingDriver}`,
    );
  }

  async onUnload(): Promise<void> {
    if (this.pollInterval) clearInterval(this.pollInterval);
    console.log("[tdp-control] Unloaded");
  }

  // -----------------------------------------------------------------------
  // RPC: getTdpInfo
  // -----------------------------------------------------------------------

  async getTdpInfo(): Promise<TdpInfo> {
    // Refresh live readings
    const reading = await this.readCurrentTdp();
    if (reading !== null) {
      this.currentTdp = reading.watts;
      this.tdpReadSource = reading.source;
      this.activeProfile = this.matchProfile(this.currentTdp);
    }

    // Refresh volatile state
    await this.detectPlatformProfile();
    const currentEpp = await this.readCurrentEpp();
    const currentGovernor = await this.readCurrentGovernor();

    // Read additional state for new fields
    const [gpuInfo, smtEnabled, cpuBoostEnabled, chargeLimitPercent] =
      await Promise.all([
        this.readGpuInfo(),
        this.readSmtEnabled(),
        this.readCpuBoostEnabled(),
        this.readChargeLimit(),
      ]);

    return {
      currentTdp: this.currentTdp,
      tdpReadSource: this.tdpReadSource,
      minWatts: this.minWatts,
      // Report the cap that currently applies so the UI slider bound reflects
      // power state immediately on load. pluggedMaxWatts/batteryMaxWatts let
      // the UI explain the two ceilings.
      maxWatts: this.effectiveMaxWatts(),
      pluggedMaxWatts: this.maxWatts,
      batteryMaxWatts: this.batteryMaxWatts,
      platform: this.dmiProductName,
      deviceName: this.deviceName,
      method: this.method,
      profiles: { ...this.profiles },
      activeProfile: this.activeProfile,
      cpuVendor: this.cpuVendor,
      cpuModel: this.cpuModel,
      scalingDriver: this.scalingDriver,
      platformProfile: this.platformProfile,
      platformProfileChoices: [...this.platformProfileChoices],
      eppOptions: [...this.eppOptions],
      currentEpp,
      governorOptions: [...this.governorOptions],
      currentGovernor,
      supportsSmt: this.supportsSmt,
      supportsCpuBoost: this.supportsCpuBoost,
      usingCustomDevice: this.customDevice !== null,
      gpuInfo,
      smtEnabled,
      cpuBoostEnabled,
      acPowerOnline: this.acPowerOnline,
      chargeLimitPercent,
    };
  }

  // -----------------------------------------------------------------------
  // RPC: setTdp
  // -----------------------------------------------------------------------

  async setTdp(
    watts: number,
  ): Promise<{ success: boolean; error?: string }> {
    watts = Math.round(watts);

    if (this.method === "none") {
      return {
        success: false,
        error: "No TDP control method available on this system",
      };
    }

    // Remember the raw intent (within the device's absolute range) so an AC
    // transition can re-apply it — clamp down on battery, spring back up on
    // AC — without mutating any saved profile.
    this.desiredTdp = Math.max(this.minWatts, Math.min(this.maxWatts, watts));

    // The cap takes precedence over the request: on battery a saved/requested
    // 70W lands at the battery cap, not refused. Clamp (don't reject) so the
    // auto-apply path (per-game profiles, defaults) always writes *something*.
    const applied = Math.max(
      this.minWatts,
      Math.min(this.effectiveMaxWatts(), watts),
    );

    try {
      if (this.method === "wmi") {
        await this.setTdpViaWmi(applied);
      } else if (this.method === "ryzenadj") {
        await this.setTdpViaRyzenadj(applied);
      } else if (this.method === "intel-rapl") {
        await this.setTdpViaIntelRapl(applied);
      } else if (this.method === "platform_profile") {
        // platform_profile is coarse — pick closest profile name
        const profileName = this.wattsToPlatformProfile(applied);
        await writeSysfs(PLATFORM_PROFILE_PATH, profileName);
        await this.detectPlatformProfile();
      }

      // Track the value we actually applied (clamped), not the raw request.
      this.trackedTdp = applied;
      this.currentTdp = applied;
      this.tdpReadSource = "tracked";
      this.activeProfile = this.matchProfile(applied);

      this.emit?.({
        event: "tdpChanged",
        data: {
          currentTdp: applied,
          activeProfile: this.activeProfile,
          tdpReadSource: this.tdpReadSource,
        },
      });

      console.log(`[tdp-control] TDP set to ${applied}W via ${this.method}`);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[tdp-control] Failed to set TDP: ${msg}`);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // RPC: getProfiles
  // -----------------------------------------------------------------------

  async getProfiles(): Promise<Record<string, number>> {
    return { ...this.profiles };
  }

  // -----------------------------------------------------------------------
  // RPC: applyProfile
  // -----------------------------------------------------------------------

  async applyProfile(
    name: string,
  ): Promise<{ success: boolean; error?: string }> {
    const watts = this.profiles[name];
    if (watts === undefined) {
      return { success: false, error: `Unknown profile: ${name}` };
    }
    return this.setTdp(watts);
  }

  // -----------------------------------------------------------------------
  // RPC: getSystemInfo
  // -----------------------------------------------------------------------

  async getSystemInfo(): Promise<SystemInfo> {
    await this.detectPlatformProfile();
    const supportsChargeLimit =
      (await readFileText(CHARGE_LIMIT_PATH)) !== null;
    return {
      deviceName: this.deviceName,
      dmiProductName: this.dmiProductName,
      cpuVendor: this.cpuVendor,
      cpuModel: this.cpuModel,
      scalingDriver: this.scalingDriver,
      tdpMethod: this.method,
      platformProfile: this.platformProfile,
      platformProfileChoices: [...this.platformProfileChoices],
      eppOptions: [...this.eppOptions],
      governorOptions: [...this.governorOptions],
      supportsSmt: this.supportsSmt,
      supportsCpuBoost: this.supportsCpuBoost,
      ryzenadjAvailable: this.ryzenadjAvailable,
      intelRaplAvailable: this.intelRaplPath !== null,
      ryzenadjCanRead: this.ryzenadjCanRead,
      gpuVendor: this.gpuVendor,
      supportsGpuControl: this.gpuCardPath !== null,
      supportsChargeLimit,
    };
  }

  // -----------------------------------------------------------------------
  // RPC: Custom device
  // -----------------------------------------------------------------------

  /** The user's custom device override, or null when auto-detecting. */
  async getCustomDevice(): Promise<CustomDevice | null> {
    return this.customDevice;
  }

  /**
   * Save a user-defined device. Once saved it becomes the DEFAULT device the
   * plugin uses (its TDP range + presets), overriding auto-detection. Only a
   * single custom device is stored — saving again replaces it. To remove it,
   * the user clears it via clearCustomDevice().
   */
  async setCustomDevice(
    device: unknown,
  ): Promise<{ success: boolean; error?: string }> {
    const result = validateCustomDevice(device);
    if (!result.ok) {
      return { success: false, error: result.error };
    }
    try {
      await writeCustomDevice("tdp-control", result.device);
      this.customDevice = result.device;
      this.applyDeviceDefaults();
      await this.onDeviceConfigChanged();
      console.log(
        `[tdp-control] Custom device saved: ${result.device.name} (${result.device.minTdp}-${result.device.maxTdp}W)`,
      );
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  /** Remove the custom device, reverting to auto-detection. */
  async clearCustomDevice(): Promise<{ success: boolean; error?: string }> {
    try {
      await clearCustomDevice("tdp-control");
      this.customDevice = null;
      this.applyDeviceDefaults();
      await this.onDeviceConfigChanged();
      console.log("[tdp-control] Custom device cleared; reverting to auto-detection");
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  /**
   * Re-apply state after the active device changed (custom saved or cleared):
   * refresh the active-profile match, tell the UI the new range + presets,
   * and re-clamp the standing TDP into the new range on hardware.
   */
  private async onDeviceConfigChanged(): Promise<void> {
    this.activeProfile = this.matchProfile(this.currentTdp);
    this.emit?.({
      event: "deviceChanged",
      data: {
        deviceName: this.deviceName,
        minWatts: this.minWatts,
        maxWatts: this.effectiveMaxWatts(),
        profiles: { ...this.profiles },
        usingCustomDevice: this.customDevice !== null,
      },
    });
    // Re-apply the standing intent through the new clamp so a value now out of
    // range is corrected on hardware (setTdp emits its own tdpChanged).
    const intent = this.desiredTdp ?? this.currentTdp;
    if (intent !== null && this.method !== "none") {
      await this.setTdp(intent);
    }
  }

  // -----------------------------------------------------------------------
  // RPC: Per-game TDP profile methods
  // -----------------------------------------------------------------------

  /**
   * Get all per-game TDP profiles.
   * Note: This is different from getProfiles() which returns device power
   * presets (Silent/Balanced/Performance).
   */
  async getGameProfiles(): Promise<TdpProfile[]> {
    if (!this.profileEngine) return [];
    return this.profileEngine.getAllProfiles();
  }

  /** Create or update a per-game TDP profile. */
  async setGameProfile(
    appId: number,
    gameName: string,
    tdpWatts: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.profileEngine) {
      return { success: false, error: "Profile engine not initialized" };
    }
    try {
      await this.profileEngine.setProfile(appId, gameName, tdpWatts);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  /** Remove a per-game TDP profile. */
  async removeGameProfile(
    appId: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.profileEngine) {
      return { success: false, error: "Profile engine not initialized" };
    }
    try {
      await this.profileEngine.removeProfile(appId);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  /** Get the default TDP (used when no per-game profile applies). */
  async getGameDefaultTdp(): Promise<number> {
    return this.profileEngine?.getDefaultTdp() ?? 15;
  }

  /** Set the default TDP (used when no per-game profile applies). */
  async setGameDefaultTdp(
    watts: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.profileEngine) {
      return { success: false, error: "Profile engine not initialized" };
    }
    try {
      await this.profileEngine.setDefaultTdp(watts);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  /** Get the current profile engine state (active profile, current TDP, game running status). */
  async getCurrentProfileState(): Promise<TdpProfileEngineState | null> {
    return this.profileEngine?.getCurrentState() ?? null;
  }

  /** Whether per-game TDP profiles are enabled. */
  async getPerGameEnabled(): Promise<boolean> {
    return this.profileEngine?.getPerGameEnabled() ?? false;
  }

  /**
   * Toggle per-game TDP profiles on/off. When off, game launches don't
   * override the user's manual TDP; the engine still tracks the active
   * game so the UI can offer "save current TDP for this game".
   */
  async setPerGameEnabled(
    enabled: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.profileEngine) {
      return { success: false, error: "Profile engine not initialized" };
    }
    try {
      await this.profileEngine.setPerGameEnabled(enabled);
      this.emit?.({
        event: "perGameEnabledChanged",
        data: {
          enabled,
          state: this.profileEngine.getCurrentState(),
        },
      });
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  /**
   * Notify the engine that a game has launched.
   * NOTE: This is exposed as an RPC method for manual testing.
   * In production, this will be called automatically by SteamClient.GameSessions
   * events once the CEF bridge integration is done.
   */
  async handleGameLaunch(
    appId: number,
    gameName: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.profileEngine) {
      return { success: false, error: "Profile engine not initialized" };
    }
    try {
      await this.profileEngine.handleGameLaunch(appId, gameName);
      console.log(
        `[tdp-control] Game launched: appId=${appId}, name=${gameName}`,
      );
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  /**
   * Notify the engine that a game has exited.
   * NOTE: This is exposed as an RPC method for manual testing.
   * In production, this will be called automatically by SteamClient.GameSessions
   * events once the CEF bridge integration is done.
   */
  async handleGameExit(
    appId: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.profileEngine) {
      return { success: false, error: "Profile engine not initialized" };
    }
    try {
      await this.profileEngine.handleGameExit(appId);
      console.log(`[tdp-control] Game exited: appId=${appId}`);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // RPC: setEpp
  // -----------------------------------------------------------------------

  async setEpp(
    epp: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.eppOptions.includes(epp)) {
      return {
        success: false,
        error: `EPP value "${epp}" not available. Options: ${this.eppOptions.join(", ")}`,
      };
    }
    try {
      const cpus = await getOnlineCpus();
      for (const cpu of cpus) {
        const path = `/sys/devices/system/cpu/cpu${cpu}/cpufreq/energy_performance_preference`;
        await writeSysfs(path, epp);
      }
      console.log(`[tdp-control] EPP set to ${epp}`);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // RPC: setGovernor
  // -----------------------------------------------------------------------

  async setGovernor(
    governor: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.governorOptions.includes(governor)) {
      return {
        success: false,
        error: `Governor "${governor}" not available. Options: ${this.governorOptions.join(", ")}`,
      };
    }
    try {
      const cpus = await getOnlineCpus();
      for (const cpu of cpus) {
        const path = `/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_governor`;
        await writeSysfs(path, governor);
      }
      console.log(`[tdp-control] Governor set to ${governor}`);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // RPC: setPlatformProfile
  // -----------------------------------------------------------------------

  async setPlatformProfile(
    profile: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.platformProfileChoices.includes(profile)) {
      return {
        success: false,
        error: `Profile "${profile}" not available. Options: ${this.platformProfileChoices.join(", ")}`,
      };
    }
    try {
      await writeSysfs(PLATFORM_PROFILE_PATH, profile);
      this.platformProfile = profile;
      console.log(`[tdp-control] Platform profile set to ${profile}`);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // RPC: setSmt
  // -----------------------------------------------------------------------

  async setSmt(
    enable: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supportsSmt) {
      return {
        success: false,
        error: "SMT control is not supported on this system",
      };
    }
    try {
      await writeSysfs(SMT_PATH, enable ? "on" : "off");
      console.log(`[tdp-control] SMT set to ${enable ? "on" : "off"}`);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // RPC: setCpuBoost
  // -----------------------------------------------------------------------

  async setCpuBoost(
    enable: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.supportsCpuBoost || !this.cpuBoostPath) {
      return {
        success: false,
        error: "CPU boost control is not supported on this system",
      };
    }
    try {
      // Intel no_turbo is inverted: 0 = turbo ON, 1 = turbo OFF
      if (this.cpuBoostPath === INTEL_CPU_BOOST_PATH) {
        await writeSysfs(this.cpuBoostPath, enable ? "0" : "1");
      } else if (this.cpuBoostPath.includes("/policy")) {
        // AMD per-CPU boost: write to each online CPU's policy
        const cpus = await getOnlineCpus();
        for (const cpu of cpus) {
          const path = `/sys/devices/system/cpu/cpufreq/policy${cpu}/boost`;
          await writeSysfs(path, enable ? "1" : "0");
        }
      } else {
        // AMD legacy path
        await writeSysfs(this.cpuBoostPath, enable ? "1" : "0");
      }
      console.log(`[tdp-control] CPU boost set to ${enable ? "enabled" : "disabled"}`);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // RPC: GPU control
  // -----------------------------------------------------------------------

  async getGpuInfo(): Promise<GpuInfo | null> {
    return this.readGpuInfo();
  }

  async setGpuMode(
    mode: GpuMode,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.gpuCardPath) {
      return { success: false, error: "No GPU detected for mode control" };
    }
    if (this.gpuVendor === "Intel") {
      return {
        success: false,
        error: "GPU mode control is not applicable for Intel GPUs (use frequency range instead)",
      };
    }
    try {
      const perfLevelPath = `${this.gpuCardPath}/device/power_dpm_force_performance_level`;
      await writeSysfs(perfLevelPath, mode);
      console.log(`[tdp-control] GPU mode set to ${mode}`);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  async setGpuFreqRange(
    minMhz: number,
    maxMhz: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.gpuCardPath) {
      return { success: false, error: "No GPU detected for frequency control" };
    }
    try {
      if (this.gpuVendor === "AMD") {
        // Set manual mode first, then write frequency range
        const perfLevelPath = `${this.gpuCardPath}/device/power_dpm_force_performance_level`;
        const odClkPath = `${this.gpuCardPath}/device/pp_od_clk_voltage`;
        await writeSysfs(perfLevelPath, "manual");
        await writeSysfs(odClkPath, `s 0 ${minMhz}`);
        await writeSysfs(odClkPath, `s 1 ${maxMhz}`);
        await writeSysfs(odClkPath, "c");
      } else if (this.gpuVendor === "Intel") {
        await writeSysfs(`${this.gpuCardPath}/gt_min_freq_mhz`, String(minMhz));
        await writeSysfs(`${this.gpuCardPath}/gt_max_freq_mhz`, String(maxMhz));
      } else {
        return { success: false, error: "Unknown GPU vendor" };
      }
      console.log(`[tdp-control] GPU frequency range set to ${minMhz}-${maxMhz} MHz`);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // RPC: AC power status
  // -----------------------------------------------------------------------

  async getAcPowerStatus(): Promise<{ online: boolean | null }> {
    if (this.acPowerPath) {
      const text = await readFileText(this.acPowerPath);
      if (text !== null) {
        this.acPowerOnline = text.trim() === "1";
      }
    }
    return { online: this.acPowerOnline };
  }

  // -----------------------------------------------------------------------
  // RPC: Battery charge limit
  // -----------------------------------------------------------------------

  async getChargeLimit(): Promise<{ percent: number | null }> {
    const val = await this.readChargeLimit();
    return { percent: val };
  }

  async setChargeLimit(
    percent: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (percent < 20 || percent > 100) {
      return {
        success: false,
        error: "Charge limit must be between 20 and 100 percent",
      };
    }
    const exists = (await readFileText(CHARGE_LIMIT_PATH)) !== null;
    if (!exists) {
      return {
        success: false,
        error: "Charge limit control is not supported on this system",
      };
    }
    try {
      await writeSysfs(CHARGE_LIMIT_PATH, String(percent));
      console.log(`[tdp-control] Charge limit set to ${percent}%`);
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // RPC: Suspend/Resume handlers
  // -----------------------------------------------------------------------

  async onSuspend(): Promise<{ success: boolean; error?: string }> {
    try {
      // ROG Ally: force-enable SMT before suspend to prevent wake issues
      if (this.dmiProductName.includes("ROG Ally") && this.supportsSmt) {
        await writeSysfs(SMT_PATH, "on");
        console.log("[tdp-control] Forced SMT on before suspend (ROG Ally workaround)");
      }
      // Save current TDP state for restore on resume
      console.log(
        `[tdp-control] Suspend: saved TDP state (${this.trackedTdp}W, profile=${this.activeProfile})`,
      );
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  async onResume(): Promise<{ success: boolean; error?: string }> {
    try {
      // Wait for WMI paths to become writable (Legion Go needs ~2s)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Re-apply current TDP profile
      if (this.trackedTdp !== null) {
        await this.setTdp(this.trackedTdp);
        console.log(`[tdp-control] Resume: re-applied TDP ${this.trackedTdp}W`);
      }
      return { success: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, error: msg };
    }
  }

  // -----------------------------------------------------------------------
  // Detection helpers
  // -----------------------------------------------------------------------

  private async detectDevice(): Promise<void> {
    this.dmiProductName =
      (await readFileText(DMI_PRODUCT_NAME)) ?? "Unknown";
  }

  private async detectCpuInfo(): Promise<void> {
    const cpuinfo = await readFileText(CPUINFO_PATH);
    if (!cpuinfo) return;

    // Vendor
    const vendorMatch = cpuinfo.match(/vendor_id\s*:\s*(\S+)/);
    if (vendorMatch) {
      const raw = vendorMatch[1];
      if (raw === "AuthenticAMD") this.cpuVendor = "AMD";
      else if (raw === "GenuineIntel") this.cpuVendor = "Intel";
    }

    // Model name
    const modelMatch = cpuinfo.match(/model name\s*:\s*(.*)/);
    if (modelMatch) {
      this.cpuModel = modelMatch[1].trim();
    }
  }

  private applyDeviceDefaults(): void {
    // A user-defined custom device is the default when present — it overrides
    // whatever DMI matching would have picked.
    if (this.customDevice) {
      const d = this.customDevice;
      this.deviceName = d.name;
      this.minWatts = d.minTdp;
      this.maxWatts = d.maxTdp;
      this.batteryMaxWatts = d.batteryMaxTdp;
      this.profiles = { ...d.profiles };
      return;
    }
    const device = matchDevice(this.dmiProductName, this.cpuVendor);
    this.deviceName = device.name;
    this.minWatts = device.minTdp;
    this.maxWatts = device.maxTdp;
    this.batteryMaxWatts = device.batteryMaxTdp;
    this.profiles = { ...device.profiles };
  }

  /**
   * The TDP ceiling that currently applies, given power state. On battery we
   * cap lower to protect runtime/thermals; plugged in (or when AC state is
   * unknown — don't over-restrict) we allow the device's full max.
   */
  private effectiveMaxWatts(): number {
    return this.acPowerOnline === false ? this.batteryMaxWatts : this.maxWatts;
  }

  private async detectTdpMethod(): Promise<void> {
    // 0. Try WMI paths first (higher priority for known devices)
    if (this.dmiProductName.includes("ROG Ally")) {
      // Try armoury driver first (newer), then legacy asus-nb-wmi
      const armouryPaths = ROG_ALLY_WMI_PATHS.armoury;
      if ((await readFileText(armouryPaths.spl)) !== null) {
        this.wmiPaths = armouryPaths;
        this.method = "wmi";
        console.log("[tdp-control] ROG Ally WMI (armoury) paths detected");
        return;
      }
      const legacyPaths = ROG_ALLY_WMI_PATHS.legacy;
      if ((await readFileText(legacyPaths.spl)) !== null) {
        this.wmiPaths = legacyPaths;
        this.method = "wmi";
        console.log("[tdp-control] ROG Ally WMI (legacy) paths detected");
        return;
      }
    }
    if (this.dmiProductName.includes("Legion Go")) {
      if ((await readFileText(LEGION_GO_WMI_PATHS.spl)) !== null) {
        this.wmiPaths = LEGION_GO_WMI_PATHS;
        this.method = "wmi";
        console.log("[tdp-control] Legion Go WMI paths detected");
        return;
      }
    }

    // 1. Try ryzenadj (AMD only — it writes to the AMD SMU mailbox over
    //    MMIO; running it on an Intel CPU is a no-op-then-error). Prefer the
    //    bundled binary that ships with the plugin (built reproducibly from
    //    https://github.com/FlyGoat/RyzenAdj v0.19.0 via this plugin's build-ryzenadj.sh)
    //    so we work out-of-box on stock SteamOS where ryzenadj isn't packaged.
    //    Fall back to a system install on $PATH (Bazzite/Arch with AUR).
    const amd = await isAmdCpu();
    if (amd) {
      const bundled = resolveBundledRyzenadj();
      const onPath = await commandExists("ryzenadj");
      console.log(
        `[tdp-control] detect: AMD bundled=${bundled ?? "none"} PATH-ryzenadj=${onPath} PLUGINS_DIR=${process.env.PLUGINS_DIR ?? "unset"} import.meta.dir=${import.meta.dir}`,
      );
      if (bundled) {
        this.ryzenadjPath = bundled;
      } else if (onPath) {
        this.ryzenadjPath = "ryzenadj";
      } else {
        this.ryzenadjPath = "";
      }
      if (this.ryzenadjPath) {
        this.ryzenadjAvailable = true;
        // Test if ryzenadj can read (some platforms like Strix Halo cannot —
        // and Vangogh/Aerith on the Deck can't read STAPM via /dev/mem
        // either; writes still go through in both cases).
        this.ryzenadjCanRead = await this.testRyzenadjRead();
        this.method = "ryzenadj";
        console.log(
          `[tdp-control] ryzenadj available at ${this.ryzenadjPath} (read=${this.ryzenadjCanRead})`,
        );
        return;
      }
    }

    // 2. Try Intel RAPL sysfs. Probe all candidate paths in parallel
    //    and pick the first one that returned a value — fan-out is
    //    safe because reads are independent and the kernel handles
    //    them on separate fds. Saves 200-400ms on cold start on
    //    Intel systems where 3 of the 4 paths typically don't exist.
    //    `INTEL_RAPL_PATHS` is ordered by preference, so picking the
    //    first non-null hit preserves the existing tie-break.
    const raplResults = await Promise.all(
      INTEL_RAPL_PATHS.map(async (path) => ({
        path,
        val: await readFileText(path),
      })),
    );
    const raplHit = raplResults.find((r) => r.val !== null);
    if (raplHit) {
      this.intelRaplPath = raplHit.path;
      this.method = "intel-rapl";
      console.log(`[tdp-control] Intel RAPL available at ${raplHit.path}`);
      return;
    }

    // 3. Fallback: platform_profile (read-only-ish, coarse control)
    const profile = await readFileText(PLATFORM_PROFILE_PATH);
    if (profile !== null) {
      this.method = "platform_profile";
      console.log("[tdp-control] Using platform_profile as TDP control");
      return;
    }

    this.method = "none";
    console.log("[tdp-control] No TDP control method available");
  }

  private async testRyzenadjRead(): Promise<boolean> {
    try {
      const { exitCode, stdout } = await runCommand([
        this.ryzenadjPath || "ryzenadj",
        "--info",
      ]);
      if (exitCode !== 0) return false;
      // Check that we can actually parse a STAPM LIMIT value
      return /STAPM LIMIT.*\d/.test(stdout);
    } catch {
      return false;
    }
  }

  private async detectScalingDriver(): Promise<void> {
    const path = "/sys/devices/system/cpu/cpufreq/policy0/scaling_driver";
    this.scalingDriver = (await readFileText(path)) ?? "";
  }

  private async detectPlatformProfile(): Promise<void> {
    // The current profile is volatile (re-read every call); the available
    // choices are fixed by firmware, so read them once and cache. This
    // keeps getTdpInfo — which the UI polls — from re-reading the choices
    // file on every refresh.
    this.platformProfile =
      (await readFileText(PLATFORM_PROFILE_PATH)) ?? null;

    if (this.platformProfileChoices.length === 0) {
      const choicesText =
        (await readFileText(PLATFORM_PROFILE_CHOICES_PATH)) ?? null;
      this.platformProfileChoices = choicesText
        ? choicesText.split(/\s+/).filter(Boolean)
        : [];
    }
  }

  private async detectSmtSupport(): Promise<void> {
    const val = await readFileText(SMT_PATH);
    this.supportsSmt = val !== null;
  }

  private async detectCpuBoostSupport(): Promise<void> {
    // Check per-policy boost first, then legacy paths
    const cpus = await getOnlineCpus();
    const perCpuPath = `/sys/devices/system/cpu/cpufreq/policy${cpus[0]}/boost`;
    if ((await readFileText(perCpuPath)) !== null) {
      this.supportsCpuBoost = true;
      this.cpuBoostPath = perCpuPath;
      return;
    }
    if ((await readFileText(AMD_LEGACY_CPU_BOOST_PATH)) !== null) {
      this.supportsCpuBoost = true;
      this.cpuBoostPath = AMD_LEGACY_CPU_BOOST_PATH;
      return;
    }
    if ((await readFileText(INTEL_CPU_BOOST_PATH)) !== null) {
      this.supportsCpuBoost = true;
      this.cpuBoostPath = INTEL_CPU_BOOST_PATH;
      return;
    }
    this.supportsCpuBoost = false;
    this.cpuBoostPath = null;
  }

  private async detectEppOptions(): Promise<void> {
    const cpus = await getOnlineCpus();
    const path = `/sys/devices/system/cpu/cpu${cpus[0]}/cpufreq/energy_performance_available_preferences`;
    const text = await readFileText(path);
    if (text) {
      this.eppOptions = text
        .split(/\s+/)
        .filter((o) => o && o !== "default");
    } else {
      this.eppOptions = [];
    }
  }

  private async detectGovernorOptions(): Promise<void> {
    const cpus = await getOnlineCpus();
    const path = `/sys/devices/system/cpu/cpu${cpus[0]}/cpufreq/scaling_available_governors`;
    const text = await readFileText(path);
    if (text) {
      this.governorOptions = text.split(/\s+/).filter(Boolean);
    } else {
      this.governorOptions = [];
    }
  }

  private async detectGpu(): Promise<void> {
    try {
      // Enumerate via readdir (not `ls`) — no subprocess, so no command
      // grant needed and it works directly as root.
      const entries = await readdir("/sys/class/drm/");
      // Find card directories (card0, card1, etc.) — skip render nodes
      const cards = entries
        .filter((e) => /^card\d+$/.test(e))
        .sort();

      for (const card of cards) {
        const cardPath = `/sys/class/drm/${card}`;

        // Check for AMD GPU (pp_od_clk_voltage)
        const amdOdPath = `${cardPath}/device/pp_od_clk_voltage`;
        if ((await readFileText(amdOdPath)) !== null) {
          this.gpuCardPath = cardPath;
          this.gpuVendor = "AMD";
          console.log(`[tdp-control] AMD GPU detected at ${cardPath}`);
          return;
        }

        // Check for Intel GPU (gt_max_freq_mhz)
        const intelFreqPath = `${cardPath}/gt_max_freq_mhz`;
        if ((await readFileText(intelFreqPath)) !== null) {
          this.gpuCardPath = cardPath;
          this.gpuVendor = "Intel";
          console.log(`[tdp-control] Intel GPU detected at ${cardPath}`);
          return;
        }
      }
    } catch {
      // DRM not available
    }
    this.gpuCardPath = null;
    this.gpuVendor = "Unknown";
  }

  private async detectAcPower(): Promise<void> {
    try {
      const entries = await readdir("/sys/class/power_supply/");
      for (const entry of entries) {
        // Only the wall adapter (type=Mains) reflects charger state. Other
        // supplies expose `online` too — notably HID peripheral batteries
        // (Bluetooth controllers/keyboards have type=Battery), whose `online`
        // tracks the peripheral's link, NOT the power cord. Latching onto one
        // of those made unplugging the charger a no-op, so the battery TDP cap
        // never engaged. Require Mains.
        const type = (
          await readFileText(`/sys/class/power_supply/${entry}/type`)
        )?.trim();
        if (type !== "Mains") continue;
        const onlinePath = `/sys/class/power_supply/${entry}/online`;
        const text = await readFileText(onlinePath);
        if (text !== null) {
          this.acPowerPath = onlinePath;
          this.acPowerOnline = text.trim() === "1";
          console.log(
            `[tdp-control] AC power adapter found: ${entry} (Mains), online=${this.acPowerOnline}`,
          );
          return;
        }
      }
    } catch {
      // power_supply not available
    }
    this.acPowerPath = null;
    this.acPowerOnline = null;
  }

  // -----------------------------------------------------------------------
  // State reading helpers (for getTdpInfo)
  // -----------------------------------------------------------------------

  private async readSmtEnabled(): Promise<boolean | null> {
    if (!this.supportsSmt) return null;
    const val = await readFileText(SMT_PATH);
    if (val === null) return null;
    return val === "on";
  }

  private async readCpuBoostEnabled(): Promise<boolean | null> {
    if (!this.supportsCpuBoost || !this.cpuBoostPath) return null;
    const text = await readFileText(this.cpuBoostPath);
    if (text === null) return null;
    // Intel no_turbo is inverted: 0 means turbo ON
    if (this.cpuBoostPath === INTEL_CPU_BOOST_PATH) {
      return text.trim() === "0";
    }
    return text.trim() === "1";
  }

  private async readGpuInfo(): Promise<GpuInfo | null> {
    if (!this.gpuCardPath) return null;

    try {
      if (this.gpuVendor === "AMD") {
        const odText = await readFileText(
          `${this.gpuCardPath}/device/pp_od_clk_voltage`,
        );
        const modeText = await readFileText(
          `${this.gpuCardPath}/device/power_dpm_force_performance_level`,
        );

        let minFreq = 0;
        let maxFreq = 0;
        if (odText) {
          // Parse OD_RANGE section: SCLK: <min>Mhz <max>Mhz
          const rangeMatch = odText.match(
            /OD_RANGE:\s*\n\s*SCLK:\s*(\d+)Mhz\s+(\d+)Mhz/,
          );
          if (rangeMatch) {
            minFreq = parseInt(rangeMatch[1], 10);
            maxFreq = parseInt(rangeMatch[2], 10);
          }
        }

        return {
          vendor: "AMD",
          minFreqMhz: minFreq,
          maxFreqMhz: maxFreq,
          currentMode: modeText ?? "unknown",
          cardPath: this.gpuCardPath,
        };
      } else if (this.gpuVendor === "Intel") {
        const [gtMax, gtMin, gtRP0, gtRPn] = await Promise.all([
          readFileText(`${this.gpuCardPath}/gt_max_freq_mhz`),
          readFileText(`${this.gpuCardPath}/gt_min_freq_mhz`),
          readFileText(`${this.gpuCardPath}/gt_RP0_freq_mhz`),
          readFileText(`${this.gpuCardPath}/gt_RPn_freq_mhz`),
        ]);

        return {
          vendor: "Intel",
          minFreqMhz: gtRPn ? parseInt(gtRPn, 10) : 0,
          maxFreqMhz: gtRP0 ? parseInt(gtRP0, 10) : 0,
          currentMode: `min=${gtMin ?? "?"}MHz max=${gtMax ?? "?"}MHz`,
          cardPath: this.gpuCardPath,
        };
      }
    } catch {
      // GPU read failed
    }
    return null;
  }

  private async readChargeLimit(): Promise<number | null> {
    const text = await readFileText(CHARGE_LIMIT_PATH);
    if (text === null) return null;
    const val = parseInt(text, 10);
    return isNaN(val) ? null : val;
  }

  // -----------------------------------------------------------------------
  // TDP reading
  // -----------------------------------------------------------------------

  private async readCurrentTdp(): Promise<{
    watts: number;
    source: TdpReadSource;
  } | null> {
    // 0. Try WMI sysfs (ROG Ally / Legion Go)
    if (this.method === "wmi" && this.wmiPaths) {
      const text = await readFileText(this.wmiPaths.spl);
      if (text !== null) {
        const milliwatts = parseInt(text, 10);
        if (!isNaN(milliwatts)) {
          return { watts: Math.round(milliwatts / 1000), source: "read" };
        }
      }
    }

    // 1. Try ryzenadj --info
    if (this.method === "ryzenadj" && this.ryzenadjCanRead) {
      const watts = await this.readTdpViaRyzenadj();
      if (watts !== null) return { watts, source: "read" };
    }

    // 2. Try Intel RAPL sysfs
    if (this.method === "intel-rapl" && this.intelRaplPath) {
      const text = await readFileText(this.intelRaplPath);
      if (text !== null) {
        const uw = parseInt(text, 10);
        if (!isNaN(uw)) {
          return { watts: Math.round(uw / 1_000_000), source: "read" };
        }
      }
    }

    // 3. Use tracked value (we set it ourselves and remember)
    if (this.trackedTdp !== null) {
      return { watts: this.trackedTdp, source: "tracked" };
    }

    // 4. Estimate from platform_profile
    const profile = await readFileText(PLATFORM_PROFILE_PATH);
    if (profile && profile in PLATFORM_PROFILE_TDP_MAP) {
      // Use device-aware profile mapping when we have profiles
      const mapped = this.platformProfileToWatts(profile);
      return { watts: mapped, source: "estimated" };
    }

    return null;
  }

  private async readTdpViaRyzenadj(): Promise<number | null> {
    try {
      const { exitCode, stdout } = await runCommand([
        "ryzenadj",
        "--info",
      ]);
      if (exitCode !== 0) return null;

      for (const line of stdout.split("\n")) {
        if (line.includes("STAPM LIMIT")) {
          const match = line.match(/([\d.]+)/);
          if (match) return Math.round(parseFloat(match[1]));
        }
      }
    } catch {
      // ryzenadj failed
    }
    return null;
  }

  private async readCurrentEpp(): Promise<string | null> {
    const cpus = await getOnlineCpus();
    const path = `/sys/devices/system/cpu/cpu${cpus[0]}/cpufreq/energy_performance_preference`;
    return readFileText(path);
  }

  private async readCurrentGovernor(): Promise<string | null> {
    const cpus = await getOnlineCpus();
    const path = `/sys/devices/system/cpu/cpu${cpus[0]}/cpufreq/scaling_governor`;
    return readFileText(path);
  }

  // -----------------------------------------------------------------------
  // TDP writing
  // -----------------------------------------------------------------------

  private async setTdpViaRyzenadj(watts: number): Promise<void> {
    const milliwatts = watts * 1000;
    const { exitCode, stderr } = await runCommand([
      this.ryzenadjPath || "ryzenadj",
      `--stapm-limit=${milliwatts}`,
      `--fast-limit=${milliwatts}`,
      `--slow-limit=${milliwatts}`,
    ]);
    if (exitCode !== 0) {
      throw new Error(`ryzenadj failed (exit ${exitCode}): ${stderr}`);
    }
  }

  private async setTdpViaIntelRapl(watts: number): Promise<void> {
    if (!this.intelRaplPath) {
      throw new Error("Intel RAPL path not available");
    }
    const microwatts = String(watts * 1_000_000);
    await writeSysfs(this.intelRaplPath, microwatts);
  }

  private async setTdpViaWmi(watts: number): Promise<void> {
    if (!this.wmiPaths) {
      throw new Error("WMI paths not available");
    }
    const milliwatts = String(watts * 1000);
    await writeSysfs(this.wmiPaths.fppt, milliwatts);
    await writeSysfs(this.wmiPaths.sppt, milliwatts);
    await writeSysfs(this.wmiPaths.spl, milliwatts);
  }

  // -----------------------------------------------------------------------
  // Profile helpers
  // -----------------------------------------------------------------------

  /** Match a TDP value to a named profile (within 1W tolerance). */
  private matchProfile(tdp: number | null): string | null {
    return matchProfileName(tdp, this.profiles);
  }

  /** Convert a platform_profile name to an approximate wattage using device profiles. */
  private platformProfileToWatts(profile: string): number {
    if (profile === "low-power") return this.profiles["Silent"] ?? 10;
    if (profile === "balanced") return this.profiles["Balanced"] ?? 18;
    if (profile === "performance") return this.profiles["Performance"] ?? 35;
    return PLATFORM_PROFILE_TDP_MAP[profile] ?? this.profiles["Balanced"] ?? 18;
  }

  /** Convert a watt value to the nearest platform_profile name. */
  private wattsToPlatformProfile(watts: number): string {
    const silent = this.profiles["Silent"] ?? 10;
    const balanced = this.profiles["Balanced"] ?? 18;
    const performance = this.profiles["Performance"] ?? 35;

    const midLow = (silent + balanced) / 2;
    const midHigh = (balanced + performance) / 2;

    if (watts <= midLow) return "low-power";
    if (watts <= midHigh) return "balanced";
    return "performance";
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  private async pollTdp(): Promise<void> {
    try {
      const reading = await this.readCurrentTdp();
      if (reading === null) return;

      const changed =
        reading.watts !== this.currentTdp ||
        reading.source !== this.tdpReadSource;

      if (changed) {
        this.currentTdp = reading.watts;
        this.tdpReadSource = reading.source;
        this.activeProfile = this.matchProfile(reading.watts);
        this.emit?.({
          event: "tdpChanged",
          data: {
            currentTdp: reading.watts,
            activeProfile: this.activeProfile,
            tdpReadSource: this.tdpReadSource,
          },
        });
      }

      // Also check if platform profile changed
      const prevProfile = this.platformProfile;
      await this.detectPlatformProfile();
      if (this.platformProfile !== prevProfile) {
        this.emit?.({
          event: "platformProfileChanged",
          data: { platformProfile: this.platformProfile },
        });
      }

      // Check AC power status change
      if (this.acPowerPath) {
        const prevAcPower = this.acPowerOnline;
        const text = await readFileText(this.acPowerPath);
        if (text !== null) {
          this.acPowerOnline = text.trim() === "1";
          if (this.acPowerOnline !== prevAcPower) {
            // Re-apply the standing intent through the (now power-state-aware)
            // clamp: unplugging throttles a 70W request down to the battery
            // cap; plugging back in springs it up to 70W again. setTdp emits
            // its own tdpChanged with the applied value.
            const intent = this.desiredTdp ?? this.currentTdp;
            if (intent !== null && this.method !== "none") {
              await this.setTdp(intent);
            }
            this.emit?.({
              event: "acPowerChanged",
              data: {
                online: this.acPowerOnline,
                maxWatts: this.effectiveMaxWatts(),
              },
            });
            console.log(
              `[tdp-control] AC power changed: ${this.acPowerOnline ? "online" : "offline"}`,
            );
          }
        }
      }
    } catch (e) {
      console.error(`[tdp-control] Poll error: ${e}`);
    }
  }
}
