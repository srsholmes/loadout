import { renameSync } from "node:fs";
import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TdpProfile {
  appId: number;
  gameName: string;
  tdpWatts: number; // 3-80
}

export interface TdpProfileStore {
  /** Schema version. Bumped when the shape changes. */
  version: 1;
  /** TDP applied when no game is running, or when a game has no profile. */
  defaultTdp: number;
  /** Per-game saved TDP. */
  profiles: TdpProfile[];
  /** When false, game launch/exit doesn't override the user's manual TDP. */
  perGameEnabled: boolean;
}

export interface TdpProfileEngineState {
  activeProfile: TdpProfile | null;
  currentTdp: number;
  isGameRunning: boolean;
  perGameEnabled: boolean;
}

export interface TdpProfileEngineOptions {
  /**
   * Persistence target. Either:
   * - `pluginId` — uses the inlined plugin-storage helper to write to
   *   `~/.config/loadout/plugins/<pluginId>.json`.
   * - `configPath` — explicit JSON path, used by unit tests.
   * Exactly one must be set.
   */
  pluginId?: string;
  configPath?: string;
  /** Apply TDP via the polkit helper. */
  onApplyTdp: (watts: number) => Promise<void>;
  /** Notify the UI that the active profile changed. */
  onProfileChanged: (profile: TdpProfile | null, gameName: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_TDP_WATTS = 3;
const MAX_TDP_WATTS = 80;
const DEFAULT_TDP_WATTS = 15;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampTdp(watts: number): number {
  return Math.max(MIN_TDP_WATTS, Math.min(MAX_TDP_WATTS, Math.round(watts)));
}

function createDefaultStore(): TdpProfileStore {
  return {
    version: 1,
    defaultTdp: DEFAULT_TDP_WATTS,
    profiles: [],
    perGameEnabled: false,
  };
}

function normalizeStore(parsed: unknown): TdpProfileStore | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Partial<TdpProfileStore>;
  if (typeof obj.defaultTdp !== "number" || !Array.isArray(obj.profiles)) {
    return null;
  }
  const profiles = obj.profiles
    .filter(
      (p: unknown): p is TdpProfile =>
        !!p &&
        typeof p === "object" &&
        typeof (p as TdpProfile).appId === "number" &&
        typeof (p as TdpProfile).gameName === "string" &&
        typeof (p as TdpProfile).tdpWatts === "number",
    )
    .map((p) => ({
      appId: p.appId,
      gameName: p.gameName,
      tdpWatts: clampTdp(p.tdpWatts),
    }));
  return {
    version: 1,
    defaultTdp: clampTdp(obj.defaultTdp),
    profiles,
    perGameEnabled: typeof obj.perGameEnabled === "boolean" ? obj.perGameEnabled : false,
  };
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

export function createTdpProfileEngine(options: TdpProfileEngineOptions) {
  const { pluginId, configPath, onApplyTdp, onProfileChanged } = options;
  if ((!pluginId && !configPath) || (pluginId && configPath)) {
    throw new Error(
      "createTdpProfileEngine: exactly one of `pluginId` or `configPath` must be provided",
    );
  }

  let store: TdpProfileStore = createDefaultStore();
  let activeProfile: TdpProfile | null = null;
  let currentTdp: number = DEFAULT_TDP_WATTS;
  let isGameRunning = false;
  let activeAppId: number | null = null;

  // -------------------------------------------------------------------------
  // Hardware-write queue
  //
  // Game focus changes arrive as back-to-back exit→launch pairs (the poller
  // sees Konsole disappear, then Cyberpunk appear, in two ticks ~ms apart).
  // If we naively forward each one to ryzenadj/RAPL, two hardware writes
  // race for the same SMU mailbox — that's a documented cause of AMD APU
  // hangs (the user's freezing-game-with-audio-still-playing symptom).
  //
  // commitTdp() collapses bursts into a single, never-concurrent write:
  //   - 250 ms debounce: a new call cancels any pending write and reschedules
  //     with the latest target. The exit's defaultTdp gets superseded by the
  //     launch's profile-watts before either touches the hardware.
  //   - Serialized fire: at most one onApplyTdp() in flight; subsequent
  //     commits wait for it to finish.
  //
  // We deliberately do NOT cache "last applied watts" for idempotency.
  // The backend's setTdp() (driven by the slider) writes to hardware
  // without going through this queue, so any cache here drifts out of
  // sync with reality and silently skips writes the user actually
  // wanted (e.g. slider-set 50W → focus change → "already at 11W" skip
  // leaves hardware at 50W). One redundant ryzenadj per focus change is
  // cheap; staleness is a real correctness bug.
  // -------------------------------------------------------------------------

  const COMMIT_DEBOUNCE_MS = 250;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTarget: number | null = null;
  let pendingResolvers: Array<() => void> = [];
  let inFlight: Promise<void> = Promise.resolve();

  function commitTdp(watts: number): Promise<void> {
    pendingTarget = watts;
    return new Promise<void>((resolve) => {
      pendingResolvers.push(resolve);
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        const target = pendingTarget;
        const resolvers = pendingResolvers;
        pendingTarget = null;
        pendingResolvers = [];
        inFlight = inFlight
          .catch(() => {})
          .then(async () => {
            if (target === null) return;
            try {
              await onApplyTdp(target);
            } catch (err) {
              console.error(
                `[tdp-profiles] commit failed for ${target}W: ${err}`,
              );
            }
          })
          .finally(() => {
            for (const r of resolvers) r();
          });
      }, COMMIT_DEBOUNCE_MS);
    });
  }

