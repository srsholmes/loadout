import { useState, useEffect, useCallback, useMemo } from "react";
import {
  FaCheck,
  FaEye,
  FaEyeSlash,
  FaGear,
  FaImage,
  FaKey,
  FaPenToSquare,
  FaXmark,
} from "react-icons/fa6";
import {
  Button,
  fuzzySearchGames,
  useCurrentGame,
  GameCard,
  HeaderBackButton,
  IconButton,
  mountComponent,
  mountHeaderStub,
  notify,
  PluginHeader,
  SearchField,
  SegmentedItem,
  Select,
  Spinner,
  TextInput,
  useBackend,
  useFocusable,
} from "@loadout/ui";
import type { GameCollection, GameInfo, GameSource } from "@loadout/types";
import { cleanTitleForSearch } from "./shared";

export const icon = FaImage;

// --- Types ---

interface SgdbMatch {
  sgdbId: number;
  name: string;
}

/**
 * The currently-selected game in the artwork browser. For Steam apps
 * the SGDB endpoints accept `appId` directly; for non-Steam shortcuts
 * we resolve a `sgdbId` via autocomplete first and cache the choice
 * via `saveSgdbMatch`.
 */
interface SelectedGame {
  appId: string;
  name: string;
  source: GameSource;
  /** SGDB-game-id used by the by-game-id asset fetchers (shortcuts). */
  sgdbId: number | null;
  /** Display name for the matched SGDB record. */
  sgdbName: string | null;
  /** True while the shortcut → SGDB mapping is being resolved. */
  resolving: boolean;
  /** True when no SGDB autocomplete results matched and the user
   *  needs to refine the search to pick one. */
  needsManualPick: boolean;
}

// Sentinel values for the filter dropdown's non-collection slots.
// Anything that isn't one of these is a literal collection id from
// `__core:game-library::getCollections` — same convention as LSFG-VK
// so the shape of the dropdown matches across plugins.
const ALL_GAMES = "__all__";
const STEAM_ONLY = "__steam__";
const SHORTCUT_ONLY = "__shortcut__";
type LibraryFilter = string;

interface SgdbImage {
  id: number;
  score: number;
  style: string;
  width: number;
  height: number;
  nsfw: boolean;
  humor: boolean;
  url: string;
  thumb: string;
  author: { name: string; steam64: string; avatar: string };
}

type AssetTab = "grids" | "heroes" | "logos" | "icons";

const TABS: {
  id: AssetTab;
  label: string;
  artType: string;
  desc: string;
  aspect: string;
}[] = [
  {
    id: "grids",
    label: "Capsule",
    artType: "grid_p",
    desc: "600 × 900 vertical library tile",
    aspect: "3/4",
  },
  {
    id: "heroes",
    label: "Hero",
    artType: "hero",
    desc: "1920 × 620 top banner",
    aspect: "16/5",
  },
  {
    id: "logos",
    label: "Logo",
    artType: "logo",
    desc: "Transparent logo overlay for hero",
    aspect: "5/2",
  },
  {
    id: "icons",
    label: "Icon",
    artType: "icon",
    desc: "256 × 256 shortcut icon",
    aspect: "1/1",
  },
];

/**
 * Per-tab backend method names. Two parallel maps because Steam apps
 * use the platform-gated `/{type}/steam/{appid}` endpoints while
 * non-Steam shortcuts go through `/{type}/game/{sgdbId}` after a
 * resolution dance. Keying on `AssetTab` lets TS enforce that every
 * tab has an entry in both maps — adding a fifth tab fails to compile
 * until you wire up its fetchers.
 */
const STEAM_FETCHER: Record<AssetTab, string> = {
  grids: "getGrids",
  heroes: "getHeroes",
  logos: "getLogos",
  icons: "getIcons",
};
const GAME_ID_FETCHER: Record<AssetTab, string> = {
  grids: "getGridsByGameId",
  heroes: "getHeroesByGameId",
  logos: "getLogosByGameId",
  icons: "getIconsByGameId",
};

// --- Main Component ---

