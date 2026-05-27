import type {
  AuthStatus,
  InstalledGame,
  LaunchSpec,
  LibraryEntry,
  PipelineEmit,
  StoreId,
} from "../types";

/**
 * The store-driver seam. Every store the plugin surfaces (Epic today,
 * GOG / Amazon / Ubisoft / xCloud later) implements this. Nothing
 * outside `lib/stores/<id>/` should know what CLI / API a given
 * store actually uses — the backend just talks to the driver.
 */
export interface StoreDriver {
  /** Stable id, doubles as the `state.stores` key. */
  id: StoreId;
  /** Human-readable label rendered in chips, headers, etc. Also doubles
   *  as the Steam user-tag so shortcuts auto-group as a collection. */
  displayName: string;

  /**
   * Cheap probe: does this driver have what it needs to operate?
   * Returns missing tool names + whether the driver knows how to
   * fetch them itself via `selfInstall()`.
   */
  preflight(): Promise<PreflightResult>;

  /**
   * Fetch any missing tooling the driver depends on (e.g. legendary
   * for Epic). Optional: streaming stores like xCloud or pure-API
   * drivers have nothing to install. Callers gate on the presence
   * of this method.
   */
  selfInstall?(emit: PipelineEmit): Promise<void>;

  /** Current auth state with the upstream store. */
  authStatus(): Promise<AuthStatus>;

  /**
   * Start an OAuth flow. Returns the URL the user has to open in a
   * browser; the backend hands it to the gaming-mode-browser plugin
   * via cross-plugin RPC. After login the user pastes a code into
   * the UI, which calls `completeAuth`. Optional — drivers that
   * authenticate through a different channel (device code, etc.)
   * omit this and the UI doesn't render the sign-in panel.
   */
  startAuth?(): Promise<{ url: string }>;

  /** Finish OAuth with the code the user pasted back. Optional —
   *  pairs with `startAuth`. */
  completeAuth?(code: string): Promise<void>;

  /** Sign out — clears any locally cached auth tokens. */
  signOut?(): Promise<void>;

  /** Owned library, fetched live from the store. */
  listLibrary(): Promise<LibraryEntry[]>;

  /** Install a title; streams progress through `emit`. */
  install(
    gameId: string,
    installDir: string,
    emit: PipelineEmit,
  ): Promise<InstalledGame>;

  /** Uninstall a title. Driver decides whether the directory is wiped. */
  uninstall(gameId: string, installDir: string): Promise<void>;

  /**
   * Describe how to launch this install via a Steam shortcut. Steam
   * runs the produced `exe args` after the shortcut is added — the
   * driver decides whether that's a wrapped `legendary launch <id>`
   * or a direct exe.
   */
  launchSpec(installed: InstalledGame): LaunchSpec;

  /**
   * Look at a directory and tell us whether it's an install belonging
   * to this store. Used by the scan-for-installs feature. Should be
   * cheap — the walker calls it for every dir it visits. Optional —
   * streaming stores have no on-disk install to identify.
   */
  identifyInstall?(dir: string): Promise<{ id: string; title: string } | null>;

  /**
   * Import an existing install (skip the download). Optional, pairs
   * with `identifyInstall` — a driver that can't identify also has
   * nothing to import.
   */
  importExisting?(
    gameId: string,
    dir: string,
    emit: PipelineEmit,
  ): Promise<InstalledGame>;

  /**
   * Re-query the store/CLI for an existing install's launch metadata
   * (executable, launch parameters, platform). Used by the backend's
   * Add-to-Steam path so records persisted before we started caching
   * this can be repaired without forcing a full reinstall.
   *
   * Returns the patched fields only — caller merges them onto the
   * stored record (preserving `addedToSteam` / `steamAppId` etc).
   * `null` means the driver couldn't refresh (e.g. CLI missing).
   */
  refreshLaunchMetadata?(installed: InstalledGame): Promise<InstalledGame | null>;

  /**
   * Estimate download + on-disk size for a title that isn't installed
   * yet. Used by the detail view to tell the user "this'll be 24 GB"
   * before they hit Install. Returns null when the driver can't
   * fetch this (CLI missing, network down, store doesn't expose it).
   */
  getRemoteSize?(gameId: string): Promise<RemoteSizeEstimate | null>;

  /**
   * Cancel an in-flight install. Signals the underlying download
   * process, then wipes the partial install dir + any store-side
   * resume marker (`~/.config/legendary/tmp/<AppName>.resume` for
   * Epic). Returns `true` when something was cancelled, `false`
   * when no in-flight install for this gameId existed.
   */
  cancelInstall?(gameId: string, installDir: string): Promise<boolean>;
}

export interface RemoteSizeEstimate {
  /** Bytes downloaded over the network (after compression / patching). */
  downloadSize?: number;
  /** Bytes the install will occupy on disk after completion. */
  installSize?: number;
  /** Version string reported by the manifest. */
  version?: string;
}

export interface PreflightResult {
  ok: boolean;
  /** Tool names the driver needs but couldn't find. */
  missing: string[];
  /** True if `selfInstall()` knows how to fetch the missing tools. */
  canSelfInstall: boolean;
  /** Human-readable hint when self-install isn't possible. */
  installHint?: string;
}
