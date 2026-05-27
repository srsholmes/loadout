// Shared TypeScript types for the lsfg-vk plugin UI. Extracted from
// app.tsx as part of the D-010 decomposition — keep this module
// type-only so the runtime cost stays zero.

export interface GameInfo {
  appId: string;
  name: string;
  sizeOnDisk: number;
  headerUrl: string;
  capsuleUrl: string;
  /** Loader-route URL pointing at the local grid file (always-set for
   *  new game-browser builds; optional here so we don't crash on an
   *  older cached bundle). */
  localHeaderUrl?: string;
  localCapsuleUrl?: string;
  /** "steam" for appmanifest games, "shortcut" for non-Steam apps. */
  source?: "steam" | "shortcut";
  /** Steam categories / collections (legacy tags + user-collections). */
  tags?: string[];
}

export interface CollectionEntry {
  id: string;
  count: number;
}

export interface LaunchOptionsEntry {
  appId: string;
  launchOptions: string;
}

export interface LsfgSettings {
  multiplier: number;
  flow_scale: number;
  performance_mode: boolean;
  hdr_mode: boolean;
  experimental_present_mode: "fifo" | "mailbox" | "immediate";
  verbose_logging: boolean;
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
