/**
 * Shape of the JSON `legendary` outputs on its various commands.
 * Only the fields we actually consume are typed — legendary's blobs
 * are richer than this and that's fine.
 */

export interface LegendaryListEntry {
  app_name: string;
  app_title: string;
  metadata?: {
    title?: string;
    description?: string;
    longDescription?: string;
    developer?: string;
    publisher?: string;
    creationDate?: string;
    keyImages?: Array<{ type: string; url: string; width?: number; height?: number }>;
    categories?: Array<{ path: string }>;
    releaseInfo?: Array<{
      appId?: string;
      id?: string;
      platform?: string[];
      dateAdded?: string;
    }>;
  };
}

export interface LegendaryInstalledEntry {
  app_name: string;
  title: string;
  version?: string;
  install_path: string;
  install_size?: number;
  is_dlc?: boolean;
  /** Path to the launch exe, relative to install_path. e.g. "Alba.exe". */
  executable?: string;
  /** Extra CLI args appended after the exe at launch time. */
  launch_parameters?: string;
  /** Either "Win32" / "Win64" / "Mac" / "Linux" — surfaces on the
   *  install metadata. legendary normalises to "Windows" / etc. */
  platform?: string;
}

export interface LegendaryInfoEntry {
  game?: { app_name?: string; title?: string; version?: string };
  manifest?: {
    download_size?: number;
    disk_size?: number;
    version?: number;
    build_version?: string;
    launch_exe?: string;
    launch_command?: string;
    num_files?: number;
  };
  install?: {
    app_name?: string;
    title?: string;
    version?: string;
    install_path?: string;
    install_size?: number;
    executable?: string;
    launch_parameters?: string;
    platform?: string;
  };
}
