import type { PluginBackend, EmitPayload } from "@loadout/types";
import { homedir } from "os";
import { join } from "path";
import { readdir, readFile, writeFile, copyFile, mkdir } from "fs/promises";
import {
  parseVdf,
  patchVdfValue,
  removeVdfKey,
  appendLaunchToken,
  removeLaunchToken,
  hasLaunchToken,
  parseBinaryVdf,
  type LaunchTokenOpts,
} from "@loadout/vdf";
import { getUserdataDir, getUserIds } from "@loadout/steam-paths";
import { withSteamClient } from "@loadout/steam-cdp";

interface GameLaunchOptions {
  appId: string;
  launchOptions: string;
}

interface Preset {
  name: string;
  options: string;
}

const PRESETS_PATH = join(
  homedir(),
  ".config",
  "loadout",
  "launch-presets.json",
);

const DEFAULT_PRESETS: Record<string, string> = {
  MangoHud: "mangohud %command%",
  "MangoHud + GameMode": "mangohud gamemoderun %command%",
  GameMode: "gamemoderun %command%",
  "Gamescope 720p": "gamescope -w 1280 -h 720 -f -- %command%",
  "Gamescope 800p": "gamescope -w 1280 -h 800 -f -- %command%",
  "Force Proton": "PROTON_USE_WINED3D=1 %command%",
  // Overrides the SteamDeck=1 env that gamescope-session-plus exports
  // on every handheld (including non-Decks like OXP Apex / ROG Ally /
  // Legion Go). Useful for games that auto-apply Steam-Deck-specific
  // settings — locked-down graphics options, controller-only UI,
  // 800p-targeted resolutions — that look wrong at 1920×1200 etc.
  "Disable Steam Deck Mode": "SteamDeck=0 %command%",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find all userdata directories and return their localconfig.vdf paths.
 */
async function findLocalConfigs(): Promise<string[]> {
  const userdataPath = getUserdataDir();
  const paths: string[] = [];
  try {
    const entries = await readdir(userdataPath);
    for (const entry of entries) {
      // Skip non-numeric directory names (e.g. "ac" or similar)
      if (!/^\d+$/.test(entry)) continue;
      const vdfPath = join(userdataPath, entry, "config", "localconfig.vdf");
      try {
        await readFile(vdfPath, "utf-8");
        paths.push(vdfPath);
      } catch {
        // File doesn't exist for this user, skip
      }
    }
  } catch {
    // Steam userdata directory doesn't exist
  }
  return paths;
}

/**
 * Try to set launch options via Steam's `SteamClient.Apps.SetAppLaunchOptions`
 * JS API over CDP. Returns `true` on success, `false` on any failure
 * (Steam unreachable, API not present, evaluate threw). Caller falls back
 * to a direct VDF write when this returns false.
 *
 * One-shot connect → evaluate → close per call. Launch-options writes
 * are human-paced (button clicks), so a persistent CDP connection isn't
 * worth the lifecycle complexity.
 */
async function trySetViaSteamClient(
  appId: string,
  options: string,
): Promise<boolean> {
  try {
    await withSteamClient((sc) => sc.apps.setAppLaunchOptions(appId, options));
    return true;
  } catch (err) {
    console.warn(
      "[launch-options] Steam Client API unreachable, falling back to VDF write:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Read launch options for every non-Steam shortcut across all Steam users.
 *
 * Shortcuts (added via "Add a non-Steam game" or by tools like EmuDeck)
 * live in `userdata/<id>/config/shortcuts.vdf` (binary VDF), and their
 * `LaunchOptions` field is on the shortcut entry itself — NOT in
 * `localconfig.vdf` like real Steam apps. Without this, the picker would
 * see "no existing options" for shortcuts and clobber whatever was there
 * on Apply.
 *
 * Returns a Map<appIdString, launchOptions>. Empty options are filtered.
 */
async function readAllShortcutLaunchOptions(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const userIds = await getUserIds();
  for (const userId of userIds) {
    const path = join(getUserdataDir(), userId, "config", "shortcuts.vdf");
    let buf: Buffer;
    try {
      buf = await readFile(path);
    } catch {
      continue; // user may have no shortcuts
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = parseBinaryVdf(buf) as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `[launch-options] Failed to parse shortcuts.vdf for user ${userId}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    const shortcuts = (parsed.shortcuts ?? {}) as Record<string, unknown>;
    for (const sc of Object.values(shortcuts)) {
      if (typeof sc !== "object" || sc === null) continue;
      const s = sc as Record<string, unknown>;
      if (typeof s.appid !== "number") continue;
      // `appid` may be parsed as signed (top bit set → negative);
      // `>>> 0` re-interprets it as the uint32 Steam stores.
      const idStr = String(s.appid >>> 0);
      const lo = typeof s.LaunchOptions === "string" ? s.LaunchOptions : "";
      if (lo.length > 0 && !map.has(idStr)) map.set(idStr, lo);
    }
  }
  return map;
}

/**
 * Loosely-typed VDF object — `parseVdf` returns a nested record with
 * string keys and arbitrary nested values (strings, numbers, sub-objects).
 * We accept `unknown` at the leaf and let callers narrow.
 */
type VdfObj = Record<string, unknown>;

/**
 * Navigate the parsed VDF tree to the apps section.
 * Path: UserLocalConfigStore -> Software -> Valve -> Steam -> apps
 */
function getAppsSection(vdf: unknown): VdfObj | null {
  const root = (vdf as VdfObj | null)?.UserLocalConfigStore as VdfObj | undefined;
  const steam = root?.Software as VdfObj | undefined;
  const valve = steam?.Valve as VdfObj | undefined;
  const steamObj = valve?.Steam as VdfObj | undefined;
  const apps = (steamObj?.apps ?? steamObj?.Apps) as VdfObj | undefined;
  return apps ?? null;
}

// ---------------------------------------------------------------------------
// Plugin backend
// ---------------------------------------------------------------------------

export default class LaunchOptionsBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  /**
   * Serialises read-modify-write operations against `localconfig.vdf`.
   *
   * The race we close (audit E-006): two concurrent
   * `setLaunchOptions(appId)` calls would each load the file, mutate
   * their own in-memory copy, and write back — the second writer
   * clobbering the first writer's changes for a different appId.
   *
   * Implementation: every public RMW wraps its body in `withVdfLock`,
   * which chains awaited promises. The next caller's `await prev`
   * doesn't resolve until the previous caller's `release()` fires in
   * `finally`. No spinlocks, no external deps; rejections from one
   * step don't block the chain (we always release).
   */
  private writeLock: Promise<void> = Promise.resolve();

  private async withVdfLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async onLoad(): Promise<void> {
    console.log("[launch-options] Plugin loaded");
  }

  async onUnload(): Promise<void> {
    console.log("[launch-options] Plugin unloaded");
  }

  /**
   * Get all games that have LaunchOptions set across all userdata dirs.
   */
  async getGames(): Promise<GameLaunchOptions[]> {
    const configs = await findLocalConfigs();
    const games: GameLaunchOptions[] = [];
    const seen = new Set<string>();

    // Steam apps — from localconfig.vdf
    for (const configPath of configs) {
      try {
        const content = await readFile(configPath, "utf-8");
        const vdf = parseVdf(content);
        const apps = getAppsSection(vdf);
        if (!apps) continue;

        for (const appId of Object.keys(apps)) {
          if (seen.has(appId)) continue;
          const appData = apps[appId];
          if (typeof appData === "object" && appData !== null) {
            const lo = (appData as Record<string, unknown>).LaunchOptions;
            if (typeof lo === "string" && lo.length > 0) {
              games.push({ appId, launchOptions: lo });
              seen.add(appId);
            }
          }
        }
      } catch {
        // Skip unreadable configs
      }
    }

    // Non-Steam shortcuts — from shortcuts.vdf (binary VDF). Without this
    // the picker thinks shortcuts have no existing options and clobbers
    // them on Apply.
    const shortcuts = await readAllShortcutLaunchOptions();
    for (const [appId, launchOptions] of shortcuts) {
      if (seen.has(appId)) continue;
      games.push({ appId, launchOptions });
      seen.add(appId);
    }

    return games;
  }

  /**
   * Get the current launch options for a specific appId. Checks both
   * `localconfig.vdf` (Steam apps) and `shortcuts.vdf` (non-Steam apps)
   * so the merge in `appendLaunchToken` doesn't wipe an existing string.
   */
  async getLaunchOptions(appId: string): Promise<string> {
    const configs = await findLocalConfigs();

    for (const configPath of configs) {
      try {
        const content = await readFile(configPath, "utf-8");
        const vdf = parseVdf(content);
        const apps = getAppsSection(vdf);
        if (!apps || !apps[appId]) continue;

        const appData = apps[appId];
        const lo =
          typeof appData === "object" && appData !== null
            ? (appData as Record<string, unknown>).LaunchOptions
            : undefined;
        if (typeof lo === "string" && lo.length > 0) return lo;
      } catch {
        continue;
      }
    }

    // Fall through to shortcuts.vdf for non-Steam app entries.
    const shortcuts = await readAllShortcutLaunchOptions();
    const fromShortcut = shortcuts.get(appId);
    if (fromShortcut) return fromShortcut;

    return "";
  }

  /**
   * Set or update the LaunchOptions for a given appId.
   *
   * Steam keeps `localconfig.vdf` in memory while it's running and
   * overwrites the on-disk file on its own schedule (autosave / shutdown).
   * That means a direct VDF write is silently clobbered as soon as Steam
   * next saves. To make the change land *live* we go through Steam's own
   * `SteamClient.Apps.SetAppLaunchOptions` JS API via Chrome DevTools
   * Protocol — that updates Steam's in-memory state, the launch-options
   * field reflects the new value in the Steam UI immediately, and Steam
   * itself flushes to `localconfig.vdf` on its next save cycle.
   *
   * If Steam isn't reachable (closed, debug port disabled, SharedJSContext
   * not yet up) we fall back to the direct VDF write — the only path
   * that actually works when Steam isn't alive to clobber it. The
   * fallback warns to the journal so we can spot it.
   */
  async setLaunchOptions(appId: string, options: string): Promise<void> {
    return this.withVdfLock(() => this._setLaunchOptionsUnlocked(appId, options));
  }

  /**
   * Lock-free body of `setLaunchOptions`. Called from inside `withVdfLock`
   * by the public wrapper, and also from `appendLaunchToken` /
   * `removeLaunchToken` which already hold the lock — calling the public
   * method again would deadlock on `await prev`.
   */
  private async _setLaunchOptionsUnlocked(
    appId: string,
    options: string,
  ): Promise<void> {
    if (await trySetViaSteamClient(appId, options)) {
      return;
    }
    await this._writeLaunchOptionsToVdfUnlocked(appId, options);
  }

  /**
   * Direct VDF file write. Surgical text-level editing to preserve VDF
   * formatting; creates a `.bak` first as a safety net.
   *
   * Public callers should go through `setLaunchOptions`, which prefers
   * the live Steam Client API and only falls back here when Steam isn't
   * reachable. Public for tests.
   *
   * Wrapped in `withVdfLock` so the read → mutate → write sequence is
   * atomic with respect to other callers on this backend instance.
   */
  async _writeLaunchOptionsToVdf(
    appId: string,
    options: string,
  ): Promise<void> {
    return this.withVdfLock(() =>
      this._writeLaunchOptionsToVdfUnlocked(appId, options),
    );
  }

  /**
   * Lock-free body of `_writeLaunchOptionsToVdf`. Must only be called
   * from inside a `withVdfLock` block, otherwise the read-modify-write
   * race E-006 closes is reopened.
   */
  private async _writeLaunchOptionsToVdfUnlocked(
    appId: string,
    options: string,
  ): Promise<void> {
    const configs = await findLocalConfigs();
    if (configs.length === 0) {
      throw new Error("No Steam userdata directories found");
    }

    // Prefer the config that already has this appId
    let targetPath = configs[0];
    for (const configPath of configs) {
      try {
        const content = await readFile(configPath, "utf-8");
        const vdf = parseVdf(content);
        const apps = getAppsSection(vdf);
        if (apps && apps[appId]) {
          targetPath = configPath;
          break;
        }
      } catch {
        continue;
      }
    }

    const content = await readFile(targetPath, "utf-8");

    // Backup before writing — user safety net
    await copyFile(targetPath, targetPath + ".bak");

    const keyPath = [
      "UserLocalConfigStore", "Software", "Valve", "Steam", "apps", appId, "LaunchOptions",
    ];

    let patched: string;
    if (options === "") {
      patched = removeVdfKey(content, keyPath);
    } else {
      patched = patchVdfValue(content, keyPath, options);
    }

    await writeFile(targetPath, patched, "utf-8");
  }

  /**
   * Append a wrapper token to a game's launch options without overwriting
   * what the user (or another plugin) already has there.
   *
   * This is the safe-merge primitive other plugins (lsfg-vk, mangohud-tweaks,
   * future wrappers) consume to inject themselves into a launch string.
   * Built on `appendLaunchToken` from `@loadout/vdf`.
   *
   * Idempotent — calling twice with the same token is a no-op.
   *
   * Returns the resulting launch-options string (whatever Steam will now see).
   */
  async appendLaunchToken(
    appId: string,
    token: string,
    opts?: LaunchTokenOpts,
  ): Promise<string> {
    return this.withVdfLock(async () => {
      const existing = await this.getLaunchOptions(appId);
      const next = appendLaunchToken(existing, token, opts);
      if (next !== existing) {
        // Use the unlocked helper — we already hold the lock; calling
        // the public `setLaunchOptions` would deadlock on `await prev`.
        await this._setLaunchOptionsUnlocked(appId, next);
      }
      return next;
    });
  }

  /**
   * Counterpart to `appendLaunchToken` — remove a previously-injected token
   * by its idempotency key. No-op if the token isn't present.
   *
   * Returns the resulting launch-options string.
   */
  async removeLaunchToken(appId: string, key: string): Promise<string> {
    return this.withVdfLock(async () => {
      const existing = await this.getLaunchOptions(appId);
      const next = removeLaunchToken(existing, key);
      if (next !== existing) {
        await this._setLaunchOptionsUnlocked(appId, next);
      }
      return next;
    });
  }

  /**
   * True if `key` is already present in this game's launch options. Useful
   * for plugins that want to render an Apply / Remove toggle for a specific
   * appId.
   */
  async hasLaunchToken(appId: string, key: string): Promise<boolean> {
    const existing = await this.getLaunchOptions(appId);
    return hasLaunchToken(existing, key);
  }

  /**
   * Return all presets (built-in defaults merged with user-saved ones).
   */
  async getPresets(): Promise<Preset[]> {
    let userPresets: Record<string, string> = {};

    try {
      const raw = await readFile(PRESETS_PATH, "utf-8");
      userPresets = JSON.parse(raw);
    } catch {
      // File doesn't exist yet — use defaults only
    }

    const merged = { ...DEFAULT_PRESETS, ...userPresets };
    return Object.entries(merged).map(([name, options]) => ({
      name,
      options,
    }));
  }

  /**
   * Save a custom preset.
   */
  async savePreset(name: string, options: string): Promise<void> {
    let existing: Record<string, string> = {};

    try {
      const raw = await readFile(PRESETS_PATH, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      // Start fresh
    }

    existing[name] = options;

    // Ensure the directory exists
    const dir = join(homedir(), ".config", "loadout");
    await mkdir(dir, { recursive: true });
    await writeFile(PRESETS_PATH, JSON.stringify(existing, null, 2), "utf-8");
  }

  /**
   * Delete a custom preset.
   */
  async deletePreset(name: string): Promise<void> {
    let existing: Record<string, string> = {};

    try {
      const raw = await readFile(PRESETS_PATH, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      return; // Nothing to delete
    }

    delete existing[name];
    await writeFile(PRESETS_PATH, JSON.stringify(existing, null, 2), "utf-8");
  }
}
