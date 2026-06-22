// ── Platform & Install Type ──────────────────────────────────────────

export type Platform =
  | "n64" | "ps1" | "ps2" | "gc" | "xbox360"
  | "gb" | "gba" | "gbc" | "nes" | "snes" | "nds" | "3ds"
  | "wii" | "wiiu" | "switch"
  | "pc" | "mobile" | "multi"
  | "arcade" | "dreamcast" | "saturn" | "xbox" | "xboxone"
  | "other";

export type InstallType =
  | "prebuilt"
  | "rom_extract"
  | "toolchain"
  | "build_from_source"
  | "custom";

export const PLATFORM_DISPLAY: Record<string, string> = {
  n64: "N64", ps1: "PS1", ps2: "PS2", gc: "GC", xbox360: "X360",
  gb: "GB", gba: "GBA", gbc: "GBC", nes: "NES", snes: "SNES",
  nds: "NDS", "3ds": "3DS", wii: "Wii", wiiu: "Wii U", switch: "Switch",
  pc: "PC", mobile: "Mobile", multi: "Multi", arcade: "Arcade",
  dreamcast: "DC", saturn: "Saturn", xbox: "Xbox", xboxone: "Xbox One",
  other: "Other",
};

export const PLATFORM_COLOR: Record<string, string> = {
  n64: "#dc2626", ps1: "#6366f1", ps2: "#2563eb", gc: "#7c3aed", xbox360: "#16a34a",
  gb: "#22c55e", gba: "#4ade80", gbc: "#15803d", nes: "#ef4444", snes: "#b91c1c",
  nds: "#3b82f6", "3ds": "#60a5fa", wii: "#06b6d4", wiiu: "#0891b2", switch: "#e11d48",
  pc: "#a3a3a3", mobile: "#facc15", multi: "#8b5cf6", arcade: "#f472b6",
  dreamcast: "#818cf8", saturn: "#c084fc", xbox: "#16a34a", xboxone: "#22c55e",
  other: "#525252",
};

// ── Registry Types (matching games.json) ─────────────────────────────

export interface PlatformAssets {
  /** Windows binary — run via Proton on the Linux host. */
  windows?: string;
  linux?: string;
}

export interface PlatformCommand {
  /** Windows launch command — run via Proton on the Linux host. */
  windows?: string;
  linux?: string;
}

export interface RomInfo {
  description: string;
  validChecksums: string[];
  extractionCommand: string;
  fileType?: string;
  extensions?: string[];
  /** When set, the pipeline copies the user-picked ROM into
   *  `{installDir}/{placeRomAs}` after the release asset is
   *  extracted. Use for upstreams (Ship of Harkinian, 2 Ship 2
   *  Harkinian, similar) where the engine ingests the ROM on first
   *  launch from a known filename in the install dir — these have
   *  no CLI extraction mode despite `extractionCommand` historically
   *  trying to invoke a `--generate-otr` flag that doesn't exist. */
  placeRomAs?: string;
}

export interface ToolchainInfo {
  description: string;
  setupCommand: string;
}

/**
 * Per-game manifest shape, consumed by `lib/registry.ts` when it
 * scans `plugins/recomp/games/*\/manifest.json`. Carries only what
 * the catalog UI + Steam shortcut registration need; install logic
 * lives in `setup.ts` next to the manifest.
 */
