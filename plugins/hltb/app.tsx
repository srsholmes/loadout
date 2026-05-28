import { useState, useEffect, useCallback, useMemo } from "react";
import { createRoot } from "react-dom/client";

export { FaClock as icon } from "react-icons/fa6";
import { FaGear } from "react-icons/fa6";
import {
  Badge,
  Button,
  fuzzySearchGames,
  GameCard,
  HeaderBackButton,
  IconButton,
  PluginHeader,
  PluginProvider,
  SearchField,
  SegmentedItem,
  Select,
  Spinner,
  Toggle,
  useBackend,
  useCurrentGame,
  useFocusable,
  useIntersectionGate,
} from "@loadout/ui";

// Sentinel values for the library-filter dropdown. Anything that
// isn't one of these is a literal collection id from
// `game-browser::getCollections` — same convention as SGDB and
// LSFG-VK so the shape of the dropdown matches across plugins.
const ALL_GAMES = "__all__";
const STEAM_ONLY = "__steam__";
const SHORTCUT_ONLY = "__shortcut__";

interface CollectionEntry {
  id: string;
  count: number;
}

// --- Types ---

/**
 * Mirror of `GameInfo` from the game-browser plugin. HLTB consumes
 * the same library source as SGDB / ProtonDB / LSFG-VK so collection
 * tags and local artwork URLs are available on every tile.
 */
interface InstalledGame {
  appId: string;
  name: string;
  source: "steam" | "shortcut";
  headerUrl: string;
  capsuleUrl: string;
  localHeaderUrl?: string;
  localCapsuleUrl?: string;
  tags: string[];
}

interface GameTimes {
  gameId: number;
  gameName: string;
  gameImage: string;
  mainStory: string;
  mainPlusExtras: string;
  completionist: string;
  allStyles: string;
}

/**
 * Mirror of the backend `GameDetail` shape returned by
 * `getGameDetailForSteamApp` / `getGameDetailById`. Lives in the UI
 * tree so the detail view can render the richer HLTB metadata
 * without TypeScript turning every access into `any`.
 */
interface GameDetail extends GameTimes {
  alias?: string;
  summary?: string;
  developer?: string;
  publisher?: string;
  platforms?: string;
  genres?: string;
  releaseWorld?: string;
  reviewScore?: number;
  reviewCount?: number;
  playingCount?: number;
  completedCount?: number;
  hltbUrl: string;
}

interface HltbSettings {
  position: "tl" | "tm" | "tr" | "bl" | "bm" | "br";
  showMainStory: boolean;
  showMainPlusExtras: boolean;
  showCompletionist: boolean;
  showAllStyles: boolean;
  enableLibraryBadge: boolean;
  enableStoreBadge: boolean;
}

const BPM_POSITION_LABELS: Record<HltbSettings["position"], string> = {
  tl: "Top Left",
  tm: "Top Middle",
  tr: "Top Right",
  bl: "Bottom Left",
  bm: "Bottom Middle",
  br: "Bottom Right",
};
const BPM_POSITIONS: ReadonlyArray<HltbSettings["position"]> = [
  "tl",
  "tm",
  "tr",
  "bl",
  "bm",
  "br",
];

interface StatusInfo {
  connected: boolean;
  tabs: number;
}

// --- Helpers ---

/** Format an HLTB time string ("4½ Hours", "30m", "--") for chip display. */
function formatTime(time: string): string {
  if (!time || time === "--") return "--";
  const m = time.match(/^([\d.½¼¾]+)\s*(m|h|Hour|Hours|Mins|Minutes)?/i);
  if (!m) return time;
  const unit = (m[2] || "").toLowerCase();
  if (unit.startsWith("m") && unit !== "hour" && unit !== "hours") {
    return `${m[1]}m`;
  }
  return `${m[1]}h`;
}

// --- Main plugin component ---