  // -------------------------------------------------------------------------
  // Persistence — strategy depends on which option was supplied.
  // -------------------------------------------------------------------------

  async function readRaw(): Promise<TdpProfileStore | null> {
    if (pluginId) {
      const data = await readPluginStorage<TdpProfileStore>(pluginId);
      // readPluginStorage returns {} on missing/invalid — treat that as "empty".
      return normalizeStore(data);
    }
    // configPath mode (tests).
    try {
      const file = Bun.file(configPath!);
      if (!(await file.exists())) return null;
      const text = await file.text();
      if (!text.trim()) return null;
      return normalizeStore(JSON.parse(text));
    } catch {
      return null;
    }
  }

  async function writeRaw(): Promise<void> {
    if (pluginId) {
      await writePluginStorage(pluginId, store);
      return;
    }
    // configPath mode (tests). Mirror the atomic-write semantics of the
    // plugin-storage helper so tests can verify .tmp + rename behavior.
    const tmpPath = configPath! + ".tmp";
    await Bun.write(tmpPath, JSON.stringify(store, null, 2));
    renameSync(tmpPath, configPath!);
  }

  async function loadProfiles(): Promise<void> {
    const loaded = await readRaw();
    store = loaded ?? createDefaultStore();
    currentTdp = store.defaultTdp;
  }

  async function saveProfiles(): Promise<void> {
    await writeRaw();
  }

  // -------------------------------------------------------------------------
  // Game lifecycle
  // -------------------------------------------------------------------------

  async function handleGameLaunch(
    appId: number,
    gameName: string,
  ): Promise<void> {
    isGameRunning = true;
    activeAppId = appId;

    const profile = store.profiles.find((p) => p.appId === appId);
    activeProfile = profile ?? null;

    // The engine still tracks which game is running so callers (e.g. the
    // UI's "save current TDP for this game" flow) know what's active —
    // but it only OVERRIDES the user's manual TDP when per-game profiles
    // are enabled.
    if (!store.perGameEnabled) {
      onProfileChanged(profile ?? null, gameName);
      return;
    }

    if (profile) {
      currentTdp = profile.tdpWatts;
      await commitTdp(profile.tdpWatts);
      onProfileChanged(profile, gameName);
    } else {
      currentTdp = store.defaultTdp;
      await commitTdp(store.defaultTdp);
      onProfileChanged(null, gameName);
    }
  }

