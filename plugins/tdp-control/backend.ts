import type { PluginBackend, EmitPayload } from "@loadout/types";
import { runFull, commandExists } from "@loadout/exec";
import {
  createTdpProfileEngine,
  type TdpProfileEngine,
  type TdpProfile,
  type TdpProfileEngineState,
} from "./lib/tdp-profiles";

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
// Enums & device database
// ---------------------------------------------------------------------------

type CpuVendor = "AMD" | "Intel" | "Unknown";

type TdpMethod = "ryzenadj" | "intel-rapl" | "platform_profile" | "wmi" | "none";

/** How we obtained the current TDP reading. */
type TdpReadSource = "read" | "tracked" | "estimated";

interface DeviceInfo {
  /** Match substring against DMI product_name */
  match: string;
  /** Friendly display name */
  name: string;
  minTdp: number;
  maxTdp: number;
  /** Per-profile watt defaults */
  profiles: { Silent: number; Balanced: number; Performance: number };
}

interface GpuInfo {
  vendor: "AMD" | "Intel" | "Unknown";
  minFreqMhz: number;
  maxFreqMhz: number;
  currentMode: string;
  cardPath: string | null;
}

type GpuMode = "auto" | "high" | "low" | "manual";

/**
 * Known device database.
 * Order matters: first match wins, so put more specific strings first.
 */
const KNOWN_DEVICES: DeviceInfo[] = [
  // Steam Deck
  {
    match: "Galileo",
    name: "Steam Deck OLED",
    minTdp: 3,
    maxTdp: 15,
    profiles: { Silent: 5, Balanced: 10, Performance: 15 },
  },
  {
    match: "Jupiter",
    name: "Steam Deck LCD",
    minTdp: 3,
    maxTdp: 15,
    profiles: { Silent: 5, Balanced: 10, Performance: 15 },
  },
  // ASUS ROG Ally
  {
    match: "ROG Ally X RC72",
    name: "ROG Ally X",
    minTdp: 5,
    maxTdp: 30,
    profiles: { Silent: 10, Balanced: 17, Performance: 30 },
  },
  {
    match: "ROG Ally RC71",
    name: "ROG Ally",
    minTdp: 5,
    maxTdp: 25,
    profiles: { Silent: 10, Balanced: 15, Performance: 25 },
  },
  // Lenovo Legion Go
  {
    match: "83L3",
    name: "Legion Go S (Z2 Go)",
    minTdp: 5,
    maxTdp: 25,
    profiles: { Silent: 8, Balanced: 15, Performance: 25 },
  },
  {
    match: "83N6",
    name: "Legion Go S (Z1 Extreme)",
    minTdp: 5,
    maxTdp: 30,
    profiles: { Silent: 8, Balanced: 15, Performance: 30 },
  },
  {
    match: "83E1",
    name: "Legion Go",
    minTdp: 5,
    maxTdp: 30,
    profiles: { Silent: 8, Balanced: 15, Performance: 30 },
  },
  // OneXPlayer
  {
    match: "ONEXPLAYER APEX",
    name: "OneXPlayer APEX",
    minTdp: 5,
    maxTdp: 80,
    profiles: { Silent: 15, Balanced: 30, Performance: 50 },
  },
  {
    match: "ONEXPLAYER Mini Pro",
    name: "OneXPlayer Mini Pro",
    minTdp: 5,
    maxTdp: 30,
    profiles: { Silent: 8, Balanced: 15, Performance: 30 },
  },
  {
    match: "ONEXPLAYER",
    name: "OneXPlayer",
    minTdp: 5,
    maxTdp: 35,
    profiles: { Silent: 10, Balanced: 18, Performance: 35 },
  },
  // GPD
  {
    match: "G1619-04",
    name: "GPD Win Max 2",
    minTdp: 5,
    maxTdp: 28,
    profiles: { Silent: 8, Balanced: 15, Performance: 28 },
  },
  {
    match: "G1618-04",
    name: "GPD Win 4",
    minTdp: 5,
    maxTdp: 28,
    profiles: { Silent: 8, Balanced: 15, Performance: 28 },
  },
  {
    match: "GPD",
    name: "GPD Device",
    minTdp: 5,
    maxTdp: 28,
    profiles: { Silent: 8, Balanced: 15, Performance: 28 },
  },
  // AYANEO
  {
    match: "AYANEO",
    name: "AYANEO",
    minTdp: 5,
    maxTdp: 33,
    profiles: { Silent: 8, Balanced: 15, Performance: 33 },
  },
  // AOKZOE
  {
    match: "AOKZOE",
    name: "AOKZOE",
    minTdp: 5,
    maxTdp: 33,
    profiles: { Silent: 8, Balanced: 18, Performance: 33 },
  },
  // Minisforum
  {
    match: "V3",
    name: "Minisforum V3",
    minTdp: 5,
    maxTdp: 30,
    profiles: { Silent: 10, Balanced: 18, Performance: 30 },
  },
  {
    match: "Minisforum",
    name: "Minisforum",
    minTdp: 5,
    maxTdp: 35,
    profiles: { Silent: 10, Balanced: 18, Performance: 35 },
  },
  // MSI Claw
  {
    match: "Claw 8 AI",
    name: "MSI Claw 8 AI+",
    minTdp: 5,
    maxTdp: 40,
    profiles: { Silent: 10, Balanced: 20, Performance: 40 },
  },
  {
    match: "Claw",
    name: "MSI Claw",
    minTdp: 5,
    maxTdp: 30,
    profiles: { Silent: 8, Balanced: 17, Performance: 30 },
  },
];