function SteamGridDB() {
  const { call } = useBackend("steamgriddb");
  const gameLibrary = useBackend("__core:game-library");

  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  /** Inline preferences popover toggle on the connected screen. */
  const [showPrefs, setShowPrefs] = useState(false);

  // Unified library list (Steam appmanifests + non-Steam shortcuts)
  // sourced from the `__core:game-library` core service. Filtered
  // client-side; the library is small enough that pushing search to a
  // backend would add latency without measurable benefit.
  const [library, setLibrary] = useState<GameInfo[]>([]);
  /** Counted collections from `__core:game-library::getCollections`.
   *  Used to populate the filter dropdown — same shape as LSFG-VK. */
  const [collections, setCollections] = useState<GameCollection[]>([]);
  /** Tri-state load status — `null` until the first attempt completes,
   *  `"ok"` after a successful fetch, an error string when the
   *  game-library RPC failed. */
  const [libraryStatus, setLibraryStatus] = useState<"ok" | string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  // Default to Steam-only — most users want SGDB grid art for their
  // Steam library, not Heroic / Lutris / emulator shortcuts (which
  // SGDB's appid lookup can't resolve anyway). The "All games"
  // option stays in the dropdown.
  const [filter, setFilter] = useState<LibraryFilter>(STEAM_ONLY);

  // Selected game (the user's pick from their library).
  const [selectedGame, setSelectedGame] = useState<SelectedGame | null>(null);
  /** True when we're showing the "pick the right SGDB match" panel
   *  for a shortcut — either because there was no saved match and
   *  autocomplete returned no results, OR because the user clicked
   *  "Change" on an auto-resolved match. */
  const [sgdbPickerOpen, setSgdbPickerOpen] = useState(false);
  const [sgdbPickerQuery, setSgdbPickerQuery] = useState("");
  const [sgdbPickerResults, setSgdbPickerResults] = useState<
    Array<{ id: number; name: string; verified: boolean }>
  >([]);
  const [sgdbPickerLoading, setSgdbPickerLoading] = useState(false);

  // Asset browsing state
  const [activeTab, setActiveTab] = useState<AssetTab>("grids");
  const [images, setImages] = useState<SgdbImage[]>([]);
  const [loadingImages, setLoadingImages] = useState(false);

  // Apply state
  const [applyingId, setApplyingId] = useState<number | null>(null);
  const [appliedIdByTab, setAppliedIdByTab] = useState<
    Partial<Record<AssetTab, number>>
  >({});
  /**
   * Per-appId cache-bust token, bumped on every successful apply/clear.
   * The library tile reads this and swaps its `<img src>` from
   * `capsuleUrl` (possibly Steam CDN) to `localCapsuleUrl?v=<token>`
   * so the user sees the new art immediately, without waiting for the
   * loader's HTTP `max-age` to expire.
   */
  const [artRefreshByAppId, setArtRefreshByAppId] = useState<
    Record<string, number>
  >({});

  // Check API key on mount. `cancelled` guards against the user
  // unmounting the plugin mid-fetch — without it, the .then() would
  // write into a stale setter and React 18 warns in dev.
  useEffect(() => {
    let cancelled = false;
    void call("hasApiKey").then((result) => {
      if (!cancelled) setHasKey(result as boolean);
    });
    return () => {
      cancelled = true;
    };
  }, [call]);

  // Pull the unified library + collection counts from the
  // `__core:game-library` core service once the API key is in place.
  // Filter client-side: the library is small enough (hundreds of
  // entries) that pushing search to a backend would add latency
  // without measurable benefit. After a successful load we ask our
  // backend to prune saved SGDB matches whose appId isn't in the live
  // library anymore (deleted shortcuts) so plugin storage doesn't
  // grow without bound.
  useEffect(() => {
    if (hasKey !== true) return;
    let cancelled = false;
    void (async () => {
      try {
        const [games, cols] = await Promise.all([
          gameLibrary.call("getGames") as Promise<GameInfo[]>,
          gameLibrary
            .call("getCollections")
            .catch(() => []) as Promise<GameCollection[]>,
        ]);
        if (cancelled) return;
        const list = Array.isArray(games) ? games : [];
        setLibrary(list);
        setCollections(Array.isArray(cols) ? cols : []);
        setLibraryStatus("ok");
        // Best-effort GC. Failure here just means the prune didn't
        // happen this session — surface the error to the console but
        // don't block the picker.
        void call(
          "pruneMatches",
          list.map((g) => g.appId),
        ).catch((err) => {
          console.warn("[steamgriddb] pruneMatches failed:", err);
        });
      } catch (err) {
        console.warn("[steamgriddb] game-library getGames failed:", err);
        if (cancelled) return;
        setLibraryStatus(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasKey, gameLibrary, call]);

  /**
   * Apply the filter dropdown first (collection / source), then run a
   * fuzzy search against name + collection tags so typos and aliases
   * still match. `fuzzySearchGames` ranks name matches above tag
   * matches, so typing "Mario" surfaces Mario games before games
   * tagged with a Mario-named collection.
   */
  const currentAppId = useCurrentGame()?.appId ?? null;

  const visibleGames = useMemo(() => {
    let list = library;
    if (filter === STEAM_ONLY) {
      list = list.filter((g) => g.source === "steam");
    } else if (filter === SHORTCUT_ONLY) {
      list = list.filter((g) => g.source === "shortcut");
    } else if (filter !== ALL_GAMES) {
      list = list.filter((g) => g.tags?.includes(filter));
    }
    const ranked = [...fuzzySearchGames(list, searchQuery)];
    // With no active search, float the currently-running game to the
    // front — it's the one you're most likely here to art up. During a
    // search, leave the fuzzy ranking untouched.
    if (!searchQuery && currentAppId != null) {
      const idx = ranked.findIndex(
        (g) => String(g.appId) === String(currentAppId),
      );
      if (idx > 0) ranked.unshift(ranked.splice(idx, 1)[0]);
    }
    return ranked;
  }, [library, filter, searchQuery, currentAppId]);

  /**
   * Dropdown options: the three Steam/non-Steam sentinels first, then
   * every collection the user has, ordered by count (most-populated
   * first — same ordering `game-browser::getCollections` already gives
   * us). Mirrors LSFG-VK's filter dropdown.
   */
  const filterOptions = useMemo(() => {
    const totalAll = library.length;
    const totalSteam = library.filter((g) => g.source === "steam").length;
    const totalShortcut = totalAll - totalSteam;
    const opts = [
      { value: ALL_GAMES, label: `All games${totalAll ? ` (${totalAll})` : ""}` },
      {
        value: STEAM_ONLY,
        label: `Steam only${totalSteam ? ` (${totalSteam})` : ""}`,
      },
      {
        value: SHORTCUT_ONLY,
        label: `Non-Steam only${totalShortcut ? ` (${totalShortcut})` : ""}`,
      },
    ];
    for (const c of collections) {
      opts.push({ value: c.id, label: `${c.id} (${c.count})` });
    }
    return opts;
  }, [library, collections]);

  /**
   * Run the SGDB autocomplete for a shortcut and persist the top
   * match. Prefers a `verified` result (community-curated artwork
   * available) so the auto-pick lands on the canonical record more
   * often; falls back to the first hit when no entry is verified.
   * If no results come back, leave the selection in the "needs
   * manual pick" state so the user can refine the query.
   */
  const autoResolveShortcutMatch = useCallback(
    async (game: GameInfo): Promise<SelectedGame> => {
      const cleaned = cleanTitleForSearch(game.name);
      try {
        const results = (await call("searchGames", cleaned)) as Array<{
          id: number;
          name: string;
          types: string[];
          verified: boolean;
        }>;
        if (results.length > 0) {
          const top = results.find((r) => r.verified) ?? results[0];
          await call("saveSgdbMatch", game.appId, top.id, top.name);
          return {
            appId: game.appId,
            name: game.name,
            source: "shortcut",
            sgdbId: top.id,
            sgdbName: top.name,
            resolving: false,
            needsManualPick: false,
          };
        }
      } catch (err) {
        console.warn("[steamgriddb] auto-resolve failed:", err);
      }
      return {
        appId: game.appId,
        name: game.name,
        source: "shortcut",
        sgdbId: null,
        sgdbName: null,
        resolving: false,
        needsManualPick: true,
      };
    },
    [call],
  );

  // Fetch images for the current asset tab whenever the user picks a
  // different game or switches tab. Steam apps go through the
  // platform-gated /{type}/steam/{appid} endpoints; non-Steam
  // shortcuts fall back to /{type}/game/{sgdbId} after the SGDB
  // resolution dance.
  useEffect(() => {
    if (!selectedGame) return;
    if (selectedGame.resolving || selectedGame.needsManualPick) return;

    const tab = TABS.find((t) => t.id === activeTab);
    if (!tab) return;

    setLoadingImages(true);
    setImages([]);

    const promise =
      selectedGame.source === "shortcut" && selectedGame.sgdbId != null
        ? call(GAME_ID_FETCHER[tab.id], selectedGame.sgdbId)
        : call(STEAM_FETCHER[tab.id], selectedGame.appId);

    promise
      .then((result) => setImages(result as SgdbImage[]))
      .catch(() => setImages([]))
      .finally(() => setLoadingImages(false));
  }, [selectedGame, activeTab, call]);

  const handleSetApiKey = useCallback(async () => {
    if (!apiKeyInput.trim()) return;
    const r = (await call("setApiKey", apiKeyInput.trim())) as {
      success: boolean;
      error?: string;
    };
    if (!r.success) {
      notify(r.error ?? "Failed to save API key.", { kind: "error" });
      return;
    }
    setHasKey(true);
    setApiKeyInput("");
    notify("Connected to SteamGridDB", { kind: "success" });
  }, [call, apiKeyInput]);

  const handleSelectGame = useCallback(
    async (game: GameInfo) => {
      setSearchQuery("");
      setActiveTab("grids");
      setAppliedIdByTab({});
      setSgdbPickerOpen(false);

      if (game.source === "steam") {
        // Steam apps use the platform-gated SGDB endpoints directly
        // — no SGDB-game-id resolution needed.
        setSelectedGame({
          appId: game.appId,
          name: game.name,
          source: "steam",
          sgdbId: null,
          sgdbName: null,
          resolving: false,
          needsManualPick: false,
        });
        return;
      }

      // Non-Steam shortcut: try the saved match first, fall back to
      // an autocomplete-based auto-pick that we then persist.
      //
      // The token guard below covers an interleaved-selection race:
      // if the user picks shortcut A and then picks game B while A's
      // network round-trip is still in flight, the late `setSelected`
      // for A must not clobber B's selection. We capture `game.appId`
      // here and only commit the resolution if the live selection's
      // appId still matches.
      const token = game.appId;
      const commitIfCurrent = (next: SelectedGame): void => {
        setSelectedGame((prev) => (prev?.appId === token ? next : prev));
      };

      setSelectedGame({
        appId: game.appId,
        name: game.name,
        source: "shortcut",
        sgdbId: null,
        sgdbName: null,
        resolving: true,
        needsManualPick: false,
      });
      try {
        const saved = (await call(
          "getSavedSgdbMatch",
          game.appId,
        )) as SgdbMatch | null;
        if (saved) {
          commitIfCurrent({
            appId: game.appId,
            name: game.name,
            source: "shortcut",
            sgdbId: saved.sgdbId,
            sgdbName: saved.name,
            resolving: false,
            needsManualPick: false,
          });
          return;
        }
      } catch (err) {
        console.warn("[steamgriddb] getSavedSgdbMatch failed:", err);
      }
      const resolved = await autoResolveShortcutMatch(game);
      commitIfCurrent(resolved);
    },
    [call, autoResolveShortcutMatch],
  );

  /**
   * Open the manual SGDB-match picker for the currently-selected
   * shortcut. Seeds the search box with the cleaned title so the
   * common case ("the auto-pick was almost right") only takes a
   * click; the user can refine the query if they need to.
   */
  const openSgdbPicker = useCallback(async () => {
    if (!selectedGame || selectedGame.source !== "shortcut") return;
    const seed = cleanTitleForSearch(selectedGame.name);
    setSgdbPickerQuery(seed);
    setSgdbPickerOpen(true);
    setSgdbPickerLoading(true);
    try {
      const results = (await call("searchGames", seed)) as Array<{
        id: number;
        name: string;
        types: string[];
        verified: boolean;
      }>;
      setSgdbPickerResults(results);
    } catch (err) {
      console.warn("[steamgriddb] manual picker search failed:", err);
      setSgdbPickerResults([]);
    } finally {
      setSgdbPickerLoading(false);
    }
  }, [selectedGame, call]);

  const handleSgdbPickerSearch = useCallback(
    async (q: string) => {
      setSgdbPickerQuery(q);
      const trimmed = q.trim();
      if (!trimmed) {
        setSgdbPickerResults([]);
        return;
      }
      setSgdbPickerLoading(true);
      try {
        const results = (await call("searchGames", trimmed)) as Array<{
          id: number;
          name: string;
          types: string[];
          verified: boolean;
        }>;
        setSgdbPickerResults(results);
      } catch {
        setSgdbPickerResults([]);
      } finally {
        setSgdbPickerLoading(false);
      }
    },
    [call],
  );

  const handleSgdbPickerConfirm = useCallback(
    async (match: { id: number; name: string }) => {
      if (!selectedGame) return;
      try {
        await call("saveSgdbMatch", selectedGame.appId, match.id, match.name);
      } catch (err) {
        console.warn("[steamgriddb] saveSgdbMatch failed:", err);
      }
      setSelectedGame((prev) =>
        prev
          ? {
              ...prev,
              sgdbId: match.id,
              sgdbName: match.name,
              needsManualPick: false,
              resolving: false,
            }
          : prev,
      );
      setSgdbPickerOpen(false);
    },
    [selectedGame, call],
  );

  /**
   * Click an asset tile. Two behaviours, gated on session state:
   *
   *   - Tile not currently applied → upload it as the custom asset
   *     for this (appId, type) and remember its id so the next click
   *     on the same tile is read as a clear.
   *   - Tile currently applied → reset that asset type back to
   *     Steam's default. The session-local "applied" highlight is
   *     dropped; other tabs' applied art is unaffected.
   *
   * Both paths surface success/failure as toasts via `notify()`. We
   * deliberately skip a confirm dialog for the clear: it's cheap to
   * redo by clicking the tile again.
   */
  const handleApply = useCallback(
    async (image: SgdbImage) => {
      if (!selectedGame) {
        notify("No game selected.", { kind: "error" });
        return;
      }
      const tab = TABS.find((t) => t.id === activeTab);
      if (!tab) return;

      const isApplied = appliedIdByTab[activeTab] === image.id;
      const targetAppId = selectedGame.appId;
      setApplyingId(image.id);
      try {
        if (isApplied) {
          await call("clearArt", targetAppId, tab.artType, selectedGame.source);
          setAppliedIdByTab((prev) => {
            const next = { ...prev };
            delete next[activeTab];
            return next;
          });
          notify(`Cleared ${tab.label.toLowerCase()} art`, { kind: "success" });
        } else {
          await call(
            "applyArt",
            targetAppId,
            image.url,
            tab.artType,
            selectedGame.source,
          );
          setAppliedIdByTab((prev) => ({ ...prev, [activeTab]: image.id }));
          notify(`Applied ${tab.label.toLowerCase()} art`, { kind: "success" });
        }
        // Bump this game's cache-bust token so its tile (and any future
        // re-render) refetches the artwork. We bump on BOTH apply and
        // clear because both mutate the on-disk file set.
        setArtRefreshByAppId((prev) => ({
          ...prev,
          [targetAppId]: Date.now(),
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("Failed to update art:", err);
        notify(msg, { kind: "error" });
      } finally {
        setApplyingId(null);
      }
    },
    [call, selectedGame, activeTab, appliedIdByTab],
  );

  const handleChangeGame = useCallback(() => {
    setSelectedGame(null);
    setImages([]);
    setSearchQuery("");
    setAppliedIdByTab({});
    setSgdbPickerOpen(false);
  }, []);

  // --- Render ---

  const activeTabConfig = TABS.find((t) => t.id === activeTab)!;
  const selectedAssetId = appliedIdByTab[activeTab];

  // Dynamic topbar header. Same React tree as the body — state and
  // callbacks (selectedGame, activeTab, handleSearchChange, …) are
  // shared by closure, no cross-root plumbing. Renders into the
  // overlay shell's reserved 60px topbar slot via `<PluginHeader>`.
  const headerNode = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            SteamGridDB
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {hasKey === false
              ? "Connect to get started"
              : selectedGame
                ? `${selectedGame.name} · AppID ${selectedGame.appId}`
                : "Custom artwork for your library"}
          </span>
        </div>

        {hasKey !== false && !selectedGame && (
          <div className="flex items-center gap-2 shrink-0">
            <SearchField
              value={searchQuery}
              onChange={setSearchQuery}
              onClear={() => setSearchQuery("")}
              placeholder="Search games…"
              width={240}
            />
            <div style={{ minWidth: 180 }}>
              <Select
                value={filter}
                options={filterOptions}
                onChange={setFilter}
              />
            </div>
            <IconButton
              onClick={() => setShowPrefs((p) => !p)}
              title="Plugin preferences"
              ariaLabel="Plugin preferences"
              size={26}
            >
              <FaGear size={11} />
            </IconButton>
          </div>
        )}

        {hasKey !== false && selectedGame && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="segmented flex">
              {TABS.map((t) => (
                <SegmentedItem
                  key={t.id}
                  active={activeTab === t.id}
                  onSelect={() => setActiveTab(t.id)}
                >
                  {t.label}
                </SegmentedItem>
              ))}
            </div>
            <HeaderBackButton
              onBack={handleChangeGame}
              title="Back to library"
            />
          </div>
        )}
      </div>
    </PluginHeader>
  );

  // Connect screen — full-page API-key onboarding shown when no key is set.
  if (hasKey === false) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <ConnectScreen
            value={apiKeyInput}
            onChange={setApiKeyInput}
            onSave={handleSetApiKey}
          />
        </div>
      </>
    );
  }

  return (
    <>
      {headerNode}
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
        {/* Preferences popover (inline card, not modal). Toasts are
            the source of truth for success/failure — see `notify()`
            calls below. */}
        {showPrefs && (
          <PrefsCard
            initialApiKey=""
            onSave={async (next) => {
              const r = (await call("setApiKey", next)) as {
                success: boolean;
                error?: string;
              };
              if (!r.success) {
                notify(r.error ?? "Failed to save API key.", { kind: "error" });
                return false;
              }
              setShowPrefs(false);
              notify("API key updated", { kind: "success" });
              return true;
            }}
            onClose={() => setShowPrefs(false)}
            onClearCache={async () => {
              try {
                await call("clearCache");
                notify("SteamGridDB cache cleared", { kind: "success" });
              } catch (err) {
                notify(
                  err instanceof Error ? err.message : "Failed to clear cache",
                  { kind: "error" },
                );
              }
            }}
          />
        )}

        {/* Library list — search input, filter dropdown, and settings
            cog live in the portaled topbar header above. The body
            renders the caption + the game grid only. */}
        {!selectedGame && (
          <div className="card">
            <div className="subsection">
              {/* Loading / error / empty-result branches, in priority
                  order. `libraryStatus === null` is the initial state
                  before the first getGames attempt resolves. */}
              {libraryStatus === null && (
                <div className="flex items-center justify-center py-12">
                  <Spinner size={28} />
                </div>
              )}

              {typeof libraryStatus === "string" && libraryStatus !== "ok" && (
                <div className="subsection-desc mb-0">
                  Couldn't load the library from the game-library core
                  service. (Underlying error: {libraryStatus})
                </div>
              )}

              {libraryStatus === "ok" && library.length === 0 && (
                <div className="subsection-desc mb-0">
                  No Steam games or non-Steam shortcuts found. Install
                  something on Steam, or add a non-Steam shortcut via
                  Steam → Games → Add a Non-Steam Game.
                </div>
              )}

              {visibleGames.length > 0 && (
                // 4 cols when the shell sidebar is open, 6 when it
                // collapses — driven by the `sidebar-open` /
                // `sidebar-collapsed` custom Tailwind variants
                // registered in overlay/src/index.css, which read
                // `<html data-sidebar="…">`.
                <div className="grid grid-cols-4 sidebar-collapsed:grid-cols-6 gap-2.5">
                  {visibleGames.map((game) => (
                    <SgdbGameTile
                      key={game.appId}
                      game={game}
                      refreshToken={artRefreshByAppId[game.appId]}
                      onPick={() => handleSelectGame(game)}
                    />
                  ))}
                </div>
              )}

              {libraryStatus === "ok" &&
                library.length > 0 &&
                visibleGames.length === 0 && (
                  <div className="subsection-desc mb-0">
                    {searchQuery.trim()
                      ? `No games match "${searchQuery.trim()}".`
                      : filter === SHORTCUT_ONLY
                        ? "No non-Steam shortcuts found. Add one via 'Add a Non-Steam game' in Steam (or via EmuDeck)."
                        : "No games match this filter."}
                  </div>
                )}
            </div>
          </div>
        )}

        {selectedGame && (
          <div className="card">
            {/* Shortcut-only: SGDB-match status + change link. Steam
                games skip this — their app id is the SGDB key. */}
            {selectedGame.source === "shortcut" && (
              <div className="subsection">
                {selectedGame.resolving ? (
                  <div className="flex items-center gap-2">
                    <Spinner size={14} />
                    <span className="text-[12.5px] text-base-content/70">
                      Resolving SteamGridDB match…
                    </span>
                  </div>
                ) : selectedGame.needsManualPick ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[12.5px] text-base-content/80">
                      No automatic match for{" "}
                      <span className="font-semibold">{selectedGame.name}</span>
                      . Pick the right game on SteamGridDB.
                    </div>
                    <Button size="sm" onClick={openSgdbPicker}>
                      Pick match
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[12.5px] text-base-content/80">
                      Matched as{" "}
                      <span className="font-semibold">
                        {selectedGame.sgdbName}
                      </span>{" "}
                      on SteamGridDB.
                    </div>
                    <Button size="sm" onClick={openSgdbPicker}>
                      <FaPenToSquare size={11} className="mr-1.5" />
                      Change
                    </Button>
                  </div>
                )}
              </div>
            )}

            {sgdbPickerOpen && (
              <SgdbMatchPicker
                query={sgdbPickerQuery}
                results={sgdbPickerResults}
                loading={sgdbPickerLoading}
                onQueryChange={handleSgdbPickerSearch}
                onConfirm={handleSgdbPickerConfirm}
                onClose={() => setSgdbPickerOpen(false)}
              />
            )}

            <div className="subsection">
              <div className="subsection-label">
                {activeTabConfig.label}
                {!loadingImages && ` (${images.length})`}
              </div>

              {selectedGame.resolving || selectedGame.needsManualPick ? (
                <div className="subsection-desc mb-0">
                  {selectedGame.needsManualPick
                    ? "Pick a SteamGridDB match above to load artwork."
                    : "Loading…"}
                </div>
              ) : loadingImages ? (
                <div className="flex items-center justify-center p-12">
                  <Spinner size={28} />
                </div>
              ) : images.length === 0 ? (
                <div className="subsection-desc mb-0">
                  No {activeTabConfig.label.toLowerCase()} art available for
                  this game.
                </div>
              ) : (
                <div
                  className={`grid gap-2.5 ${
                    activeTab === "heroes" ? "grid-cols-2" : "grid-cols-4"
                  }`}
                >
                  {images.map((img) => {
                    const isSelected = selectedAssetId === img.id;
                    const isApplying = applyingId === img.id;
                    const canApply = !!selectedGame?.appId;
                    const flatTab =
                      activeTab === "icons" || activeTab === "logos";
                    return (
                      <AssetTile
                        key={img.id}
                        img={img}
                        aspect={activeTabConfig.aspect}
                        activeTab={activeTab}
                        isSelected={isSelected}
                        isApplying={isApplying}
                        canApply={canApply}
                        flatTab={flatTab}
                        onApply={() => handleApply(img)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        </div>
      </div>
    </>
  );
}

/**
 * Mount this plugin into a container element.
 * Called by the overlay shell when this plugin is selected.
 * Returns an unmount function.
 */
export const mount = mountComponent(SteamGridDB);

/**
 * Render one library tile. Backed by the shared `GameCard` so the
 * picker matches ProtonDB / HLTB / LSFG-VK visually; the first user
 * collection becomes the color-coded overlay badge on the bottom of
 * the image (this is what replaces the old "Non-Steam" pill).
 */
function SgdbGameTile({
  game,
  refreshToken,
  onPick,
}: {
  game: GameInfo;
  /** Bumps when the user has just applied/cleared art for this game.
   *  Drives a cache-busting `?v=…` query string AND forces a switch
   *  from the CDN-backed `capsuleUrl` to `localCapsuleUrl` (since the
   *  loader endpoint now has the freshly-written file, whereas the
   *  CDN never sees user customizations). */
  refreshToken?: number;
  onPick: () => void;
}) {
  // game-browser already emits the correct URLs: portrait library
  // tile for `capsuleUrl`, landscape header for `headerUrl`. Once a
  // refreshToken arrives we know custom art has just been written to
  // disk, so swap to the loader's `/api/steam-grid` endpoint with a
  // cache buster — that's the only case where we want the local URL
  // over the CDN (the CDN never sees user customizations).
  const primaryThumb =
    refreshToken !== undefined && game.localCapsuleUrl
      ? `${game.localCapsuleUrl}?v=${refreshToken}`
      : game.capsuleUrl;
  const headerThumb =
    refreshToken !== undefined && game.localHeaderUrl
      ? `${game.localHeaderUrl}?v=${refreshToken}`
      : game.headerUrl;

  return (
    <GameCard
      imageUrl={primaryThumb}
      fallbackImageUrl={headerThumb}
      title={game.name}
      collections={game.tags}
      onPick={onPick}
    />
  );
}

/**
 * Inline panel that lets the user search SteamGridDB by name and
 * pick the right game record for a non-Steam shortcut. The result
 * gets persisted by the parent via `saveSgdbMatch`. Used both for
 * the "no automatic match" case and the explicit "Change" link on
 * an already-resolved match.
 */
function SgdbMatchPicker({
  query,
  results,
  loading,
  onQueryChange,
  onConfirm,
  onClose,
}: {
  query: string;
  results: Array<{ id: number; name: string; verified: boolean }>;
  loading: boolean;
  onQueryChange: (q: string) => void;
  onConfirm: (match: { id: number; name: string }) => void;
  onClose: () => void;
}) {
  return (
    <div className="subsection">
      <div className="flex items-center gap-2 mb-3">
        <div className="subsection-label mb-0 flex-1">
          Pick the SteamGridDB match
        </div>
        <Button onClick={onClose}>
          <FaXmark size={11} />
        </Button>
      </div>
      <div className="mb-3">
        <SearchField
          value={query}
          onChange={onQueryChange}
          onClear={() => onQueryChange("")}
          placeholder="Search SteamGridDB…"
          width={420}
        />
      </div>
      {loading ? (
        <div className="flex items-center justify-center p-4">
          <Spinner size={20} />
        </div>
      ) : results.length === 0 ? (
        <div className="subsection-desc mb-0">
          {query.trim()
            ? "No SteamGridDB matches. Try simplifying the query."
            : "Type to search SteamGridDB."}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
          {results.map((r) => (
            <SgdbMatchRow
              key={r.id}
              name={r.name}
              verified={r.verified}
              onSelect={() => onConfirm({ id: r.id, name: r.name })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SgdbMatchRow({
  name,
  verified,
  onSelect,
}: {
  name: string;
  verified: boolean;
  onSelect: () => void;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onSelect });
  return (
    <button
      ref={ref}
      onClick={onSelect}
      className={
        "flex items-center gap-2 px-3 py-2 rounded-md bg-[var(--bg-inset)] text-left text-[12.5px] transition-all " +
        (focused
          ? "border border-[var(--accent)] scale-[1.01]"
          : "border border-transparent hover:border-[var(--accent)]/40")
      }
    >
      <span className="flex-1 truncate">{name}</span>
      {verified && (
        <span className="text-[10px] font-semibold text-[var(--accent)]">
          ✓ Verified
        </span>
      )}
    </button>
  );
}

/**
 * One image tile in the asset grid (heroes / grids / icons / logos).
 * Wrapped with `useFocusable` so the d-pad reaches it; preserves the
 * dynamic aspectRatio + selected/applying overlays.
 */
function AssetTile({
  img,
  aspect,
  activeTab,
  isSelected,
  isApplying,
  canApply,
  flatTab,
  onApply,
}: {
  img: { id: number; thumb: string; style: string; score: number; author: { name: string } };
  aspect: string;
  activeTab: string;
  isSelected: boolean;
  isApplying: boolean;
  canApply: boolean;
  flatTab: boolean;
  onApply: () => void;
}) {
  const disabled = isApplying || !canApply;
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      if (!disabled) onApply();
    },
    focusable: !disabled,
  });
  return (
    <button
      ref={ref}
      onClick={onApply}
      disabled={disabled}
      title={!canApply ? "No game selected" : undefined}
      style={{ aspectRatio: aspect }}
      className={[
        "relative rounded-lg p-0 overflow-hidden transition-all duration-150",
        flatTab ? "bg-[var(--bg-inset)]" : "bg-base-200",
        isSelected
          ? "border-2 border-[var(--accent)]"
          : focused
            ? "border-2 border-[var(--accent)]"
            : "border border-[var(--line)]",
        focused ? "scale-[1.03]" : "",
        isApplying ? "cursor-wait opacity-70" : "cursor-pointer",
      ].join(" ")}
    >
      <img
        src={img.thumb}
        alt={`Art by ${img.author.name}`}
        loading="lazy"
        className={`w-full h-full block ${
          activeTab === "logos" ? "object-contain" : "object-cover"
        }`}
      />

      {isSelected && (
        <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full grid place-items-center bg-[var(--accent)] text-[var(--on-accent)]">
          <FaCheck size={10} />
        </div>
      )}

      {isApplying && (
        <div className="absolute inset-0 grid place-items-center bg-black/50">
          <Spinner size={22} />
        </div>
      )}

      <div className="mono absolute bottom-0 left-0 right-0 p-1.5 text-[9.5px] text-white flex justify-between gap-1.5 bg-gradient-to-t from-black/60 to-transparent">
        <span className="truncate">{img.style}</span>
        <span>★ {img.score.toFixed(1)}</span>
      </div>
    </button>
  );
}

// --- Connect screen (API-key gate) ---

function ConnectScreen({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="page-content">
      <div className="card">
        <div className="subsection text-center px-7 pt-9 pb-5">
          <div className="w-16 h-16 rounded-2xl mx-auto mb-4 grid place-items-center bg-[var(--accent-soft)] text-[var(--accent)]">
            <FaImage size={28} />
          </div>
          <div className="text-lg font-bold mb-1.5">Connect to SteamGridDB</div>
          <div className="text-[13px] text-[var(--fg-2)] max-w-[380px] mx-auto leading-relaxed">
            SteamGridDB needs an API key to fetch artwork. Generate one
            (free) and paste it in — it's stored locally in plugin
            preferences and reused for every game.
          </div>
        </div>

        {/* Step 1 — generate the key. The overlay can't reliably open a
            browser under Gaming Mode without the quick-links plugin
            installed, so we surface the URL as selectable text and
            recommend opening it on another device. Mirrors the same
            pattern as the loader's WelcomeScreen onboarding. */}
        <div className="subsection">
          <div className="subsection-label">Step 1 · Generate a key</div>
          <div className="subsection-desc">
            Sign in at SteamGridDB and visit your API preferences:
          </div>
          <div className="mt-2 px-3 py-2.5 rounded-xl bg-[var(--bg-inset)] border border-[var(--line)] font-mono text-[12.5px] text-[var(--accent)] break-all select-all">
            https://www.steamgriddb.com/profile/preferences/api
          </div>
          <div className="subsection-desc mt-2">
            Open on your phone or another device — copy the key from the
            page, then paste it below.
          </div>
        </div>

        <div className="subsection">
          <div className="subsection-label">Step 2 · Paste it here</div>
          <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-[var(--bg-inset)] border border-[var(--line)]">
            <FaKey size={13} />
            <TextInput
              autoFocus
              type="password"
              value={value}
              onChange={onChange}
              onKeyDown={(e) => e.key === "Enter" && value.trim() && onSave()}
              placeholder="Paste API key"
              className="flex-1 bg-transparent border-none outline-none text-[var(--fg-1)] font-mono text-[12.5px]"
            />
          </div>
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="primary" onClick={onSave} disabled={!value.trim()}>
              <FaCheck size={12} className="mr-1.5" /> Save &amp; connect
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Preferences popover (inline card) ---

function PrefsCard({
  initialApiKey,
  onSave,
  onClose,
  onClearCache,
}: {
  initialApiKey: string;
  /** Return true on success; false keeps the popover open so the user can see the validation error. */
  onSave: (next: string) => Promise<boolean>;
  onClose: () => void;
  /** Wipe the on-disk cache of SGDB API responses for this plugin. */
  onClearCache: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(initialApiKey);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const trimmed = draft.trim();
  return (
    <div className="card">
      <div className="subsection">
        <div className="flex items-center gap-2 mb-3">
          <div className="subsection-label mb-0 flex-1">Plugin preferences</div>
          <Button onClick={onClose}>
            <FaXmark size={11} />
          </Button>
        </div>
        <div className="subsection-label">API key</div>
        <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-[var(--bg-inset)] border border-[var(--line)]">
          <FaKey size={12} />
          <TextInput
            type={reveal ? "text" : "password"}
            value={draft}
            onChange={setDraft}
            placeholder="Replace API key…"
            className="flex-1 bg-transparent border-none outline-none text-[var(--fg-1)] font-mono text-xs"
          />
          <Button onClick={() => setReveal((r) => !r)}>
            {reveal ? <FaEyeSlash size={11} /> : <FaEye size={11} />}
          </Button>
          <Button
            variant="primary"
            disabled={!trimmed || saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(trimmed);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Validating…" : "Save"}
          </Button>
        </div>
        <div className="subsection-desc mb-0">
          Saved on this device — same key is reused for every game.
        </div>
      </div>

      {/* Cache — drops the on-disk SGDB API response cache so the
          next browse forces a fresh fetch. Useful when SGDB ships
          new art for a game and the user doesn't want to wait out
          the 6-hour TTL. The saved API key + per-game match
          mappings are NOT touched — those live in plugin-storage
          (config), not external-cache (cache). */}
      <div className="subsection">
        <div className="subsection-label">Cache</div>
        <div className="flex justify-between items-center gap-3">
          <div className="subsection-desc mt-0 flex-1">
            Clears all cached SteamGridDB API responses and re-fetches
            on next view.
          </div>
          <Button
            disabled={clearing}
            onClick={async () => {
              setClearing(true);
              try {
                await onClearCache();
              } finally {
                setClearing(false);
              }
            }}
          >
            {clearing ? "Clearing…" : "Clear SGDB Cache"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot for this plugin
 * (`usePluginHasHeader` probes for the export). The actual header
 * content is portaled from inside the body tree via `<PluginHeader>`
 * in @loadout/ui — same React tree as the body, so state and
 * callbacks are shared without any cross-root pub/sub.
 */
export const mountHeader = mountHeaderStub;
