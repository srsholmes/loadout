import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FaLayerGroup,
  FaPlus,
  FaGear,
  FaPlay,
  FaBookBookmark,
  FaTrash,
  FaChevronUp,
  FaChevronDown,
  FaEye,
  FaEyeSlash,
  FaPen,
} from "react-icons/fa6";
import {
  Button,
  fuzzySearchGames,
  GameCard,
  GameCardGrid,
  HeaderBackButton,
  IconButton,
  mountComponent,
  mountHeaderStub,
  notify,
  PluginHeader,
  SearchField,
  Spinner,
  useBackend,
  useCurrentGame,
  useFocusable,
} from "@loadout/ui";
import type { GameCollection, GameInfo } from "@loadout/types";
import type {
  BacklogEntry,
  Filter,
  GameTabsData,
  Tab,
} from "./lib/types";
import {
  filterTabGames,
  gameMatchesTab,
  isTabVisible,
  sortGames,
} from "./lib/filters";
import {
  addToBacklog,
  cycleBacklogStatus,
  inBacklog,
  removeFromBacklog,
  swapBacklogOrder,
} from "./lib/backlog";
import { GamePicker } from "./components/GamePicker";
import { TabEditor, makeFilter } from "./components/TabEditor";
import { BacklogView } from "./components/BacklogView";
import { ActionRow, Modal, newId } from "./components/shared";

export { FaLayerGroup as icon };

const GAME_LIBRARY = "__core:game-library";
const GAME_DETECTION = "__core:game-detection";
const BACKLOG_TAB = "__backlog__";

// Where the game picker's confirmed selection should be written.
type PickerTarget =
  | { kind: "backlog" }
  | { kind: "draftFilter"; filterId: string };

interface PickerState {
  target: PickerTarget;
  initial: string[];
  title: string;
  confirmLabel: string;
}

// ── Whitelist helpers (add a game to a tab's hand-picked list) ────────

/** The appIds in a tab's first whitelist filter, if any. */
function whitelistIds(tab: Tab): string[] {
  const wl = tab.filters.find((f) => f.type === "whitelist");
  return wl && wl.type === "whitelist" ? wl.params.appIds : [];
}

/** Return a copy of `tab` whose whitelist filter contains `appId`,
 *  creating the whitelist filter (OR-combined semantics via the tab's
 *  own mode) if the tab has none yet. */
function addToTabWhitelist(tab: Tab, appId: string): Tab {
  const existing = tab.filters.find((f) => f.type === "whitelist");
  if (existing && existing.type === "whitelist") {
    if (existing.params.appIds.includes(appId)) return tab;
    return {
      ...tab,
      filters: tab.filters.map((f) =>
        f.id === existing.id && f.type === "whitelist"
          ? { ...f, params: { appIds: [...f.params.appIds, appId] } }
          : f,
      ),
    };
  }
  const wl: Filter = {
    id: newId("filter"),
    type: "whitelist",
    params: { appIds: [appId] },
  };
  return { ...tab, filters: [...tab.filters, wl] };
}

function removeFromTabWhitelist(tab: Tab, appId: string): Tab {
  return {
    ...tab,
    filters: tab.filters.map((f) =>
      f.type === "whitelist"
        ? { ...f, params: { appIds: f.params.appIds.filter((id) => id !== appId) } }
        : f,
    ),
  };
}

function setFilterAppIds(tab: Tab, filterId: string, appIds: string[]): Tab {
  return {
    ...tab,
    filters: tab.filters.map((f) =>
      f.id === filterId && (f.type === "whitelist" || f.type === "blacklist")
        ? { ...f, params: { appIds } }
        : f,
    ),
  };
}

// ── Main component ────────────────────────────────────────────────────

