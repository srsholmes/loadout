/**
 * @loadout/vdf — Valve Data Format parsing, serialization, and surgical editing.
 *
 * VDF is used by Steam config files (localconfig.vdf, libraryfolders.vdf, appmanifest_*.acf).
 *
 * Also exposes launch-options string surgery (`appendLaunchToken` and friends)
 * since that's a thin layer over the same VDF mutation primitives.
 */
export {
  parseVdf,
  serializeVdf,
  patchVdfValue,
  removeVdfKey,
  type VdfNode,
  type VdfObject,
} from "./vdf";

export {
  appendLaunchToken,
  removeLaunchToken,
  hasLaunchToken,
  type LaunchTokenOpts,
} from "./launch-options";

export {
  parseBinaryVdf,
  shortcutGameId64,
  type BinaryVdfObject,
  type BinaryVdfValue,
} from "./binary-vdf";
