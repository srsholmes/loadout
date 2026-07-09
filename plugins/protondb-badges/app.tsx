import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Badge,
  Button,
  fuzzySearchGames,
  GameCard,
  GameCardGrid,
  HeaderBackButton,
  hideOverlay,
  IconButton,
  mountComponent,
  mountHeaderStub,
  PluginHeader,
  SearchField,
  SegmentedItem,
  Select,
  Spinner,
  Toggle,
  useBackend,
  useCurrentGame,
  useIntersectionGate,
} from "@loadout/ui";
import { steamArtworkUrls } from "@loadout/steam-paths/artwork";

export { FaAward as icon } from "react-icons/fa6";
import { FaGear } from "react-icons/fa6";

// --- Types ---

/**
 * Library tile shape consumed by the grid. In steam-loader this came
 * from the `game-browser` plugin's `getGames` RPC (collection tags,
 * local-art URLs). Loadout doesn't have `game-browser` yet, so the
 * backend's `listInstalledGames` (via `@loadout/steam-paths`) is the
 * source of truth and we synthesise the Steam-CDN art URLs by appId
 * inline. Image URLs are not gated by the sandboxed `fetch` (only
 * declared `fetch()` hosts are), so `<img src>` to Steam's CDN works
 * without adding the host to `permissions.network`.
 */
interface GridGame {
  appId: string;
  name: string;
  capsuleUrl: string;
  headerUrl: string;
}

interface ProtonDBReport {
  tier: string;
  confidence: string;
  score: number;
  trendingTier: string;
}

interface ProtonDBSettings {
  size: "regular" | "small" | "minimalist";
  position: "tl" | "tm" | "tr" | "bl" | "bm" | "br";
  labelOnHover: "off" | "small" | "regular";
  showSubmitButton: boolean;
  enableLibraryBadge: boolean;
  enableStoreBadge: boolean;
}

interface StatusInfo {
  connected: boolean;
  tabs: number;
}

interface BareInstalledGame {
  appId: string;
  name: string;
}

/** Which slice of the Steam library the grid shows. "installed" reads
 *  `appmanifest_*.acf` off disk (fast, offline); "all" reads the full
 *  owned library from `appStore.allApps` over CDP (needs Steam up). */
type LibrarySource = "installed" | "all";

const LIBRARY_SOURCE_OPTIONS: { value: LibrarySource; label: string }[] = [
  { value: "installed", label: "Installed games" },
  { value: "all", label: "All games" },
];

// --- Tier config ---

const TIER_ORDER = ["platinum", "gold", "silver", "bronze", "borked"] as const;
type TierKey = typeof TIER_ORDER[number];

const TIER_COLOR: Record<TierKey, string> = {
  platinum: "oklch(0.85 0.02 260)",
  gold: "oklch(0.78 0.14 85)",
  silver: "oklch(0.7 0.02 260)",
  bronze: "oklch(0.55 0.1 50)",
  borked: "var(--color-error, oklch(0.6 0.2 25))",
};

const TIER_LABEL: Record<TierKey, string> = {
  platinum: "Platinum",
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
  borked: "Borked",
};

const TIER_DESCRIPTIONS: Record<string, string> = {
  platinum: "Runs perfectly out of the box",
  gold: "Runs perfectly after tweaks",
  silver: "Runs with minor issues",
  bronze: "Runs, but often crashes or has issues",
  borked: "Does not run or is unplayable",
  pending: "Reports exist but not yet rated",
};

const CONFIDENCE_LABELS: Record<string, string> = {
  good: "High",
  fair: "Medium",
  low: "Low",
  inadequate: "Very Low",
  unknown: "Unknown",
};

const POSITION_LABELS: Record<string, string> = {
  tl: "Top Left",
  tm: "Top Middle",
  tr: "Top Right",
  bl: "Bottom Left",
  bm: "Bottom Middle",
  br: "Bottom Right",
};

// "Badge Style" segmented in the Loadout design maps to the existing
// `size` backend setting so we keep wiring real — no new backend fields.
const STYLE_OPTIONS: { value: ProtonDBSettings["size"]; label: string }[] = [
  { value: "regular", label: "Label badge" },
  { value: "minimalist", label: "Colored dot" },
  { value: "small", label: "Tile border tint" },
];

// --- Inline tier chip ---