/** Default ranges when device is unknown. */
const DEFAULT_AMD: Omit<DeviceInfo, "match"> = {
  name: "Generic AMD",
  minTdp: 5,
  maxTdp: 35,
  profiles: { Silent: 10, Balanced: 18, Performance: 35 },
};

const DEFAULT_INTEL: Omit<DeviceInfo, "match"> = {
  name: "Generic Intel",
  minTdp: 3,
  maxTdp: 40,
  profiles: { Silent: 8, Balanced: 15, Performance: 30 },
};

const DEFAULT_UNKNOWN: Omit<DeviceInfo, "match"> = {
  name: "Unknown",
  minTdp: 5,
  maxTdp: 35,
  profiles: { Silent: 10, Balanced: 18, Performance: 35 },
};

/** Approximate TDP for platform_profile values (used only as fallback estimate). */
const PLATFORM_PROFILE_TDP_MAP: Record<string, number> = {
  "low-power": 15,
  balanced: 25,
  performance: 35,
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

async function readFileText(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return (await file.text()).trim();
  } catch {
    return null;
  }
}

async function writeFileSudo(path: string, value: string): Promise<void> {
  // Try direct write first
  try {
    await Bun.write(path, value);
    return;
  } catch {
    // fall through to sudo tee
  }
  const { stderr, exitCode } = await runFull(["sudo", "tee", path], { stdin: value });
  if (exitCode !== 0) {
    throw new Error(`Failed to write ${path}: ${stderr}`);
  }
}

