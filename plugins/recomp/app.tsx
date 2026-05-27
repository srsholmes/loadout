import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { FaArrowLeft, FaFile, FaFolder, FaGear, FaHouse, FaPuzzlePiece } from "react-icons/fa6";
import {
  Badge,
  Button,
  GameCard,
  HeaderBackButton,
  IconButton,
  Panel,
  PluginHeader,
  PluginProvider,
  SearchField,
  Select,
  Spinner,
  TabBar,
  Text,
  TextInput,
  notify,
  useBackend,
  useFocusable,
} from "@loadout/ui";
import { steamArtworkUrls } from "@loadout/steam-paths";

// ── Internal navigation ──────────────────────────────────────────────
//
// Replaces the QAM-only `navigateBack` / `navigateToPage` flow this
// plugin originally used. The overlay isn't a Steam-router host —
// each plugin owns its own sub-page state. Three views: list (the
// game grid), detail (one game), settings. The navigator is exposed
// via Context so the inner components don't have to thread props
// through every level.

type RecompView =
  | { kind: "list" }
  | { kind: "detail"; gameId: string }
  | { kind: "settings" };

interface RecompNav {
  toList: () => void;
  toDetail: (gameId: string) => void;
  toSettings: () => void;
  /** Open another overlay plugin by id. Drives the hash-based shell
   *  router from `packages/overlay/src/App.tsx`. */
  toPlugin: (pluginId: string) => void;
}

const RecompNavContext = createContext<RecompNav | null>(null);
function useRecompNav(): RecompNav {
  const ctx = useContext(RecompNavContext);
  if (!ctx) throw new Error("useRecompNav() outside <RecompApp>");
  return ctx;
}

/**
 * Close the overlay via the Electrobun host's `hide` RPC. Plugins
 * don't get a sanctioned `useHost()` hook today, so we reach into
 * `window.__electroview` directly. No-op outside Electrobun (vite dev
 * / unit tests) and silently swallows host errors so a broken host
 * can't tank the user's click. Same pattern quick-links uses after
 * launching a URL.
 */
function dismissOverlay(): void {
  try {
    const w = window as unknown as {
      __electroview?: { rpc?: { request?: Record<string, (...a: unknown[]) => Promise<unknown>> } };
    };
    const fn = w.__electroview?.rpc?.request?.hide;
    if (typeof fn === "function") void fn();
  } catch {
    /* best-effort */
  }
}

// ── Frontend-side type mirror ────────────────────────────────────────
//
// The frontend bundle is built independently of the backend module, so
// we re-declare just the shapes the UI consumes. Keep these in sync
// with `lib/types.ts`.

type GameStatus =
  | "available"
  | "installed"
  | "update_available"
  | "installing"
  | "updating"
  | "unavailable"
  | "in_progress";

interface GameInfo {
  id: string;
  name: string;
  project: string;
  platform: string;
  description: string;
  installType: string;
  tags: string[];
  website?: string;
  latestVersion?: string;
  installedVersion?: string;
  hasUpdate: boolean;
  gameStatus: GameStatus;
  hasNativeBuild: boolean;
  addedToSteam: boolean;
  steamAppId?: number;
  steamGameId64?: string;
  romInfo?: { description: string; extensions?: string[] };
  status?: string;
  // Mirror of registry fields the build_from_source UX reads.
  // `repo` is the GitHub `<owner>/<name>` slug; `requiresRom`
  // widens `needsRom` so the ROM picker appears for buildable
  // games whose recipes need a ROM.
  repo?: string;
  requiresRom?: boolean;
  // Carries the per-game mods catalog from the registry. Used by
  // the detail page to decide whether to show the Mods & extras tab.
  // The actual ModInfo shape (with install state) is fetched lazily
  // via the `getMods` RPC inside the panel.
  mods?: unknown[];
}

interface BuildEnvProbe {
  ok: boolean;
  label: string;
  missing: string[];
  installHint?: string;
  distroId?: string;
  hasRecipe: boolean;
}

interface PipelineEvent {
  type: "progress" | "complete" | "error" | "rom_required";
  gameId: string;
  stage?: string;
  percent?: number;
  message?: string;
  version?: string;
}

// Mirrors backend `ModSource` / `ModEntry` / `ModInfo` types — kept
// inline here so the frontend bundle doesn't pull in the backend
// type tree.
type ModSourceKind = "github-release" | "direct-url" | "manual-import";
type ModStatus = "not_installed" | "installing" | "installed";

interface ModInfo {
  id: string;
  name: string;
  description: string;
  author?: string;
  credit?: string;
  source: {
    kind: ModSourceKind;
    /** github-release */ repo?: string;
    /** github-release */ assetPattern?: string;
    /** github-release / direct-url */ tag?: string;
    /** direct-url */ url?: string;
    /** direct-url */ filename?: string;
    /** manual-import */ acceptExtensions?: string[];
  };
  installSubdir?: string;
  setupModule?: string;
  externalUrl?: string;
  previewImageUrl?: string;
  sizeBytes?: number;
  /** Catalog-declared version, if any. Mirrors backend `ModEntry.version`. */
  version?: string;
  status: ModStatus;
  installedAt?: string;
  /** Version recorded on disk for the installed copy — set after a
   *  successful install. May differ from `version` when the
   *  archive-parsed version overrides the catalog one (or vice
   *  versa, depending on which side is authoritative). */
  installedVersion?: string;
}

interface LaunchUrlResult {
  launched: boolean;
  reason?: string;
  message?: string;
}

interface Settings {
  autoAddToSteam: boolean;
  updateCheckInterval: number;
  romDirectory?: string;
}

// ── Display tables ───────────────────────────────────────────────────

const PLATFORM_DISPLAY: Record<string, string> = {
  n64: "N64", ps1: "PS1", ps2: "PS2", gc: "GC", xbox360: "X360",
  gb: "GB", gba: "GBA", gbc: "GBC", nes: "NES", snes: "SNES",
  nds: "NDS", "3ds": "3DS", wii: "Wii", wiiu: "Wii U", switch: "Switch",
  pc: "PC", mobile: "Mobile", multi: "Multi", arcade: "Arcade",
  dreamcast: "DC", saturn: "Saturn", xbox: "Xbox", xboxone: "Xbox One",
  other: "Other",
};

const FILTER_PLATFORMS = [
  "all", "n64", "ps1", "ps2", "gc", "xbox360",
] as const;

// `all` excludes "unavailable" games (registry entries without a
// shipping build / abandoned projects). They're hidden from the
// default browse but reachable via the dedicated "Unavailable" tab,
// so users who want to see what's been catalogued can still find
// them without polluting the install grid.
const TAB_IDS = ["all", "installed", "available", "updates", "unavailable"] as const;
type TabId = (typeof TAB_IDS)[number];

// ── Cover-art URL resolution ─────────────────────────────────────────

/**
 * Pick the best artwork URL for a game tile. Installed-and-in-Steam
 * games resolve via the loader-local `/api/steam-grid/<gameid64>/...`
 * route — that respects any custom art the user applied via the
 * steamgriddb plugin AND falls through to Steam's appcache when our
 * `applyArtwork` hasn't written anything yet. Uninstalled games have
 * no Steam shortcut yet, so we render the placeholder gradient.
 */
