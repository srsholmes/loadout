// ─── Apply-to-game picker ─────────────────────────────────────────────
//
// Lists the user's Steam library and lets them apply / remove the
// `~/lsfg` wrapper to any game's Steam launch options without stomping
// on whatever else is there (mangohud, gamemoderun, env-vars, etc.).
//
// Pulls library + artwork from the `game-browser` plugin (full
// appmanifest scan), the running game from `__core:game-detection`,
// and existing launch-options strings from the `launch-options`
// plugin. All three are treated as optional — if any plugin is
// missing or errors, the picker degrades to whatever data it could
// fetch.
//
// Apply / Remove call into `launch-options` via the shared
// `appendLaunchToken` / `removeLaunchToken` RPCs (which delegate to
// the pure helpers in @loadout/vdf). Idempotent: clicking Apply
// twice is a no-op; mid-launch-options strings like
// `mangohud %command%` are merged in-place.
//
// Extracted from app.tsx as part of the D-010 decomposition.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  fuzzySearchGames,
  GameCard,
  Spinner,
  useBackend,
  useCurrentGame,
} from "@loadout/ui";
import { hasLaunchToken } from "@loadout/vdf";

import { ALL_COLLECTIONS, STEAM_ONLY } from "./lib/constants";
import type {
  CollectionEntry,
  GameInfo,
  LaunchOptionsEntry,
} from "./lib/types";

interface GamePickerProps {
  /** Token we hand to launch-options (e.g. `~/lsfg`). */
  wrapperToken: string;
  /** Search query — owned by the parent so the dynamic header can
   *  drive it. Empty string matches everything. */
  search: string;
  /** Collection filter — owned by the parent so the dynamic header
   *  dropdown can drive it. Use the `ALL_COLLECTIONS` /
   *  `STEAM_ONLY` sentinels for the special filters. */
  collectionFilter: string;
  /** Callback fired when the picker's library + collection list
   *  finish loading, so the parent can populate its header dropdown
   *  options. Total = full library size pre-filter. */
  onCollectionsLoaded?: (collections: CollectionEntry[], total: number) => void;
}

interface GameRowProps {
  game: GameInfo;
  applied: boolean;
  isCurrent: boolean;
  isBusy: boolean;
  disabled: boolean;
  onClick: () => void;
}

/**
 * One tile in the LSFG-VK picker. Wraps the shared `GameCard` so the
 * layout matches the SGDB / ProtonDB / HLTB grids; the Apply / Remove
 * action sits in the `action` slot below the title (per the design
 * directive — buttons go below the title, not on the tile body).
 *
 * `onPick` is wired to the same handler as the Apply/Remove button so
 * gamepad d-pad A on the focused card triggers Apply / Remove without
 * the user having to navigate further into the tile. Mouse users keep
 * the explicit button. `GameCard` switches to a div+onClick render
 * when both `onPick` and `action` are set, avoiding nested <button>
 * HTML — see GameCard's render-decision comment.
 */
function GameRow({
  game,
  applied,
  isCurrent,
  isBusy,
  disabled,
  onClick,
}: GameRowProps) {
  // game-browser already emits the right URLs: `capsuleUrl` is the
  // portrait library tile (or the loader's local-grid endpoint for
  // shortcuts) and `headerUrl` is the landscape header. Use them as-is
  // so the picker stays in sync with what SGDB shows.
  const primaryThumb = game.capsuleUrl;

  return (
    <GameCard
      imageUrl={primaryThumb}
      fallbackImageUrl={game.headerUrl}
      title={game.name}
      collections={game.tags}
      onPick={disabled || isBusy ? undefined : onClick}
      topLeftBadge={
        isCurrent ? (
          <span className="chip chip-accent">RUNNING</span>
        ) : undefined
      }
      highlighted={isCurrent}
      action={
        <Button
          onClick={onClick}
          disabled={isBusy || disabled}
          variant={applied ? "default" : "primary"}
          size="sm"
          style={{ width: "100%" }}
        >
          {isBusy ? <Spinner size={12} /> : applied ? "Remove" : "Apply"}
        </Button>
      }
    />
  );
}