  async function handleGameExit(_appId: number): Promise<void> {
    const wasEnabled = store.perGameEnabled;
    isGameRunning = false;
    activeAppId = null;
    activeProfile = null;

    if (!wasEnabled) {
      onProfileChanged(null, "");
      return;
    }

    currentTdp = store.defaultTdp;
    await commitTdp(store.defaultTdp);
    onProfileChanged(null, "");
  }

  // -------------------------------------------------------------------------
  // Profile CRUD
  // -------------------------------------------------------------------------

  async function setProfile(
    appId: number,
    gameName: string,
    tdpWatts: number,
  ): Promise<void> {
    const clamped = clampTdp(tdpWatts);
    const existing = store.profiles.find((p) => p.appId === appId);
    if (existing) {
      existing.gameName = gameName;
      existing.tdpWatts = clamped;
    } else {
      store.profiles.push({ appId, gameName, tdpWatts: clamped });
    }
    await saveProfiles();

    // Reflect the saved value if this game is currently running. Apply
    // hardware only when per-game is enabled — otherwise the user is
    // driving the slider themselves and we'd be fighting them.
    if (isGameRunning && activeAppId === appId) {
      activeProfile = { appId, gameName, tdpWatts: clamped };
      if (store.perGameEnabled) {
        currentTdp = clamped;
        await commitTdp(clamped);
      }
      onProfileChanged(activeProfile, gameName);
    }
  }

  async function removeProfile(appId: number): Promise<void> {
    store.profiles = store.profiles.filter((p) => p.appId !== appId);
    await saveProfiles();

    if (isGameRunning && activeAppId === appId) {
      activeProfile = null;
      if (store.perGameEnabled) {
        currentTdp = store.defaultTdp;
        await commitTdp(store.defaultTdp);
      }
      onProfileChanged(null, "");
    }
  }

  function getProfile(appId: number): TdpProfile | undefined {
    return store.profiles.find((p) => p.appId === appId);
  }

  function getAllProfiles(): TdpProfile[] {
    return [...store.profiles];
  }

  // -------------------------------------------------------------------------
  // Default TDP
  // -------------------------------------------------------------------------

  function getDefaultTdp(): number {
    return store.defaultTdp;
  }

  async function setDefaultTdp(watts: number): Promise<void> {
    store.defaultTdp = clampTdp(watts);
    await saveProfiles();

    if (!isGameRunning) {
      currentTdp = store.defaultTdp;
      await commitTdp(store.defaultTdp);
      onProfileChanged(null, "");
    }
  }

  // -------------------------------------------------------------------------
  // Per-game toggle
  // -------------------------------------------------------------------------

  function getPerGameEnabled(): boolean {
    return store.perGameEnabled;
  }

  async function setPerGameEnabled(enabled: boolean): Promise<void> {
    if (store.perGameEnabled === enabled) return;
    store.perGameEnabled = enabled;
    await saveProfiles();

    // If the toggle flipped on while a game is already running, apply
    // that game's profile (or the default) right now so the user doesn't
    // have to relaunch. If it flipped off, leave whatever TDP is current.
    if (enabled && isGameRunning && activeAppId != null) {
      const profile = store.profiles.find((p) => p.appId === activeAppId);
      activeProfile = profile ?? null;
      currentTdp = profile?.tdpWatts ?? store.defaultTdp;
      await commitTdp(currentTdp);
      onProfileChanged(profile ?? null, profile?.gameName ?? "");
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  function getCurrentState(): TdpProfileEngineState {
    return {
      activeProfile: activeProfile ? { ...activeProfile } : null,
      currentTdp,
      isGameRunning,
      perGameEnabled: store.perGameEnabled,
    };
  }

  function getActiveAppId(): number | null {
    return activeAppId;
  }

  return {
    loadProfiles,
    saveProfiles,
    handleGameLaunch,
    handleGameExit,
    setProfile,
    removeProfile,
    getProfile,
    getAllProfiles,
    getDefaultTdp,
    setDefaultTdp,
    getPerGameEnabled,
    setPerGameEnabled,
    getCurrentState,
    getActiveAppId,
  };
}

export type TdpProfileEngine = ReturnType<typeof createTdpProfileEngine>;