function GameTabsApp() {
  const gameTabs = useBackend("game-tabs");
  const library = useBackend(GAME_LIBRARY);
  const detection = useBackend(GAME_DETECTION);
  const currentGame = useCurrentGame();

  const [data, setData] = useState<GameTabsData | null>(null);
  const [games, setGames] = useState<GameInfo[] | null>(null);
  const [collections, setCollections] = useState<GameCollection[]>([]);
  const [recentAppIds, setRecentAppIds] = useState<string[]>([]);

  const [activeId, setActiveId] = useState<string>("all");
  const [search, setSearch] = useState("");

  // Overlay views layered above the tab grid.
  const [draft, setDraft] = useState<Tab | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [managing, setManaging] = useState(false);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [actionGame, setActionGame] = useState<GameInfo | null>(null);

  // ── Load ────────────────────────────────────────────────────────

  useEffect(() => {
    void gameTabs.call("getData").then((d) => setData(d as GameTabsData));
    void library
      .call("getGames")
      .then((g) => setGames(Array.isArray(g) ? (g as GameInfo[]) : []))
      .catch(() => setGames([]));
    void library
      .call("getCollections")
      .then((c) => setCollections(Array.isArray(c) ? (c as GameCollection[]) : []))
      .catch(() => setCollections([]));
    void detection
      .call("getRecentSessions")
      .then((s) => {
        if (Array.isArray(s)) {
          setRecentAppIds(
            (s as Array<{ appId: number }>).map((r) => String(r.appId)),
          );
        }
      })
      .catch(() => setRecentAppIds([]));
  }, [gameTabs, library, detection]);

  // Keep in sync with library rescans + other overlay instances.
  library.useEvent({
    event: "libraryChanged",
    handler: (payload) => {
      const p = payload as { games?: GameInfo[]; collections?: GameCollection[] };
      if (Array.isArray(p.games)) setGames(p.games);
      if (Array.isArray(p.collections)) setCollections(p.collections);
    },
  });
  gameTabs.useEvent({
    event: "dataChanged",
    handler: (d) => setData(d as GameTabsData),
  });

  const currentAppId = currentGame ? String(currentGame.appId) : null;

  // ── Persistence ─────────────────────────────────────────────────

  const persistTabs = useCallback(
    async (tabs: Tab[]) => {
      setData((prev) => (prev ? { ...prev, tabs } : prev));
      await gameTabs.call("saveTabs", tabs);
    },
    [gameTabs],
  );

  const persistBacklog = useCallback(
    async (backlog: BacklogEntry[]) => {
      setData((prev) => (prev ? { ...prev, backlog } : prev));
      await gameTabs.call("saveBacklog", backlog);
    },
    [gameTabs],
  );

  // ── Derived: visible tabs + active tab's games ──────────────────

  const tabs = useMemo(() => data?.tabs ?? [], [data]);
  const backlog = useMemo(() => data?.backlog ?? [], [data]);

  const orderedTabs = useMemo(
    () => tabs.slice().sort((a, b) => a.position - b.position),
    [tabs],
  );

  const visibleTabs = useMemo(() => {
    if (!games) return orderedTabs.filter((t) => !t.hidden);
    return orderedTabs.filter((t) => {
      if (t.hidden) return false;
      if (!t.autoHide) return true;
      const count = games.reduce(
        (n, g) => (gameMatchesTab(g, t) ? n + 1 : n),
        0,
      );
      return isTabVisible(t, count);
    });
  }, [orderedTabs, games]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  const gridGames = useMemo(() => {
    if (!games || !activeTab || activeId === BACKLOG_TAB) return [];
    const filtered = filterTabGames(games, activeTab);
    const sorted = sortGames(filtered, activeTab.sort, {
      recentAppIds,
      manualOrder: whitelistIds(activeTab),
    });
    const searched = fuzzySearchGames(sorted, search);
    // Float the running game to the front for quick resume.
    if (!currentAppId) return searched;
    const idx = searched.findIndex((g) => g.appId === currentAppId);
    if (idx <= 0) return searched;
    const copy = searched.slice();
    const [running] = copy.splice(idx, 1);
    if (running) copy.unshift(running);
    return copy;
  }, [games, activeTab, activeId, recentAppIds, search, currentAppId]);

  // If the active tab was deleted / hidden, fall back to the first visible.
  useEffect(() => {
    if (activeId === BACKLOG_TAB) return;
    if (!tabs.some((t) => t.id === activeId) && visibleTabs[0]) {
      setActiveId(visibleTabs[0].id);
    }
  }, [tabs, visibleTabs, activeId]);

  // ── Launch ──────────────────────────────────────────────────────

  const launch = useCallback(
    async (game: GameInfo | undefined, appId: string, source?: GameInfo["source"]) => {
      const src = source ?? game?.source ?? "steam";
      const res = (await gameTabs.call("launchGame", appId, src)) as {
        launched: boolean;
        message?: string;
      };
      if (res.launched) {
        notify(`Launching ${game?.name ?? appId}…`, { kind: "success" });
      } else {
        notify(res.message ?? "Couldn't launch the game.", { kind: "error" });
      }
    },
    [gameTabs],
  );

  // ── Tab CRUD ────────────────────────────────────────────────────

  const openNewTab = () => {
    const position = tabs.reduce((m, t) => Math.max(m, t.position), -1) + 1;
    setDraft({
      id: newId("tab"),
      name: "",
      filters: [makeFilter("whitelist")],
      filtersMode: "or",
      sort: "manual",
      autoHide: false,
      position,
      hidden: false,
    });
    setDraftIsNew(true);
  };

  const openEditTab = (tab: Tab) => {
    setDraft({ ...tab });
    setDraftIsNew(false);
    setManaging(false);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const next = draftIsNew
      ? [...tabs, draft]
      : tabs.map((t) => (t.id === draft.id ? draft : t));
    await persistTabs(next);
    setActiveId(draft.id);
    setDraft(null);
  };

  const deleteDraft = async () => {
    if (!draft) return;
    await persistTabs(tabs.filter((t) => t.id !== draft.id));
    setDraft(null);
    setActiveId("all");
  };

  const reorderTab = async (tabId: string, dir: "up" | "down") => {
    const ord = orderedTabs;
    const i = ord.findIndex((t) => t.id === tabId);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ord.length) return;
    const a = ord[i]!;
    const b = ord[j]!;
    await persistTabs(
      tabs.map((t) => {
        if (t.id === a.id) return { ...t, position: b.position };
        if (t.id === b.id) return { ...t, position: a.position };
        return t;
      }),
    );
  };

  const toggleTabHidden = async (tabId: string) => {
    await persistTabs(
      tabs.map((t) => (t.id === tabId ? { ...t, hidden: !t.hidden } : t)),
    );
  };

  // ── Picker plumbing ─────────────────────────────────────────────

  const openBacklogPicker = () =>
    setPicker({
      target: { kind: "backlog" },
      initial: backlog.map((e) => e.appId),
      title: "Add games to your backlog",
      confirmLabel: "Save backlog",
    });

  const openDraftFilterPicker = (filterId: string) => {
    if (!draft) return;
    const f = draft.filters.find((x) => x.id === filterId);
    const initial = f && (f.type === "whitelist" || f.type === "blacklist") ? f.params.appIds : [];
    setPicker({
      target: { kind: "draftFilter", filterId },
      initial,
      title: "Choose games",
      confirmLabel: "Done",
    });
  };

  const confirmPicker = async (appIds: string[]) => {
    if (!picker) return;
    const t = picker.target;
    if (t.kind === "backlog") {
      // Merge: keep existing entries (and their status/order), add new ones,
      // drop ones the user deselected.
      const now = Date.now();
      let next = backlog.filter((e) => appIds.includes(e.appId));
      for (const id of appIds) {
        if (!next.some((e) => e.appId === id)) next = addToBacklog(next, id, now);
      }
      await persistBacklog(next);
    } else if (t.kind === "draftFilter" && draft) {
      setDraft(setFilterAppIds(draft, t.filterId, appIds));
    }
    setPicker(null);
  };

  // ── Backlog actions ─────────────────────────────────────────────

  const addGameToBacklog = async (appId: string) => {
    await persistBacklog(addToBacklog(backlog, appId, Date.now()));
    notify("Added to backlog", { kind: "success" });
  };

  // ── Header ──────────────────────────────────────────────────────

  const subtitle = (() => {
    if (draft) return draftIsNew ? "New tab" : `Editing “${draft.name || "tab"}”`;
    if (managing) return "Reorder, hide, edit or delete tabs";
    if (activeId === BACKLOG_TAB) return `${backlog.length} game${backlog.length === 1 ? "" : "s"} to play through`;
    if (!games) return "Reading library…";
    return `${activeTab?.name ?? "All Games"} · ${gridGames.length} game${gridGames.length === 1 ? "" : "s"}`;
  })();

  const inTabView = !draft && !managing;
  const header = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            Game Tabs
          </h1>
          <span className="text-[11.5px] text-base-content/55 truncate leading-tight">
            {subtitle}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {inTabView && activeId !== BACKLOG_TAB && (
            <SearchField value={search} onChange={setSearch} onClear={() => setSearch("")} />
          )}
          {draft || managing ? (
            <HeaderBackButton
              onBack={() => {
                setDraft(null);
                setManaging(false);
              }}
              title="Back to library"
            />
          ) : (
            <>
              <IconButton onClick={openNewTab} title="New tab" ariaLabel="New tab">
                <FaPlus size={12} />
              </IconButton>
              <IconButton onClick={() => setManaging(true)} title="Manage tabs" ariaLabel="Manage tabs">
                <FaGear size={12} />
              </IconButton>
            </>
          )}
        </div>
      </div>
    </PluginHeader>
  );

  // ── Body ────────────────────────────────────────────────────────

  if (!data || games === null) {
    return (
      <>
        {header}
        <div className="p-7 h-full overflow-y-auto">
          <div className="flex items-center justify-center h-64">
            <Spinner size={32} />
          </div>
        </div>
      </>
    );
  }

  let body: React.ReactNode;
  if (draft) {
    body = (
      <TabEditor
        tab={draft}
        collections={collections}
        canDelete={!draftIsNew && tabs.length > 1}
        onChange={setDraft}
        onEditGameList={openDraftFilterPicker}
        onSave={saveDraft}
        onCancel={() => setDraft(null)}
        onDelete={deleteDraft}
      />
    );
  } else if (managing) {
    body = (
      <ManageTabs
        tabs={orderedTabs}
        onReorder={reorderTab}
        onToggleHidden={toggleTabHidden}
        onEdit={openEditTab}
        onDone={() => setManaging(false)}
      />
    );
  } else if (activeId === BACKLOG_TAB) {
    body = (
      <>
        <TabStrip
          tabs={visibleTabs}
          activeId={activeId}
          backlogCount={backlog.length}
          onSelect={setActiveId}
        />
        <BacklogView
          backlog={backlog}
          library={games}
          currentGameAppId={currentAppId}
          onLaunch={(g, id) => launch(g, id)}
          onCycleStatus={(id) => void persistBacklog(cycleBacklogStatus(backlog, id))}
          onSwap={(a, b) => void persistBacklog(swapBacklogOrder(backlog, a, b))}
          onRemove={(id) => void persistBacklog(removeFromBacklog(backlog, id))}
          onAddGames={openBacklogPicker}
        />
      </>
    );
  } else {
    body = (
      <>
        <TabStrip
          tabs={visibleTabs}
          activeId={activeId}
          backlogCount={backlog.length}
          onSelect={setActiveId}
        />
        {gridGames.length === 0 ? (
          <div className="card">
            <div className="text-center py-10 text-[var(--fg-3)]">
              {search.trim()
                ? "No games match your search."
                : "No games match this tab's filters yet."}
            </div>
          </div>
        ) : (
          <GameCardGrid>
            {gridGames.map((game) => (
              <GameCard
                key={game.appId}
                imageUrl={game.capsuleUrl}
                fallbackImageUrl={game.headerUrl}
                title={game.name}
                collections={game.tags}
                highlighted={game.appId === currentAppId}
                topLeftBadge={
                  game.appId === currentAppId ? (
                    <span className="chip chip-accent">RUNNING</span>
                  ) : undefined
                }
                onPick={() => setActionGame(game)}
              />
            ))}
          </GameCardGrid>
        )}
      </>
    );
  }

  return (
    <>
      {header}
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content full flex flex-col gap-4">{body}</div>
      </div>

      {picker && (
        <GamePicker
          library={games}
          collections={collections}
          initialSelected={picker.initial}
          title={picker.title}
          confirmLabel={picker.confirmLabel}
          onConfirm={confirmPicker}
          onClose={() => setPicker(null)}
        />
      )}

      {actionGame && (
        <GameActionSheet
          game={actionGame}
          inBacklog={inBacklog(backlog, actionGame.appId)}
          activeTab={
            activeTab &&
            activeId !== BACKLOG_TAB &&
            activeTab.filters.some((f) => f.type === "whitelist")
              ? activeTab
              : null
          }
          onClose={() => setActionGame(null)}
          onLaunch={() => {
            void launch(actionGame, actionGame.appId);
            setActionGame(null);
          }}
          onToggleBacklog={() => {
            if (inBacklog(backlog, actionGame.appId)) {
              void persistBacklog(removeFromBacklog(backlog, actionGame.appId));
            } else {
              void addGameToBacklog(actionGame.appId);
            }
            setActionGame(null);
          }}
          onToggleTab={() => {
            if (!activeTab) return;
            const has = whitelistIds(activeTab).includes(actionGame.appId);
            const next = has
              ? removeFromTabWhitelist(activeTab, actionGame.appId)
              : addToTabWhitelist(activeTab, actionGame.appId);
            void persistTabs(tabs.map((t) => (t.id === activeTab.id ? next : t)));
            setActionGame(null);
          }}
        />
      )}
    </>
  );
}

