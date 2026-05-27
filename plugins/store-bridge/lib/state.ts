import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configDir, gamesDir } from "./platform";
import type {
  PersistedState,
  Settings,
  StoreId,
  StoreState,
  InstalledGame,
} from "./types";

const STATE_FILE = "state.json";

export function defaultStoreState(_storeId: StoreId): StoreState {
  return {
    libraryCacheFetchedAt: 0,
    library: {},
    installed: {},
    authStatus: "unknown",
  };
}

export function defaultSettings(): Settings {
  return {
    autoAddToSteam: true,
    enabledStores: ["epic"],
    driverOverrides: {},
    scanPaths: [],
  };
}

export function defaultState(): PersistedState {
  return {
    version: 1,
    stores: {
      epic: defaultStoreState("epic"),
    },
    settings: defaultSettings(),
  };
}

/**
 * Load + shape-normalise state.json. Missing keys (because the user
 * upgraded from an earlier version) get filled with defaults rather
 * than left undefined, so callers never have to guard with `?? {}`.
 */
export async function loadState(): Promise<PersistedState> {
  const path = join(configDir(), STATE_FILE);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const defaults = defaultState();
    const stores = { ...defaults.stores };
    if (parsed.stores) {
      for (const [id, st] of Object.entries(parsed.stores)) {
        if (!st) continue;
        const sid = id as StoreId;
        const base = defaults.stores[sid] ?? defaultStoreState(sid);
        stores[sid] = {
          ...base,
          ...st,
          library: st.library ?? {},
          installed: st.installed ?? {},
        };
      }
    }
    // Settings shape migration: `legendaryBinary` was a flat field
    // before driver overrides existed. Hoist any persisted value
    // into the new `driverOverrides.epic.binary` slot so the rest
    // of the codebase can read one location.
    const settings: Settings = { ...defaults.settings, ...parsed.settings };
    if (
      settings.legendaryBinary &&
      !settings.driverOverrides?.epic?.binary
    ) {
      settings.driverOverrides = {
        ...settings.driverOverrides,
        epic: {
          ...settings.driverOverrides?.epic,
          binary: settings.legendaryBinary,
        },
      };
    }
    delete settings.legendaryBinary;
    return {
      version: 1,
      stores,
      settings,
    };
  } catch {
    return defaultState();
  }
}

/**
 * FIFO write queue — identical pattern to plugins/recomp/lib/state.ts.
 * Without it, two concurrent saveState callers can interleave their
 * atomic-write-and-rename sequences and produce a torn state.json.
 * Logical race on the in-memory snapshot is not protected by this
 * queue; callers must serialise their own reads if they care.
 */
let writeQueue: Promise<void> = Promise.resolve();

export async function saveState(state: PersistedState): Promise<void> {
  const next = writeQueue.then(async () => {
    const dir = configDir();
    await mkdir(dir, { recursive: true });
    const path = join(dir, STATE_FILE);
    const tmpPath = path + ".tmp";
    await writeFile(tmpPath, JSON.stringify(state, null, 2));
    await rename(tmpPath, path);
  });
  writeQueue = next.catch(() => {});
  return next;
}

function withStore(
  state: PersistedState,
  storeId: StoreId,
  patch: (s: StoreState) => StoreState,
): PersistedState {
  const current = state.stores[storeId] ?? defaultStoreState(storeId);
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

/** Re-export for callers that need the canonical install root. */
export { gamesDir };