export interface Manifest {
  id: string;
  name: string;
  project: string;
  platform: Platform;
  description?: string;
  /** Upstream repo "owner/name" for catalog-side info + the
   *  default `cloneFromGitHub()` target if the recipe doesn't
   *  pass an explicit one. */
  repo: string;
  /** Required for ROM-bearing games. */
  requiresRom?: boolean;
  romInfo?: RomInfo;
  /** Tags shown in the catalog UI. */
  tags?: string[];
  website?: string;
  /** SteamGridDB id for artwork lookup. */
  steamGridDbId?: number;
  /** Suffix appended to the Steam shortcut display name (defaults
   *  to `" (Recomp)"`). */
  nameSuffix?: string;
  /** Files preserved across re-installs (configs, saves). */
  preservePaths?: string[];
  /**
   * Optional expected SHA-256 of the downloadable release asset,
   * per platform. When set for the resolved platform, the install
   * pipeline aborts (and cleans up) if the downloaded file's hash
   * doesn't match — pinning the exact bytes a manifest expects. Hex
   * digest, optionally prefixed `sha256:`; matched case-insensitively.
   * Absent ⇒ download proceeds with an "unverified" notice.
   */
  releaseSha256?: PlatformAssets;
  /**
   * The directory the game's engine reads its per-user data from on
   * Linux (config / saves / texture replacements). Declared once
   * here so individual mod entries don't repeat it — they reference
   * it via the `{userDataDir}` token in their `installSubdir`.
   *
   * Tilde-expanded (`~/` → `$HOME`) when the mod-install pipeline
   * resolves the destination. Example for Dusklight:
   *   `"~/.local/share/TwilitRealm/Dusklight"`
   * which a texture-pack mod then references as:
   *   `installSubdir: "{userDataDir}/texture_replacements/"`
   *
   * When the same upstream port is built for multiple platforms or
   * by multiple recomp projects (each with their own SDL_GetPrefPath
   * tuple), this field lets us add the new game without re-deriving
   * paths inside every mod entry.
   */
  userDataDir?: string;
  /** Optional mod / texture-pack catalog for this game. Surfaced in
   *  the detail page's "Mods & extras" panel. Each entry is either
   *  auto-installed (github-release / direct-url) or surfaced as
   *  "Open page + Import from disk" (manual-import) for sources we
   *  can't direct-fetch (MediaFire / Google Drive). */
  mods?: ModEntry[];
}

// ── Mods ────────────────────────────────────────────────────────────

/**
 * How the plugin obtains a mod's archive. Each variant determines
 * the buttons rendered on the mod card and the install pipeline that
 * runs server-side.
 */
export type ModSource =
  | {
      /** GitHub release asset. Resolves `/releases/<tag|latest>` and
       *  glob-matches `assetPattern` against asset names. */
      kind: "github-release";
      repo: string;
      assetPattern: string;
      tag?: string;
    }
  | {
      /** Single direct download URL (gamebanana CDN, etc.). */
      kind: "direct-url";
      url: string;
      /** Optional explicit filename for the staged download. Falls
       *  back to the URL path's basename. */
      filename?: string;
    }
  | {
      /** No automatic download — the user follows `externalUrl` in a
       *  browser (MediaFire / Drive), then imports the local file.
       *  `acceptExtensions` filters the picker. */
      kind: "manual-import";
      acceptExtensions?: string[];
    };

/**
 * Catalog entry for a single mod / texture-pack / extra surfaced on a
 * game's detail page. Either `setupModule` (escape hatch — a TS file
 * that owns the install) OR `installSubdir` (default copy path) must
 * be set; the validator rejects entries with neither.
 */
export interface ModEntry {
  /** Stable kebab-case id. Primary key per game; the install state
   *  is keyed on this. */
  id: string;
  name: string;
  description: string;
  author?: string;
  /** Longer attribution string rendered as small print under the card. */
  credit?: string;
  source: ModSource;
  /** Catalog-declared version. Used as the source-of-truth for
   *  update detection on `manual-import` mods (which can't otherwise
   *  derive a version) and as the override for auto-source mods
   *  whose filename version-parse misses. Free-form string —
   *  semver-style is preferred but anything readable works. */
  version?: string;
  /**
   * Default destination for the copy-files path. Ignored when
   * `setupModule` is set — the script owns placement.
   *
   * Three shapes supported:
   *   - `"textures/"` — relative to the game's install dir
   *   - `"~/Foo"` — expanded against `$HOME` (gated to live under
   *     home for safety)
   *   - `"{userDataDir}/texture_replacements/"` — substitutes the
   *     parent `GameEntry.userDataDir`, then expands `~/` and
   *     applies the same `$HOME` gate. Use this for mods that
   *     write into the engine's per-user data dir so the path
   *     stays declared once on the game manifest.
   */
  installSubdir?: string;
  /** Optional path (relative to
   *  `plugins/recomp/games/<gameId>/mods/<modId>/`) to a setup.ts
   *  that owns the install. Same shape as the per-game setup
   *  pattern for `build_from_source` entries. Required when the
   *  mod needs anything beyond "extract → cp -r into a subdir"
   *  (e.g. chmod a binary, drop a desktop file, edit a config). */
  setupModule?: string;
  /** Required when `source.kind === "manual-import"` — the URL the
   *  "Open page" button hands to quick-links. Optional otherwise but
   *  encouraged so users can read the mod's home page. */
  externalUrl?: string;
  /** Optional URL for the card thumbnail. Placeholder shown otherwise. */
  previewImageUrl?: string;
  /** Optional pre-known size in bytes. Direct-URL / github-release
   *  generally don't know this up-front; gamebanana exposes it in
   *  its mod listing. Empty = "Size: —" on the card. */
  sizeBytes?: number;
}

