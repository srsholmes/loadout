/**
 * Store Bridge — shared type surface.
 *
 * Per-store namespacing is the central design choice: every store
 * (Epic today, GOG/Amazon/Ubisoft/xCloud later) gets its own slot
 * under `state.stores[storeId]`. The driver registry binds a
 * `StoreDriver` to each storeId at runtime; only the driver knows
 * how to talk to that store's underlying CLI / API.
 */

export type StoreId = "epic" | "gog" | "amazon" | "ubisoft" | "xcloud";
export type AuthStatus = "unknown" | "authed" | "expired";
export type GameStatus =
  | "available"
  | "installing"
  | "installed"
  | "update_available"
  | "updating"
  | "uninstalling"
  | "not_owned";
export type InstallSource = "installed" | "imported";

/** A title in the user's library, as returned by the store driver. */
export interface LibraryEntry {
  /** Store-side game id (legendary AppName for Epic). */
  id: string;
  title: string;
  /** Optional cover URLs the store provides (e.g. Epic keyImages). */
  coverUrl?: string;
  heroUrl?: string;
  logoUrl?: string;
  /** Bytes — null/undefined when unknown without an `info` call. */
  installSize?: number;
  /** Free-form tags pulled from the store (e.g. "DLC" or genre). */
  tags?: string[];
  /** Short marketing blurb. Epic ships this for nearly every title. */
  description?: string;
  /** Longer prose; many titles leave it null on Epic. */
  longDescription?: string;
  developer?: string;
  publisher?: string;
  /** ISO-8601 release date — Epic's `releaseInfo[0].dateAdded` when
   *  available, else `creationDate` (when the title was added to the
   *  user's library, a passable proxy for older titles where Epic
   *  didn't backfill releaseInfo). */
  releaseDate?: string;
  /** Platforms the store says this title supports (e.g. ["Windows"]). */
  platforms?: string[];
}

/** A title the user has installed (via store, or imported off disk). */
export interface InstalledGame {
  id: string;
  title: string;
  installedAt: string; // ISO-8601
  installDir: string;
  /** Bytes on disk after install completed. */
  installSize?: number;
  /** Version string reported by the store, when available. */
  version?: string;
  /**
   * Executable to launch (relative to `installDir`). Set by the
   * driver — e.g. legendary reports "Alba.exe". Used to build the
   * Steam shortcut: shortcut.exe = join(installDir, executable).
   * Falls back to "legendary launch <id>" wrapping when missing.
   */
  executable?: string;
  /** Extra launch-time CLI args reported by the store (Epic
   *  "launch_parameters", e.g. "-window-mode exclusive"). */
  launchParameters?: string;
  /** Native OS of the executable. `"windows"` drives whether we set
   *  Proton as the Steam compat tool when adding the shortcut (the
   *  host is always Linux). */
  platform?: "windows" | "linux";
  source: InstallSource;
  addedToSteam: boolean;
  steamAppId?: number;
  steamGameId64?: string;
}

/** Per-store slice of `state.json`. */
export interface StoreState {
  /** Unix ms when the library was last fetched from the store. */
  libraryCacheFetchedAt: number;
  library: Record<string, LibraryEntry>;
  installed: Record<string, InstalledGame>;
  authStatus: AuthStatus;
}

/** Per-driver overrides — generalised from the old `legendaryBinary`
 *  field so a future GOG / Amazon driver can plug in its own binary
 *  override without another flat field on `Settings`. */
export interface DriverOverrides {
  /** User-overridden path to the driver's CLI binary. */
  binary?: string;
  /**
   * Pin the self-installer to a specific upstream release (e.g.
   * "v0.20.34"). Empty / unset = always pull "latest". Lets a
   * security-conscious user vet one release and stop auto-pulling
   * new binaries without re-vetting. See the trust-model note in
   * `epic/install-legendary.ts`.
   */
  pinnedVersion?: string;
}

/** Plugin-wide settings, persisted to disk. */
export interface Settings {
  /** Stores the UI surfaces (chip row). */
  enabledStores: StoreId[];
  /** Per-driver overrides — currently just the CLI binary path. */
  driverOverrides?: Partial<Record<StoreId, DriverOverrides>>;
  /** User-added directories to scan for already-installed games. */
  scanPaths: string[];
  /** Unix ms of the last completed scan. */
  lastScanAt?: number;
}

/**
 * Pipeline-event id prefixes. Kept here so backend emits and
 * frontend filters never drift — a substring typo in either place
 * would silently break the double-toast suppression.
 */
export const PIPELINE_ADD_TO_STEAM_PREFIX = ":add-to-steam:";

/** Build the canonical add-to-Steam emit id. */
export function addToSteamPipelineId(
  storeId: StoreId,
  gameId: string,
): string {
  return `${storeId}${PIPELINE_ADD_TO_STEAM_PREFIX}${gameId}`;
}

/** Top-level state.json shape. */
export interface PersistedState {
  version: 1;
  stores: Partial<Record<StoreId, StoreState>>;
  settings: Settings;
}

/**
 * Single envelope the backend emits to the frontend for any
 * long-running operation (install, auth, scan, self-install of
 * tooling). The frontend keys progress UI off `kind` + `id`.
 */
export type PipelineEvent =
  | { kind: "progress"; id: string; percent: number; bytes?: number; label?: string }
  | { kind: "complete"; id: string; payload?: unknown }
  | { kind: "error"; id: string; message: string };

export type PipelineEmit = (event: PipelineEvent) => void;

/** Candidate install discovered by the scan walker. */
export interface DetectedInstall {
  storeId: StoreId;
  gameId: string;
  title: string;
  dir: string;
}

/** Driver-agnostic "what's the launch command look like" record. */
export interface LaunchSpec {
  exe: string;
  args: string;
  /** Working directory for the shortcut. Defaults to dirname(exe). */
  cwd?: string;
}