function tileImageUrl(game: GameInfo): string {
  if (game.addedToSteam && typeof game.steamAppId === "number") {
    return steamArtworkUrls(game.steamAppId).capsule;
  }
  return "";
}

// ── Status helpers ───────────────────────────────────────────────────

interface TileAction {
  label: string;
  variant: "primary" | "secondary" | "accent" | "warning" | "danger";
  loading?: boolean;
  disabled?: boolean;
  action: "install" | "play" | "update" | "open-detail" | "add-to-steam";
}

function tileActionFor(game: GameInfo): TileAction {
  switch (game.gameStatus) {
    case "available":
      // ROM-extract installs need a ROM picker; route to the detail
      // page rather than try to one-click them.
      if (
        game.installType === "rom_extract" ||
        game.installType === "toolchain" ||
        game.installType === "build_from_source"
      ) {
        return { label: "Set up…", variant: "primary", action: "open-detail" };
      }
      return { label: "Install", variant: "primary", action: "install" };
    case "installing":
      return { label: "Installing…", variant: "secondary", loading: true, disabled: true, action: "open-detail" };
    case "updating":
      return { label: "Updating…", variant: "secondary", loading: true, disabled: true, action: "open-detail" };
    case "installed":
      if (!game.addedToSteam) {
        return { label: "Add to Steam", variant: "accent", action: "add-to-steam" };
      }
      return { label: "Play", variant: "primary", action: "play" };
    case "update_available":
      return { label: "Update", variant: "warning", action: "update" };
    case "unavailable":
      return { label: "Unavailable", variant: "secondary", disabled: true, action: "open-detail" };
    case "in_progress":
      return { label: "In development", variant: "secondary", disabled: true, action: "open-detail" };
  }
}

// ── List view: the game catalog ──────────────────────────────────────

