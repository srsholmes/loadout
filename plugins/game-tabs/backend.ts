/**
 * Game Tabs backend.
 *
 * Deliberately thin: it persists the tab/backlog blob and launches games.
 * All filtering, sorting, and list mutation happen client-side in
 * `app.tsx` using the pure helpers in `lib/` — the frontend already holds
 * the library (via `useBackend("__core:game-library")`) and the tab
 * definitions, so there's nothing for the server to compute.
 *
 * Persistence routes through `@loadout/plugin-storage`
 * (`~/.config/loadout/plugins/game-tabs.json`). Tab saves and backlog
 * saves each merge into the same file via `mutatePluginStorage`, so a
 * concurrent tab edit and backlog edit can't clobber each other.
 */

import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import {
  readPluginStorage,
  mutatePluginStorage,
} from "@loadout/plugin-storage";
import {
  withSteamClient,
  SteamClientUnreachableError,
} from "@loadout/steam-cdp";
import { shortcutGameId64 } from "@loadout/vdf";
import type {
  GameTabsData,
  Tab,
  BacklogEntry,
} from "./lib/types";

const PLUGIN_ID = "game-tabs";

/** The tab every fresh install starts with — an unfiltered "All Games". */
function defaultTabs(): Tab[] {
  return [
    {
      id: "all",
      name: "All Games",
      filters: [],
      filtersMode: "and",
      sort: "alpha",
      autoHide: false,
      position: 0,
      hidden: false,
    },
  ];
}

/** Coerce whatever is on disk (possibly `{}` or a partial) into a complete,
 *  well-typed `GameTabsData`, seeding defaults for missing pieces. */
function normalize(stored: Partial<GameTabsData>): GameTabsData {
  const tabs =
    Array.isArray(stored.tabs) && stored.tabs.length > 0
      ? stored.tabs
      : defaultTabs();
  const backlog = Array.isArray(stored.backlog) ? stored.backlog : [];
  return { version: 1, tabs, backlog };
}

/** Result of a launch attempt. Mirrors the shape quick-links/store-bridge
 *  use so the UI handles one consistent object rather than catching. */
export interface LaunchResult {
  launched: boolean;
  reason?: "steam-unreachable" | "launch-failed";
  message?: string;
}

export default class GameTabsBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;
  log?: PluginLogger;

  // ─── Persistence ──────────────────────────────────────────────────

  /** Read the persisted tabs + backlog, seeding defaults on first run. */
  async getData(): Promise<GameTabsData> {
    const stored = await readPluginStorage<GameTabsData>(PLUGIN_ID);
    return normalize(stored);
  }

  /** Overwrite the tab list, preserving the backlog. Returns the merged
   *  data and broadcasts it so any other open overlay stays in sync. */
  async saveTabs(tabs: Tab[]): Promise<GameTabsData> {
    let next: GameTabsData = { version: 1, tabs, backlog: [] };
    await mutatePluginStorage<GameTabsData>(PLUGIN_ID, (current) => {
      next = { version: 1, tabs, backlog: normalize(current).backlog };
      return next;
    });
    this.broadcast(next);
    return next;
  }

  /** Overwrite the backlog, preserving the tab list. */
  async saveBacklog(backlog: BacklogEntry[]): Promise<GameTabsData> {
    let next: GameTabsData = { version: 1, tabs: defaultTabs(), backlog };
    await mutatePluginStorage<GameTabsData>(PLUGIN_ID, (current) => {
      next = { version: 1, tabs: normalize(current).tabs, backlog };
      return next;
    });
    this.broadcast(next);
    return next;
  }

  // ─── Launching ────────────────────────────────────────────────────

  /**
   * Launch a game through Steam. Steam apps go straight to
   * `steam://rungameid/<appId>` (Steam accepts the 32-bit appid);
   * non-Steam shortcuts need the 64-bit gameid derived from the appid.
   * Dispatched over CDP (not xdg-open) so it works under the loader's
   * stripped systemd PATH — same path store-bridge / recomp / quick-links
   * take. Retries once on a transient Steam-CEF unreachable error.
   */
  async launchGame(
    appId: string,
    source: "steam" | "shortcut",
  ): Promise<LaunchResult> {
    const runId =
      source === "shortcut"
        ? shortcutGameId64(Number(appId) >>> 0)
        : appId;
    const uri = `steam://rungameid/${runId}`;
    const attempt = () =>
      withSteamClient((sc) => sc.url.executeSteamURL(uri));

    this.log?.info(`[game-tabs] launch ${source} ${appId} → ${uri}`);
    try {
      await attempt();
      return { launched: true };
    } catch (err) {
      if (err instanceof SteamClientUnreachableError) {
        this.log?.warn(
          `[game-tabs] launch unreachable, retrying in 600ms: ${err.message}`,
        );
        await new Promise((r) => setTimeout(r, 600));
        try {
          await attempt();
          return { launched: true };
        } catch (err2) {
          if (err2 instanceof SteamClientUnreachableError) {
            return {
              launched: false,
              reason: "steam-unreachable",
              message:
                "Steam isn't responding on its debug port. Make sure Steam is running with -cef-enable-debugging.",
            };
          }
          throw err2;
        }
      }
      throw err;
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private broadcast(data: GameTabsData): void {
    this.emit?.({ event: "dataChanged", data });
  }
}