const runCommand = runFull;

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
  maxWatts: number;
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

  // TDP method & state
  private method: TdpMethod = "none";
  private minWatts = 5;
  private maxWatts = 35;
  private profiles: Record<string, number> = {
    Silent: 10,
    Balanced: 18,
    Performance: 35,
  };
  private currentTdp: number | null = null;
  private tdpReadSource: TdpReadSource = "estimated";
  private activeProfile: string | null = null;
  private trackedTdp: number | null = null;

  // Capabilities
  private ryzenadjAvailable = false;
  private ryzenadjCanRead = false;
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

    // Apply device-specific ranges
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

    // Initialize per-game TDP profile engine. Storage now lives at
    // ~/.config/loadout/plugins/tdp-control.json via the inlined
    // plugin-storage helper. The engine handles a one-shot migration from
    // the legacy ~/.config/loadout/tdp-profiles.json on first load.
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
      maxWatts: this.maxWatts,
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

    if (watts < this.minWatts || watts > this.maxWatts) {
      return {
        success: false,
        error: `TDP must be between ${this.minWatts}W and ${this.maxWatts}W`,
      };
    }

    if (this.method === "none") {
      return {
        success: false,
        error: "No TDP control method available on this system",
      };
    }

    try {
      if (this.method === "wmi") {
        await this.setTdpViaWmi(watts);
      } else if (this.method === "ryzenadj") {
        await this.setTdpViaRyzenadj(watts);
      } else if (this.method === "intel-rapl") {
        await this.setTdpViaIntelRapl(watts);
      } else if (this.method === "platform_profile") {
        // platform_profile is coarse — pick closest profile name
        const profileName = this.wattsToPlatformProfile(watts);
        await writeFileSudo(PLATFORM_PROFILE_PATH, profileName);
        await this.detectPlatformProfile();
      }

      // Track the value we just set
      this.trackedTdp = watts;
      this.currentTdp = watts;
      this.tdpReadSource = "tracked";
      this.activeProfile = this.matchProfile(watts);

      this.emit?.({
        event: "tdpChanged",
        data: {
          currentTdp: watts,
          activeProfile: this.activeProfile,
          tdpReadSource: this.tdpReadSource,
        },
      });

      console.log(`[tdp-control] TDP set to ${watts}W via ${this.method}`);
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
        await writeFileSudo(path, epp);
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
        await writeFileSudo(path, governor);
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
      await writeFileSudo(PLATFORM_PROFILE_PATH, profile);
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
      await writeFileSudo(SMT_PATH, enable ? "on" : "off");
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
        await writeFileSudo(this.cpuBoostPath, enable ? "0" : "1");
      } else if (this.cpuBoostPath.includes("/policy")) {
        // AMD per-CPU boost: write to each online CPU's policy
        const cpus = await getOnlineCpus();
        for (const cpu of cpus) {
          const path = `/sys/devices/system/cpu/cpufreq/policy${cpu}/boost`;
          await writeFileSudo(path, enable ? "1" : "0");
        }
      } else {
        // AMD legacy path
        await writeFileSudo(this.cpuBoostPath, enable ? "1" : "0");
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
      await writeFileSudo(perfLevelPath, mode);
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
        await writeFileSudo(perfLevelPath, "manual");
        await writeFileSudo(odClkPath, `s 0 ${minMhz}`);
        await writeFileSudo(odClkPath, `s 1 ${maxMhz}`);
        await writeFileSudo(odClkPath, "c");
      } else if (this.gpuVendor === "Intel") {
        await writeFileSudo(`${this.gpuCardPath}/gt_min_freq_mhz`, String(minMhz));
        await writeFileSudo(`${this.gpuCardPath}/gt_max_freq_mhz`, String(maxMhz));
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
      await writeFileSudo(CHARGE_LIMIT_PATH, String(percent));
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
        await writeFileSudo(SMT_PATH, "on");
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
    // Try to match a known device
    for (const device of KNOWN_DEVICES) {
      if (this.dmiProductName.includes(device.match)) {
        this.deviceName = device.name;
        this.minWatts = device.minTdp;
        this.maxWatts = device.maxTdp;
        this.profiles = { ...device.profiles };
        return;
      }
    }

    // Fallback by CPU vendor
    const fallback =
      this.cpuVendor === "AMD"
        ? DEFAULT_AMD
        : this.cpuVendor === "Intel"
          ? DEFAULT_INTEL
          : DEFAULT_UNKNOWN;

    this.deviceName = fallback.name;
    this.minWatts = fallback.minTdp;
    this.maxWatts = fallback.maxTdp;
    this.profiles = { ...fallback.profiles };
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

    // 1. Try ryzenadj (AMD)
    if (await commandExists("ryzenadj")) {
      this.ryzenadjAvailable = true;
      // Test if ryzenadj can read (some platforms like Strix Halo cannot)
      this.ryzenadjCanRead = await this.testRyzenadjRead();
      this.method = "ryzenadj";
      console.log(
        `[tdp-control] ryzenadj available, read=${this.ryzenadjCanRead}`,
      );
      return;
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
        "sudo",
        "ryzenadj",
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
    this.platformProfile =
      (await readFileText(PLATFORM_PROFILE_PATH)) ?? null;

    const choicesText =
      (await readFileText(PLATFORM_PROFILE_CHOICES_PATH)) ?? null;
    this.platformProfileChoices = choicesText
      ? choicesText.split(/\s+/).filter(Boolean)
      : [];
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
      const { stdout } = await runCommand(["ls", "/sys/class/drm/"]);
      const entries = stdout.split(/\s+/).filter(Boolean);
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
      const { stdout } = await runCommand(["ls", "/sys/class/power_supply/"]);
      const entries = stdout.split(/\s+/).filter(Boolean);
      for (const entry of entries) {
        const onlinePath = `/sys/class/power_supply/${entry}/online`;
        const text = await readFileText(onlinePath);
        if (text !== null) {
          this.acPowerPath = onlinePath;
          this.acPowerOnline = text.trim() === "1";
          console.log(
            `[tdp-control] AC power adapter found: ${entry}, online=${this.acPowerOnline}`,
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
        "sudo",
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
      "sudo",
      "ryzenadj",
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
    await writeFileSudo(this.intelRaplPath, microwatts);
  }

  private async setTdpViaWmi(watts: number): Promise<void> {
    if (!this.wmiPaths) {
      throw new Error("WMI paths not available");
    }
    const milliwatts = String(watts * 1000);
    await writeFileSudo(this.wmiPaths.fppt, milliwatts);
    await writeFileSudo(this.wmiPaths.sppt, milliwatts);
    await writeFileSudo(this.wmiPaths.spl, milliwatts);
  }

  // -----------------------------------------------------------------------
  // Profile helpers
  // -----------------------------------------------------------------------

  /** Match a TDP value to a named profile (within 1W tolerance). */
  private matchProfile(tdp: number | null): string | null {
    if (tdp === null) return null;
    for (const [name, watts] of Object.entries(this.profiles)) {
      if (Math.abs(tdp - watts) <= 1) return name;
    }
    return "Custom";
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
            this.emit?.({
              event: "acPowerChanged",
              data: { online: this.acPowerOnline },
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