function CatalogView() {
  const nav = useRecompNav();
  const { call, useEvent } = useBackend("recomp");
  const [games, setGames] = useState<GameInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [progress, setProgress] = useState<Record<string, PipelineEvent>>({});

  const loadGames = useCallback(async () => {
    try {
      const result = await call("getGames");
      setGames(result as GameInfo[]);
    } catch (err) {
      console.error("[recomp] Failed to load games:", err);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    loadGames();
  }, [loadGames]);

  useEvent({
    event: "pipelineEvent",
    handler: (data: unknown) => {
      const ev = data as PipelineEvent;
      if (ev.type === "complete") {
        // Hold the progress entry until the reload settles — the
        // pipeline's addToSteam/artwork tail runs AFTER the complete
        // event fires, so the tile would flash back to "Install"
        // between this event and gameStatusChanged's reload. The
        // games-reconciliation effect below drops the entry once
        // the game's status reflects "installed".
        const title =
          games.find((g) => g.id === ev.gameId)?.name ?? ev.gameId;
        notify(`${title} installed and added to Steam`);
        loadGames();
      } else if (ev.type === "error") {
        // Errors leave the game at status="available", so the
        // reconciliation effect can't clear progress on its own.
        setProgress((prev) => {
          const { [ev.gameId]: _, ...rest } = prev;
          return rest;
        });
        // Toast the failure so the user knows the tile didn't just
        // silently snap back to its idle state. Message comes
        // straight from the recomp pipeline (`stage`-tagged); the
        // user-facing form passes the game name first.
        const title =
          games.find((g) => g.id === ev.gameId)?.name ?? ev.gameId;
        notify(`${title}: ${ev.message ?? "install failed"}`, { kind: "error" });
        loadGames();
      } else {
        setProgress((prev) => ({ ...prev, [ev.gameId]: ev }));
      }
    },
  });

  useEvent({
    event: "gameStatusChanged",
    handler: () => loadGames(),
  });

  // Clear stale progress entries once the loaded registry reflects
  // the new install state. Without this, the pipelineEvent.complete
  // handler above would race the reload — same flicker the
  // store-bridge catalog had.
  useEffect(() => {
    setProgress((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [id, ev] of Object.entries(prev)) {
        const g = games.find((x) => x.id === id);
        if (g && (g.gameStatus === "installed" || g.gameStatus === "update_available")) {
          changed = true; // install finalized — drop
        } else {
          next[id] = ev;
        }
      }
      return changed ? next : prev;
    });
  }, [games]);

  // ── Filtering ───
  const filtered = useMemo(() => {
    let result = games;

    if (activeTab === "installed") {
      result = result.filter(
        (g) => g.gameStatus === "installed" || g.gameStatus === "update_available",
      );
    } else if (activeTab === "available") {
      result = result.filter((g) => g.gameStatus === "available");
    } else if (activeTab === "updates") {
      result = result.filter((g) => g.gameStatus === "update_available");
    } else if (activeTab === "unavailable") {
      result = result.filter(
        (g) => g.gameStatus === "unavailable" || g.gameStatus === "in_progress",
      );
    } else {
      // "all" — hide the unavailable / in-development entries by
      // default; they have their own tab.
      result = result.filter(
        (g) => g.gameStatus !== "unavailable" && g.gameStatus !== "in_progress",
      );
    }

    if (platformFilter !== "all") {
      result = result.filter((g) => g.platform === platformFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (g) =>
          g.name.toLowerCase().includes(q) ||
          g.project.toLowerCase().includes(q) ||
          g.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    return result;
  }, [games, activeTab, platformFilter, search]);

  const installedCount = games.filter(
    (g) => g.gameStatus === "installed" || g.gameStatus === "update_available",
  ).length;
  const availableCount = games.filter((g) => g.gameStatus === "available").length;
  const updateCount = games.filter((g) => g.gameStatus === "update_available").length;
  const unavailableCount = games.filter(
    (g) => g.gameStatus === "unavailable" || g.gameStatus === "in_progress",
  ).length;
  // The "All" count subtracts unavailable so the number matches what
  // the tab actually shows after the default filter.
  const allCount = games.length - unavailableCount;

  const tabLabels: Record<TabId, string> = {
    all: `All (${allCount})`,
    installed: `Installed (${installedCount})`,
    available: `Available (${availableCount})`,
    updates: `Updates (${updateCount})`,
    unavailable: `Unavailable (${unavailableCount})`,
  };

  const subtitle = (() => {
    if (loading) return "Loading…";
    const shown = filtered.length;
    const total = games.length;
    if (shown === total) return `${total} recompiled games`;
    return `${shown} of ${total} games`;
  })();

  // ── Action handlers ───
  const handleInstall = useCallback(
    async (id: string) => {
      try {
        await call("installGame", id);
      } catch (err) {
        console.error("[recomp] install failed:", err);
      }
    },
    [call],
  );

  const handleUpdate = useCallback(
    async (id: string) => {
      try {
        await call("updateGame", id);
      } catch (err) {
        console.error("[recomp] update failed:", err);
      }
    },
    [call],
  );

  const handlePlay = useCallback(
    async (id: string) => {
      try {
        await call("launchGame", id);
        // Get out of the user's way — Steam's about to take focus.
        dismissOverlay();
      } catch (err) {
        console.error("[recomp] launch failed:", err);
      }
    },
    [call],
  );

  const handleAddToSteam = useCallback(
    async (id: string) => {
      try {
        await call("addInstalledToSteam", id);
      } catch (err) {
        console.error("[recomp] add-to-steam failed:", err);
      }
    },
    [call],
  );

  const dispatchAction = useCallback(
    (game: GameInfo, action: TileAction["action"]) => {
      switch (action) {
        case "install":
          return handleInstall(game.id);
        case "update":
          return handleUpdate(game.id);
        case "play":
          return handlePlay(game.id);
        case "add-to-steam":
          return handleAddToSteam(game.id);
        case "open-detail":
          return nav.toDetail(game.id);
      }
    },
    [handleInstall, handleUpdate, handlePlay, handleAddToSteam, nav],
  );

  if (loading) {
    return (
      <div className="p-6 h-full overflow-y-auto">
        <div className="flex items-center justify-center h-64">
          <Spinner size={32} />
        </div>
      </div>
    );
  }

  return (
    <>
      <PluginHeader>
        <div className="flex items-center justify-between gap-4 w-full min-w-0">
          <div className="flex flex-col gap-0.5 min-w-0">
            <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
              RecompHub
            </h1>
            <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
              {subtitle}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <SearchField
              value={search}
              onChange={setSearch}
              onClear={() => setSearch("")}
              placeholder="Search games, projects, tags…"
            />
            <IconButton
              onClick={() => nav.toSettings()}
              title="RecompHub settings"
              ariaLabel="RecompHub settings"
            >
              <FaGear size={11} />
            </IconButton>
          </div>
        </div>
      </PluginHeader>
      <div className="p-6 h-full overflow-y-auto">
        <div className="max-w-5xl mx-auto">
          {/* Tabs + platform-filter chrome — TabBar for tabs (matches
              every other plugin's tab UI) and Select for the platform
              filter (6 entries, compact dropdown beats a chip row). */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <TabBar
              tabs={TAB_IDS.map((id) => ({ id, label: tabLabels[id] }))}
              activeTab={activeTab}
              onTabChange={(id) => setActiveTab(id as TabId)}
            />
            <Select
              value={platformFilter}
              options={FILTER_PLATFORMS.map((p) => ({
                value: p,
                label:
                  p === "all"
                    ? "All platforms"
                    : (PLATFORM_DISPLAY[p] ?? p.toUpperCase()),
              }))}
              onChange={(v) => setPlatformFilter(v)}
            />
          </div>

          {/* Cover-art grid */}
        {filtered.length === 0 ? (
          <div className="py-12 text-center">
            <Text variant="secondary">No games match.</Text>
          </div>
        ) : (
          <div className="grid grid-cols-4 sidebar-collapsed:grid-cols-6 gap-2.5">
            {filtered.map((game) => (
              <RecompTile
                key={game.id}
                game={game}
                progress={progress[game.id]}
                onAction={dispatchAction}
              />
            ))}
          </div>
        )}
        </div>
      </div>
    </>
  );
}

// ── Tile ──────────────────────────────────────────────────────────────

function RecompTile({
  game,
  progress,
  onAction,
}: {
  game: GameInfo;
  progress?: PipelineEvent;
  onAction: (game: GameInfo, action: TileAction["action"]) => void;
}) {
  const nav = useRecompNav();
  const { call } = useBackend("recomp");
  const tileAction = tileActionFor(game);
  const platformLabel =
    PLATFORM_DISPLAY[game.platform] ?? game.platform.toUpperCase();

  // Lazy-fetch SGDB capsule for uninstalled games — installed ones
  // have local Steam-grid art via `tileImageUrl` already. The backend
  // disk-caches the SGDB lookup 24 h, so subsequent catalog opens
  // resolve from cache and the tile renders the art on first paint.
  const localUrl = tileImageUrl(game);
  const [sgdbUrl, setSgdbUrl] = useState<string | null>(null);
  useEffect(() => {
    if (localUrl) return; // installed → already have art
    let cancelled = false;
    void call("getCatalogArt", game.id).then((url) => {
      if (!cancelled && typeof url === "string") setSgdbUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [call, game.id, localUrl]);

  const overlayBadges = (
    <span
      className="inline-flex rounded-full"
      style={{ background: "var(--bg-inset)" }}
    >
      <Badge variant="info" size="xs">
        {platformLabel}
      </Badge>
    </span>
  );

  return (
    <GameCard
      imageUrl={localUrl || sgdbUrl || ""}
      title={game.name}
      onPick={() => nav.toDetail(game.id)}
      overlayBadges={overlayBadges}
      subtitle={
        progress ? (
          <ProgressLine event={progress} />
        ) : (
          // `block truncate` (vs `inline truncate` on a span) gives
          // the element a width to fill so text-overflow:ellipsis
          // actually kicks in. Long project names ("Decompilation
          // of …") otherwise blow the tile width out.
          <div className="block truncate w-full" title={game.project}>
            {game.project}
          </div>
        )
      }
      action={
        // The action slot sits inside GameCard's outer div onClick.
        // Wrap in a stopPropagation-on-click div so tapping the
        // button fires only the install/play/update action without
        // *also* opening the detail page.
        <div
          className="w-full"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            size="sm"
            variant={tileAction.variant === "danger" ? "danger" : tileAction.variant}
            disabled={tileAction.disabled}
            onClick={() => onAction(game, tileAction.action)}
          >
            {tileAction.loading ? <Spinner size={12} /> : null}
            {tileAction.label}
          </Button>
        </div>
      }
    />
  );
}

function ProgressLine({ event }: { event: PipelineEvent }) {
  const pct = Math.max(0, Math.min(100, event.percent ?? 0));
  return (
    <div className="flex flex-col gap-0.5">
      <progress
        className="progress progress-primary w-full h-1"
        value={pct}
        max={100}
      />
      <span className="truncate text-[10px] text-base-content/50">
        {event.stage ? `${event.stage}: ` : ""}{event.message ?? "Working…"}
      </span>
    </div>
  );
}

// ── ROM file browser modal ───────────────────────────────────────────

interface DirEntry {
  name: string;
  isDir: boolean;
}
interface DirListing {
  currentPath: string;
  parent: string | null;
  entries: DirEntry[];
}

/**
 * Touch-driven file browser. Renders a daisyUI modal with the
 * current directory's entries (folders + extension-matching files)
 * as tappable rows. No d-pad assumptions — every row is a
 * full-width button suitable for finger taps.
 *
 * Used by:
 *   - ROM picker (Browse… on the detail page) — default start dir
 *     is `settings.romDirectory ?? $HOME`.
 *   - Mod-archive picker (Import from disk on the Mods & extras
 *     panel) — starts at `~/Downloads`.
 *
 * Hidden entries (`.foo`) are filtered backend-side. Files are
 * filtered against `extensions` here on the frontend so navigating
 * INTO a deep folder tree stays fast — the backend's directory
 * listing isn't aware of which extensions we're looking for.
 *
 * Selection model: tap a folder → drill in; tap a file → return
 * its absolute path via `onPick` and close. Cancel discards.
 *
 * Renders inside the overlay — no zenity / kdialog hand-off, so no
 * Gamescope focus-fight dance is needed.
 */
function FileBrowser({
  open,
  onClose,
  onPick,
  extensions,
  startPath,
  title,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
  extensions: string[];
  /** Initial directory. `undefined` → backend default
   *  (`settings.romDirectory ?? $HOME`). Use `"~/Downloads"` for
   *  user-archive imports. */
  startPath?: string;
  /** Optional title rendered in the modal header. */
  title?: string;
}) {
  const { call } = useBackend("recomp");
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(
    async (path: string | undefined) => {
      setLoading(true);
      setError(null);
      try {
        const r = (await call("listDirectory", path)) as DirListing;
        setListing(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [call],
  );

  // Open → load the starting directory (caller-supplied or backend
  // default). Close → drop the listing so the next open starts fresh.
  useEffect(() => {
    if (!open) {
      setListing(null);
      return;
    }
    void navigate(startPath);
  }, [open, navigate, startPath]);

  if (!open) return null;

  const wantedExts = extensions
    .map((e) => e.replace(/^\./, "").toLowerCase())
    .filter((e) => e.length > 0);
  const visibleEntries = (listing?.entries ?? []).filter((e) => {
    if (e.isDir) return true;
    if (wantedExts.length === 0) return true;
    const lower = e.name.toLowerCase();
    return wantedExts.some((ext) => lower.endsWith(`.${ext}`));
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div
        className="bg-base-100 rounded-xl shadow-2xl w-full max-w-xl flex flex-col overflow-hidden"
        style={{ height: "80vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 gap-3 flex flex-col" style={{ height: "100%" }}>
          {title ? (
            <div className="text-sm font-medium shrink-0">{title}</div>
          ) : null}
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="neutral"
              onClick={() => navigate("~")}
              disabled={loading}
            >
              <FaHouse className="mr-1.5" /> Home
            </Button>
            <Button
              size="sm"
              variant="neutral"
              onClick={() => listing?.parent && navigate(listing.parent)}
              disabled={loading || !listing?.parent}
            >
              <FaArrowLeft className="mr-1.5" /> Up
            </Button>
            <div className="ml-auto">
              <Button size="sm" variant="neutral" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>

          <div
            className="text-[11px] mono text-base-content/60 truncate shrink-0"
            title={listing?.currentPath ?? ""}
          >
            {listing?.currentPath ?? "Loading…"}
          </div>

          <div
            className="rounded-md border border-base-300/50"
            style={{
              flex: "1 1 0",
              minHeight: 0,
              overflowY: "auto",
              WebkitOverflowScrolling: "touch",
              touchAction: "pan-y",
            }}
          >
            {loading ? (
              <div className="flex items-center justify-center h-32">
                <Spinner size={24} />
              </div>
            ) : error ? (
              <div className="p-4 text-sm text-error">{error}</div>
            ) : visibleEntries.length === 0 ? (
              <div className="p-4 text-sm text-base-content/60">
                No matching entries.
                {wantedExts.length > 0 ? (
                  <span className="block mt-1 text-[11px]">
                    Filtering by:{" "}
                    {wantedExts.map((e) => `.${e}`).join(", ")}
                  </span>
                ) : null}
              </div>
            ) : (
              <ul className="divide-y divide-base-300/40">
                {visibleEntries.map((e) => (
                  <li key={e.name}>
                    <FileBrowserRow
                      entry={e}
                      onActivate={() => {
                        if (!listing) return;
                        const next = `${listing.currentPath}/${e.name}`.replace(
                          /\/+/g,
                          "/",
                        );
                        if (e.isDir) void navigate(next);
                        else onPick(next);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One row inside the `FileBrowser` modal. Extracted so each row gets
 * its own `useFocusable` — closes issue #134's d-pad-reachability
 * audit for the file picker (without this, the user could d-pad to
 * the Home / Up / Cancel buttons in the header but not to any of
 * the directory entries below them).
 */
function FileBrowserRow({
  entry,
  onActivate,
}: {
  entry: { name: string; isDir: boolean };
  onActivate: () => void;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      className={
        "flex items-center gap-3 w-full px-3 py-3 hover:bg-base-200 active:bg-base-300 text-left " +
        (focused ? "bg-base-200 ring-1 ring-primary/40" : "")
      }
      onClick={onActivate}
    >
      {entry.isDir ? (
        <FaFolder className="shrink-0 text-warning" />
      ) : (
        <FaFile className="shrink-0 text-base-content/60" />
      )}
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

/**
 * One auto-suggested ROM match shown under "Matches in your ROM
 * folder" on the GameDetailPage. Extracted so each row gets its
 * own `useFocusable` (issue #134) — the suggestions are the user's
 * fastest path to picking a ROM, so d-pad reachability matters.
 */
function RomSuggestionRow({
  basename,
  path,
  selected,
  onActivate,
}: {
  basename: string;
  path: string;
  selected: boolean;
  onActivate: () => void;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onActivate}
      className={
        "text-left px-3 py-2 rounded-md border transition-colors " +
        (selected
          ? "border-accent/60 bg-accent/10"
          : "border-base-300/40 hover:border-base-300 hover:bg-base-200/30") +
        (focused ? " ring-2 ring-primary/40" : "")
      }
    >
      <div className="text-sm font-medium leading-tight truncate">
        {basename}
      </div>
      <div className="text-[11px] text-base-content/55 mt-0.5 truncate">
        {path}
      </div>
    </button>
  );
}

// ── Detail view ──────────────────────────────────────────────────────

function GameDetailPage({ gameId }: { gameId: string }) {
  const nav = useRecompNav();
  const { call, useEvent } = useBackend("recomp");
  const [game, setGame] = useState<GameInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PipelineEvent | null>(null);
  const [romPath, setRomPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  // Auto-suggested ROM matches from settings.romDirectory. Populated
  // once per game on first load (when no saved path exists); cleared
  // when the user picks anything, so we don't keep nagging them.
  const [romSuggestions, setRomSuggestions] = useState<
    Array<{ path: string; basename: string }>
  >([]);
  // Build-env probe for build_from_source — populated on mount.
  // `null` = not checked yet (don't draw the panel); the probe
  // tells us whether distrobox+podman are present and the
  // per-distro install hint when not.
  const [buildEnv, setBuildEnv] = useState<BuildEnvProbe | null>(null);

  // Hero banner URL. Installed-and-added-to-Steam games use the
  // loader-local steam-grid route (serves SGDB hero if applied, else
  // Steam's library_hero); other games hit the backend's SGDB hero
  // RPC. Null means "no hero available" — we render a gradient
  // placeholder instead of an empty banner.
  const [heroUrl, setHeroUrl] = useState<string | null>(null);
  // Detail-page tab selection. "overview" is the default home; "mods"
  // is gated on the registry entry declaring a mods catalog.
  const [tab, setTab] = useState<"overview" | "mods">("overview");

  const loadDetail = useCallback(async () => {
    if (!gameId) return;
    try {
      const result = await call("getGameDetail", gameId);
      setGame(result as GameInfo | null);
    } catch (err) {
      console.error("[recomp] detail load failed:", err);
    } finally {
      setLoading(false);
    }
  }, [call, gameId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // Load any previously-saved ROM path for this game so the user
  // doesn't have to re-pick it after a failed install or when
  // returning to the page later. Saved paths are persisted to
  // state.json the moment the picker resolves.
  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    void call("getRomPath", gameId).then((p) => {
      if (cancelled) return;
      const path = (p as string | null) ?? "";
      if (path) setRomPath(path);
    });
    return () => {
      cancelled = true;
    };
  }, [call, gameId]);

  // Resolve a hero banner URL whenever the game's identity or install
  // state changes. Installed-and-added-to-Steam games get the loader's
  // /api/steam-grid/<gameid64>/hero route (SGDB hero if applied, else
  // Steam's library_hero). Other games hit the backend's SGDB lookup
  // — returns null when no SGDB key or no match, and the hero block
  // falls back to a gradient placeholder.
  useEffect(() => {
    if (!game) return;
    let cancelled = false;
    if (game.addedToSteam && game.steamAppId != null) {
      setHeroUrl(steamArtworkUrls(game.steamAppId).hero);
      return;
    }
    setHeroUrl(null);
    void call("getDetailHero", game.id).then((u) => {
      if (cancelled) return;
      setHeroUrl((u as string | null) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [call, game]);

  // Reset to the Overview tab whenever the game changes so we don't
  // dangle on "Mods" when navigating from a game with mods to one
  // without (the tab would be hidden, no body would render).
  useEffect(() => {
    setTab("overview");
  }, [gameId]);

  // Persist the picked ROM path so it survives navigation away,
  // browser refreshes, install retries, and update operations.
  // Fire-and-forget — backend serializes on the same state file.
  const persistRomPath = useCallback(
    (path: string) => {
      if (!gameId) return;
      void call("setRomPath", gameId, path || null);
    },
    [call, gameId],
  );

  // Auto-suggest ROM files from `settings.romDirectory`. Runs once
  // per game on detail-page load when the game requires a ROM AND
  // no saved path exists yet — so we only nag fresh installs, not
  // returning users. Returns `[]` silently if no romDirectory is
  // configured, no matches above threshold, etc.; the UI just hides
  // the suggestion list in that case and falls through to the
  // browse / textbox flow.
  useEffect(() => {
    if (!gameId || !game) return;
    if (game.gameStatus !== "available") return;
    if (!game.requiresRom && game.installType !== "rom_extract"
      && game.installType !== "toolchain") return;
    if (romPath) return; // user already has one — don't override
    let cancelled = false;
    void call("suggestRomFiles", gameId).then((r) => {
      if (cancelled) return;
      setRomSuggestions(
        (r as Array<{ path: string; basename: string }>) ?? [],
      );
    });
    return () => {
      cancelled = true;
    };
  }, [call, gameId, game, romPath]);

  // Probe the build env (distrobox + podman) whenever the loaded
  // game is a build_from_source entry. The recipe owns its own
  // package list and installs everything inside the container at
  // install time, so no per-game dep probe is needed up front.
  useEffect(() => {
    if (!game || game.installType !== "build_from_source") {
      setBuildEnv(null);
      return;
    }
    let cancelled = false;
    void call("checkBuildEnv", game.id).then((r) => {
      if (cancelled) return;
      setBuildEnv(r as BuildEnvProbe);
    });
    return () => {
      cancelled = true;
    };
  }, [call, game]);

  useEvent({
    event: "pipelineEvent",
    handler: (data: unknown) => {
      const ev = data as PipelineEvent;
      if (ev.gameId !== gameId) return;
      if (ev.type === "complete") {
        setProgress(null);
        setBusy(false);
        loadDetail();
      } else if (ev.type === "error") {
        // Stage-scoped errors (steam/artwork) are non-fatal — keep
        // busy true so the artwork stage still renders. The pipeline
        // emits a "complete" once everything's done.
        if (ev.stage === "steam" || ev.stage === "artwork") {
          setProgress({ ...ev, type: "progress" });
        } else {
          setProgress(null);
          setBusy(false);
          setError(ev.message ?? "An error occurred");
        }
        loadDetail();
      } else if (ev.type === "rom_required") {
        setProgress(null);
        setBusy(false);
        setError(null);
      } else {
        setProgress(ev);
        setError(null);
      }
    },
  });

  if (loading) {
    return (
      <div className="p-6 h-full overflow-y-auto">
        <div className="flex items-center justify-center h-64">
          <Spinner size={32} />
        </div>
      </div>
    );
  }

  if (!game) {
    return (
      <>
        <PluginHeader>
          <div className="flex items-center justify-between gap-4 w-full min-w-0">
            <div className="flex flex-col gap-0.5 min-w-0">
              <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
                RecompHub
              </h1>
              <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
                Not found
              </span>
            </div>
            <HeaderBackButton onBack={nav.toList} title="Back to library" />
          </div>
        </PluginHeader>
        <div className="p-6 h-full overflow-y-auto">
          <Text variant="secondary">Game not in registry.</Text>
        </div>
      </>
    );
  }

  const handleInstall = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("installGame", game.id, romPath || undefined);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUpdate = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("updateGame", game.id);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUninstall = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("uninstallGame", game.id);
      await loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePlay = async () => {
    try {
      await call("launchGame", game.id);
      // Get out of the user's way — Steam's about to take focus.
      dismissOverlay();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddToSteam = async () => {
    setBusy(true);
    setError(null);
    try {
      await call("addInstalledToSteam", game.id);
      await loadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const platformLabel = PLATFORM_DISPLAY[game.platform] ?? game.platform.toUpperCase();
  // build_from_source counts as needing the ROM picker only when
  // its manifest declares `requiresRom`.
  const needsRom =
    game.installType === "rom_extract" ||
    game.installType === "toolchain" ||
    (game.installType === "build_from_source" && !!game.requiresRom);

  const hasMods = (game.mods?.length ?? 0) > 0;
  const tabs: { id: "overview" | "mods"; label: string }[] = hasMods
    ? [
        { id: "overview", label: "Overview" },
        { id: "mods", label: "Mods & extras" },
      ]
    : [{ id: "overview", label: "Overview" }];

  return (
    <>
      <PluginHeader>
        <div className="flex items-center justify-between gap-4 w-full min-w-0">
          <div className="flex flex-col gap-0.5 min-w-0">
            <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight truncate">
              {game.name}
            </h1>
            <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
              {game.project} · {platformLabel}
            </span>
          </div>
          <HeaderBackButton onBack={nav.toList} title="Back to library" />
        </div>
      </PluginHeader>
      <div className="p-6 h-full overflow-y-auto">
        <div className="max-w-3xl mx-auto">

        {/* Hero banner — landscape 460×215. Mirrors HLTB / store-bridge.
            Title + project chip overlaid on a bottom-up gradient scrim
            so they stay legible over any artwork. */}
        <div
          className="relative rounded-lg overflow-hidden mb-4"
          style={{
            aspectRatio: "460 / 215",
            background:
              "linear-gradient(135deg, var(--bg-2) 0%, var(--bg-inset) 100%)",
          }}
        >
          {heroUrl ? (
            <img
              src={heroUrl}
              alt={game.name}
              className="absolute inset-0 w-full h-full object-cover block"
              // Bias toward the top — SGDB heroes are typically 1920×620
              // (≈3.1:1) but our frame is 460×215 (≈2.14:1). object-cover
              // default-centers, slicing logo/title content out of the
              // top of compositions. Bias 30% from top keeps the focal
              // area visible at the cost of slightly more bottom crop
              // (which already sits under the title overlay anyway).
              style={{ objectPosition: "center 30%" }}
              // Defence-in-depth against CDNs that 200-respond with a
              // 1×1 transparent stub: treat any image whose decoded
              // size is unusably small as a failed load.
              onLoad={(e) => {
                if (e.currentTarget.naturalWidth < 50) setHeroUrl(null);
              }}
              onError={() => setHeroUrl(null)}
            />
          ) : null}
          {/* Bottom gradient + title overlay always renders. When the
              image is missing, the gradient sits on the flat
              `bg-2/bg-inset` background and the title is the only
              visible artwork — no need for the duplicate italic
              centred title that previously stacked under the
              overlay's title. */}
          <div
            className="absolute inset-x-0 bottom-0 pointer-events-none"
            style={{
              height: "60%",
              background:
                "linear-gradient(to top, rgba(0,0,0,0.80) 0%, rgba(0,0,0,0.45) 60%, rgba(0,0,0,0) 100%)",
            }}
          />
          <div className="absolute inset-x-4 bottom-3 flex flex-col gap-1">
            <div className="text-lg font-semibold leading-tight text-white drop-shadow truncate">
              {game.name}
            </div>
            <div className="text-[11.5px] text-white/80 tracking-[0.02em] truncate">
              {game.project} · {platformLabel}
              {game.installedVersion ? ` · v${game.installedVersion.replace(/^v/i, "")}` : ""}
            </div>
          </div>
        </div>

        {/* Action button cluster — sits directly under the hero so
            Install / Play / Update is above the fold without scrolling
            past panels. */}
        <div className="flex flex-wrap gap-2 mb-3">
          {game.gameStatus === "available" ? (
            <Button
              variant="primary"
              disabled={
                busy ||
                (needsRom && !romPath.trim()) ||
                (game.installType === "build_from_source" &&
                  buildEnv !== null &&
                  (!buildEnv.ok || !buildEnv.hasRecipe))
              }
              onClick={handleInstall}
            >
              {busy ? <Spinner size={12} /> : null}
              Install
            </Button>
          ) : null}

          {game.gameStatus === "installed" && game.addedToSteam ? (
            <Button variant="primary" onClick={handlePlay}>
              Play
            </Button>
          ) : null}

          {game.gameStatus === "installed" && !game.addedToSteam ? (
            <Button
              variant="accent"
              disabled={busy}
              onClick={handleAddToSteam}
            >
              Add to Steam
            </Button>
          ) : null}

          {game.gameStatus === "update_available" ? (
            <Button
              variant="warning"
              disabled={busy}
              onClick={handleUpdate}
            >
              {busy ? <Spinner size={12} /> : null}
              Update
            </Button>
          ) : null}

          {game.gameStatus === "installed" ||
          game.gameStatus === "update_available" ? (
            <Button
              variant="neutral"
              disabled={busy}
              onClick={handleUninstall}
            >
              Uninstall
            </Button>
          ) : null}
        </div>

        {/* Inline progress bar so the user sees install state without
            scrolling. Sits right under the action buttons. */}
        {progress ? (
          <div className="mb-3">
            <ProgressLine event={progress} />
          </div>
        ) : null}

        {error ? (
          <div className="mb-3"><Panel title="Error">
            <Text>{error}</Text>
          </Panel></div>
        ) : null}

        {/* "Not in Steam yet" inline note. Pre-redesign rendered as a
            full Panel; now condensed to a one-liner under the action
            cluster so the user understands why "Play" isn't there
            and that Add to Steam is the fix. */}
        {game.gameStatus === "installed" && !game.addedToSteam ? (
          <div className="mb-3 text-[11.5px] text-base-content/65 italic">
            Not registered with Steam — usually because Steam wasn't running
            when you installed. Click <strong>Add to Steam</strong> above to
            enable Play and Gaming Mode launch.
          </div>
        ) : null}

        {/* Tab bar — only when the game declares a mods catalog.
            Single-tab games (most of the registry) get no bar; an
            empty "Overview" tab adds visual noise without any
            user-actionable affordance. Multi-tab games (Dusklight,
            future OoT) keep the bar for navigation. */}
        {tabs.length > 1 ? (
          <div className="mb-3">
            <TabBar
              tabs={tabs}
              activeTab={tab}
              onTabChange={(t) => setTab(t as "overview" | "mods")}
            />
          </div>
        ) : null}

        {tab === "overview" ? (
          <>
        <Panel title="About">
          <Text>{game.description}</Text>
          {game.website ? (
            <div className="mt-2">
              <Text variant="secondary">
                Project page:{" "}
                <a
                  href={game.website}
                  target="_blank"
                  rel="noreferrer"
                  className="link"
                >
                  {game.website}
                </a>
              </Text>
            </div>
          ) : null}
          {game.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {game.tags.map((t) => (
                <Badge key={t} variant="info" size="xs">
                  {t}
                </Badge>
              ))}
            </div>
          ) : null}
        </Panel>

        {buildEnv && game.installType === "build_from_source" ? (
          <div className="mt-3"><Panel title="Build environment">
            <Text variant="secondary">
              The plugin clones {game.repo} and builds it inside a
              managed distrobox container. The container is created
              automatically on first install and reused for every
              build-from-source game after that — no host packages
              installed, no reboots needed.
            </Text>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span
                className={`chip text-[11px] ${buildEnv.ok ? "chip-success" : "chip-error"}`}
              >
                {buildEnv.ok ? "✓ Ready" : "✗ Setup needed"}
              </span>
              <span className="text-[11px] text-base-content/70">
                {buildEnv.label}
              </span>
              {buildEnv.distroId && buildEnv.distroId !== "unknown" ? (
                <span className="chip chip-info text-[11px]">
                  {buildEnv.distroId}
                </span>
              ) : null}
            </div>
            {!buildEnv.ok && buildEnv.installHint ? (
              <div className="mt-2">
                <Text variant="secondary">
                  Install the missing tools ({buildEnv.missing.join(", ")})
                  first. On {buildEnv.distroId ?? "this distro"}, run from
                  a terminal:
                </Text>
                <div className="mt-1 p-2 bg-base-300/50 rounded font-mono text-xs break-all">
                  {buildEnv.installHint}
                </div>
              </div>
            ) : null}
            {!buildEnv.hasRecipe ? (
              <div className="mt-2">
                <Text variant="secondary">
                  No setup.ts shipped for this entry — recompile the
                  plugin against the latest games/ directory.
                </Text>
              </div>
            ) : null}
          </Panel></div>
        ) : null}

        {needsRom && game.gameStatus === "available" ? (
          <div className="mt-3"><Panel title="ROM required">
            <Text variant="secondary">
              {game.romInfo?.description ?? "This game requires you to supply your own ROM file."}
            </Text>

            {/* Auto-suggested matches from settings.romDirectory.
                Rendered above the manual textbox so the obvious
                "yes that's it" cases are one click. Clicking a
                suggestion sets the path, persists it, and clears
                the suggestion list so we don't keep dangling stale
                options after the user has chosen. */}
            {romSuggestions.length > 0 ? (
              <div className="mt-3 mb-2">
                <div className="text-[11.5px] text-base-content/55 tracking-[0.02em] mb-1.5">
                  Matches in your ROM folder
                </div>
                <div className="flex flex-col gap-1">
                  {romSuggestions.map((s) => (
                    <RomSuggestionRow
                      key={s.path}
                      basename={s.basename}
                      path={s.path}
                      selected={romPath === s.path}
                      onActivate={() => {
                        setRomPath(s.path);
                        persistRomPath(s.path);
                        setRomSuggestions([]);
                      }}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-2 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <TextInput
                  value={romPath}
                  onChange={(v) => {
                    setRomPath(v);
                    persistRomPath(v);
                  }}
                  placeholder="Absolute path to ROM file"
                />
              </div>
              <Button
                variant="neutral"
                size="sm"
                onClick={() => setBrowserOpen(true)}
              >
                Browse…
              </Button>
            </div>
          </Panel></div>
        ) : null}

        <FileBrowser
          open={browserOpen}
          onClose={() => setBrowserOpen(false)}
          onPick={(path) => {
            setRomPath(path);
            persistRomPath(path);
            setBrowserOpen(false);
          }}
          extensions={game.romInfo?.extensions ?? []}
          title="Select ROM file"
        />
          </>
        ) : null}

        {tab === "mods" && hasMods ? (
          <ModsPanel
            gameId={game.id}
            gameTitle={game.name}
            installedVersion={game.installedVersion}
            gameInstalled={
              game.gameStatus === "installed" ||
              game.gameStatus === "update_available"
            }
          />
        ) : null}
        </div>
      </div>
    </>
  );
}

// ── Mods & extras panel ──────────────────────────────────────────────

interface ModsPanelProps {
  gameId: string;
  gameTitle: string;
  installedVersion?: string;
  /** Whether the base game is installed. When false the panel shows
   *  a stub asking the user to install first — install/import RPCs
   *  reject otherwise, so the buttons would just toast errors. */
  gameInstalled: boolean;
}

/**
 * Renders the "Mods & extras" card on the detail page, gated on the
 * game being installed AND the manifest declaring at least one mod.
 * Each card shows install state, action buttons appropriate to the
 * mod's source kind (Install for github-release / direct-url; Open
 * page + Import from disk for manual-import), and an inline progress
 * bar fed by `pipelineEvent.stage?.startsWith("mod:<id>")`.
 */
function ModsPanel({ gameId, gameInstalled }: ModsPanelProps) {
  const { call, useEvent } = useBackend("recomp");
  // quick-links exposes `launchUrl(url)` — the cross-plugin RPC
  // pattern store-bridge uses for the same affordance.
  const browser = useBackend("quick-links");
  const [mods, setMods] = useState<ModInfo[] | null>(null);
  const [progress, setProgress] = useState<Record<string, PipelineEvent>>({});
  // When non-null, the FileBrowser modal is open for this mod's
  // "Import from disk" flow. Tracking the active mod here keeps a
  // single FileBrowser instance for all the panel's mod cards.
  const [importingMod, setImportingMod] = useState<ModInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = (await call("getMods", gameId)) as ModInfo[];
      setMods(r);
    } catch {
      setMods([]);
    }
  }, [call, gameId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // gameStatusChanged fires after every install/import — refresh so
  // the per-mod status flips and the button state updates.
  useEvent({
    event: "gameStatusChanged",
    handler: (data: unknown) => {
      const d = data as { gameId?: string };
      if (d.gameId === gameId) void refresh();
    },
  });

  // Per-mod progress: keyed off pipelineEvent.stage of shape
  // `mod:<modId>:<phase>`. Drop the stage on terminal events so the
  // bar disappears after the toast.
  useEvent({
    event: "pipelineEvent",
    handler: (data: unknown) => {
      const ev = data as PipelineEvent;
      if (ev.gameId !== gameId) return;
      if (!ev.stage?.startsWith("mod:")) return;
      const modId = ev.stage.split(":")[1] ?? "";
      if (!modId) return;
      setProgress((prev) => {
        const next = { ...prev };
        if (ev.type === "complete" || ev.type === "error") {
          delete next[modId];
        } else {
          next[modId] = ev;
        }
        return next;
      });
      if (ev.type === "error") {
        notify(`Mod install failed — ${ev.message ?? "unknown error"}`, {
          kind: "error",
        });
      }
    },
  });

  if (!mods || mods.length === 0) return null;

  if (!gameInstalled) {
    return (
      <div>
        <Text variant="secondary">
          Install the base game first — mods overlay an existing install, so
          they can't be applied to a game that isn't on disk yet.
        </Text>
      </div>
    );
  }

  const handleInstall = async (mod: ModInfo) => {
    try {
      await call("installMod", gameId, mod.id);
      notify(`${mod.name} installed`);
    } catch (err) {
      // pipelineEvent.error already toasted; the RPC throw here is
      // mostly defensive (transport blip). Don't double-toast unless
      // the error is something the event stream wouldn't have shown.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/^Operation already in progress/.test(msg)) {
        notify(`Couldn't install ${mod.name} — ${msg}`, { kind: "error" });
      }
    }
  };

  const handleOpenPage = async (mod: ModInfo) => {
    try {
      const url = (await call("getModUrl", gameId, mod.id)) as string | null;
      if (!url) {
        notify("This mod has no linked page.", { kind: "error" });
        return;
      }
      const r = (await browser.call("launchUrl", url)) as LaunchUrlResult;
      if (r.launched) {
        // Dismiss the overlay so the user can see the browser the
        // launch raised. Mirrors store-bridge's auth-URL pattern.
        dismissOverlay();
        return;
      }
      notify(
        r.message ??
          "No browser is registered. Open the Quick Links plugin and install one first.",
        { kind: "error" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`Couldn't open page — ${msg}`, { kind: "error" });
    }
  };

  // Open the in-overlay file browser. We use the same FileBrowser
  // component the ROM picker uses (no zenity / kdialog hand-off,
  // so no Gamescope focus-fight). The actual `importModFromDisk`
  // call happens in the FileBrowser's onPick callback below.
  const handleImport = (mod: ModInfo) => {
    setImportingMod(mod);
  };

  const onPickArchive = async (path: string) => {
    const mod = importingMod;
    setImportingMod(null);
    if (!mod) return;
    try {
      await call("importModFromDisk", gameId, mod.id, path);
      notify(`${mod.name} imported`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/^Operation already in progress/.test(msg)) {
        notify(`Couldn't import ${mod.name} — ${msg}`, { kind: "error" });
      }
    }
  };

  return (
    <div>
      <Text variant="secondary">
        Optional texture packs and tools. Most are folder-merge overlays —
        reinstalling the base game clears them.
      </Text>
      <div className="mt-3 flex flex-col gap-3">
        {mods.map((mod) => (
          <ModCard
            key={mod.id}
            mod={mod}
            progress={progress[mod.id] ?? null}
            onInstall={() => handleInstall(mod)}
            onOpenPage={() => handleOpenPage(mod)}
            onImport={() => handleImport(mod)}
          />
        ))}
      </div>
      <FileBrowser
        open={importingMod !== null}
        onClose={() => setImportingMod(null)}
        onPick={(path) => void onPickArchive(path)}
        extensions={importingMod?.source.acceptExtensions ?? ["zip", "7z", "rar"]}
        startPath="~/Downloads"
        title={
          importingMod
            ? `Import "${importingMod.name}" from disk`
            : "Select mod archive"
        }
      />
    </div>
  );
}

interface ModCardProps {
  mod: ModInfo;
  progress: PipelineEvent | null;
  onInstall: () => void;
  onOpenPage: () => void;
  onImport: () => void;
}

function ModCard({ mod, progress, onInstall, onOpenPage, onImport }: ModCardProps) {
  const isInstalling = mod.status === "installing" || progress !== null;
  const isInstalled = mod.status === "installed";
  const isManualImport = mod.source.kind === "manual-import";
  return (
    <div className="rounded-md border border-base-content/15 p-3 flex flex-col gap-2">
      <div className="flex items-start gap-3">
        {mod.previewImageUrl ? (
          <img
            src={mod.previewImageUrl}
            alt=""
            className="w-12 h-12 rounded object-cover shrink-0"
          />
        ) : (
          <div className="w-12 h-12 rounded bg-base-content/10 shrink-0 flex items-center justify-center text-base-content/55">
            <FaPuzzlePiece size={20} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{mod.name}</span>
            {isInstalled ? (
              <Badge variant="success" size="xs">
                {mod.installedVersion
                  ? `Installed v${mod.installedVersion.replace(/^v/i, "")}`
                  : "Installed"}
              </Badge>
            ) : null}
          </div>
          {mod.author ? (
            <div className="text-[12px] text-base-content/65">by {mod.author}</div>
          ) : null}
          <div className="text-[12.5px] mt-1 line-clamp-2">{mod.description}</div>
          {mod.sizeBytes ? (
            <div className="text-[11.5px] mt-1 text-base-content/65">
              {formatBytes(mod.sizeBytes)}
            </div>
          ) : null}
        </div>
      </div>
      {progress ? (
        <div>
          <div className="w-full h-1.5 rounded bg-base-content/10 overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: progress.percent != null ? `${progress.percent}%` : "30%",
              }}
            />
          </div>
          {progress.message ? (
            <div className="text-[11.5px] mt-1 truncate text-base-content/65">
              {progress.message}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!isManualImport ? (
          <Button
            variant="primary"
            size="sm"
            disabled={isInstalling}
            onClick={onInstall}
          >
            {isInstalling
              ? "Installing…"
              : isInstalled
                ? "Re-install"
                : "Install"}
          </Button>
        ) : null}
        {isManualImport ? (
          <>
            <Button
              variant="neutral"
              size="sm"
              disabled={isInstalling}
              onClick={onOpenPage}
            >
              Open page
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={isInstalling}
              onClick={onImport}
            >
              {isInstalling
                ? "Importing…"
                : isInstalled
                  ? "Re-import"
                  : "Import from disk"}
            </Button>
          </>
        ) : null}
        {!isManualImport && mod.externalUrl ? (
          <Button
            variant="neutral"
            size="sm"
            disabled={isInstalling}
            onClick={onOpenPage}
          >
            Open page
          </Button>
        ) : null}
      </div>
      {mod.credit ? (
        <div className="text-[11px] mt-1 text-base-content/65">{mod.credit}</div>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Settings view ────────────────────────────────────────────────────

function SettingsPage() {
  const nav = useRecompNav();
  const { call } = useBackend("recomp");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sgdbConfigured, setSgdbConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const s = (await call("getSettings")) as Settings;
      setSettings(s);
    })();
  }, [call]);

  // Probe the steamgriddb plugin's `hasApiKey` RPC so we can tell the
  // user whether artwork will work for their next install. If the
  // plugin isn't installed at all the call rejects — treat that the
  // same as "no key configured".
  useEffect(() => {
    const sgdbCall = (method: string) =>
      // Use the shell's WebSocket plumbing directly to talk to the
      // other plugin's backend.
      (window as unknown as {
        __LOADOUT__?: {
          call: (req: { plugin: string; method: string; args: unknown[] }) => Promise<unknown>;
        };
      }).__LOADOUT__?.call({
        plugin: "steamgriddb",
        method,
        args: [],
      });

    (async () => {
      try {
        const ok = (await sgdbCall("hasApiKey")) as boolean;
        setSgdbConfigured(!!ok);
      } catch {
        setSgdbConfigured(false);
      }
    })();
  }, []);

  if (!settings) {
    return (
      <div className="p-6">
        <Spinner size={32} />
      </div>
    );
  }

  const persist = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await call("updateSettings", patch);
  };

  return (
    <>
      <PluginHeader>
        <div className="flex items-center justify-between gap-4 w-full min-w-0">
          <div className="flex flex-col gap-0.5 min-w-0">
            <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
              RecompHub
            </h1>
            <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
              Settings
            </span>
          </div>
          <HeaderBackButton onBack={nav.toList} title="Back to library" />
        </div>
      </PluginHeader>
      <div className="p-6 h-full overflow-y-auto">
        <div className="max-w-2xl mx-auto">

        <div><Panel title="Artwork">
          {sgdbConfigured === null ? (
            <Text variant="secondary">Checking…</Text>
          ) : sgdbConfigured ? (
            <Text variant="secondary">
              SteamGridDB plugin is configured. Artwork will be applied automatically when you install a game.
            </Text>
          ) : (
            <>
              <Text variant="secondary">
                The SteamGridDB plugin isn't configured. Games will still install, but Steam will show the default shortcut tile until you set an API key in the SteamGridDB plugin.
              </Text>
              <div className="mt-2">
                <Button
                  variant="neutral"
                  size="sm"
                  onClick={() => nav.toPlugin("steamgriddb")}
                >
                  Open SteamGridDB plugin
                </Button>
              </div>
            </>
          )}
        </Panel></div>

        <div className="mt-3"><Panel title="ROM directory">
          <Text variant="secondary">
            Default location for ROMs used by recompilations that need one (e.g. Ship of Harkinian). Leave empty to enter a path per game at install time.
          </Text>
          <div className="mt-2">
            <TextInput
              value={settings.romDirectory ?? ""}
              onChange={(v) => persist({ romDirectory: v || undefined })}
              placeholder="/home/<you>/Roms"
            />
          </div>
        </Panel></div>
        </div>
      </div>
    </>
  );
}

// ── Top-level router + mount exports ─────────────────────────────────

/**
 * Switches between the three internal views and provides the nav
 * Context every child consumes. The dynamic `<PluginHeader>` is
 * rendered by each child view (CatalogView shows search + cog,
 * GameDetailPage shows the game name + back button, SettingsPage
 * shows "Settings" + back button) — the router itself just owns
 * the view-state machine.
 */
function RecompApp() {
  const [view, setView] = useState<RecompView>({ kind: "list" });
  const nav = useMemo<RecompNav>(
    () => ({
      toList: () => setView({ kind: "list" }),
      toDetail: (gameId: string) => setView({ kind: "detail", gameId }),
      toSettings: () => setView({ kind: "settings" }),
      // Cross-plugin nav drives the overlay shell's hash-based router
      // directly. Plugins don't have a sanctioned navigateOverlay()
      // hook — see packages/overlay/src/App.tsx for the routes.
      toPlugin: (pluginId: string) => {
        window.location.hash = `#/plugin/${pluginId}`;
      },
    }),
    [],
  );

  return (
    <RecompNavContext.Provider value={nav}>
      {view.kind === "list" && <CatalogView />}
      {view.kind === "detail" && <GameDetailPage gameId={view.gameId} />}
      {view.kind === "settings" && <SettingsPage />}
    </RecompNavContext.Provider>
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
      <RecompApp />
    </PluginProvider>,
  );
  return () => root.unmount();
}

/**
 * Stub `mountHeader` — its presence tells the loader to allocate a
 * header slot. The actual content is portaled from inside `mount()`
 * via `<PluginHeader>` so the back button / cog can read the same
 * view state as the body without prop-drilling across mount
 * boundaries. Same pattern as quick-links / protondb-badges.
 */
export function mountHeader(): () => void {
  return () => {};
}
