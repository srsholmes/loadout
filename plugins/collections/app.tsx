/**
 * Collections — the overlay UI.
 *
 * Two screens. The **grid** lists every collection you have: the ones this
 * plugin maintains from rules, and the ones already in Steam (EmuDeck's ROM
 * sets, anything hand-made). Opening one shows the games inside it. That is
 * the whole point — the grid is a preview of what Steam has, so there is never
 * a question of what syncing will produce.
 *
 * Game membership is computed on the backend rather than here. The rule
 * evaluator is fast enough to run in the webview and does for the rule
 * builder, but a linked collection's membership only exists in Steam, so both
 * kinds are asked for over one RPC and the UI stays agnostic about which it
 * has.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  GameCardGrid,
  IconButton,
  PluginHeader,
  SearchField,
  Spinner,
  Text,
  hideOverlay,
  mountComponent,
  mountHeaderStub,
  notify,
  useBackend,
} from "@loadout/ui";
import { FaGear, FaLayerGroup } from "react-icons/fa6";
import type { GameMetadataSnapshot } from "@loadout/types";
import { CollectionCard } from "./components/CollectionCard";
import { CollectionDetail } from "./components/CollectionDetail";
import { CollectionActionsPage } from "./components/CollectionActionsPage";
import { RuleBuilder } from "./components/RuleBuilder";
import { buildEvalGames } from "./lib/facts";
import type { ManagedCollection } from "./lib/types";

export { FaLayerGroup as icon };

interface SyncChange {
  label: string;
  kind: "created" | "updated" | "deleted";
  added: string[];
  removed: string[];
  addedCount: number;
  removedCount: number;
}

/**
 * One sync change as a sentence.
 *
 * Names up to a couple of games rather than counts alone — "Portal 2 left"
 * answers the question a bare "1 removed" provokes.
 */
function describeChange(c: SyncChange): string {
  if (c.kind === "created") return `${c.label} — created with ${c.addedCount} games`;
  if (c.kind === "deleted") return `${c.label} — removed from Steam`;

  const parts: string[] = [];
  if (c.addedCount > 0) parts.push(`${c.addedCount} added${listOf(c.added)}`);
  if (c.removedCount > 0) parts.push(`${c.removedCount} removed${listOf(c.removed)}`);
  return `${c.label} — ${parts.join(", ")}`;
}

function listOf(names: string[]): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? ` (${shown}, …)` : ` (${shown})`;
}

interface CollectionSummary {
  id: string;
  label: string;
  count: number;
  previewAppIds: string[];
  kind: "managed" | "linked";
  autoMaintained: boolean;
}

/** Where we are. A tagged union rather than a pile of booleans, so the header
 *  and the body can never disagree about which screen is showing. */
type View =
  | { kind: "grid" }
  | { kind: "detail"; id: string; label: string }
  | { kind: "rules"; id: string }
  | { kind: "actions"; id: string };

/** Exported for tests: `mount` wraps this in the real `PluginProvider`,
 *  which opens a WebSocket the specs have no use for. */