// ── Tab strip ─────────────────────────────────────────────────────────

function TabButton({
  label,
  active,
  onSelect,
  icon,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onSelect });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      className={[
        "flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[12.5px] whitespace-nowrap transition-all duration-150 border cursor-pointer",
        active
          ? "bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)] font-semibold"
          : "bg-[var(--bg-inset)] border-[var(--line)] text-[var(--fg-2)]",
        focused ? "scale-[1.04]" : "",
      ].join(" ")}
      style={focused ? { animation: "focusPulse 2s ease-in-out infinite" } : undefined}
    >
      {icon}
      {label}
    </button>
  );
}

function TabStrip({
  tabs,
  activeId,
  backlogCount,
  onSelect,
}: {
  tabs: Tab[];
  activeId: string;
  backlogCount: number;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      {tabs.map((t) => (
        <TabButton
          key={t.id}
          label={t.name}
          active={t.id === activeId}
          onSelect={() => onSelect(t.id)}
        />
      ))}
      <div className="w-px h-6 bg-[var(--line)] shrink-0 mx-1" />
      <TabButton
        label={`Backlog${backlogCount ? ` (${backlogCount})` : ""}`}
        active={activeId === BACKLOG_TAB}
        onSelect={() => onSelect(BACKLOG_TAB)}
        icon={<FaBookBookmark size={11} />}
      />
    </div>
  );
}