/** Per-mod install record persisted under `InstalledGame.installedMods`. */
export interface InstalledModEntry {
  installedAt: string;
  version?: string;
  /** Kept so the UI can tell which RPC retry path applies (e.g. a
   *  manual-import mod doesn't get a re-Install button, just
   *  Re-import). */
  source: ModSource["kind"];
}

/**
 * Manual-import descriptor for a game whose release can't be fetched
 * headless — the upstream gates downloads behind a browser challenge
 * and/or expiring signed URLs (IndieDB / ModDB via DBolical). The
 * catalog UI replaces the Install button with "Open download page"
 * (handed to quick-links) + "Import from disk" (the in-overlay file
 * picker), and the install pipeline extracts the user-picked archive
 * instead of downloading `latestAssetUrl`. `installType` stays
 * "prebuilt" — only the bytes' provenance differs.
 */
export interface GameManualImport {
  /** URL the "Open download page" button hands to quick-links so the
   *  user's browser shortcut opens the upstream download page. */
  pageUrl: string;
  /** Archive extensions the import file picker filters to. Defaults to
   *  all extractor-supported formats when unset. */
  acceptExtensions?: string[];
}

export interface GameEntry {
  id: string;
  name: string;
  project: string;
  platform: Platform;
  repo: string;
  description: string;
  installType: InstallType;
  releaseAssets: PlatformAssets;
  launchCommand: PlatformCommand;
  romInfo?: RomInfo;
  toolchain?: ToolchainInfo;
  /** True when the entry needs a user-supplied ROM. Sourced from
   *  `Manifest.requiresRom` for directory-scanned entries. The
   *  install pipeline + UI gate the ROM picker on this. */
  requiresRom?: boolean;
  coverArt?: string;
  steamGridDbId?: number;
  tags: string[];
  website?: string;
  versionPattern?: string;
  preservePaths?: string[];
  releaseChecksums?: Record<string, string>;
  /**
   * Optional expected SHA-256 of the release asset, per platform.
   * When present for the resolved platform, the download pipeline
   * verifies the downloaded file's hash before extraction and aborts
   * on mismatch. Hex digest, optionally `sha256:`-prefixed, matched
   * case-insensitively. Sourced from `Manifest.releaseSha256` for
   * directory-scanned entries; bundled `games.json` entries leave it
   * unset until a real checksum is recorded.
   */
  releaseSha256?: PlatformAssets;
  status?: string;
  latestVersion?: string;
  latestAssetUrl?: PlatformAssets;
  /**
   * Extra hostnames the download pipeline accepts as the FINAL
   * (post-redirect) host of a release-asset download, ON TOP of the
   * GitHub defaults. Only needed for non-GitHub `latestAssetUrl`
   * downloads — e.g. a ModDB / IndieDB mirror link, which 302s to a
   * DBolical-hosted file server. Leave unset for the GitHub-hosted
   * majority; the pipeline always allows the GitHub object CDN.
   */
  downloadHosts?: string[];
  /**
   * Local filename to save the downloaded asset as, overriding the
   * default (the basename of the resolved asset URL). Required when
   * that URL ends in an opaque token with no file extension — ModDB /
   * IndieDB mirror links look like `/downloads/mirror/<id>/<n>/<hash>`
   * — because `extractArchive` picks the unpacker by file extension.
   */
  downloadFilename?: string;
  /**
   * When set, the game has no headless-downloadable asset; the user
   * supplies the archive via the in-overlay importer. See
   * `GameManualImport`. The install pipeline branches on this before
   * resolving any `latestAssetUrl` / GitHub download.
   */
  manualImport?: GameManualImport;
  /** Engine's per-user data dir on Linux. See `Manifest.userDataDir`. */
  userDataDir?: string;
  /** Optional mods/extras catalog for this game (see `Manifest.mods`). */
  mods?: ModEntry[];
}

