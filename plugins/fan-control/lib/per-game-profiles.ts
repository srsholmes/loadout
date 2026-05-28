/**
 * Per-game profile engine — inlined into fan-control.
 *
 * In the old Steam Loader repo this lived in a shared workspace package
 * (`@steam-loader/per-game-profiles`). Per the Loadout migration rule
 * ("better to repeat a little code than to hastily abstract"), the
 * slice fan-control actually uses is inlined here rather than promoted
 * to a shared `packages/*`. tdp-control is migrating in a parallel PR
 * and keeps its own copy — extraction is a cheap follow-up once two
 * already-merged plugins genuinely share an identical helper.
 *
 * What fan-control uses:
 *   - `createPerGameEngine` — the {profiles, perGameEnabled, snapshot,
 *     boundAppId} state machine, with apply/snapshot/restore callbacks.
 *   - `createPluginStoragePersistence` — load/save backed by a single
 *     JSON file under the user's config dir (see `./plugin-storage`).
 */

import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";

// ---------------------------------------------------------------------------
// Per-game profile engine (inlined from @steam-loader/per-game-profiles)
// ---------------------------------------------------------------------------

/** A stored profile entry: which game it's for + the plugin-specific payload. */
export interface GameProfile<P> {
  appId: number;
  gameName: string;
  payload: P;
}

/** The state shape the engine load/save callbacks deal in. */
export interface PerGameState<P> {
  perGameEnabled: boolean;
  profiles: GameProfile<P>[];
}

export interface PerGameEnginePersistence<P> {
  /** Read the persisted state. Called once during `engine.load()`. */
  load: () => Promise<PerGameState<P>>;
  /**
   * Write the persisted state. Called after every mutation
   * (setProfile / removeProfile / setPerGameEnabled). Plugins that
   * cohabit per-game state with other keys in the same storage file
   * are responsible for read-modify-writing inside this callback.
   */
  save: (state: PerGameState<P>) => Promise<void>;
}

export interface PerGameEngineOptions<P, S> {
  /** Load + save callbacks. Use `createPluginStoragePersistence` for
   *  the common case of a single plugin-storage JSON file. */
  persistence: PerGameEnginePersistence<P>;
  /**
   * Apply the profile's payload to the world. Called inside
   * `handleGameLaunch` AFTER the snapshot is taken.
   */
  onApply: (payload: P, ctx: { appId: number; gameName: string }) => Promise<void>;
  /** Snapshot the current state. Saved internally so `onRestore` can revert. */
  onSnapshot: () => Promise<S>;
  /** Restore the previously snapshotted state. Called from `handleGameExit`. */
  onRestore: (snapshot: S) => Promise<void>;
  /**
   * Optional gate. If returns `false`, `handleGameLaunch` is a no-op
   * for this tick (e.g., the plugin's hardware isn't ready). The
   * `perGameEnabled` toggle is checked separately.
   */
  guard?: () => boolean;
  /**
   * Optional callback fired whenever the active profile changes — both
   * the launch and exit edges. Use it to emit a UI event.
   */
  onActiveChanged?: (active: GameProfile<P> | null) => void;
}

export interface PerGameEngine<P> {
  /** Load persisted state. Call once in the plugin's `onLoad`. */
  load: () => Promise<void>;
  /** Steam game launched — apply matching profile if one exists + perGameEnabled. */
  handleGameLaunch: (appId: number, gameName: string) => Promise<void>;
  /** Steam game exited — restore snapshot if this appId is bound. */
  handleGameExit: (appId: number) => Promise<void>;
  /** Read APIs for RPC handlers / UI. */
  getProfile: (appId: number) => GameProfile<P> | null;
  getProfiles: () => GameProfile<P>[];
  getActiveAppId: () => number | null;
  isPerGameEnabled: () => boolean;
  /** Write APIs — each one persists before returning. */
  setProfile: (appId: number, gameName: string, payload: P) => Promise<GameProfile<P>>;
  removeProfile: (appId: number) => Promise<void>;
  setPerGameEnabled: (enabled: boolean) => Promise<void>;
}

