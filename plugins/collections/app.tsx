/**
 * Collections — the overlay UI.
 *
 * Seven screens. The **grid** lists every collection you have: the ones this
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
import { FaGear, FaLayerGroup, FaPlus, FaRotate } from "react-icons/fa6";
import type { GameMetadataSnapshot } from "@loadout/types";
import { CollectionCard } from "./components/CollectionCard";
import { CollectionDetail } from "./components/CollectionDetail";
import { CollectionActionsPage } from "./components/CollectionActionsPage";
import { AddGamesPage } from "./components/AddGamesPage";
import { NewCollectionPage } from "./components/NewCollectionPage";
import type { CollectionPreset } from "./lib/presets";
import { RuleBuilder } from "./components/RuleBuilder";
import { SettingsPage, type SyncChange } from "./components/SettingsPage";
import { buildEvalGames } from "./lib/facts";
import type { ManagedCollection } from "./lib/types";

export { FaLayerGroup as icon };

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
  | { kind: "actions"; id: string }
  | { kind: "add"; id: string; label: string }
  | { kind: "new" }
  | { kind: "settings" };

/** Exported for tests: `mount` wraps this in the real `PluginProvider`,
 *  which opens a WebSocket the specs have no use for. */
export function Collections() {
  const { call, ready } = useBackend("collections");

  const [view, setView] = useState<View>({ kind: "grid" });
  const [summaries, setSummaries] = useState<CollectionSummary[] | null>(null);
  const [steamReachable, setSteamReachable] = useState(true);
  /** The first grid read has been going long enough to owe an explanation. */
  const [slowLoad, setSlowLoad] = useState(false);
  const [search, setSearch] = useState("");

  const [games, setGames] = useState<Array<{ appId: string; name: string }> | null>(null);
  /** Dead shortcut ids in the open collection — see `listGames`. */
  const [staleCount, setStaleCount] = useState(0);
  /** Bumped when a create fails, so the New page can unlock itself. */
  const [createFailedAt, setCreateFailedAt] = useState<number | undefined>(undefined);

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
  /** Collections the last sync refused to write, and why. */
  const [blocked, setBlocked] = useState<Array<{ label: string; reason: string }>>([]);
  const [autoSync, setAutoSync] = useState(false);
  const [pendingSync, setPendingSync] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const evalGames = useMemo(() => buildEvalGames(snapshot?.games ?? []), [snapshot]);

  const loadGrid = useCallback(async () => {
    const slow = setTimeout(() => setSlowLoad(true), 2500);
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
    } finally {
      clearTimeout(slow);
      setSlowLoad(false);
    }
  }, [call]);

  /**
   * Sync on the way out.
   *
   * Held in a ref and read only in the unmount cleanup: the effect must not
   * re-run when these values change, or leaving would fire on every edit —
   * which is the behaviour this replaced.
   */
  const syncOnLeave = useRef({ enabled: false, owed: false, call });
  syncOnLeave.current = { enabled: autoSync, owed: pendingSync, call };
  useEffect(() => {
    return () => {
      const { enabled, owed, call: send } = syncOnLeave.current;
      if (!enabled || !owed) return;
      // Fire and forget: the plugin is going away, so there is nobody left to
      // report to — and nobody left waiting on the backend either, which is
      // the entire point of doing it here.
      void (send("syncMirror") as Promise<unknown>).catch(() => {});
    };
  }, []);

  /** Config the shell also owns — read back rather than guessed at. */
  const loadConfig = useCallback(async () => {
    const cfg = (await call("getConfig")) as {
      config: {
        collections: ManagedCollection[];
        mirror: { autoSync: boolean; pendingSync: boolean };
      };
    };
    setCollections(cfg.config.collections);
    setAutoSync(cfg.config.mirror.autoSync);
    setPendingSync(cfg.config.mirror.pendingSync);
  }, [call]);

  useEffect(() => {
    if (!ready) return;
    void loadGrid();
    void (async () => {
      try {
        const [snap] = await Promise.all([
          call("getSnapshot") as Promise<GameMetadataSnapshot>,
          loadConfig(),
        ]);
        setSnapshot(snap);
      } catch {
        // The grid still works without these; only rule editing needs them.
      }
    })();
  }, [ready, loadGrid, loadConfig, call]);

  /**
   * Which collection the newest `listGames` was for.
   *
   * Without it a slow response lands in whichever collection is open when it
   * arrives: open a 700-game one, go back, open a small one, and the first
   * response overwrites the second's games. That is not just a display bug —
   * the edit paths write against what is on screen, so removing a game there
   * would have written the first collection's members into the second.
   */
  const openRequest = useRef(0);

  const openCollection = useCallback(
    async (summary: { id: string; label: string }) => {
      const request = ++openRequest.current;
      setView({ kind: "detail", id: summary.id, label: summary.label });
      setGames(null);
      setStaleCount(0);
      try {
        const result = (await call("listGames", summary.id)) as {
          games: Array<{ appId: string; name: string }>;
          staleAppIds?: string[];
        };
        if (request !== openRequest.current) return;
        setGames(result.games);
        setStaleCount(result.staleAppIds?.length ?? 0);
      } catch (err) {
        if (request !== openRequest.current) return;
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

  // ── Settings ───────────────────────────────────────────────────────
  if (view.kind === "settings") {
    return (
      <div className="p-7 h-full overflow-y-auto" style={{ overflowX: "hidden" }}>
        <SettingsPage
          autoSync={autoSync}
          managedCount={collections.length}
          pendingSync={pendingSync}
          busy={syncing}
          lastSync={lastSync}
          blocked={blocked}
          onBack={() => setView({ kind: "grid" })}
          onToggleAutoSync={(next) => void setAutoSyncTo(next)}
          onSyncNow={() => void sync()}
        />
      </div>
    );
  }

  // ── Add games ──────────────────────────────────────────────────────
  if (view.kind === "add") {
    const already = new Set((games ?? []).map((g) => g.appId));
    // Bare, not wrapped: the picker owns its own scroll box, which is what the
    // row windowing measures against.
    return (
      <AddGamesPage
          label={view.label}
          candidates={(snapshot?.games ?? [])
            .filter((g) => !already.has(g.appId))
            .map((g) => ({ appId: g.appId, name: g.name, installed: g.installed }))}
        onBack={() => setView({ kind: "detail", id: view.id, label: view.label })}
        onAdd={(appIds) => void addToLinked(view.id, view.label, appIds)}
      />
    );
  }

  // ── New ────────────────────────────────────────────────────────────
  if (view.kind === "new") {
    return (
      <div className="p-7 h-full overflow-y-auto" style={{ overflowX: "hidden" }}>
        <NewCollectionPage
          existingNames={(summaries ?? []).map((c) => c.label)}
          games={evalGames}
          libraryLoaded={snapshot !== null}
          onBack={() => setView({ kind: "grid" })}
          onPickPreset={(preset) => void createCollection(preset.label, preset)}
          onCreate={(label) => void createCollection(label)}
          failedAt={createFailedAt}
        />
      </div>
    );
  }

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
          onBack={() => void openCollection(summaryFor)}
          onRename={(label) => void renameCollection(summaryFor, label)}
          onDelete={() => void removeCollection(summaryFor.id)}
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
          onCancel={() => void openCollection(editing)}
          onSave={(next) => void saveCollection(next)}
          onDelete={() => void removeCollection(editing.id)}
        />
      </div>
    );
  }

  // ── Detail ─────────────────────────────────────────────────────────
  if (view.kind === "detail") {
    // Only a linked, non-dynamic collection can be edited by hand: a managed
    // one would get its games straight back on the next sync, and Steam
    // recomputes a dynamic one.
    const summary = summaries?.find((c) => c.id === view.id);
    const handEditable = summary?.kind === "linked" && !summary.autoMaintained;
    return (
      <CollectionDetail
        label={view.label}
        games={games}
        onBack={() => setView({ kind: "grid" })}
        onPickGame={(appId) => void openGame(appId)}
        // A managed collection's options *are* its rule builder — name, rules
        // and delete on one page. A linked one has no rules, so it gets the
        // shorter page.
        onOptions={() =>
          setView(
            collections.some((c) => c.id === view.id)
              ? { kind: "rules", id: view.id }
              : { kind: "actions", id: view.id },
          )
        }
        onDelete={() => void removeCollection(view.id)}
        staleCount={handEditable ? staleCount : 0}
        onCleanUp={handEditable ? () => void cleanUpLinked(view.id) : undefined}
        onAddGames={
          // Only once the membership has arrived. It used to be offered while
          // the list was still loading, and adding then meant Steam kept only
          // what was picked.
          handEditable && games !== null
            ? () => setView({ kind: "add", id: view.id, label: view.label })
            : undefined
        }
        onRemoveGames={
          handEditable ? (appIds) => void removeFromLinked(view.id, appIds) : undefined
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
            {/* An icon, like everything else up here. The word sat among four
                icon buttons and read as the odd one out. */}
            <IconButton
              onClick={() => setView({ kind: "new" })}
              title="New collection"
              ariaLabel="New collection"
            >
              <FaPlus size={13} />
            </IconButton>
            {/* Syncing is a press, not a side effect. It used to run itself a
                couple of seconds after any edit — a full library evaluation
                plus Steam Cloud writes, on a single-threaded backend, while
                the user was still working. Every RPC queued behind it, which
                from the front is indistinguishable from a frozen plugin. */}
            <IconButton
              onClick={() => void sync()}
              title={
                syncing
                  ? "Syncing with Steam…"
                  : pendingSync
                    ? "Sync with Steam — changes are waiting"
                    : "Sync with Steam"
              }
              ariaLabel="Sync with Steam"
              disabled={syncing}
            >
              <FaRotate size={13} style={pendingSync && !syncing ? undefined : { opacity: 0.6 }} />
            </IconButton>
            <IconButton
              onClick={() => setView({ kind: "settings" })}
              title="Settings"
              ariaLabel="Settings"
            >
              <FaGear size={13} />
            </IconButton>
          </div>
        </div>
      </PluginHeader>


      {!steamReachable ? (
        <Text variant="secondary">
          Steam isn&apos;t reachable, so only the collections this plugin maintains are
          shown. Start Steam to see the rest.
        </Text>
      ) : null}

      {summaries === null ? (
        <div className="flex flex-col items-center justify-center gap-2" style={{ padding: "4rem 0" }}>
          <Spinner />
          {/* A spinner alone says "working" for as long as it spins and never
              says how long that might be. Reading the grid means the whole
              library plus a Steam round trip, so past a few seconds it owes an
              explanation. */}
          {slowLoad ? (
            <Text variant="secondary">
              Still reading your library and asking Steam for its collections…
            </Text>
          ) : null}
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
      await loadGrid();
      await openCollection({ id: c.id, label });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't rename that collection", {
        kind: "error",
      });
    }
  }

  /**
   * Delete a collection and land back on the grid without it.
   *
   * Takes an id rather than a summary. It used to need the row from
   * `summaries`, and did nothing at all when it could not find one — so a
   * confirmed delete could be a silent no-op, which is the worst possible
   * answer to "did that work?". The kind comes from `collections`, which is
   * what actually decides it: ours if we hold it, Steam's otherwise.
   *
   * The card goes immediately rather than after the grid reload. Re-reading
   * the grid means a full library evaluation plus a Steam round trip, and a
   * collection that lingers for that long after you confirmed its deletion
   * reads as a delete that did not take.
   */
  async function removeCollection(id: string) {
    // The grid row's `kind` is the backend's answer and the one to trust;
    // `collections` is only a fallback, because a failed `getConfig` leaves it
    // empty and a managed collection would then be deleted as a Steam one.
    const summary = summaries?.find((c) => c.id === id);
    const managed = summary ? summary.kind === "managed" : collections.some((c) => c.id === id);
    const before = summaries;
    setSummaries((prev) => prev?.filter((c) => c.id !== id) ?? prev);
    setView({ kind: "grid" });
    try {
      if (managed) {
        const config = (await call("deleteCollection", id)) as {
          collections: ManagedCollection[];
        };
        setCollections(config.collections);
        setPendingSync(true);
      } else {
        await call("deleteLinked", id);
      }
      await loadGrid();
    } catch (err) {
      setSummaries(before);
      notify(err instanceof Error ? err.message : "Couldn't delete that collection", {
        kind: "error",
      });
    }
  }

  /** Drop every entry Steam can no longer resolve — see `listGames`. */
  async function cleanUpLinked(id: string) {
    const request = openRequest.current;
    const before = staleCount;
    setStaleCount(0);
    try {
      const result = (await call("pruneLinked", id)) as { removed: number; kept: number };
      notify(
        result.removed === 0
          ? "Nothing left to clean up"
          : `Removed ${result.removed} dead ${result.removed === 1 ? "entry" : "entries"}`,
        { kind: "success" },
      );
      await loadGrid();
    } catch (err) {
      // Same token as `openCollection`: by the time this lands the user may be
      // looking at a different collection, and painting this one's state under
      // that one's header is how an edit gets aimed at the wrong thing.
      if (request === openRequest.current) setStaleCount(before);
      notify(err instanceof Error ? err.message : "Couldn't clean that collection up", {
        kind: "error",
      });
    }
  }

  async function addToLinked(id: string, label: string, appIds: string[]) {
    const request = openRequest.current;
    const before = games ?? [];
    const nameOf = new Map((snapshot?.games ?? []).map((g) => [g.appId, g.name] as const));
    const added = appIds.map((appId) => ({ appId, name: nameOf.get(appId) ?? appId }));
    // Straight back to the collection, showing what was added: the collection
    // *is* the confirmation, and a toast on top of an unchanged grid is not.
    setGames([...before, ...added]);
    setView({ kind: "detail", id, label });
    try {
      // A delta, not the whole list: `games` here is what the UI happens to
      // be showing, and writing that back truncates the collection to it.
      await call("editLinked", id, { add: appIds });
      await loadGrid();
    } catch (err) {
      if (request === openRequest.current) setGames(before);
      notify(err instanceof Error ? err.message : "Couldn't update that collection", {
        kind: "error",
      });
    }
  }

  async function removeFromLinked(id: string, appIds: readonly string[]) {
    const request = openRequest.current;
    const before = games ?? [];
    const dropped = new Set(appIds);
    const next = before.filter((g) => !dropped.has(g.appId));
    // Optimistic: the write is a Steam round trip, and a tile that lingers for
    // a second reads as a failed press.
    setGames(next);
    try {
      await call("editLinked", id, { remove: [...appIds] });
      await loadGrid();
    } catch (err) {
      if (request === openRequest.current) setGames(before);
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
      // The backend marks a sync owed on any edit that reaches Steam. Mirror
      // that here rather than re-reading the whole config, which would clobber
      // the collections we have just set — without it, leaving the plugin
      // skips the very sync the setting exists for.
      setPendingSync(true);
      // Back to the collection you were editing, not out to the grid: saving a
      // rule is how you find out what it did, and the grid does not show that.
      await loadGrid();
      await openCollection(next);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't save those rules", {
        kind: "error",
      });
    }
  }

  async function setAutoSyncTo(next: boolean) {
    try {
      const cfg = (await call("getConfig")) as {
        config: { mirror: Record<string, unknown> };
      };
      await call("setConfig", {
        ...cfg.config,
        mirror: { ...cfg.config.mirror, autoSync: next },
      });
      await loadConfig();
      // Turning it on syncs straight away — otherwise the switch reads as
      // broken: you enable it, look at Steam, and nothing has happened.
      if (next) await sync();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't change that setting", {
        kind: "error",
      });
    }
  }

  async function createCollection(label: string, preset?: CollectionPreset) {
    try {
      const config = (await call("createCollection", label)) as {
        collections: ManagedCollection[];
      };
      const made = config.collections[config.collections.length - 1];
      if (!made) throw new Error("The collection was saved but didn't come back — try reopening the plugin");

      if (preset) {
        // Rebuilt against the id the backend assigned rather than the preset's
        // own, so the rule ids inside it stay unique once two collections come
        // from the same preset.
        const built = { ...preset.build(made.id), label: made.label };
        const updated = config.collections.map((c) => (c.id === made.id ? built : c));
        await call("setCollections", updated);
        setCollections(updated);
        setPendingSync(true);
        await loadGrid();
        // A preset is already a result, so it opens as one. The builder would
        // be showing its homework.
        await openCollection(built);
        return;
      }

      setCollections(config.collections);
      setPendingSync(true);
      await loadGrid();
      // Straight into the builder: a collection built from scratch matches the
      // whole library, and leaving the user on the grid in front of a
      // 2500-game card with no obvious next step is the wrong place to stop.
      setView({ kind: "rules", id: made.id });
    } catch (err) {
      setCreateFailedAt(Date.now());
      notify(err instanceof Error ? err.message : "Couldn't create that collection", {
        kind: "error",
      });
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const result = (await call("syncMirror")) as {
        created: number;
        updated: number;
        renamed: number;
        deleted: number;
        failures: unknown[];
        changes: SyncChange[];
        blocked?: Array<{ label: string; reason: string }>;
      };
      const wrote = result.created + result.updated + result.renamed + result.deleted;
      const blocked = result.blocked ?? [];
      setLastSync(result.changes);
      setBlocked(blocked);
      // "Already up to date" is the shape of a success, and a sync that wrote
      // nothing *because everything was blocked* is not one.
      notify(
        blocked.length > 0
          ? `${blocked.length} ${blocked.length === 1 ? "collection" : "collections"} couldn't sync — see Settings`
          : wrote === 0
            ? "Already up to date"
            : `Synced ${wrote} collections`,
        { kind: result.failures.length > 0 || blocked.length > 0 ? "error" : "success" },
      );
      // pendingSync flips when Steam refuses a write, so read it back rather
      // than assuming the sync cleared it.
      await Promise.all([loadGrid(), loadConfig().catch(() => {})]);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Couldn't reach Steam", { kind: "error" });
    } finally {
      setSyncing(false);
    }
  }
}

// `mountComponent` wraps in `PluginProvider` itself and returns the mounter.
export const mount = mountComponent(Collections);

export const mountHeader = mountHeaderStub;