export function GamePicker({
  wrapperToken,
  search,
  collectionFilter,
  onCollectionsLoaded,
}: GamePickerProps) {
  const launchOptionsBackend = useBackend("launch-options");
  const gameBrowserBackend = useBackend("game-browser");
  const currentGame = useCurrentGame();

  const [library, setLibrary] = useState<GameInfo[]>([]);
  const [collections, setCollections] = useState<CollectionEntry[]>([]);
  const [launchOptsByApp, setLaunchOptsByApp] = useState<
    Map<string, string>
  >(new Map());
  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setErrorMsg(null);
    try {
      const [games, withLO, cols] = await Promise.all([
        gameBrowserBackend.call("getGames").catch(() => []) as Promise<
          GameInfo[]
        >,
        launchOptionsBackend
          .call("getGames")
          .catch(() => []) as Promise<LaunchOptionsEntry[]>,
        gameBrowserBackend.call("getCollections").catch(() => []) as Promise<
          CollectionEntry[]
        >,
      ]);
      // Defensive dedupe by appId — game-browser dedupes too, but we don't
      // want to assume that and double-render rows on stale clients.
      const dedupedGames: GameInfo[] = [];
      const seen = new Set<string>();
      for (const g of Array.isArray(games) ? games : []) {
        if (seen.has(g.appId)) continue;
        seen.add(g.appId);
        dedupedGames.push(g);
      }
      setLibrary(dedupedGames);
      const colsArr = Array.isArray(cols) ? cols : [];
      setCollections(colsArr);
      onCollectionsLoaded?.(colsArr, dedupedGames.length);
      const map = new Map<string, string>();
      for (const g of withLO) map.set(g.appId, g.launchOptions);
      setLaunchOptsByApp(map);
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setLoading(false);
    }
  }, [gameBrowserBackend, launchOptionsBackend, onCollectionsLoaded]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  // Avoid an unused-var warning when the parent doesn't care about
  // collection metadata (e.g. simplified embeddings).
  void collections;

  // Optimistic local update — when launch-options writes go via Steam's
  // SteamClient API, Steam updates its in-memory state immediately but
  // doesn't flush localconfig.vdf until autosave. So a refresh() right
  // after Apply would still see the old VDF and revert the row to "not
  // applied". Instead, use the RPC's return value (the new launch-options
  // string) to update the local map directly. The next mount-time
  // refresh picks up Steam's eventually-flushed state for free.
  const apply = useCallback(
    async (appId: string) => {
      setBusyAppId(appId);
      setErrorMsg(null);
      try {
        const newOpts = (await launchOptionsBackend.call(
          "appendLaunchToken",
          appId,
          wrapperToken,
        )) as string;
        setLaunchOptsByApp((prev) => {
          const next = new Map(prev);
          next.set(appId, newOpts);
          return next;
        });
      } catch (err) {
        setErrorMsg(String(err));
      } finally {
        setBusyAppId(null);
      }
    },
    [launchOptionsBackend, wrapperToken],
  );

  const remove = useCallback(
    async (appId: string) => {
      setBusyAppId(appId);
      setErrorMsg(null);
      try {
        const newOpts = (await launchOptionsBackend.call(
          "removeLaunchToken",
          appId,
          wrapperToken,
        )) as string;
        setLaunchOptsByApp((prev) => {
          const next = new Map(prev);
          if (newOpts === "") {
            next.delete(appId);
          } else {
            next.set(appId, newOpts);
          }
          return next;
        });
      } catch (err) {
        setErrorMsg(String(err));
      } finally {
        setBusyAppId(null);
      }
    },
    [launchOptionsBackend, wrapperToken],
  );

  /**
   * Filter by collection (from the dropdown), then run the query
   * through fuzzysort (name + collection tags + friendly aliases),
   * then float the currently-running game to the top so it's the
   * easiest target.
   */
  const visible = useMemo(() => {
    let filtered = library;

    if (collectionFilter === STEAM_ONLY) {
      filtered = filtered.filter((g) => g.source === "steam");
    } else if (collectionFilter !== ALL_COLLECTIONS) {
      filtered = filtered.filter((g) => g.tags?.includes(collectionFilter));
    }

    filtered = fuzzySearchGames(filtered, search);

    if (!currentGame) return filtered;
    const currentId = String(currentGame.appId);
    const idx = filtered.findIndex((g) => g.appId === currentId);
    if (idx <= 0) return filtered;
    return [filtered[idx], ...filtered.slice(0, idx), ...filtered.slice(idx + 1)];
  }, [library, search, currentGame, collectionFilter]);

  return (
    <div className="subsection">
      {/* Search + collection dropdown live in the portaled topbar
          header now. Body is just the results list. */}
      {errorMsg && (
        <div
          style={{
            color: "var(--color-error)",
            fontSize: 12,
            marginBottom: 8,
          }}
        >
          {errorMsg}
        </div>
      )}

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
          <Spinner size={20} />
        </div>
      ) : visible.length === 0 ? (
        <div
          style={{
            padding: "14px 12px",
            background: "var(--bg-inset)",
            borderRadius: 8,
            fontSize: 12.5,
            color: "var(--fg-3)",
          }}
        >
          {library.length === 0
            ? "No installed games found. Is the game-browser plugin enabled?"
            : "No games match that search."}
        </div>
      ) : (
        // 4 cols when the shell sidebar is open, 6 when it
        // collapses — driven by the `sidebar-open` /
        // `sidebar-collapsed` custom Tailwind variants
        // registered in overlay/src/index.css.
        <div className="grid grid-cols-4 sidebar-collapsed:grid-cols-6 gap-2.5">
          {visible.map((g) => {
            const lo = launchOptsByApp.get(g.appId) ?? "";
            const applied = wrapperToken
              ? hasLaunchToken(lo, wrapperToken)
              : false;
            const isCurrent =
              !!currentGame && String(currentGame.appId) === g.appId;
            const isBusy = busyAppId === g.appId;

            return (
              <GameRow
                key={g.appId}
                game={g}
                applied={applied}
                isCurrent={isCurrent}
                isBusy={isBusy}
                disabled={!wrapperToken}
                onClick={() =>
                  applied ? remove(g.appId) : apply(g.appId)
                }
              />
            );
          })}
        </div>
      )}

      <div className="subsection-desc" style={{ marginTop: 8 }}>
        Apply adds <span className="mono">{wrapperToken || "~/lsfg"}</span>{" "}
        to the game's launch options without overwriting existing wrappers
        like <span className="mono">mangohud</span> or{" "}
        <span className="mono">gamemoderun</span>. Remove takes it back out.
      </div>
    </div>
  );
}