export function createPerGameEngine<P, S>(
  opts: PerGameEngineOptions<P, S>,
): PerGameEngine<P> {
  let profiles: GameProfile<P>[] = [];
  let perGameEnabled = false;
  let preGameSnapshot: S | null = null;
  let boundAppId: number | null = null;

  async function persist(): Promise<void> {
    await opts.persistence.save({ perGameEnabled, profiles });
  }

  function emitActive(): void {
    if (!opts.onActiveChanged) return;
    const active = boundAppId !== null
      ? (profiles.find((p) => p.appId === boundAppId) ?? null)
      : null;
    opts.onActiveChanged(active);
  }

  return {
    async load() {
      const state = await opts.persistence.load();
      perGameEnabled = Boolean(state.perGameEnabled);
      profiles = Array.isArray(state.profiles) ? state.profiles : [];
    },

    async handleGameLaunch(appId, gameName) {
      if (!perGameEnabled) return;
      if (opts.guard && !opts.guard()) return;
      const profile = profiles.find((p) => p.appId === appId);
      if (!profile) return;

      preGameSnapshot = await opts.onSnapshot();
      boundAppId = appId;
      await opts.onApply(profile.payload, { appId, gameName });
      emitActive();
    },

    async handleGameExit(appId) {
      if (boundAppId !== appId) return;
      const snapshot = preGameSnapshot;
      boundAppId = null;
      preGameSnapshot = null;
      if (snapshot !== null) {
        await opts.onRestore(snapshot);
      }
      emitActive();
    },

    getProfile(appId) {
      const found = profiles.find((p) => p.appId === appId);
      return found ? { ...found } : null;
    },

    getProfiles() {
      return profiles.map((p) => ({ ...p }));
    },

    getActiveAppId() {
      return boundAppId;
    },

    isPerGameEnabled() {
      return perGameEnabled;
    },

    async setProfile(appId, gameName, payload) {
      const next: GameProfile<P> = { appId, gameName, payload };
      const idx = profiles.findIndex((p) => p.appId === appId);
      if (idx === -1) profiles.push(next);
      else profiles[idx] = next;
      await persist();
      return { ...next };
    },

    async removeProfile(appId) {
      const before = profiles.length;
      profiles = profiles.filter((p) => p.appId !== appId);
      if (profiles.length !== before) await persist();
      // If the active profile was removed, we still keep boundAppId so
      // handleGameExit can fire onRestore. The next launch with a
      // different appId clears it.
    },

    async setPerGameEnabled(enabled) {
      perGameEnabled = enabled;
      await persist();
    },
  };
}

/**
 * Convenience factory for storing per-game state alongside other keys
 * in a single plugin-storage JSON file.
 *
 * The plugin's storage file ends up looking like:
 *
 *   {
 *     // ... other plugin state ...
 *     [enabledKey]: boolean,
 *     [profilesKey]: GameProfile<P>[],
 *   }
 *
 * The factory reads and merges back, so other top-level keys survive
 * every save. Profiles default to `[]` and the enabled flag defaults to
 * `false` on first load.
 */
export function createPluginStoragePersistence<P>(
  pluginId: string,
  opts: {
    /** Top-level key for the perGameEnabled flag. Default `"perGameEnabled"`. */
    enabledKey?: string;
    /** Top-level key for the profiles array. Default `"gameProfiles"`. */
    profilesKey?: string;
  } = {},
): PerGameEnginePersistence<P> {
  const enabledKey = opts.enabledKey ?? "perGameEnabled";
  const profilesKey = opts.profilesKey ?? "gameProfiles";
  return {
    async load() {
      const stored = await readPluginStorage<Record<string, unknown>>(pluginId);
      return {
        perGameEnabled: Boolean(stored[enabledKey]),
        profiles: Array.isArray(stored[profilesKey])
          ? (stored[profilesKey] as GameProfile<P>[])
          : [],
      };
    },
    async save(state) {
      const existing = await readPluginStorage<Record<string, unknown>>(pluginId);
      await writePluginStorage(pluginId, {
        ...existing,
        [enabledKey]: state.perGameEnabled,
        [profilesKey]: state.profiles,
      });
    },
  };
}