// ── Manage tabs ───────────────────────────────────────────────────────

function ManageTabs({
  tabs,
  onReorder,
  onToggleHidden,
  onEdit,
  onDone,
}: {
  tabs: Tab[];
  onReorder: (tabId: string, dir: "up" | "down") => void;
  onToggleHidden: (tabId: string) => void;
  onEdit: (tab: Tab) => void;
  onDone: () => void;
}) {
  return (
    <div className="card flex flex-col gap-2">
      {tabs.map((t, i) => (
        <div
          key={t.id}
          className="flex items-center gap-3 rounded-[10px] border px-3 py-2.5"
          style={{ borderColor: "var(--line)", background: "var(--bg-inset)" }}
        >
          <span className="text-[13px] font-medium flex-1 truncate">
            {t.name}
            {t.hidden && <span className="text-[var(--fg-3)] ml-2 text-[11px]">hidden</span>}
          </span>
          <IconButton onClick={() => onReorder(t.id, "up")} disabled={i === 0} title="Move up" ariaLabel="Move up">
            <FaChevronUp size={11} />
          </IconButton>
          <IconButton
            onClick={() => onReorder(t.id, "down")}
            disabled={i === tabs.length - 1}
            title="Move down"
            ariaLabel="Move down"
          >
            <FaChevronDown size={11} />
          </IconButton>
          <IconButton
            onClick={() => onToggleHidden(t.id)}
            title={t.hidden ? "Show tab" : "Hide tab"}
            ariaLabel={t.hidden ? "Show tab" : "Hide tab"}
          >
            {t.hidden ? <FaEyeSlash size={11} /> : <FaEye size={11} />}
          </IconButton>
          <IconButton onClick={() => onEdit(t)} title="Edit tab" ariaLabel="Edit tab" variant="accent">
            <FaPen size={11} />
          </IconButton>
        </div>
      ))}
      <div className="flex justify-end mt-2">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ── Game action sheet ─────────────────────────────────────────────────

function GameActionSheet({
  game,
  inBacklog,
  activeTab,
  onClose,
  onLaunch,
  onToggleBacklog,
  onToggleTab,
}: {
  game: GameInfo;
  inBacklog: boolean;
  activeTab: Tab | null;
  onClose: () => void;
  onLaunch: () => void;
  onToggleBacklog: () => void;
  onToggleTab: () => void;
}) {
  const inTab =
    activeTab != null && whitelistIds(activeTab).includes(game.appId);
  return (
    <Modal title={game.name} onClose={onClose}>
      <div className="flex flex-col gap-2">
        <ActionRow
          label="Launch game"
          hint="Start playing now"
          icon={<FaPlay size={13} />}
          onSelect={onLaunch}
        />
        <ActionRow
          label={inBacklog ? "Remove from backlog" : "Add to backlog"}
          hint={inBacklog ? "Take it off your play-through list" : "Queue it up to play through"}
          icon={<FaBookBookmark size={13} />}
          onSelect={onToggleBacklog}
        />
        {activeTab && (
          <ActionRow
            label={inTab ? `Remove from “${activeTab.name}”` : `Add to “${activeTab.name}”`}
            hint={inTab ? "Take it out of this tab" : "Hand-pick it into this tab"}
            icon={inTab ? <FaTrash size={13} /> : <FaPlus size={13} />}
            onSelect={onToggleTab}
          />
        )}
      </div>
    </Modal>
  );
}

export const mount = mountComponent(GameTabsApp);
export const mountHeader = mountHeaderStub;
