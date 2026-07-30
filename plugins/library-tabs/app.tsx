/**
 * Library Tabs — the overlay UI.
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

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GameCard,
  GameCardGrid,
  PluginProvider,
  Spinner,
  Text,
  collectionSearchTokens,
  fuzzySearchGames,
  friendlyCollectionName,
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
import { LibraryTabsHeader } from "./components/LibraryTabsHeader";
import type { ParamOption } from "./lib/rule-params";
import type { LibraryTabsConfig } from "./lib/config";
import { orderedTabs, resolveDefaultTab } from "./lib/config";
import { countMatches, evaluateTab } from "./lib/evaluate";
import { buildEvalGames } from "./lib/facts";
import { diagnoseTab, type Fix } from "./lib/diagnose";
import { requiredFacts } from "./lib/rules";
import { summarizeTab } from "./lib/summarize";
import { templates } from "./lib/templates";
import type { Tab } from "./lib/types";

export { FaLayerGroup as icon };

interface ConfigPayload {
  config: LibraryTabsConfig;
  warnings: string[];
  readOnly: boolean;
}

function LibraryTabs() {
  const { call, useEvent, ready } = useBackend("library-tabs");

  const [config, setConfig] = useState<LibraryTabsConfig | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [snapshot, setSnapshot] = useState<GameMetadataSnapshot | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  /** Tab whose rules are being edited, or null when browsing. */
  const [editingTabId, setEditingTabId] = useState<string | null>(null);

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
    handler: (next: unknown) => setConfig(next as LibraryTabsConfig),
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
        await call("createTabFromTemplate", templateId);
        setShowTemplates(false);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't create that tab", {
          kind: "error",
        });
      }
    },
    [call],
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

  const launch = useCallback(
    async (game: GameMetadata) => {
      try {
        await call("launchGame", game.appId, game.source);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't launch that game", {
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
    <LibraryTabsHeader
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
      onEditRules={
        !readOnly && activeTab && activeTab.builtin === undefined
          ? () => setEditingTabId(activeTab.id)
          : undefined
      }
    />
  );

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
      className="p-7 h-full overflow-y-auto flex flex-col gap-3"
      // `overflow-y: auto` makes overflow-x compute to `auto` as well, so the
      // tab strip's scrollIntoView scrolled this container sideways and clipped
      // the page. The strip owns its own horizontal scrolling.
      style={{ overflowX: "hidden" }}
    >
      {header}
      {readOnly ? (
        <Text variant="secondary">
          These settings were written by a newer version of Loadout, so they
          can&apos;t be changed here.
        </Text>
      ) : null}

      <TabStrip
        tabs={stripTabs}
        activeId={activeId}
        onSelect={setActiveId}
        showCounts={config.settings.showCounts}
      />

      {showTemplates ? (
        <TemplateGallery
          snapshot={snapshot}
          onPick={addTemplate}
        />
      ) : null}

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
          <GameCardGrid minTileWidth={activeTab?.display.tileWidth ?? 150}>
            {shown.map((game) => (
              <GameCard
                key={game.appId}
                imageUrl={game.capsuleUrl}
                fallbackImageUrl={game.headerUrl}
                title={game.name}
                collections={game.collections.map(friendlyCollectionName)}
                onPick={() => void launch(game)}
              />
            ))}
          </GameCardGrid>
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
  const KIND_FIELD: Partial<Record<string, string>> = {
    owned: "owned",
    lastPlayed: "lastPlayed",
    playtime: "playtimeMinutes",
    reviewScore: "reviewPercentage",
    metacritic: "metacritic",
    deckCompat: "deckCompat",
    steamOsCompat: "steamOsCompat",
    releaseDate: "releaseDate",
    purchaseDate: "purchasedAt",
    storeTags: "storeTags",
    genres: "genres",
    developer: "developers",
    publisher: "publishers",
    feature: "features",
    appKind: "kind",
    comingSoon: "comingSoon",
    familyShared: "familyShared",
    streamable: "streamable",
  };

  const walk = (rule: Tab["root"] | { kind: string; children?: unknown }): boolean => {
    if ("children" in rule && Array.isArray(rule.children)) {
      return (rule.children as Array<Parameters<typeof walk>[0]>).some(walk);
    }
    const field = KIND_FIELD[rule.kind];
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
    if (!needs || !providers) return null;
    for (const provider of Object.values(providers)) {
      if (provider.status !== "unavailable") continue;
      // A template is blocked when the provider that owns its data is out.
      if (needs.length > 0 && provider.reason) return provider.reason;
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-base-200 p-3">
      <Text variant="heading">Add a tab</Text>
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

export const mount = mountComponent(LibraryTabs);

/**
 * Reserves the shell's 60px topbar slot. The header's actual content is
 * portaled up from inside `mount()` by `LibraryTabsHeader`, so it shares
 * state with the body instead of running as a second React tree.
 */
export const mountHeader = mountHeaderStub;

export { PluginProvider };