export interface Registry {
  version: number;
  games: GameEntry[];
}

// ── State Types ──────────────────────────────────────────────────────

export interface InstalledGame {
  installedVersion: string;
  installedAt: string;
  updatedAt: string;
  installDir: string;
  romPath?: string;
  addedToSteam: boolean;
  // Populated when `addedToSteam: true`. `steamAppId` is the 32-bit
  // uint Steam assigns to the shortcut; `steamGameId64` is the
  // 64-bit form used by `steam://rungameid/<id>` and as the
  // grid-folder filename stem.
  steamAppId?: number;
  steamGameId64?: string;
  /** Which platform the install actually came from. `"windows"` on
   *  a Linux host means the binary is a .exe and the Steam shortcut
   *  was registered with Proton as the compat tool. Optional for
   *  backwards-compat with state files written before this field
   *  existed (assumed = current platform when absent). */
  installedPlatform?: "linux" | "windows";
  /** For `build_from_source` installs, the launch command the
   *  recipe (or the auto-generated distrobox wrapper) declared.
   *  Persisted so `addInstalledToSteam` can re-register the
   *  shortcut after a steam-loader restart without needing the
   *  registry entry to remember it. Absolute path or template
   *  with `{installDir}` token. Empty for prebuilt installs. */
  launchCommand?: string;
  /** Installed mods, keyed by ModEntry.id. Empty / absent when no
   *  mods have been installed. The base game's reinstall pipeline
   *  blows the install dir away, taking mods with it — we don't
   *  carry these across reinstall; the field gets cleared together
   *  with the rest of the entry. */
  installedMods?: Record<string, InstalledModEntry>;
}

export interface Settings {
  autoAddToSteam: boolean;
  updateCheckInterval: number;
  romDirectory?: string;
}

export interface PersistedState {
  version: number;
  installPath: string;
  games: Record<string, InstalledGame>;
  settings: Settings;
  /** Per-game ROM paths the user has picked, keyed by game id.
   *  Persisted independently of `games` so the path survives
   *  across uninstall/reinstall cycles AND is set the moment the
   *  picker resolves (not only when an install completes), so the
   *  user doesn't have to re-pick after a failed install. */
  romPaths?: Record<string, string>;
}

// ── Frontend-facing Types ────────────────────────────────────────────

export type GameStatus =
  | "available"
  | "installed"
  | "update_available"
  | "installing"
  | "updating"
  | "unavailable"
  | "in_progress";

export interface GameInfo extends GameEntry {
  installedVersion?: string;
  hasUpdate: boolean;
  gameStatus: GameStatus;
  hasNativeBuild: boolean;
  // Populated from `InstalledGame` for the tile/detail UI — used to
  // toggle between "Add to Steam" and "Play" actions, and to build
  // the loader-local artwork URL via `steamArtworkUrls(steamAppId)`.
  addedToSteam: boolean;
  steamAppId?: number;
  steamGameId64?: string;
}

export type ModStatus = "not_installed" | "installing" | "installed";

/** UI-facing mod descriptor — `ModEntry` plus install-state. */
export interface ModInfo extends ModEntry {
  status: ModStatus;
  installedAt?: string;
  /** Version recorded on disk for the installed copy — may be the
   *  catalog's `version` or a filename-parsed version from the
   *  downloaded archive. Surface alongside `installedAt` on the
   *  mod card. Undefined for in-progress / not-installed mods. */
  installedVersion?: string;
}

// ── Pipeline Events ──────────────────────────────────────────────────

export interface PipelineEvent {
  type: "progress" | "complete" | "error" | "rom_required";
  gameId: string;
  stage?: string;
  /** 0-100 inclusive. Always check with `!= null`, since 0 is a valid value. */
  percent?: number;
  message?: string;
  version?: string;
}

// ── GitHub API Types ─────────────────────────────────────────────────

export interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  assets: GitHubAsset[];
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