function TierChip({ tier, dense }: { tier: TierKey; dense?: boolean }) {
  return (
    <span
      style={{
        padding: dense ? "1px 5px" : "2px 8px",
        background: TIER_COLOR[tier],
        color: "#1a1a1a",
        borderRadius: 4,
        fontSize: dense ? 9 : 10,
        fontWeight: 700,
        letterSpacing: "0.08em",
        display: "inline-block",
        textTransform: "uppercase",
      }}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}

// --- Main plugin component ---

function ProtonDBBadges() {
  const { call, useEvent } = useBackend("protondb-badges");
  const currentGame = useCurrentGame();

  const [settings, setSettings] = useState<ProtonDBSettings | null>(null);
  const [status, setStatus] = useState<StatusInfo>({ connected: false, tabs: 0 });
  const [installed, setInstalled] = useState<GridGame[] | null>(null);
  /** Which library slice the grid shows. Defaults to "installed" —
   *  the plugin's original behaviour (disk-read appmanifests). */
  const [librarySource, setLibrarySource] = useState<LibrarySource>("installed");
  /** Set when the "All games" CDP read fails (Steam unreachable) so the
   *  grid can show an actionable empty state instead of a bare "no
   *  games". Cleared whenever a fetch starts. */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Toggles between library grid and inline settings card. */
  const [showConfig, setShowConfig] = useState(false);
  /** Header search query — filters the grid in place. */
  const [searchQuery, setSearchQuery] = useState("");
  /** Live aggregate of every tier we've seen across the rendered cards.
   *  Drives the "Library Breakdown" stat bar on the settings card. */
  const [tierMap, setTierMap] = useState<Record<string, TierKey | "pending">>({});

  useEffect(() => {
    void call("getSettings").then((s) => setSettings(s as ProtonDBSettings));
    void call("getStatus").then((s) => setStatus(s as StatusInfo));
  }, [call]);

  // Load the grid's games for the selected source. "installed" reads
  // appmanifests off disk; "all" pulls the full owned library from
  // Steam over CDP (and can fail if Steam isn't reachable — surface
  // that as `loadError` rather than a silent empty grid).
  useEffect(() => {
    let alive = true;
    setInstalled(null);
    setLoadError(null);
    const rpc = librarySource === "all" ? "listAllGames" : "listInstalledGames";
    call(rpc)
      .then((games) => {
        if (!alive) return;
        const list = Array.isArray(games)
          ? (games as BareInstalledGame[])
          : [];
        // Resolve art through the loader's local steam-grid route (same
        // as every other plugin) so the user's SteamGridDB / custom-
        // artwork overrides are honoured — a raw Steam-CDN URL never
        // sees those and shows the default capsule. Falls back from the
        // portrait capsule to the landscape header inside <GameCard>.
        setInstalled(
          list.map((g) => {
            const art = steamArtworkUrls(g.appId);
            return {
              appId: g.appId,
              name: g.name,
              capsuleUrl: art.capsule,
              headerUrl: art.header,
            };
          }),
        );
      })
      .catch((err) => {
        if (!alive) return;
        setInstalled([]);
        if (librarySource === "all") {
          setLoadError(
            "Couldn't read your full Steam library. Make sure Steam is running, then try again.",
          );
        }
        console.warn(`[protondb-badges] ${rpc} failed:`, err);
      });
    return () => {
      alive = false;
    };
  }, [call, librarySource]);

  // Open the game in Steam and land on its ProtonDB page — the same
  // destination the injected library badge reaches. Hide the overlay
  // first so the Steam UI / ProtonDB page isn't obscured, then drive
  // Steam from the backend over CDP.
  const handleOpenGame = useCallback(
    (appId: string) => {
      void hideOverlay().catch(() => {});
      void call("openProtonDb", { appId }).catch((err) => {
        console.warn("[protondb-badges] openProtonDb failed:", err);
      });
    },
    [call],
  );

  useEvent({
    event: "stateChanged",
    handler: (data: unknown) => {
      const d = data as {
        settings?: ProtonDBSettings;
        connected?: boolean;
        tabs?: number;
      };
      if (d.settings) {
        setSettings(d.settings);
      }
      // Backend emits connection state alongside settings on connect /
      // health-check changes — reflect it live in the Steam CEF section.
      if (typeof d.connected === "boolean") {
        setStatus({ connected: d.connected, tabs: d.tabs ?? 0 });
      }
    },
  });

  const handleSettingsUpdate = useCallback(
    async (newSettings: ProtonDBSettings) => {
      setSettings(newSettings);
      await call("updateSettings", newSettings);
    },
    [call],
  );

  const update = useCallback(
    (partial: Partial<ProtonDBSettings>) => {
      if (!settings) return;
      void handleSettingsUpdate({ ...settings, ...partial });
    },
    [settings, handleSettingsUpdate],
  );

  const handleReconnect = useCallback(async () => {
    await call("reconnect");
    const s = (await call("getStatus")) as StatusInfo;
    setStatus(s);
  }, [call]);

  const handleClearCache = useCallback(async () => {
    await call("clearCache");
    setTierMap({});
  }, [call]);

  /** Card→parent callback: stash the tier so the breakdown card can
   *  aggregate live as cards finish loading. */
  const reportTier = useCallback(
    (appId: string, tier: TierKey | "pending" | null) => {
      if (!tier) return;
      setTierMap((prev) =>
        prev[appId] === tier ? prev : { ...prev, [appId]: tier },
      );
    },
    [],
  );

  // Sort + filter the library. Query runs through fuzzysort (name +
  // collection tags + friendly aliases); the running game floats to
  // the top so it's the easiest target. We deliberately do NOT
  // offer a tier-based filter — tier data loads lazily per card
  // (rate-limited against ProtonDB) so a "Gold only" filter would
  // hide games whose tier hasn't been fetched yet.
  const visibleGames = useMemo(() => {
    if (!installed) return null;
    const runningAppId = currentGame ? String(currentGame.appId) : null;
    const list = fuzzySearchGames(installed, searchQuery);
    if (!runningAppId) return list;
    const idx = list.findIndex((g) => g.appId === runningAppId);
    if (idx <= 0) return list;
    const next = list.slice();
    // idx is a valid found index (> 0), so splice yields exactly one element.
    const [running] = next.splice(idx, 1);
    if (running !== undefined) next.unshift(running);
    return next;
  }, [installed, currentGame, searchQuery]);

  // Live tier counts across the loaded cards. Only counts tiers we
  // recognise so unknown / "pending" don't pollute the breakdown.
  const tierCounts = useMemo<Record<TierKey, number>>(() => {
    const counts: Record<TierKey, number> = {
      platinum: 0,
      gold: 0,
      silver: 0,
      bronze: 0,
      borked: 0,
    };
    for (const tier of Object.values(tierMap)) {
      if (tier && tier in counts) counts[tier as TierKey]++;
    }
    return counts;
  }, [tierMap]);
  const breakdownTotal = TIER_ORDER.reduce((a, t) => a + tierCounts[t], 0);

  const subtitle = (() => {
    if (showConfig) return "Plugin preferences";
    if (installed === null) return "Reading Steam library…";
    if (loadError) return "Steam library unavailable";
    if (installed.length === 0) {
      return librarySource === "all"
        ? "No Steam games found"
        : "No installed Steam games found";
    }
    const total = installed.length;
    const shown = visibleGames?.length ?? total;
    const filteringCopy =
      searchQuery.trim() && shown !== total
        ? `${shown} of ${total} games`
        : `${total} games`;
    if (currentGame) {
      return `${filteringCopy} · running: ${currentGame.gameName || `App ${currentGame.appId}`}`;
    }
    return filteringCopy;
  })();

  // Dynamic topbar header. Title + dynamic subtitle on the left.
  // On the grid view: search input + gear icon. On the settings
  // view: back arrow only (search is hidden — it filters the grid,
  // which isn't visible in settings).
  const headerNode = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            ProtonDB
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {subtitle}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!showConfig && (
            <Select<LibrarySource>
              value={librarySource}
              options={LIBRARY_SOURCE_OPTIONS}
              onChange={setLibrarySource}
              size="sm"
            />
          )}
          {!showConfig && (
            <SearchField
              value={searchQuery}
              onChange={setSearchQuery}
              onClear={() => setSearchQuery("")}
            />
          )}
          {showConfig ? (
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

  if (showConfig) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <ConfigCards
              settings={settings}
              status={status}
              tierCounts={tierCounts}
              breakdownTotal={breakdownTotal}
              onUpdate={update}
              onReconnect={handleReconnect}
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
        <div className="page-content full">
          {visibleGames && visibleGames.length === 0 ? (
            <div className="card">
              <div className="text-center py-10 text-[var(--fg-3)]">
                {loadError
                  ? loadError
                  : searchQuery.trim()
                    ? `No games match "${searchQuery.trim()}".`
                    : librarySource === "all"
                      ? "No Steam games found in your library."
                      : "No installed Steam games found. Install something via Steam first."}
              </div>
            </div>
          ) : (
            <GameCardGrid>
              {(visibleGames ?? []).map((game) => (
                <ProtonDBGameCard
                  key={game.appId}
                  game={game}
                  isCurrent={
                    currentGame !== null &&
                    String(currentGame.appId) === game.appId
                  }
                  onTier={reportTier}
                  onPick={() => handleOpenGame(game.appId)}
                />
              ))}
            </GameCardGrid>
          )}
        </div>
      </div>
    </>
  );
}

// --- Game card ---

/**
 * One tile in the library grid. Renders the Steam capsule + name +
 * the ProtonDB tier badge (or pending / no-data fallback). Each
 * card kicks off its own `getReport` call on mount; the backend's
 * 4-slot semaphore batches the fan-out so ProtonDB doesn't 429.
 */
function ProtonDBGameCard({
  game,
  isCurrent,
  onTier,
  onPick,
}: {
  game: GridGame;
  isCurrent: boolean;
  onTier: (appId: string, tier: TierKey | "pending" | null) => void;
  onPick: () => void;
}) {
  const { call } = useBackend("protondb-badges");
  const [report, setReport] = useState<ProtonDBReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  // Gate `getReport` on the card actually scrolling into view —
  // without this a 100+ game library fans out 100+ ProtonDB requests
  // on mount and risks a 429. `rootMargin: 200px` (the
  // useIntersectionGate default) starts the fetch just before the
  // card lands on-screen so data is ready when the user sees it.
  const [inView, handleRootRef] = useIntersectionGate<HTMLDivElement>();

  useEffect(() => {
    if (!inView) return;
    let alive = true;
    setLoading(true);
    setMissing(false);
    call("getReport", game.appId)
      .then((result) => {
        if (!alive) return;
        if (result) {
          const r = result as ProtonDBReport;
          setReport(r);
          const tier = r.tier?.toLowerCase();
          if (tier && (TIER_ORDER as readonly string[]).includes(tier)) {
            onTier(game.appId, tier as TierKey);
          } else if (tier === "pending") {
            onTier(game.appId, "pending");
          }
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
  }, [call, game.appId, onTier, inView]);

  const primaryThumb = game.capsuleUrl;
  const fallbackThumb = game.headerUrl;
  const tierLower = report?.tier?.toLowerCase();
  const tierKey =
    tierLower && (TIER_ORDER as readonly string[]).includes(tierLower)
      ? (tierLower as TierKey)
      : null;

  // Every fetch state lives in the bottom-of-image overlay slot as a
  // pill. Keeps every tile the same height regardless of which cards
  // have resolved their tier yet (background fetches are rate-limited,
  // so cards trickle in). The final fallback covers tiers that aren't
  // in `TIER_ORDER` (mainly "pending" — community reports exist but no
  // rating yet) — without it, those tiles would render a blank overlay
  // and look visually broken next to other tiles that have a chip.
  const tierBadges = loading ? (
    <Badge variant="neutral" size="xs">
      <span className="flex items-center gap-1">
        <Spinner size={10} /> Loading
      </span>
    </Badge>
  ) : missing || !report ? (
    <Badge variant="neutral" size="xs">
      <span className="italic">No ProtonDB data</span>
    </Badge>
  ) : tierKey ? (
    <TierChip tier={tierKey} dense />
  ) : (
    <Badge variant="neutral" size="xs">
      <span
        className="italic capitalize"
        title={tierLower ? TIER_DESCRIPTIONS[tierLower] : undefined}
      >
        {tierLower ?? "Unknown"}
      </span>
    </Badge>
  );

  return (
    <GameCard
      imageUrl={primaryThumb}
      fallbackImageUrl={fallbackThumb}
      title={game.name}
      overlayBadges={tierBadges}
      topLeftBadge={
        isCurrent ? (
          <span className="chip chip-accent">RUNNING</span>
        ) : undefined
      }
      highlighted={isCurrent}
      rootRef={handleRootRef}
      onPick={onPick}
    />
  );
}

// --- Settings cards (gear icon view) ---

function ConfigCards({
  settings,
  status,
  tierCounts,
  breakdownTotal,
  onUpdate,
  onReconnect,
  onClearCache,
}: {
  settings: ProtonDBSettings;
  status: StatusInfo;
  tierCounts: Record<TierKey, number>;
  breakdownTotal: number;
  onUpdate: (partial: Partial<ProtonDBSettings>) => void;
  onReconnect: () => void;
  onClearCache: () => void;
}) {
  return (
    <>
      {/* Primary card */}
      <div className="card">
        {/* Header: label + description + master toggle */}
        <div className="subsection">
          <div className="flex justify-between items-center gap-4">
            <div className="min-w-0">
              <div className="subsection-label mb-0.5">
                Compatibility Badges
              </div>
              <div className="text-xs text-[var(--fg-3)]">
                Show ProtonDB tier badges on Steam library tiles and detail
                pages
              </div>
            </div>
            <Toggle
              checked={settings.enableLibraryBadge}
              onChange={(v) => onUpdate({ enableLibraryBadge: v })}
            />
          </div>
        </div>

        {/* Library Breakdown — live-aggregated as cards load */}
        <div className="subsection">
          <div className="subsection-label">Your Library Breakdown</div>
          {breakdownTotal > 0 ? (
            <>
              <div className="metric-value mono mb-2" style={{ fontSize: 24 }}>
                {breakdownTotal} title{breakdownTotal === 1 ? "" : "s"} rated
              </div>
              <div
                style={{
                  display: "flex",
                  height: 16,
                  borderRadius: 8,
                  overflow: "hidden",
                  marginBottom: 12,
                  background: "var(--color-base-300, rgba(0,0,0,0.1))",
                }}
              >
                {TIER_ORDER.map((t) =>
                  tierCounts[t] > 0 ? (
                    <div
                      key={t}
                      style={{
                        width: `${(tierCounts[t] / breakdownTotal) * 100}%`,
                        background: TIER_COLOR[t],
                      }}
                      title={`${TIER_LABEL[t]}: ${tierCounts[t]}`}
                    />
                  ) : null,
                )}
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {TIER_ORDER.map((t) => (
                  <div
                    key={t}
                    className="p-2.5 rounded-lg text-center"
                    style={{ background: "var(--color-base-200, rgba(0,0,0,0.2))" }}
                  >
                    <TierChip tier={t} />
                    <div className="metric-value mono mt-2" style={{ fontSize: 20 }}>
                      {tierCounts[t]}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="subsection-desc mt-1">
              Reports are still loading. Open the library grid and let the
              cards finish — the breakdown fills in live.
            </div>
          )}
        </div>

        {/* Badge Style */}
        <div className="subsection">
          <div className="subsection-label">Badge Style</div>
          <div className="segmented">
            {STYLE_OPTIONS.map((opt) => (
              <SegmentedItem
                key={opt.value}
                active={settings.size === opt.value}
                onSelect={() => onUpdate({ size: opt.value })}
                style={{ flex: 1 }}
              >
                {opt.label}
              </SegmentedItem>
            ))}
          </div>
        </div>
      </div>

      {/* Secondary card */}
      <div className="card">
        <div className="subsection">
          <div className="subsection-label">Store Badge</div>
          <div className="flex justify-between items-center">
            <div className="subsection-desc mt-0">
              Inject a badge into Steam store pages.
            </div>
            <Toggle
              checked={settings.enableStoreBadge}
              onChange={(v) => onUpdate({ enableStoreBadge: v })}
            />
          </div>
        </div>

        <div className="subsection">
          <div className="subsection-label">Submit Button</div>
          <div className="flex justify-between items-center">
            <div className="subsection-desc mt-0">
              Show a "Submit to ProtonDB" button next to the library badge.
            </div>
            <Toggle
              checked={settings.showSubmitButton}
              onChange={(v) => onUpdate({ showSubmitButton: v })}
            />
          </div>
        </div>

        <div className="subsection">
          <div className="subsection-label">Badge Position</div>
          <div className="segmented">
            {(["tl", "tm", "tr", "bl", "bm", "br"] as const).map((p) => (
              <SegmentedItem
                key={p}
                active={settings.position === p}
                onSelect={() => onUpdate({ position: p })}
                style={{ flex: 1, fontSize: 11 }}
              >
                {POSITION_LABELS[p]}
              </SegmentedItem>
            ))}
          </div>
        </div>

        {settings.size === "minimalist" && (
          <div className="subsection">
            <div className="subsection-label">Label on Hover</div>
            <div className="segmented">
              {(["off", "small", "regular"] as const).map((h) => (
                <SegmentedItem
                  key={h}
                  active={settings.labelOnHover === h}
                  onSelect={() => onUpdate({ labelOnHover: h })}
                  style={{ flex: 1, textTransform: "capitalize" }}
                >
                  {h}
                </SegmentedItem>
              ))}
            </div>
          </div>
        )}

        <div className="subsection">
          <div className="subsection-label">Steam CEF</div>
          <div className="row">
            <span className="row-label">Status</span>
            <span className="row-value flex items-center gap-1.5">
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: status.connected
                    ? "var(--color-success, oklch(0.7 0.18 145))"
                    : "var(--color-error, oklch(0.6 0.2 25))",
                  display: "inline-block",
                }}
              />
              {status.connected
                ? `Connected (${status.tabs} tab${status.tabs !== 1 ? "s" : ""})`
                : "Disconnected"}
            </span>
          </div>
          {!status.connected && (
            <div className="mt-2">
              <Button onClick={onReconnect}>Reconnect</Button>
            </div>
          )}
        </div>

        <div className="subsection">
          <div className="subsection-label">Cache</div>
          <div className="flex justify-between items-center gap-3">
            <div className="subsection-desc mt-0 flex-1">
              Clears all cached ProtonDB ratings and re-fetches on next view.
            </div>
            <Button onClick={onClearCache}>Clear ProtonDB Cache</Button>
          </div>
        </div>
      </div>
    </>
  );
}

// --- Home widget ---

function ProtonDBHomeWidget() {
  const { call } = useBackend("protondb-badges");
  const currentGame = useCurrentGame();
  const targetAppId = currentGame ? String(currentGame.appId) : null;
  const [report, setReport] = useState<ProtonDBReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!targetAppId) {
      setReport(null);
      setLoading(false);
      setMissing(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setMissing(false);
    call("getReport", targetAppId)
      .then((result) => {
        if (!alive) return;
        if (result) {
          setReport(result as ProtonDBReport);
        } else {
          setReport(null);
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
  }, [call, targetAppId]);

  if (!currentGame) {
    return (
      <div className="card-body">
        <div className="flex items-center justify-between mb-2">
          <div className="card-title">PROTON COMPAT</div>
        </div>
        <div className="flex items-center justify-center h-full">
          <span className="text-xs italic text-base-content/60">
            No game running
          </span>
        </div>
      </div>
    );
  }

  const tier = (report?.tier ?? "pending").toLowerCase();
  const tierKey = TIER_ORDER.includes(tier as TierKey)
    ? (tier as TierKey)
    : null;

  return (
    <div className="card-body">
      <div className="flex items-center justify-between mb-3.5">
        <div className="card-title">PROTON COMPAT</div>
        <div className="chip truncate max-w-[60%]">
          {currentGame.gameName || `App ${currentGame.appId}`}
        </div>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-3">
          <Spinner size={16} />
        </div>
      ) : missing || !report ? (
        <div className="text-xs italic text-base-content/60">
          No ProtonDB reports for this game.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            {tierKey ? (
              <TierChip tier={tierKey} />
            ) : (
              <span className="chip">{tier}</span>
            )}
            <span className="text-xs text-base-content/70">
              {TIER_DESCRIPTIONS[tier] ?? "Compatibility rating"}
            </span>
          </div>
          <div className="row">
            <span className="row-label">Confidence</span>
            <span className="row-value">
              {CONFIDENCE_LABELS[(report.confidence ?? "unknown").toLowerCase()] ??
                report.confidence ??
                "—"}
            </span>
          </div>
          {typeof report.score === "number" && report.score > 0 && (
            <div className="row">
              <span className="row-label">Score</span>
              <span className="row-value mono">{report.score}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Mount functions ---

export const mount = mountComponent(ProtonDBBadges);
export const mountHomeWidget = mountComponent(ProtonDBHomeWidget);

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot — the actual header
 * content is portaled from inside `mount()` via `<PluginHeader>`.
 */
export const mountHeader = mountHeaderStub;