function HltbPlugin() {
  const { call, useEvent } = useBackend("hltb");
  // Library + collection tags come from the game-browser plugin
  // (single source of truth across SGDB / LSFG-VK / ProtonDB / here).
  const gameBrowser = useBackend("game-browser");
  const currentGame = useCurrentGame();

  const [settings, setSettings] = useState<HltbSettings | null>(null);
  const [status, setStatus] = useState<StatusInfo>({
    connected: false,
    tabs: 0,
  });
  const [installed, setInstalled] = useState<InstalledGame[] | null>(null);
  /** Toggles between the default library grid and the inline config card. */
  const [showConfig, setShowConfig] = useState(false);
  /** Header search query — filters the grid in place. */
  const [searchQuery, setSearchQuery] = useState("");
  /** Library filter dropdown — `ALL_GAMES`, `STEAM_ONLY`,
   *  `SHORTCUT_ONLY`, or a literal collection id. Same convention as
   *  SGDB / LSFG-VK. Defaults to `STEAM_ONLY` because most users
   *  open this to check completion times for their Steam library;
   *  Heroic / Lutris / emulator shortcuts rarely have HLTB matches. */
  const [libraryFilter, setLibraryFilter] = useState<string>(STEAM_ONLY);
  /** Collections list from game-browser, for the filter dropdown. */
  const [collections, setCollections] = useState<CollectionEntry[]>([]);
  /** Currently-detailed game (clicked from the grid). When set, the
   *  body switches to the detail view; `null` shows the grid. The
   *  reference is the InstalledGame row, not just the appId, so the
   *  detail header can render the local Steam name immediately even
   *  before the backend resolves the HLTB payload. */
  const [detailGame, setDetailGame] = useState<InstalledGame | null>(null);

  useEffect(() => {
    void call("getSettings").then((s) => setSettings(s as HltbSettings));
    void call("getStatus").then((s) => setStatus(s as StatusInfo));
    // Unified library: Steam appmanifests + non-Steam shortcuts (ROMs,
    // emulator titles, Heroic / Lutris launchers). HLTB resolves each
    // via name-based search (see `getTimesForGame`) so emulated games
    // like SSX3 surface their time-to-beat alongside Steam games.
    void gameBrowser
      .call("getGames")
      .then((games) => {
        const list = Array.isArray(games) ? (games as InstalledGame[]) : [];
        setInstalled(list);
      })
      .catch(() => setInstalled([]));
    void gameBrowser
      .call("getCollections")
      .then((cols) => {
        if (Array.isArray(cols)) setCollections(cols as CollectionEntry[]);
      })
      .catch(() => setCollections([]));
  }, [call, gameBrowser]);

  useEvent({
    event: "stateChanged",
    handler: (data: unknown) => {
      if (!data || typeof data !== "object") return;
      const d = data as {
        connected?: boolean;
        tabs?: number;
        settings?: HltbSettings;
      };
      if (d.connected !== undefined) {
        setStatus({
          connected: d.connected,
          tabs: d.tabs ?? 0,
        });
      }
      if (d.settings) {
        setSettings(d.settings);
      }
    },
  });

  const updateSettings = useCallback(
    async (partial: Partial<HltbSettings>) => {
      if (!settings) return;
      const next = { ...settings, ...partial };
      setSettings(next);
      await call("updateSettings", next);
    },
    [settings, call],
  );

  /** Wipe the on-disk + in-memory HLTB caches via the backend. The
   *  config card surfaces this as a button — useful when HLTB ships
   *  a metadata fix and the user wants to force-refresh without
   *  waiting out the 12-hour TTL. */
  const handleClearCache = useCallback(async () => {
    await call("clearCache");
  }, [call]);

  // Apply the source / collection filter first, then fuzzysort, then
  // float the running game to the top so it's the easiest target.
  // `currentGame.appId` is a number; library keys are strings —
  // coerce once here.
  const sortedGames = useMemo(() => {
    if (!installed) return null;
    let filtered: InstalledGame[] = installed;
    if (libraryFilter === STEAM_ONLY) {
      filtered = filtered.filter((g) => g.source === "steam");
    } else if (libraryFilter === SHORTCUT_ONLY) {
      filtered = filtered.filter((g) => g.source === "shortcut");
    } else if (libraryFilter !== ALL_GAMES) {
      filtered = filtered.filter((g) => g.tags?.includes(libraryFilter));
    }
    const list = fuzzySearchGames(filtered, searchQuery);
    const runningAppId = currentGame ? String(currentGame.appId) : null;
    if (!runningAppId) return list;
    const idx = list.findIndex((g) => g.appId === runningAppId);
    if (idx <= 0) return list;
    const next = list.slice();
    const [running] = next.splice(idx, 1);
    next.unshift(running);
    return next;
  }, [installed, currentGame, searchQuery, libraryFilter]);

  // Build collection dropdown options for the header. Pulled up here
  // so the picker's options stay in sync with the live library size
  // + collections.
  const filterOptions = useMemo(() => {
    const total = installed?.length ?? 0;
    const steamCount = installed?.filter((g) => g.source === "steam").length ?? 0;
    const shortcutCount =
      installed?.filter((g) => g.source === "shortcut").length ?? 0;
    const opts: Array<{ value: string; label: string }> = [
      { value: ALL_GAMES, label: `All games${total ? ` (${total})` : ""}` },
      { value: STEAM_ONLY, label: `Steam only (${steamCount})` },
    ];
    if (shortcutCount > 0) {
      opts.push({
        value: SHORTCUT_ONLY,
        label: `Non-Steam only (${shortcutCount})`,
      });
    }
    for (const c of collections) {
      opts.push({ value: c.id, label: `${c.id} (${c.count})` });
    }
    return opts;
  }, [installed, collections]);

  // Dynamic topbar header. Title + dynamic subtitle on the left;
  // a single gear toggle on the right that flips the body between
  // the library grid and the inline preferences card. Same React
  // tree as the body — `showConfig`, `installed.length`, and the
  // running-game pointer are shared by closure.
  // When `detailGame` is set the header retitles itself to "How
  // long to beat" with the game name as subtitle (per issue #86) —
  // matches the dynamic-header dance launch-options uses for its
  // selected-game state.
  const subtitle = (() => {
    if (detailGame) return detailGame.name;
    if (showConfig) return "Plugin preferences";
    if (installed === null) return "Reading library…";
    if (installed.length === 0) return "No installed games found";
    const total = installed.length;
    const shown = sortedGames?.length ?? total;
    const filteringCopy =
      searchQuery.trim() && shown !== total
        ? `${shown} of ${total} games`
        : `${total} games`;
    if (currentGame) {
      return `${filteringCopy} · running: ${currentGame.gameName || `App ${currentGame.appId}`}`;
    }
    return `${filteringCopy} · ${status.connected ? `${status.tabs} Steam tab${status.tabs !== 1 ? "s" : ""}` : "Steam CEF not connected"}`;
  })();
  const title = detailGame ? "How long to beat" : "How Long to Beat";

  const headerNode = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            {title}
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {subtitle}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!showConfig && !detailGame && (
            <>
              <SearchField
                value={searchQuery}
                onChange={setSearchQuery}
                onClear={() => setSearchQuery("")}
              />
              <div style={{ minWidth: 180 }}>
                <Select
                  value={libraryFilter}
                  onChange={setLibraryFilter}
                  options={filterOptions}
                />
              </div>
            </>
          )}
          {detailGame ? (
            <HeaderBackButton
              onBack={() => setDetailGame(null)}
              title="Back to library"
            />
          ) : showConfig ? (
            <HeaderBackButton
              onBack={() => setShowConfig(false)}
              title="Back to library"
            />
          ) : (
            <IconButton
              onClick={() => setShowConfig(true)}
              title="Plugin preferences"
              ariaLabel="Plugin preferences"
            >
              <FaGear size={11} />
            </IconButton>
          )}
        </div>
      </div>
    </PluginHeader>
  );

  if (!settings || installed === null) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <div className="flex items-center justify-center h-64">
              <Spinner size={32} />
            </div>
          </div>
        </div>
      </>
    );
  }

  if (detailGame) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <HltbDetailView game={detailGame} />
          </div>
        </div>
      </>
    );
  }

  if (showConfig) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <ConfigCard
              settings={settings}
              status={status}
              onUpdate={updateSettings}
              onClearCache={handleClearCache}
            />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {headerNode}
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          {sortedGames && sortedGames.length === 0 ? (
            <div className="card">
              <div className="text-center py-10 text-[var(--fg-3)]">
                {installed && installed.length === 0
                  ? "No installed games found. Install something via Steam or add a non-Steam shortcut first."
                  : "No games match the current search / filter."}
              </div>
            </div>
          ) : (
            // 4 cols when the shell sidebar is open, 6 when it
            // collapses — driven by the `sidebar-open` /
            // `sidebar-collapsed` custom Tailwind variants
            // registered in overlay/src/index.css.
            <div className="grid grid-cols-4 sidebar-collapsed:grid-cols-6 gap-2.5">
              {sortedGames!.map((game) => (
                <HltbGameCard
                  key={game.appId}
                  game={game}
                  isCurrent={
                    currentGame !== null &&
                    String(currentGame.appId) === game.appId
                  }
                  showMainStory={settings.showMainStory}
                  showMainPlusExtras={settings.showMainPlusExtras}
                  showCompletionist={settings.showCompletionist}
                  showAllStyles={settings.showAllStyles}
                  onOpen={() => setDetailGame(game)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// --- Game card (library grid) ---

/**
 * One tile in the library grid. Renders the capsule + name + the
 * configured HLTB time chips. Each card kicks off its own
 * `getTimesForGame(appId, name)` call on mount — name comes from
 * `game-browser` so Steam apps AND non-Steam shortcuts (emulator
 * titles etc.) resolve via the same path. The backend's concurrency
 * limiter (`MAX_CONCURRENT_LOOKUPS = 3`) batches the fan-out so HLTB
 * doesn't 429.
 */
function HltbGameCard({
  game,
  isCurrent,
  showMainStory,
  showMainPlusExtras,
  showCompletionist,
  showAllStyles,
  onOpen,
}: {
  game: InstalledGame;
  isCurrent: boolean;
  showMainStory: boolean;
  showMainPlusExtras: boolean;
  showCompletionist: boolean;
  showAllStyles: boolean;
  /** Click / Enter / A-button → drills into the HLTB detail view
   *  (issue #86). The card itself stays passive on data load; only
   *  user activation drives the route change. */
  onOpen: () => void;
}) {
  const { call } = useBackend("hltb");
  const [times, setTimes] = useState<GameTimes | null>(null);
  // `loading` stays true until either the card enters view AND the
  // fetch resolves, OR the card unmounts. Off-screen cards never
  // change state — keeps the spinner static (visually identical to
  // a paused state) without burning HLTB rate budget.
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  // Gate the HLTB fetch on the card actually scrolling into view —
  // without this a 100+ game library would fan out 100+ requests on
  // mount and trip HLTB's anti-bot. `useIntersectionGate` is the
  // shared helper used by ProtonDB / theme-loader for the same
  // pattern; `rootMargin: 200px` starts loading just before the card
  // visibly lands on-screen so data resolves while it's scrolling in.
  const [inView, handleRootRef] = useIntersectionGate<HTMLDivElement>();

  useEffect(() => {
    if (!inView) return;
    let alive = true;
    setLoading(true);
    setMissing(false);
    call("getTimesForGame", game.appId, game.name)
      .then((result) => {
        if (!alive) return;
        if (result) {
          setTimes(result as GameTimes);
        } else {
          setMissing(true);
        }
      })
      .catch(() => {
        if (alive) setMissing(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [call, game.appId, game.name, inView]);

  // game-browser already emits the right URLs: `capsuleUrl` is the
  // portrait library tile (or the loader's local-grid endpoint for
  // shortcuts) and `headerUrl` is the landscape header. Use them as-is
  // so we stay in sync with what SGDB shows.
  const primaryThumb = game.capsuleUrl;
  const fallbackThumb = game.headerUrl;

  // Everything — loading, error, and the actual time chips — rides
  // the bottom of the image as a Badge. Keeps every HLTB tile the
  // same height regardless of fetch state so the grid doesn't
  // reflow when data trickles in from background fetches.
  const timeBadges = loading ? (
    <Badge variant="neutral" size="xs">
      <span className="flex items-center gap-1">
        <Spinner size={10} /> Loading
      </span>
    </Badge>
  ) : missing || !times ? (
    <Badge variant="neutral" size="xs">
      <span className="italic">No HLTB data</span>
    </Badge>
  ) : (
    <>
      {showMainStory && (
        <Badge
          variant="info"
          size="xs"
          className="max-w-full truncate min-w-0"
        >
          <span title="Main story" style={{ fontVariantNumeric: "tabular-nums" }}>
            Main {formatTime(times.mainStory)}
          </span>
        </Badge>
      )}
      {showMainPlusExtras && (
        <Badge
          variant="secondary"
          size="xs"
          className="max-w-full truncate min-w-0"
        >
          <span title="Main + extras" style={{ fontVariantNumeric: "tabular-nums" }}>
            +Ex {formatTime(times.mainPlusExtras)}
          </span>
        </Badge>
      )}
      {showCompletionist && (
        <Badge
          variant="accent"
          size="xs"
          className="max-w-full truncate min-w-0"
        >
          <span title="Completionist" style={{ fontVariantNumeric: "tabular-nums" }}>
            100% {formatTime(times.completionist)}
          </span>
        </Badge>
      )}
      {showAllStyles && (
        <Badge
          variant="primary"
          size="xs"
          className="max-w-full truncate min-w-0"
        >
          <span title="All styles" style={{ fontVariantNumeric: "tabular-nums" }}>
            All {formatTime(times.allStyles)}
          </span>
        </Badge>
      )}
    </>
  );

  return (
    <GameCard
      imageUrl={primaryThumb}
      fallbackImageUrl={fallbackThumb}
      title={game.name}
      overlayBadges={timeBadges}
      topLeftBadge={
        isCurrent ? (
          <span className="chip chip-accent">RUNNING</span>
        ) : undefined
      }
      highlighted={isCurrent}
      rootRef={handleRootRef}
      onPick={onOpen}
    />
  );
}

// --- Detail view (clicked from the library grid) ---

/** Format the four headline times for the breakdown table. Anchors
 *  the visual hierarchy: bold time + tabular-nums on each row so the
 *  numbers align vertically even when one row is "—". */
const DETAIL_ROWS: Array<{
  key: "mainStory" | "mainPlusExtras" | "completionist" | "allStyles";
  label: string;
  shortLabel: string;
  tooltip: string;
}> = [
  {
    key: "mainStory",
    label: "Main Story",
    shortLabel: "Main",
    tooltip: "Time to complete the main story only.",
  },
  {
    key: "mainPlusExtras",
    label: "Main + Sides",
    shortLabel: "+Sides",
    tooltip: "Main story plus side content (most playthroughs).",
  },
  {
    key: "completionist",
    label: "Completionist",
    shortLabel: "100%",
    tooltip: "100% completion — every collectible / side activity.",
  },
  {
    key: "allStyles",
    label: "All Styles",
    shortLabel: "Avg",
    tooltip: "Average across all playstyles.",
  },
];

function HltbDetailView({ game }: { game: InstalledGame }) {
  const { call } = useBackend("hltb");
  const [detail, setDetail] = useState<GameDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setMissing(false);
    setDetail(null);
    // Detail uses `getGameDetailForGame` — the backend's two-hop path
    // (HLTB search → resolve HLTB gameId → /_next/data deep-link)
    // that surfaces dev/pub/platforms/genres/score on top of the four
    // times. Passing the name directly works for Steam games AND
    // non-Steam shortcuts; the search→appId hop is cached, so
    // navigating back into the same detail page is a single
    // deep-link fetch.
    call("getGameDetailForGame", game.appId, game.name)
      .then((result) => {
        if (!alive) return;
        if (result) setDetail(result as GameDetail);
        else setMissing(true);
      })
      .catch(() => {
        if (alive) setMissing(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [call, game.appId, game.name]);

  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center justify-center h-48">
          <Spinner size={32} />
        </div>
      </div>
    );
  }

  if (missing || !detail) {
    return (
      <div className="card">
        <div className="text-center py-10 text-[var(--fg-3)]">
          No HLTB data found for{" "}
          <span className="font-semibold text-[var(--fg-2)]">{game.name}</span>.
        </div>
      </div>
    );
  }

  // Hero is a 460×215 landscape banner. Steam's `headerUrl` is the
  // matching landscape header art, so use it as the primary source.
  // HLTB's `gameImage` is portrait boxart (capsule-style) — at
  // landscape aspect ratio it crops to a vertical strip down the
  // middle, which is what made the hero look like a capsule. Keep it
  // only as a last-ditch fallback for non-Steam shortcuts where
  // headerUrl might 404.
  const heroImage = game.headerUrl;
  const heroFallback = detail.gameImage;

  // Headline times the issue calls out: "HowLongToBeat- 78½ Hours /
  // Main Story - 50½ Hours / Main + Sides - 84½ Hours / Completionist
  // - 193 Hours". We surface the four rows below the hero — the
  // "HowLongToBeat" headline is "All Styles" (the cross-playstyle
  // average that HLTB displays prominently on game pages).
  return (
    <div className="card">
      <HltbHero
        gameName={detail.gameName || game.name}
        imageUrl={heroImage}
        fallbackUrl={heroFallback}
        detail={detail}
      />

      <HltbMetadataPanel detail={detail} game={game} />

      <div className="subsection">
        {/* Read-only source line. CEF's `window.open` is gated inside
            the overlay, so this is currently informational only. If
            we want it clickable later, route through the
            `quick-links` plugin's `launchUrl` RPC the same way the
            home-widget chips do. */}
        <div
          className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border"
          style={{
            background: "var(--bg-inset)",
            borderColor: "var(--line)",
          }}
        >
          <span className="text-[11.5px] text-[var(--fg-3)] truncate">
            Source:{" "}
            <span className="mono text-[var(--fg-2)]">{detail.hltbUrl}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Hero banner at the top of the detail view. Landscape Steam header
 *  art (~460×215) with the four time-to-beat values overlaid as
 *  pill-badges along the bottom edge — same approach as the in-BPM
 *  pill, scaled up for the detail page. A dark gradient scrim keeps
 *  the badges legible over any artwork; each badge keeps its accent
 *  dot so the colour coding matches the metadata panel below. */
function HltbHero({
  gameName,
  imageUrl,
  fallbackUrl,
  detail,
}: {
  gameName: string;
  imageUrl: string;
  fallbackUrl: string;
  detail: GameDetail;
}) {
  const [src, setSrc] = useState(imageUrl);
  // Reset whenever the upstream URL changes — switching detail games
  // in quick succession would otherwise leave the previous hero
  // pinned on a fallback-back-to-fallback chain.
  useEffect(() => {
    setSrc(imageUrl);
  }, [imageUrl]);

  return (
    <div
      className="relative rounded-lg overflow-hidden mb-4"
      style={{
        aspectRatio: "460 / 215",
        background:
          "linear-gradient(135deg, var(--bg-2) 0%, var(--bg-inset) 100%)",
      }}
    >
      {src ? (
        <img
          src={src}
          alt={gameName}
          className="absolute inset-0 w-full h-full object-cover block"
          onError={() => {
            if (src !== fallbackUrl) setSrc(fallbackUrl);
            else setSrc("");
          }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--fg-3)] italic">
          {gameName}
        </div>
      )}

      {/* Bottom gradient scrim so the badge row stays legible over
          bright artwork without darkening the whole hero. Tall enough
          (75%) to cover a wrapped 2-row badge layout on narrow
          overlays where the 4 pills overflow into a second row. */}
      <div
        className="absolute inset-x-0 bottom-0 pointer-events-none"
        style={{
          height: "75%",
          background:
            "linear-gradient(to top, rgba(0,0,0,0.80) 0%, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0) 100%)",
        }}
      />

      {/* Time badges. Solid `--bg-inset` backing matches the pill
          treatment used on game cards (chip-accent + badge-soft are
          translucent and would fade into the art). */}
      <div className="absolute inset-x-2 bottom-2 flex flex-wrap gap-1.5 justify-start">
        {DETAIL_ROWS.map((row) => {
          const value = detail[row.key] as string;
          const hasValue = value && value !== "--";
          return (
            <span
              key={row.key}
              title={`${row.label} — ${row.tooltip}`}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border"
              style={{
                background: "var(--bg-inset)",
                borderColor: "var(--line)",
              }}
            >
              <span className="text-[11px] text-[var(--fg-2)] font-medium">
                {row.shortLabel}
              </span>
              <span
                className="mono text-[12px] font-semibold tabular-nums"
                style={{
                  color: hasValue ? "var(--fg-1)" : "var(--fg-3)",
                }}
              >
                {hasValue ? value : "—"}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Optional metadata panel — only renders rows for fields HLTB
 *  actually populated. HLTB's data is patchy; an obscure title
 *  might have only a release date and dev. Skipping empty rows
 *  keeps the layout from looking like a Mad Libs page. */
function HltbMetadataPanel({
  detail,
  game,
}: {
  detail: GameDetail;
  game: InstalledGame;
}) {
  const rows: Array<{ label: string; value: string }> = [];

  if (detail.alias && detail.alias !== detail.gameName) {
    rows.push({ label: "Also known as", value: detail.alias });
  }
  if (detail.developer) rows.push({ label: "Developer", value: detail.developer });
  if (detail.publisher) rows.push({ label: "Publisher", value: detail.publisher });
  if (detail.releaseWorld) {
    rows.push({ label: "Released", value: detail.releaseWorld });
  }
  if (detail.genres) rows.push({ label: "Genre", value: detail.genres });
  if (detail.platforms) rows.push({ label: "Platforms", value: detail.platforms });

  // Backlog / playing / completed counts give a useful sense of how
  // popular the game is on HLTB — surface them as a compact stat
  // row so the detail page doesn't lean entirely on metadata cards.
  const stats: Array<{ label: string; value: string }> = [];
  if (typeof detail.reviewScore === "number") {
    stats.push({ label: "Score", value: `${detail.reviewScore}/100` });
  }
  if (typeof detail.completedCount === "number") {
    stats.push({
      label: "Completed",
      value: detail.completedCount.toLocaleString(),
    });
  }
  if (typeof detail.playingCount === "number") {
    stats.push({
      label: "Playing",
      value: detail.playingCount.toLocaleString(),
    });
  }

  const hasMeta = rows.length > 0;
  const hasStats = stats.length > 0;
  const hasSummary = !!detail.summary;
  if (!hasMeta && !hasStats && !hasSummary) return null;

  return (
    <>
      {hasStats && (
        <div className="subsection">
          <div className="grid grid-cols-3 gap-2">
            {stats.map((s) => (
              <div
                key={s.label}
                className="flex flex-col items-center justify-center py-3 rounded-lg border"
                style={{
                  background: "var(--bg-inset)",
                  borderColor: "var(--line)",
                }}
              >
                <span className="text-[16px] font-semibold tabular-nums text-[var(--fg-1)]">
                  {s.value}
                </span>
                <span className="text-[10.5px] uppercase tracking-[0.05em] text-[var(--fg-3)]">
                  {s.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasMeta && (
        <div className="subsection">
          <div className="subsection-label mb-2">About</div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
            {rows.map((r) => (
              <FragmentRow key={r.label} label={r.label} value={r.value} />
            ))}
            <FragmentRow
              label={game.source === "shortcut" ? "Shortcut ID" : "Steam AppID"}
              value={game.appId}
            />
          </dl>
        </div>
      )}

      {hasSummary && (
        <div className="subsection">
          <div className="subsection-label mb-2">Summary</div>
          <p
            className="text-[12.5px] leading-relaxed text-[var(--fg-2)] m-0"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 6,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {detail.summary}
          </p>
        </div>
      )}
    </>
  );
}

/** One row in the metadata `<dl>`. Split into a fragment so the
 *  grid auto-rows align label-and-value columns across all rows. */
function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--fg-3)] font-medium">{label}</dt>
      <dd className="m-0 text-[var(--fg-1)] break-words">{value}</dd>
    </>
  );
}

// --- Config card (shown when the gear icon is clicked) ---

function ConfigCard({
  settings,
  status,
  onUpdate,
  onClearCache,
}: {
  settings: HltbSettings;
  status: StatusInfo;
  onUpdate: (partial: Partial<HltbSettings>) => Promise<void>;
  onClearCache: () => Promise<void>;
}) {
  const integrationEnabled =
    settings.enableLibraryBadge || settings.enableStoreBadge;

  const toggleIntegration = (on: boolean) => {
    void onUpdate({ enableLibraryBadge: on, enableStoreBadge: on });
  };

  const metrics: Array<{
    key:
      | "showMainStory"
      | "showMainPlusExtras"
      | "showCompletionist"
      | "showAllStyles";
    label: string;
  }> = [
    { key: "showMainStory", label: "Main Story" },
    { key: "showMainPlusExtras", label: "Main + Extras" },
    { key: "showCompletionist", label: "Completionist" },
    { key: "showAllStyles", label: "All Styles" },
  ];

  return (
    <div className="card">
      {/* Steam Integration */}
      <div className="subsection">
        <div className="flex justify-between items-center gap-3">
          <div className="min-w-0">
            <div className="subsection-label mb-0.5">Steam Integration</div>
            <div className="text-xs text-[var(--fg-3)]">
              Inject time-to-beat badges into your library and game detail
              pages
              {status.connected
                ? ` · Connected (${status.tabs} tab${status.tabs !== 1 ? "s" : ""})`
                : " · Steam CEF not connected"}
            </div>
          </div>
          <Toggle checked={integrationEnabled} onChange={toggleIntegration} />
        </div>
      </div>

      {/* Metrics shown */}
      <div className="subsection">
        <div className="subsection-label">Metrics Shown</div>
        <div className="grid grid-cols-2 gap-2">
          {metrics.map(({ key, label }) => (
            <MetricToggle
              key={key}
              label={label}
              on={settings[key]}
              onToggle={() => onUpdate({ [key]: !settings[key] })}
            />
          ))}
        </div>
      </div>

      {/* Badge position — mirrors the ProtonDB plugin's 6-way picker
          so the BPM badge can be moved off of Steam's bottom-right
          controller/settings icons. */}
      <div className="subsection">
        <div className="subsection-label">Badge Position</div>
        <div className="segmented">
          {BPM_POSITIONS.map((p) => (
            <SegmentedItem
              key={p}
              active={settings.position === p}
              onSelect={() => onUpdate({ position: p })}
              style={{ flex: 1, fontSize: 11 }}
            >
              {BPM_POSITION_LABELS[p]}
            </SegmentedItem>
          ))}
        </div>
      </div>

      {/* Cache — wipes the on-disk + in-memory HLTB caches so the
          next library card forces a fresh fetch. Useful when HLTB
          ships a metadata correction and the user doesn't want to
          wait out the 12-hour TTL. */}
      <div className="subsection">
        <div className="subsection-label">Cache</div>
        <div className="flex justify-between items-center gap-3">
          <div className="subsection-desc mt-0 flex-1">
            Clears all cached HowLongToBeat completion times and
            re-fetches on next view.
          </div>
          <Button onClick={onClearCache}>Clear HLTB Cache</Button>
        </div>
      </div>
    </div>
  );
}

function MetricToggle({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: onToggle,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      className={[
        "flex items-center justify-center gap-2 p-3 rounded-[10px] cursor-pointer text-[12.5px] transition-all duration-150",
        on
          ? "bg-[var(--accent-soft)] border border-[var(--accent)] text-[var(--accent)] font-semibold"
          : "bg-[var(--bg-inset)] border border-[var(--line)] text-[var(--fg-2)] font-medium",
        focused ? "scale-[1.03]" : "",
      ].join(" ")}
      style={focused ? { animation: "focusPulse 2s ease-in-out infinite" } : undefined}
    >
      {on ? "✓ " : ""}
      {label}
    </button>
  );
}

// --- Home widget (unchanged behaviour, kept for the Home dashboard) ---

interface HltbGameTimes {
  gameId: number;
  gameName: string;
  mainStory: string;
  mainPlusExtras: string;
  completionist: string;
  allStyles: string;
}

function HltbHomeWidget() {
  const { call } = useBackend("hltb");
  const currentGame = useCurrentGame();
  const targetAppId = currentGame ? String(currentGame.appId) : null;
  const targetName = currentGame?.gameName ?? null;
  const [times, setTimes] = useState<HltbGameTimes | null>(null);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!targetAppId) {
      setTimes(null);
      setLoading(false);
      setMissing(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setMissing(false);
    // Prefer the name-aware RPC so the widget works for non-Steam
    // shortcuts (emulator titles) too. Falls back to the Steam-only
    // path if the runtime didn't surface a name on currentGame.
    const lookup = targetName
      ? call("getTimesForGame", targetAppId, targetName)
      : call("getTimesForSteamApp", targetAppId);
    lookup
      .then((result) => {
        if (!alive) return;
        if (result) {
          setTimes(result as HltbGameTimes);
        } else {
          setTimes(null);
          setMissing(true);
        }
      })
      .catch(() => {
        if (alive) setMissing(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [call, targetAppId, targetName]);

  if (!currentGame) {
    return (
      <div className="card-body">
        <div className="flex items-center justify-between mb-2">
          <div className="card-title">HOW LONG TO BEAT</div>
        </div>
        <div className="flex items-center justify-center h-full">
          <span className="text-xs italic text-base-content/60">
            No game running
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="card-body">
      <div className="flex items-center justify-between mb-3.5">
        <div className="card-title">HOW LONG TO BEAT</div>
        {times && (
          <div className="chip chip-accent truncate max-w-[60%]">
            {times.gameName}
          </div>
        )}
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-3">
          <Spinner size={16} />
        </div>
      ) : missing || !times ? (
        <div className="text-xs italic text-base-content/60">
          No HLTB data found for {currentGame.gameName || `App ${currentGame.appId}`}.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="row">
            <span className="row-label">Main Story</span>
            <span className="row-value mono">{formatTime(times.mainStory)}</span>
          </div>
          <div className="row">
            <span className="row-label">Main + Extras</span>
            <span className="row-value mono">
              {formatTime(times.mainPlusExtras)}
            </span>
          </div>
          <div className="row">
            <span className="row-label">Completionist</span>
            <span className="row-value mono">
              {formatTime(times.completionist)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function mount(
  container: HTMLElement,
  opts?: { parentFocusKey?: string; headerSlot?: HTMLElement | null },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider
      parentFocusKey={opts?.parentFocusKey}
      headerSlot={opts?.headerSlot ?? null}
    >
      <HltbPlugin />
    </PluginProvider>,
  );
  return () => root.unmount();
}

export function mountHomeWidget(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <HltbHomeWidget />
    </PluginProvider>,
  );
  return () => root.unmount();
}

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot — the actual header
 * content is portaled from inside `mount()` via `<PluginHeader>` so
 * the gear/back toggle and the running-game pointer share the body's
 * React tree without any cross-root pub/sub.
 */
export function mountHeader(): () => void {
  return () => {};
}
