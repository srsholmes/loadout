import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";
import type {
  PersistedState,
  Settings,
  StoreId,
  StoreState,
  InstalledGame,
} from "./types";

/**
 * Per-plugin storage id. The persisted JSON file lands at
 *   $XDG_CONFIG_HOME/loadout/plugins/store-bridge.json
 * via `@loadout/plugin-storage`, which is the canonical location
 * every other migrated plugin uses. Earlier iterations of this
 * plugin rolled their own `~/.config/loadout/store-bridge/state.json`
 * path; the migration review flagged that as a DoD slip.
 */
const PLUGIN_ID = "store-bridge";

export function defaultStoreState(): StoreState {
  return {
    libraryCacheFetchedAt: 0,
    library: {},
    installed: {},
    authStatus: "unknown",
  };
}

export function defaultSettings(): Settings {
  return {
    enabledStores: ["epic"],
    driverOverrides: {},
    scanPaths: [],
  };
}

export function defaultState(): PersistedState {
  return {
    version: 1,
    stores: {
      epic: defaultStoreState(),
    },
    settings: defaultSettings(),
  };
}

/**
 * Load + shape-normalise state. Missing keys (because the user
 * upgraded from an earlier version) get filled with defaults rather
 * than left undefined, so callers never have to guard with `?? {}`.
 *
 * Storage is routed through `@loadout/plugin-storage`, which returns
 * `{}` on missing/unparseable files — the merge below treats that the
 * same as "fresh install".
 */
export async function loadState(): Promise<PersistedState> {
  const parsed = await readPluginStorage<PersistedState>(PLUGIN_ID);
  const defaults = defaultState();
  const stores = { ...defaults.stores };
  if (parsed.stores) {
    for (const [id, st] of Object.entries(parsed.stores)) {
      if (!st) continue;
      const sid = id as StoreId;
      const base = defaults.stores[sid] ?? defaultStoreState();
      stores[sid] = {
        ...base,
        ...st,
        library: st.library ?? {},
        installed: st.installed ?? {},
      };
    }
  }
  return {
    version: 1,
    stores,
    settings: { ...defaults.settings, ...parsed.settings },
  };
}

/**
 * Persist state. `@loadout/plugin-storage` handles the atomic
 * tmp + rename internally so a crash mid-write never tears the
 * file. Concurrent writers are serialised one level up via the
 * backend's `stateMutex`.
 */
export async function saveState(state: PersistedState): Promise<void> {
  await writePluginStorage<PersistedState>(PLUGIN_ID, state);
}

function withStore(
  state: PersistedState,
  storeId: StoreId,
  patch: (s: StoreState) => StoreState,
): PersistedState {
  const current = state.stores[storeId] ?? defaultStoreState();
  return {
    ...state,
    stores: { ...state.stores, [storeId]: patch(current) },
  };
}

export async function updateInstalledGame(
  state: PersistedState,
  storeId: StoreId,
  gameId: string,
  game: InstalledGame,
): Promise<PersistedState> {
  const next = withStore(state, storeId, (s) => ({
    ...s,
    installed: { ...s.installed, [gameId]: game },
  }));
  await saveState(next);
  return next;
}

export async function removeInstalledGame(
  state: PersistedState,
  storeId: StoreId,
  gameId: string,
): Promise<PersistedState> {
  const next = withStore(state, storeId, (s) => {
    const { [gameId]: _, ...rest } = s.installed;
    return { ...s, installed: rest };
  });
  await saveState(next);
  return next;
}

export async function updateStoreLibrary(
  state: PersistedState,
  storeId: StoreId,
  library: StoreState["library"],
): Promise<PersistedState> {
  const next = withStore(state, storeId, (s) => ({
    ...s,
    library,
    libraryCacheFetchedAt: Date.now(),
  }));
  await saveState(next);
  return next;
}

export async function updateAuthStatus(
  state: PersistedState,
  storeId: StoreId,
  authStatus: StoreState["authStatus"],
): Promise<PersistedState> {
  const next = withStore(state, storeId, (s) => ({ ...s, authStatus }));
  await saveState(next);
  return next;
}

export async function updateSettings(
  state: PersistedState,
  patch: Partial<Settings>,
): Promise<PersistedState> {
  // Defence-in-depth: normalise pinnedVersion at the persistence
  // boundary too. The UI strips + caps before send, but raw RPC
  // callers can bypass it. Strip control chars + whitespace + cap
  // at 64 so state.json never holds garbage that would 404 on
  // every Reinstall.
  const normalised = normaliseSettingsPatch(patch);
  const next: PersistedState = {
    ...state,
    settings: { ...state.settings, ...normalised },
  };
  await saveState(next);
  return next;
}

function normaliseSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
  const driverOverrides = patch.driverOverrides;
  if (!driverOverrides) return patch;
  const out: Partial<Settings> = { ...patch, driverOverrides: { ...driverOverrides } };
  const epic = driverOverrides.epic;
  if (epic && typeof epic.pinnedVersion === "string") {
    const cleaned = epic.pinnedVersion
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, "")
      .slice(0, 64);
    out.driverOverrides = {
      ...driverOverrides,
      epic: { ...epic, pinnedVersion: cleaned },
    };
  }
  return out;
}

export async function addScanPath(
  state: PersistedState,
  path: string,
): Promise<PersistedState> {
  if (state.settings.scanPaths.includes(path)) return state;
  return updateSettings(state, {
    scanPaths: [...state.settings.scanPaths, path],
  });
}

export async function removeScanPath(
  state: PersistedState,
  path: string,
): Promise<PersistedState> {
  return updateSettings(state, {
    scanPaths: state.settings.scanPaths.filter((p) => p !== path),
  });
}
