/**
 * Collections — the overlay UI.
 *
 * Evaluation happens **here**, in the webview, not on the backend. The whole
 * library arrives once per change and every tab is filtered locally, so
 * switching tabs is instant, search is instant, and a live match count on
 * every keystroke costs nothing. That local-first arrangement is what makes
 * the builder's per-rule counts affordable — and it is the opposite of
 * TabMaster's model, where a rebuild is triggered by MobX reactions on
 * Steam's own stores.
 *
 * The backend owns only persistence and the library snapshot.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GameCard,
  GameCardGrid,
  PluginProvider,
  Spinner,
  Text,
  collectionSearchTokens,
  fuzzySearchGames,
  friendlyCollectionName,
  hideOverlay,
  mountComponent,
  mountHeaderStub,
  notify,
  useBackend,
  useFocusable,
} from "@loadout/ui";
import { FaLayerGroup } from "react-icons/fa6";
import type { GameMetadata, GameMetadataSnapshot } from "@loadout/types";
import { TabStrip, type TabStripEntry } from "./components/TabStrip";
import { TabDiagnostics } from "./components/TabDiagnostics";
import { RuleBuilder } from "./components/RuleBuilder";
import { CollectionsHeader } from "./components/CollectionsHeader";
import { TabActionsPage } from "./components/TabActionsPage";
import { MirrorPage } from "./components/MirrorPage";
import { SettingsPage } from "./components/SettingsPage";
import type { MirrorPlan } from "./lib/mirror";
import { BuilderPage } from "./components/BuilderPage";
import type { ParamOption } from "./lib/rule-params";
import type { CollectionsConfig } from "./lib/config";
import { orderedTabs, resolveDefaultTab } from "./lib/config";
import { countMatches, evaluateTab } from "./lib/evaluate";
import { buildEvalGames } from "./lib/facts";
import { useVisibleRows } from "./hooks/useVisibleRows";
import { diagnoseTab, type Fix } from "./lib/diagnose";
import { RULE_FIELD, factUnavailableReason, requiredFacts, ruleDef } from "./lib/rules";
import { summarizeTab } from "./lib/summarize";
import { templates } from "./lib/templates";
import type { Tab } from "./lib/types";

export { FaLayerGroup as icon };

/** Matches the `p-7` on the page container, in px. */
const PAGE_PADDING = 28;

interface ConfigPayload {
  config: CollectionsConfig;
  warnings: string[];
  readOnly: boolean;
}

