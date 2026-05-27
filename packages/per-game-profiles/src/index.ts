/**
 * Generic per-game profile engine.
 *
 * Three plugins (tdp-control, fan-control, audio-mixer) each maintained
 * their own copy of "store-a-profile-per-Steam-appId, snapshot the
 * pre-game state on launch, restore it on exit". The audit (2026-05
 * D-001 cross-domain candidate) flagged this as a single pattern with
 * three implementations.
 *
 * The shape every consumer needed:
 *
 *   - A list of `{ appId, gameName, payload }` profiles persisted to
 *     plugin storage.
 *   - A `perGameEnabled` toggle so the user can keep their profiles
 *     stored but skip applying them on launch.
 *   - On `handleGameLaunch(appId, gameName)`: find the matching profile,
 *     snapshot the current state (mode/volume/sink/etc.), apply the
 *     profile's payload, remember which app is bound so exit can revert
 *     to the correct snapshot.
 *   - On `handleGameExit(appId)`: if it matches the bound app, restore
 *     the snapshot, clear bound state.
 *   - CRUD over the profile list and a "what's active right now?" probe.
 *
 * The differences across plugins:
 *
 *   - The payload type — `{ tdpWatts: number }` vs `{ mode, speed }` vs
 *     `{ defaultSinkName, perAppVolumes }`. Parameterised as `P`.
 *   - The snapshot type — what each plugin needs to remember to restore
 *     pre-game state. Parameterised as `S`.
 *   - The apply / snapshot / restore operations — passed as callbacks.
 *   - The persistence shape on disk. Persistence is passed as a `load` +
 *     `save` callback pair so each plugin keeps its existing JSON
 *     layout. Audio-mixer for example stores `apps` at the top level
 *     alongside `perGameEnabled` and `gameProfiles`; fan-control's file
 *     is just per-game state. The engine doesn't pick the shape.
 *   - An optional `guard()` that returns false to skip launch handling
 *     when hardware isn't ready (e.g., fan-control with no PWM device).
 *
 * `createPluginStoragePersistence(pluginId, { enabledKey, profilesKey })`
 * is a convenience factory for the common case where the plugin's
 * `@loadout/plugin-storage` file already has `perGameEnabled` and
 * `<something>Profiles` as top-level keys. Plugins with a different
 * layout pass their own load/save pair.
 *
 * tdp-control deliberately doesn't migrate yet — its `tdp-profiles.ts`
 * carries a TDP-specific debounce queue + ROG Ally SMT workarounds that
 * would need separate handling. TODO in plugins/tdp-control/lib/.
 */

import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";

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
   *  the common case of `@loadout/plugin-storage`. */
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
 * Convenience factory for plugins that store per-game state alongside
 * other keys in a single `@loadout/plugin-storage` JSON file.
 *
 * The plugin's storage file ends up looking like:
 *
 *   {
 *     // ... other plugin state ...
 *     [enabledKey]: boolean,
 *     [profilesKey]: GameProfile<P>[],
 *   }
 *
 * The factory reads and merges back, so other top-level keys (e.g.
 * audio-mixer's `apps`) survive every save. Profiles default to `[]`
 * and the enabled flag defaults to `false` on first load.
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