export function Collections() {
  const { call, ready } = useBackend("collections");

  const [view, setView] = useState<View>({ kind: "grid" });
  const [summaries, setSummaries] = useState<CollectionSummary[] | null>(null);
  const [steamReachable, setSteamReachable] = useState(true);
  const [search, setSearch] = useState("");

  const [games, setGames] = useState<Array<{ appId: string; name: string }> | null>(null);

  /**
   * The whole library, held in the webview.
   *
   * The rule builder prices every candidate rule and every row on each
   * keystroke, which is only affordable because evaluation happens here rather
   * than over RPC. Fetched once and reused; the grid does not need it.
   */
  const [snapshot, setSnapshot] = useState<GameMetadataSnapshot | null>(null);
  const [collections, setCollections] = useState<ManagedCollection[]>([]);
  /**
   * What the last sync changed.
   *
   * Shown on the grid rather than as a toast: a rules-driven collection
   * dropping a game is correct behaviour, and the only thing that makes it
   * feel arbitrary is finding out by accident. A toast is gone before you
   * have read it.
   */
  const [lastSync, setLastSync] = useState<SyncChange[] | null>(null);

  const evalGames = useMemo(() => buildEvalGames(snapshot?.games ?? []), [snapshot]);

  const loadGrid = useCallback(async () => {
    try {
      const result = (await call("listAll")) as {
        collections: CollectionSummary[];
        steamReachable: boolean;
      };
      setSummaries(result.collections);
      setSteamReachable(result.steamReachable);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't read your collections", {
        kind: "error",
      });
      setSummaries([]);
    }
  }, [call]);

  useEffect(() => {
    if (!ready) return;
    void loadGrid();
    void (async () => {
      try {
        const [snap, cfg] = await Promise.all([
          call("getSnapshot") as Promise<GameMetadataSnapshot>,
          call("getConfig") as Promise<{ config: { collections: ManagedCollection[] } }>,
        ]);
        setSnapshot(snap);
        setCollections(cfg.config.collections);
      } catch {
        // The grid still works without these; only rule editing needs them.
      }
    })();
  }, [ready, loadGrid, call]);

  const openCollection = useCallback(
    async (summary: CollectionSummary) => {
      setView({ kind: "detail", id: summary.id, label: summary.label });
      setGames(null);
      try {
        const result = (await call("listGames", summary.id)) as {
          games: Array<{ appId: string; name: string }>;
        };
        setGames(result.games);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't open that collection", {
          kind: "error",
        });
        setGames([]);
      }
    },
    [call],
  );

  /**
   * Open a game's Steam page rather than launching it.
   *
   * Launching straight from a tile is a lot of consequence for one press,
   * especially on a grid where a mis-tap starts a download. Hide first, then
   * navigate: the overlay is its own window over Gamescope, so leaving it up
   * means Steam moves behind it and the press looks like it did nothing.
   */
  const openGame = useCallback(
    async (appId: string) => {
      void hideOverlay().catch(() => {});
      try {
        await call("showGameInSteam", appId);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Couldn't open that game", { kind: "error" });
      }
    },
    [call],
  );

  const shown = useMemo(() => {
    if (!summaries) return [];
    const q = search.trim().toLowerCase();
    return q ? summaries.filter((c) => c.label.toLowerCase().includes(q)) : summaries;
  }, [summaries, search]);

  // ── Options ────────────────────────────────────────────────────────
  if (view.kind === "actions") {
    const summaryFor = summaries?.find((c) => c.id === view.id);
    if (!summaryFor) {
      return (
        <div className="p-7">
          <Spinner />
        </div>
      );
    }
    return (
      <div className="p-7 h-full overflow-y-auto" style={{ overflowX: "hidden" }}>
        <CollectionActionsPage
          label={summaryFor.label}
          kind={summaryFor.kind}
          count={summaryFor.count}
          autoMaintained={summaryFor.autoMaintained}
          onBack={() => setView({ kind: "grid" })}
          onRename={(label) => void renameCollection(summaryFor, label)}
          onDelete={() => void removeCollection(summaryFor)}
          onEditRules={
            summaryFor.kind === "managed"
              ? () => setView({ kind: "rules", id: view.id })
              : undefined
          }
        />
      </div>
    );
  }

  // ── Rule builder ───────────────────────────────────────────────────
  if (view.kind === "rules") {
    const editing = collections.find((c) => c.id === view.id);
    if (!editing) {
      // Deleted from under us, or the config has not arrived yet.
      return (
        <div className="p-7">
          <Spinner />
        </div>
      );
    }
    return (
      <div className="p-7 h-full overflow-y-auto" style={{ overflowX: "hidden" }}>
        <RuleBuilder
          collection={editing}
          games={evalGames}
          onCancel={() => setView({ kind: "grid" })}
          onSave={(next) => void saveCollection(next)}
        />
      </div>
    );
  }

  // ── Detail ─────────────────────────────────────────────────────────
  if (view.kind === "detail") {
    return (
      <CollectionDetail
        label={view.label}
        games={games}
        onBack={() => setView({ kind: "grid" })}
        onPickGame={(appId) => void openGame(appId)}
        onEditRules={
          collections.some((c) => c.id === view.id)
            ? () => setView({ kind: "rules", id: view.id })
            : undefined
        }
        onOptions={() => setView({ kind: "actions", id: view.id })}
        onRemoveGame={
          // Only a linked, non-dynamic collection can have games removed by
          // hand: a managed one would get them straight back on the next sync,
          // and Steam recomputes a dynamic one.
          summaries?.find((c) => c.id === view.id)?.kind === "linked" &&
          !summaries.find((c) => c.id === view.id)?.autoMaintained
            ? (appId) => void removeFromLinked(view.id, appId)
            : undefined
        }
      />
    );
  }

  // ── Grid ───────────────────────────────────────────────────────────
  return (
    <div className="p-7 h-full overflow-y-auto flex flex-col gap-3" style={{ overflowX: "hidden" }}>
      <PluginHeader>
        <div className="flex items-center justify-between gap-4 w-full min-w-0">
          <div className="flex flex-col gap-0.5 min-w-0">
            <h1 className="text-xl font-semibold m-0 leading-tight">Collections</h1>
            <span className="text-[11.5px] text-base-content/55 truncate leading-tight">
              {summaries === null
                ? "Reading your library…"
                : `${summaries.length} collections`}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <SearchField
              value={search}
              onChange={setSearch}
              onClear={() => setSearch("")}
              placeholder="Search collections…"
              width={220}
            />
            <Button variant="neutral" onClick={() => void createCollection()}>
              New
            </Button>
            <IconButton onClick={() => void sync()} title="Sync with Steam" ariaLabel="Sync with Steam" size={26}>
              <FaGear size={11} />
            </IconButton>
          </div>
        </div>
      </PluginHeader>

      {lastSync && lastSync.length > 0 ? (
        <div className="flex flex-col gap-1">
          <Text variant="secondary">Last sync</Text>
          <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
            {lastSync.map((c) => (
              <li key={`${c.kind}-${c.label}`}>
                <Text variant="secondary">{describeChange(c)}</Text>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!steamReachable ? (
        <Text variant="secondary">
          Steam isn&apos;t reachable, so only the collections this plugin maintains are
          shown. Start Steam to see the rest.
        </Text>
      ) : null}

      {summaries === null ? (
        <div className="flex items-center justify-center" style={{ padding: "4rem 0" }}>
          <Spinner />
        </div>
      ) : shown.length === 0 ? (
        <Text variant="secondary">
          {search.trim()
            ? `No collection matches “${search.trim()}”.`
            : "No collections yet. Press New to build one from rules."}
        </Text>
      ) : (
        <GameCardGrid minTileWidth={190}>
          {shown.map((c) => (
            <CollectionCard
              key={c.id}
              label={c.label}
              count={c.count}
              previewAppIds={c.previewAppIds}
              kind={c.kind}
              autoMaintained={c.autoMaintained}
              onOpen={() => void openCollection(c)}
            />
          ))}
        </GameCardGrid>
      )}
    </div>
  );

  async function renameCollection(c: CollectionSummary, label: string) {
    try {
      if (c.kind === "managed") {
        const config = (await call("renameCollection", c.id, label)) as {
          collections: ManagedCollection[];
        };
        setCollections(config.collections);
      } else {
        await call("renameLinked", c.id, label);
      }
      setView({ kind: "grid" });
      await loadGrid();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't rename that collection", {
        kind: "error",
      });
    }
  }

  async function removeCollection(c: CollectionSummary) {
    try {
      if (c.kind === "managed") {
        const config = (await call("deleteCollection", c.id)) as {
          collections: ManagedCollection[];
        };
        setCollections(config.collections);
      } else {
        await call("deleteLinked", c.id);
      }
      setView({ kind: "grid" });
      await loadGrid();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't delete that collection", {
        kind: "error",
      });
    }
  }

  /** Drop one game from a linked collection, writing straight to Steam. */
  async function removeFromLinked(id: string, appId: string) {
    const before = games ?? [];
    const next = before.filter((g) => g.appId !== appId);
    // Optimistic: the write is a Steam round trip, and a tile that lingers for
    // a second reads as a failed press.
    setGames(next);
    try {
      await call("setLinkedApps", id, next.map((g) => g.appId));
      await loadGrid();
    } catch (err) {
      setGames(before);
      notify(err instanceof Error ? err.message : "Couldn't update that collection", {
        kind: "error",
      });
    }
  }

  async function saveCollection(next: ManagedCollection) {
    try {
      const updated = collections.map((c) => (c.id === next.id ? next : c));
      await call("setCollections", updated);
      setCollections(updated);
      setView({ kind: "grid" });
      await loadGrid();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't save those rules", {
        kind: "error",
      });
    }
  }

  async function createCollection() {
    try {
      const config = (await call("createCollection", "New collection")) as {
        collections: ManagedCollection[];
      };
      setCollections(config.collections);
      await loadGrid();
      // Straight into the builder: a new collection matches the whole library,
      // and leaving the user on the grid in front of a 4000-game card with no
      // obvious next step is the wrong place to stop.
      const made = config.collections[config.collections.length - 1];
      if (made) setView({ kind: "rules", id: made.id });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't create that collection", {
        kind: "error",
      });
    }
  }

  async function sync() {
    try {
      const result = (await call("syncMirror")) as {
        created: number;
        updated: number;
        renamed: number;
        deleted: number;
        failures: unknown[];
        changes: SyncChange[];
      };
      const wrote = result.created + result.updated + result.renamed + result.deleted;
      setLastSync(result.changes);
      notify(wrote === 0 ? "Already up to date" : `Synced ${wrote} collections`, {
        kind: result.failures.length > 0 ? "error" : "success",
      });
      await loadGrid();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't reach Steam", { kind: "error" });
    }
  }
}

// `mountComponent` wraps in `PluginProvider` itself and returns the mounter.
export const mount = mountComponent(Collections);

export const mountHeader = mountHeaderStub;
