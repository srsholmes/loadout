// Shared TypeScript types for the lsfg-vk plugin. Keep this module
// type-only so the runtime cost stays zero.
//
// `GameInfo` / `GameCollection` for the apply-to-game picker come from
// `@loadout/types` (consumed via the `__core:game-library` core
// service), not from a local copy.

/**
 * Which lsfg-vk layer build to install:
 * - `latest` — newest upstream release (LSFG 3.1). Best for native games.
 * - `compat` — older pre-rewrite build for setups where the latest layer
 *   crashes the app with a Vulkan initialization error at launch.
 */
export type LayerVersion = "latest" | "compat";

/** TOML-backed config that the layer reads from `~/.config/lsfg-vk/conf.toml`. */
export interface LsfgSettings {
  multiplier: number;
  flow_scale: number;
  performance_mode: boolean;
  hdr_mode: boolean;
  experimental_present_mode: "fifo" | "mailbox" | "immediate";
  /**
   * When true, the wrapper exports LSFG_LOG=1 + VK_LOADER_DEBUG=layer
   * so the user can confirm the layer is engaging via journalctl. Not
   * written to TOML — wrapper-only.
   */
  verbose_logging: boolean;
}

export interface PersistedStore {
  settings?: Partial<LsfgSettings>;
  customDllPath?: string;
  /** Which layer build the user picked. Drives `install()`. */
  layerVersion?: LayerVersion;
  /** Human-readable version of the layer last installed (display only). */
  installedVersion?: string | null;
}

/** Returned by `launch-options` plugin's `getGames` RPC. */
export interface LaunchOptionsEntry {
  appId: string;
  launchOptions: string;
}

export interface VulkanCheck {
  available: boolean;
  layerLoaded: boolean;
  jsonExists: boolean;
  excerpt: string;
}

export interface InstallStatus {
  installed: boolean;
  layerSoExists: boolean;
  layerJsonExists: boolean;
  wrapperExists: boolean;
  /** Absolute filesystem path to the wrapper (display only). */
  wrapperPath: string;
  /** Tilde-form token to put into Steam launch options (e.g. `~/lsfg`). */
  wrapperToken: string;
  layerSoPath: string;
  layerJsonPath: string;
  tomlPath: string;
  /** Layer build selected for install (persists across restarts). */
  layerVersion: LayerVersion;
  /** Human-readable version of the currently-installed layer, or null. */
  installedVersion: string | null;
}

export interface DllStatus {
  found: boolean;
  path: string | null;
  isCustom: boolean;
}

export interface FullStatus {
  install: InstallStatus;
  dll: DllStatus;
  settings: LsfgSettings;
  customDllPath: string | null;
  launchOptions: string;
}

export interface ProgressEvent {
  message: string;
  done?: boolean;
  error?: boolean;
}