function Collections() {
  const { call, useEvent, ready } = useBackend("collections");

  const [config, setConfig] = useState<CollectionsConfig | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [snapshot, setSnapshot] = useState<GameMetadataSnapshot | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  /** Tab whose rules are being edited, or null when browsing. */
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  /** Tab whose rename/move/delete page is open. */
  const [managingTabId, setManagingTabId] = useState<string | null>(null);
  const [showMirror, setShowMirror] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [mirror, setMirror] = useState<{
    plan: MirrorPlan;
    summary: string;
    tabLabels: Record<string, string>;
  } | null>(null);
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  /** The scrolling page, and the wrapper around the tile grid — both measured
   *  by `useVisibleRows` so only the rows in view are mounted. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridWrapperRef = useRef<HTMLDivElement | null>(null);
  /** Wraps the spacers and the grid; its top is the fixed point the window
   *  measures from, since the grid's own offset moves as padTop grows. */
  const listRef = useRef<HTMLDivElement | null>(null);

  // ── Data ───────────────────────────────────────────────────────────

  const loadConfig = useCallback(async () => {
    const payload = (await call("getConfig")) as ConfigPayload;
    setConfig(payload.config);
    setReadOnly(payload.readOnly);
    // Load warnings are handed over once by the backend; surface them as
    // toasts rather than inline, since they describe an event that has
    // already happened rather than the current state of anything.
    for (const warning of payload.warnings) notify(warning, { kind: "info" });
  }, [call]);

  useEffect(() => {
    if (!ready) return;
    void loadConfig();
    void (async () => {
      setSnapshot((await call("getSnapshot")) as GameMetadataSnapshot);
    })();
  }, [ready, call, loadConfig]);

  // The backend broadcasts after every write, so an edit made anywhere (or a
  // restore) refreshes without polling.
  useEvent({
    event: "configChanged",
    handler: (next: unknown) => setConfig(next as CollectionsConfig),
  });

  // ── Derived ────────────────────────────────────────────────────────

  const evalGames = useMemo(
    () => buildEvalGames(snapshot?.games ?? []),
    [snapshot],
  );

  const visibleTabs = useMemo(
    () => (config ? orderedTabs(config).filter((t) => t.visible) : []),
    [config],
  );

  /**
   * Counts for every tab, computed in one pass. Also drives `autoHide`, so a
   * tab that evaluates to nothing can drop out of the strip while keeping its
   * position for when it fills up again.
   */
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const tab of visibleTabs) out.set(tab.id, countMatches(tab, evalGames));
    return out;
  }, [visibleTabs, evalGames]);

  /** Tabs whose rules need a data source the snapshot says is unavailable. */
  const unavailableTabs = useMemo(() => {
    const out = new Set<string>();
    const providers = snapshot?.providers;
    if (!providers) return out;
    const broken = new Set(
      Object.values(providers)
        .filter((p) => p.status === "unavailable")
        .flatMap((p) => p.ownsFields as readonly string[]),
    );
    for (const tab of visibleTabs) {
      // A fact-backed rule, or a rule reading a field no provider can supply.
      if (requiredFacts(tab.root).size > 0) {
        out.add(tab.id);
        continue;
      }
      if (broken.size > 0 && tabTouchesBrokenField(tab, broken)) out.add(tab.id);
    }
    return out;
  }, [visibleTabs, snapshot]);

  const stripTabs: TabStripEntry[] = useMemo(
    () =>
      visibleTabs
        .filter((tab) => !(tab.autoHide && (counts.get(tab.id) ?? 0) === 0))
        .map((tab) => ({
          id: tab.id,
          label: tab.label,
          count: snapshot ? counts.get(tab.id) : undefined,
          unavailable: unavailableTabs.has(tab.id),
        })),
    [visibleTabs, counts, snapshot, unavailableTabs],
  );

  // Pick a tab once the config lands, and recover if the active one vanishes.
  useEffect(() => {
    if (!config) return;
    if (activeId !== null && stripTabs.some((t) => t.id === activeId)) return;
    setActiveId(resolveDefaultTab(config)?.id ?? stripTabs[0]?.id ?? null);
  }, [config, activeId, stripTabs]);

  const activeTab: Tab | null = useMemo(
    () => visibleTabs.find((t) => t.id === activeId) ?? null,
    [visibleTabs, activeId],
  );

  const editingTab: Tab | null = useMemo(
    () => config?.tabs.find((t) => t.id === editingTabId) ?? null,
    [config, editingTabId],
  );

  /**
   * Choices for the builder's `picker` params. Derived from the snapshot the
   * page already holds, so opening the editor costs no extra RPC.
   */
  const pickerOptions = useMemo(() => {
    const games: ParamOption[] = (snapshot?.games ?? []).map((game) => ({
      value: game.appId,
      label: game.name,
    }));
    const seen = new Set<string>();
    const collections: ParamOption[] = [];
    for (const game of snapshot?.games ?? []) {
      for (const id of game.collections) {
        if (seen.has(id)) continue;
        seen.add(id);
        collections.push({ value: id, label: friendlyCollectionName(id) });
      }
    }
    collections.sort((a, b) => a.label.localeCompare(b.label));
    return { game: games, collection: collections };
  }, [snapshot]);

  const result = useMemo(
    // `trace` is on only while a diagnosis might be needed — it roughly
    // triples evaluation cost, and the happy path doesn't need it.
    () =>
      activeTab
        ? evaluateTab(activeTab, evalGames, { trace: true })
        : null,
    [activeTab, evalGames],
  );

  const diagnosis = useMemo(() => {
    if (!activeTab || !result) return null;
    const flipped = countMatches(
      {
        ...activeTab,
        root: {
          ...activeTab.root,
          combinator: activeTab.root.combinator === "all" ? "any" : "all",
        },
      },
      evalGames,
    );
    return diagnoseTab(activeTab, result, {
      librarySize: evalGames.length,
      flippedCombinatorCount: flipped,
    });
  }, [activeTab, result, evalGames]);

  /**
   * Search narrows the current tab rather than replacing it.
   *
   * `fuzzySearchGames` matches on `name` plus a `tags` array, so collections
   * are projected onto `tags` — and via `collectionSearchTokens` both the long
   * EmuDeck label and its short alias are searchable, so "n64" and
   * "Nintendo 64" find the same tiles.
   */
  const shown: GameMetadata[] = useMemo(() => {
    const matched = result?.matched ?? [];
    if (search.trim().length === 0) return matched;
    const searchable = matched.map((game) => ({
      ...game,
      tags: game.collections.flatMap(collectionSearchTokens),
    }));
    return fuzzySearchGames(searchable, search);
  }, [result, search]);

  // Mounting 4356 GameCards stalls CEF; evaluation is not the bottleneck,
  // rendering is. Only the rows in view (plus a little overscan) are mounted.
  const rowWindow = useVisibleRows({
    total: shown.length,
    gridWrapperRef,
    listRef,
    scrollRef,
  });

  // ── Actions ────────────────────────────────────────────────────────

  const applyFix = useCallback(
    async (fix: Fix) => {
      if (!config || !activeTab) return;
      const next = fix.apply(activeTab);
      try {
        await call("setTabs", config.tabs.map((t) => (t.id === next.id ? next : t)));
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't save that change", {
          kind: "error",
        });
      }
    },
    [call, config, activeTab],
  );

  const addTemplate = useCallback(
    async (templateId: string) => {
      try {
        const before = new Set((config?.tabs ?? []).map((t) => t.id));
        const next = (await call("createTabFromTemplate", templateId)) as
          | CollectionsConfig
          | undefined;
        // Select whatever the backend just created. It owns id generation
        // (`uniqueTabId` suffixes collisions), so the new id is whichever one
        // wasn't there a moment ago rather than anything we can predict.
        const created = (next?.tabs ?? []).find((t) => !before.has(t.id));
        if (created) {
          setActiveId(created.id);
          // A template with no rules is the "start from scratch" case: leaving
          // the user on an empty tab with no obvious next step is the worst
          // possible landing, so go straight into the builder.
          if (created.root.children.length === 0) setEditingTabId(created.id);
        }
        setShowTemplates(false);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't create that tab", {
          kind: "error",
        });
      }
    },
    // `config?.tabs` is a real dependency, not a lint formality: the new tab is
    // identified by diffing against the ids that existed a moment ago, so a
    // stale list would pick out the wrong tab — or none at all.
    [call, config?.tabs],
  );

  const saveTab = useCallback(
    async (next: Tab) => {
      if (!config) return;
      try {
        await call("setTabs", config.tabs.map((t) => (t.id === next.id ? next : t)));
        setEditingTabId(null);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't save that tab", {
          kind: "error",
        });
      }
    },
    [call, config],
  );

  const managingTab: Tab | null = useMemo(
    () => config?.tabs.find((t) => t.id === managingTabId) ?? null,
    [config, managingTabId],
  );

  /** Persist a whole-tab change and surface any rejection. */
  const applyTabs = useCallback(
    async (next: Tab[], failure: string) => {
      try {
        await call("setTabs", next);
      } catch (err) {
        notify(err instanceof Error ? err.message : failure, { kind: "error" });
      }
    },
    [call],
  );

  // ── Steam collection mirror ────────────────────────────────────────
  //
  // The plan is fetched, shown, and only then acted on. It is deliberately
  // not fetched on mount: building it costs a full library evaluation plus a
  // round trip to Steam, and most sessions never open this screen.
  const refreshMirrorPlan = useCallback(async () => {
    setMirrorBusy(true);
    setMirrorError(null);
    try {
      const preview = (await call("previewMirror")) as {
        plan: MirrorPlan;
        summary: string;
        tabLabels: Record<string, string>;
      };
      setMirror(preview);
    } catch (err) {
      setMirror(null);
      setMirrorError(err instanceof Error ? err.message : "Couldn't reach Steam.");
    } finally {
      setMirrorBusy(false);
    }
  }, [call]);

  const syncMirror = useCallback(async () => {
    setMirrorBusy(true);
    setMirrorError(null);
    try {
      const result = (await call("syncMirror")) as {
        created: number;
        updated: number;
        renamed: number;
        deleted: number;
        failures: Array<{ tabId: string; step: string; message: string }>;
      };
      const wrote =
        result.created + result.updated + result.renamed + result.deleted;
      if (result.failures.length > 0) {
        // Partial success is the common outcome when Steam is mid-restart, and
        // reporting it as a flat failure would send the user to re-sync work
        // that already landed.
        notify(
          `Synced ${wrote}, but ${result.failures.length} didn't work: ${result.failures[0]!.message}`,
          { kind: "error" },
        );
      } else {
        notify(wrote === 0 ? "Already up to date" : `Synced ${wrote} collections`, {
          kind: "success",
        });
      }
    } catch (err) {
      setMirrorError(err instanceof Error ? err.message : "Couldn't reach Steam.");
    } finally {
      setMirrorBusy(false);
      // Re-read rather than assuming the plan is now empty: the sync may have
      // been partial, and the screen must show what is actually left.
      void refreshMirrorPlan();
    }
  }, [call, refreshMirrorPlan]);

  const openMirror = useCallback(() => {
    setShowMirror(true);
    setShowSettings(false);
    setManagingTabId(null);
    void refreshMirrorPlan();
  }, [refreshMirrorPlan]);

  /**
   * Turn automatic syncing on or off.
   *
   * Switching it on syncs immediately rather than waiting for the next edit —
   * otherwise the setting reads as broken: you enable it, look at Steam, and
   * nothing has happened.
   */
  const setAutoSync = useCallback(
    async (next: boolean) => {
      if (!config) return;
      try {
        await call("setConfig", {
          ...config,
          mirror: { ...config.mirror, autoSync: next },
        });
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't change that setting", {
          kind: "error",
        });
      }
    },
    [call, config],
  );

  const deleteTab = useCallback(
    async (tabId: string) => {
      try {
        await call("deleteTab", tabId);
        setManagingTabId(null);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't delete that tab", {
          kind: "error",
        });
      }
    },
    [call],
  );

  const moveTab = useCallback(
    async (tabId: string, delta: number) => {
      if (!config) return;
      const order = orderedTabs(config).map((t) => t.id);
      const at = order.indexOf(tabId);
      const to = at + delta;
      if (at === -1 || to < 0 || to >= order.length) return;
      const [moved] = order.splice(at, 1);
      if (!moved) return;
      order.splice(to, 0, moved);
      try {
        await call("reorderTabs", order);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't reorder the tabs", {
          kind: "error",
        });
      }
    },
    [call, config],
  );

  /**
   * Open the game's page in Steam rather than starting it.
   *
   * Launching straight from a tile is a lot of consequence for one press —
   * especially on a grid of 4356 tiles where a mis-tap starts a download or a
   * game you did not want. Navigating lands you where you can read about it and
   * press Play, which is also where Steam's own library takes you.
   *
   * Hide first, then navigate: the overlay is its own X11 window over
   * Gamescope, so leaving it up means Steam moves behind it and the press looks
   * like it did nothing.
   */
  const openGame = useCallback(
    async (game: GameMetadata) => {
      void hideOverlay().catch(() => {});
      try {
        await call("showGameInSteam", game.appId);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't open that game", {
          kind: "error",
        });
      }
    },
    [call],
  );

  // ── Render ─────────────────────────────────────────────────────────

  if (!ready || !config) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const header = (
    <CollectionsHeader
      subtitle={
        editingTab
          ? `Editing “${editingTab.label}”`
          : activeTab
            ? summarizeTab(activeTab)
            : "Custom, filter-driven tabs for your library"
      }
      search={search}
      onSearchChange={setSearch}
      showBrowseActions={!editingTab}
      searchPlaceholder={
        activeTab ? `Search ${activeTab.label}…` : "Search your library…"
      }
      addTabLabel={showTemplates ? "Close" : "Add tab"}
      onAddTab={
        readOnly ? undefined : () => setShowTemplates((open) => !open)
      }
      onTabOptions={
        !readOnly && activeTab ? () => setManagingTabId(activeTab.id) : undefined
      }
      onSettings={() => setShowSettings(true)}
    />
  );

  // Its own screen, not a panel under the tab strip. Inline, it opened
  // wherever you happened to be scrolled — on a 4356-tile grid that is usually
  // off-screen, so pressing Add tab appeared to do nothing at all.
  if (showTemplates) {
    return (
      <div className="p-7 h-full overflow-y-auto" style={{ overflowX: "hidden" }}>
        {header}
        <BuilderPage
          title="Add a tab"
          description="Start from a template, or build one from scratch."
          onBack={() => setShowTemplates(false)}
        >
          <TemplateGallery snapshot={snapshot} onPick={addTemplate} />
        </BuilderPage>
      </div>
    );
  }

  if (showSettings) {
    return (
      <div className="p-7 h-full overflow-y-auto" style={{ overflowX: "hidden" }}>
        {header}
        <SettingsPage
          autoSync={config.mirror.autoSync}
          mirroredCount={config.tabs.filter((t) => t.mirror.enabled).length}
          pendingSync={config.mirror.pendingSync}
          readOnly={readOnly}
          onBack={() => setShowSettings(false)}
          onToggleAutoSync={(next) => void setAutoSync(next)}
          onOpenMirror={openMirror}
        />
      </div>
    );
  }

  if (showMirror) {
    return (
      <div className="p-7 h-full overflow-y-auto" style={{ overflowX: "hidden" }}>
        {header}
        <MirrorPage
          plan={mirror?.plan ?? null}
          summary={mirror?.summary ?? ""}
          tabLabels={mirror?.tabLabels ?? {}}
          busy={mirrorBusy}
          error={mirrorError}
          onBack={() => setShowMirror(false)}
          onRefresh={() => void refreshMirrorPlan()}
          onSync={() => void syncMirror()}
        />
      </div>
    );
  }

  if (managingTab) {
    const order = config ? orderedTabs(config) : [];
    return (
      <div className="p-7 h-full overflow-y-auto" style={{ overflowX: "hidden" }}>
        {header}
        <TabActionsPage
          tab={managingTab}
          index={order.findIndex((t) => t.id === managingTab.id)}
          tabCount={order.length}
          onBack={() => setManagingTabId(null)}
          onEditRules={() => {
            setEditingTabId(managingTab.id);
            setManagingTabId(null);
          }}
          onRename={(label) => {
            void applyTabs(
              (config?.tabs ?? []).map((t) =>
                t.id === managingTab.id ? { ...t, label } : t,
              ),
              "Couldn't rename that tab",
            );
          }}
          onToggleVisible={() => {
            void applyTabs(
              (config?.tabs ?? []).map((t) =>
                t.id === managingTab.id ? { ...t, visible: !t.visible } : t,
              ),
              "Couldn't change that tab",
            );
          }}
          onMove={(delta) => void moveTab(managingTab.id, delta)}
          onDelete={() => void deleteTab(managingTab.id)}
          onToggleMirror={() => {
            void applyTabs(
              (config?.tabs ?? []).map((t) =>
                t.id === managingTab.id
                  ? {
                      ...t,
                      mirror: {
                        enabled: !t.mirror.enabled,
                        // Seed the collection name from the label the first
                        // time, so turning this on doesn't create a collection
                        // called after whatever the tab used to be named.
                        collectionName: t.mirror.collectionName.trim() || t.label,
                      },
                    }
                  : t,
              ),
              "Couldn't change that tab",
            );
          }}
          onOpenMirror={openMirror}
        />
      </div>
    );
  }

  // The builder takes over the page rather than opening beside it: the rule
  // tree, its counts and the palette all need the width, and a gamepad user
  // should never have two focus regions competing for the D-pad.
  if (editingTab) {
    return (
      <div className="p-7 h-full overflow-y-auto" style={{ overflowX: "hidden" }}>
        {header}
        <RuleBuilder
          tab={editingTab}
          games={evalGames}
          pickerOptions={pickerOptions}
          onCancel={() => setEditingTabId(null)}
          onSave={(next) => void saveTab(next)}
        />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="p-7 h-full overflow-y-auto flex flex-col gap-3"
      style={{
        // `overflow-y: auto` makes overflow-x compute to `auto` as well, so the
        // tab strip's scrollIntoView scrolled this container sideways and
        // clipped the page. The strip owns its own horizontal scrolling.
        overflowX: "hidden",
        // Makes this the offsetParent of the grid. `offsetParent` skips
        // unpositioned ancestors, so without it the windowing hook's walk up
        // the chain sailed past the scroller and summed offsets all the way to
        // the body — a gridTop so large that the window never left row 0.
        position: "relative",
      }}
    >
      {header}
      {readOnly ? (
        <Text variant="secondary">
          These settings were written by a newer version of Loadout, so they
          can&apos;t be changed here.
        </Text>
      ) : null}

      {/* Full-bleed: cancel the page's padding so the strip scrolls edge to
          edge, then re-apply it inside so the first and last tab still clear
          the sides. Inline rather than `-mx-7`, which is not in the shell's
          stylesheet (see README). */}
      <div
        style={{
          marginInline: -PAGE_PADDING,
          // Sticky rather than pinned in the header: it belongs to the page's
          // scroll box, so it can bleed to the edges and still scroll with the
          // content until it reaches the top. `top` cancels the page's padding
          // so it lands flush. Inline because `sticky`/`z-10` are not classes
          // this plugin can rely on (see README).
          position: "sticky",
          top: -PAGE_PADDING,
          zIndex: 10,
          background: "var(--color-base-100)",
          paddingBlock: 8,
        }}
      >
        <TabStrip
          tabs={stripTabs}
          activeId={activeId}
          onSelect={setActiveId}
          onOpenMenu={readOnly ? undefined : setManagingTabId}
          showCounts={config.settings.showCounts}
          edgePadding={PAGE_PADDING}
        />
      </div>

      {diagnosis && diagnosis.kind !== "ok" ? (
        <TabDiagnostics
          diagnosis={diagnosis}
          onApplyFix={(fix) => void applyFix(fix)}
          editable={!readOnly && activeTab?.builtin === undefined}
        />
      ) : null}

      {!snapshot ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : shown.length > 0 ? (
        <>
          {search.trim().length > 0 ? (
            <Text variant="secondary">
              {shown.length} of {result?.matched.length ?? 0} shown
            </Text>
          ) : null}
          {/* Spacers stand in for the rows that aren't mounted, so the
              scrollbar still describes the whole list. They sit outside the
              grid because a CSS grid would lay them out as tiles. */}
          <div ref={listRef} style={{ flexShrink: 0 }}>
          <div style={{ height: rowWindow.padTop, flexShrink: 0 }} />
          {/* flexShrink: 0 throughout — the page is a flex column, and a flex
              item defaults to shrinking to fit, which silently collapsed the
              spacers to zero and left the scrollbar describing four rows
              instead of eight hundred. */}
          <div ref={gridWrapperRef} style={{ flexShrink: 0 }}>
            <GameCardGrid minTileWidth={activeTab?.display.tileWidth ?? 150}>
              {shown.slice(rowWindow.start, rowWindow.end).map((game) => (
                <GameCard
                  key={game.appId}
                  imageUrl={game.capsuleUrl}
                  fallbackImageUrl={game.headerUrl}
                  title={game.name}
                  collections={game.collections.map(friendlyCollectionName)}
                  onPick={() => void openGame(game)}
                />
              ))}
            </GameCardGrid>
          </div>
          <div style={{ height: rowWindow.padBottom, flexShrink: 0 }} />
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Whether any of a tab's rules reads a field no provider can currently
 * supply. Cheap and approximate — it looks at rule kinds, not at the fields
 * they happen to touch — but enough to dim a tab and set an honest tooltip.
 */
function tabTouchesBrokenField(tab: Tab, brokenFields: Set<string>): boolean {

  const walk = (rule: Tab["root"] | { kind: string; children?: unknown }): boolean => {
    if ("children" in rule && Array.isArray(rule.children)) {
      return (rule.children as Array<Parameters<typeof walk>[0]>).some(walk);
    }
    const field = RULE_FIELD[rule.kind as keyof typeof RULE_FIELD];
    return field !== undefined && brokenFields.has(field);
  };
  return walk(tab.root);
}

interface TemplateGalleryProps {
  snapshot: GameMetadataSnapshot | null;
  onPick: (templateId: string) => void;
}

/**
 * Templates, with the ones that can't work yet greyed and explained.
 *
 * Offering a "Deck Verified" template that silently produces an empty tab is
 * the failure this whole design is built to avoid, so a template whose data
 * source is unavailable says so up front and is not clickable.
 */
function TemplateGallery({ snapshot, onPick }: TemplateGalleryProps) {
  const providers = snapshot?.providers;

  const blockedReason = (needs: string[] | undefined): string | null => {
    if (!needs || needs.length === 0 || !providers) return null;

    // Map each needed rule kind to the field it reads, then to the provider
    // that owns that field. Only *that* provider being unavailable blocks the
    // template. The previous version greyed out anything with a non-empty
    // `needs` as soon as any provider was down — so a Deck Verified template
    // was disabled because genres were missing, long after Deck ratings worked.
    for (const kind of needs) {
      const field = RULE_FIELD[kind as keyof typeof RULE_FIELD];
      if (!field) continue;
      for (const provider of Object.values(providers)) {
        if (provider.status !== "unavailable") continue;
        if ((provider.ownsFields as readonly string[]).includes(field)) {
          return provider.reason ?? "This needs data that isn't available yet.";
        }
      }
    }

    // A rule backed by an async fact has no provider at all, so nothing above
    // can speak for it. Report it rather than leaving the template clickable.
    for (const kind of needs) {
      const factKey = ruleDef(kind as Parameters<typeof ruleDef>[0])?.factKey;
      if (factKey) return factUnavailableReason(factKey);
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {templates().map((template) => {
          const blocked = blockedReason(template.needs);
          return (
            <TemplateCard
              key={template.id}
              label={template.label}
              description={blocked ?? template.description}
              disabled={blocked !== null}
              onPick={() => onPick(template.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function TemplateCard({
  label,
  description,
  disabled,
  onPick,
}: {
  label: string;
  description: string;
  disabled: boolean;
  onPick: () => void;
}) {
  const { ref, focused } = useFocusable({
    focusable: !disabled,
    onEnterPress: onPick,
  });

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onPick}
      className={[
        "flex flex-col items-start gap-1 rounded-lg border p-3 text-left min-h-[44px]",
        "bg-base-100 border-base-300 transition-colors",
        disabled ? "opacity-50 cursor-not-allowed" : "hover:border-primary",
        focused ? "ring-2 ring-primary/60" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="font-semibold text-base-content">{label}</span>
      <span className="text-xs text-base-content/60">{description}</span>
    </button>
  );
}

export const mount = mountComponent(Collections);

/**
 * Reserves the shell's 60px topbar slot. The header's actual content is
 * portaled up from inside `mount()` by `CollectionsHeader`, so it shares
 * state with the body instead of running as a second React tree.
 */
export const mountHeader = mountHeaderStub;

export { PluginProvider };
