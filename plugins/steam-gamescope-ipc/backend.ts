import type { PluginBackend, EmitPayload } from "@loadout/types";

/**
 * Steam Gamescope IPC plugin — frontend-only display of the currently
 * running game and recent sessions. Game detection itself moved to the
 * core `__core:game-detection` service in the loader, so this backend
 * no longer owns any state. It exists to satisfy the manifest and to
 * provide a clear "lifted to core" trail.
 */
export default class SteamGamescopeIpcBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  async onLoad(): Promise<void> {
    console.log(
      "[steam-gamescope-ipc] Plugin loaded — game state served by __core:game-detection",
    );
  }
}
