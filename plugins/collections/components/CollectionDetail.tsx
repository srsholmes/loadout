/**
 * The games inside one collection.
 *
 * Windowed, because this is where the big ones live: a Steam ROM Manager set
 * can hold 700+ entries, and mounting that many `GameCard`s stalls CEF on a
 * handheld long before you have scrolled to the second row. The arithmetic is
 * in `lib/windowing.ts`; `useVisibleRows` does the measuring.
 *
 * The spacers sit *outside* the grid — inside it, a CSS grid would lay them
 * out as tiles — and everything carries `flexShrink: 0`, because the page is a
 * flex column and a flex item defaults to shrinking to fit, which silently
 * collapsed the spacers and left the scrollbar describing four rows instead of
 * eight hundred.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  GameCard,
  GameCardGrid,
  IconButton,
  PluginHeader,
  SearchField,
  Spinner,
  Text,
  pushBackInterceptor,
} from "@loadout/ui";
import { FaChevronLeft, FaGear, FaPen, FaPlus, FaTrash, FaXmark } from "react-icons/fa6";
import { useVisibleRows } from "../hooks/useVisibleRows";

export interface CollectionDetailProps {
  label: string;
  /** `null` while loading. */
  games: Array<{ appId: string; name: string }> | null;
  onBack: () => void;
  onPickGame: (appId: string) => void;
  /**
   * Everything about the collection itself — its name, its rules if it has
   * any, and deleting it. One screen: "Options" and "Edit rules" were two
   * buttons leading to two pages that both edited this collection, and
   * nothing on either said which of them held what.
   */
  onOptions: () => void;
  /** Delete the whole collection. Confirmed here before it is called. */
  onDelete: () => void;
  /**
   * Add games by hand. Offered on the same terms as {@link onRemoveGames}: a
   * managed collection's members come from its rules, and Steam recomputes a
   * dynamic one.
   */
  onAddGames?: () => void;
  /**
   * Entries Steam still stores but can no longer resolve — dead shortcut ids
   * left behind when EmuDeck or a ROM manager re-added its shortcuts.
   */
  staleCount?: number;
  /** Drop them. Linked collections only, and confirmed here. */
  onCleanUp?: () => void;
  /**
   * Drop games. Offered only for a linked, non-dynamic collection: a managed
   * one would get them straight back on the next sync, and Steam recomputes a
   * dynamic one.
   */
  onRemoveGames?: (appIds: string[]) => void;
}

const artUrl = (appId: string, kind: "capsule" | "header") =>
  `http://localhost:33820/api/steam-grid/${appId}/${kind}`;

export function CollectionDetail({
  label,
  games,
  onBack,
  onPickGame,
  onOptions,
  onDelete,
  onAddGames,
  staleCount = 0,
  onCleanUp,
  onRemoveGames,
}: CollectionDetailProps) {
  /** The bin has been pressed and is showing what it would do. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingCleanUp, setConfirmingCleanUp] = useState(false);
  /**
   * Picking games to remove.
   *
   * A Remove button on every tile put a destructive control under the thumb on
   * a grid you scroll with a thumbstick, and made removing five games five
   * separate writes. Editing is a mode now — the same one adding uses, so the
   * two halves of curating a collection behave alike.
   */
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>([]);
  /** Filter, because a ROM collection here runs to 700+ entries. */
  const [filter, setFilter] = useState("");

  /**
   * B goes back to the grid rather than out of the plugin.
   *
   * Every other screen here pushes one; this — the most-visited of them — did
   * not, so B fell through to the shell's default and dropped focus into the
   * sidebar with the collection still on screen.
   */
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const back = useCallback(() => onBackRef.current(), []);
  useEffect(
    () =>
      pushBackInterceptor(() => {
        back();
        return true;
      }),
    [back],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridWrapperRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const shown = useMemo(() => {
    if (!games) return null;
    const q = filter.trim().toLowerCase();
    return q ? games.filter((g) => g.name.toLowerCase().includes(q)) : games;
  }, [games, filter]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  /** Picked, but filtered out of view — the removals you cannot see. */
  const hiddenPicked = useMemo(() => {
    if (!shown) return 0;
    // A set, not a scan per pick: this recomputes on every keystroke, and the
    // collection this component exists for holds 700 entries.
    const visible = new Set(shown.map((g) => g.appId));
    return selected.filter((id) => !visible.has(id)).length;
  }, [selected, shown]);

  const rowWindow = useVisibleRows({
    total: shown?.length ?? 0,
    gridWrapperRef,
    listRef,
    scrollRef,
  });

  return (
    <div
      ref={scrollRef}
      className="p-7 h-full overflow-y-auto flex flex-col gap-3"
      style={{
        // `overflow-y: auto` makes overflow-x compute to `auto` too, which
        // lets a focus scroll drag the page sideways.
        overflowX: "hidden",
        position: "relative",
      }}
    >
      <PluginHeader>
        <div className="flex items-center justify-between gap-4 w-full min-w-0">
          <div className="flex flex-col gap-0.5 min-w-0">
            <h1 className="text-xl font-semibold m-0 leading-tight truncate">{label}</h1>
            <span className="text-[11.5px] text-base-content/55 truncate leading-tight">
              {games === null
                ? "Loading…"
                : editing
                  ? selected.length === 0
                    ? "Pick the ones to remove"
                    : hiddenPicked > 0
                      ? // The count that matters when a filter is on: picks
                        // survive it, so confirming can remove games that are
                        // not on screen. Saying only "3 picked" while showing
                        // one tile is how that goes unnoticed.
                        `${selected.length} picked · ${hiddenPicked} not shown`
                      : `${selected.length} picked`
                  : shown && shown.length !== games.length
                    ? `${shown.length} of ${games.length} games`
                    : `${games.length} games`}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* A long ROM collection is unusable without this: 700+ tiles is
                not something you scroll to the middle of with a thumbstick. */}
            {games !== null && games.length > 0 ? (
              <SearchField
                value={filter}
                onChange={setFilter}
                onClear={() => setFilter("")}
                placeholder="Filter…"
                width={180}
              />
            ) : null}
            {editing ? (
              <>
                <Button
                  variant="danger"
                  disabled={selected.length === 0 || !onRemoveGames}
                  onClick={() => {
                    if (!onRemoveGames) return;
                    onRemoveGames([...selected]);
                    setSelected([]);
                    setEditing(false);
                  }}
                >
                  {selected.length === 0
                    ? "Remove from collection"
                    : `Remove ${selected.length} from collection`}
                </Button>
                <IconButton
                  onClick={() => {
                    setEditing(false);
                    setSelected([]);
                  }}
                  title="Done"
                  ariaLabel="Done"
                >
                  <FaXmark size={13} />
                </IconButton>
              </>
            ) : null}
            {onRemoveGames && !editing ? (
              <IconButton
                onClick={() => {
                  // Disarm both: the confirms are hidden while editing, and
                  // coming back to a live destructive button from an intent
                  // expressed several interactions ago is one press from
                  // disaster.
                  setConfirmingDelete(false);
                  setConfirmingCleanUp(false);
                  setEditing(true);
                }}
                title="Edit collection"
                ariaLabel="Edit collection"
              >
                <FaPen size={13} />
              </IconButton>
            ) : null}
            {/* A bin icon alone is one press away from destroying a collection
                somebody else's tool may have spent a long time generating, and
                an icon cannot say what it is about to delete. Pressing it
                spells the consequence out as a red button instead — the second
                press is the one that acts. */}
            {editing ? null : confirmingDelete ? (
              <>
                {/* "Keep it" first, and the destructive button renamed and
                    told to say what it destroys: the trigger and its
                    confirmation used to share an accessible name *and* a
                    screen position, so two quick presses on what reads as one
                    control deleted a 700-entry collection. */}
                <Button variant="neutral" onClick={() => setConfirmingDelete(false)}>
                  Keep it
                </Button>
                <Button variant="danger" onClick={onDelete}>
                  {games === null
                    ? `Delete “${label}”`
                    : `Delete “${label}” (${games.length} games stay in your library)`}
                </Button>
              </>
            ) : (
              <IconButton
                onClick={() => setConfirmingDelete(true)}
                title="Remove collection"
                ariaLabel="Remove collection"
              >
                <FaTrash size={13} />
              </IconButton>
            )}
            {onAddGames && !editing ? (
              <IconButton onClick={onAddGames} title="Add games" ariaLabel="Add games">
                <FaPlus size={13} />
              </IconButton>
            ) : null}
            {editing ? null : (
              <IconButton onClick={onOptions} title="Options" ariaLabel="Options">
                <FaGear size={13} />
              </IconButton>
            )}
            <IconButton onClick={back} title="Back" ariaLabel="Back">
              <FaChevronLeft size={13} />
            </IconButton>
          </div>
        </div>
      </PluginHeader>

      {/* Named rather than hidden. These entries are why a collection can read
          as 221 games here and 16 in Steam, and silently dropping them would
          leave that discrepancy with no explanation at all. */}
      {staleCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Text variant="secondary">
            {staleCount} more {staleCount === 1 ? "entry" : "entries"} in this collection point at
            shortcuts Steam no longer has — usually left behind when a ROM manager re-added them
            under new ids. Steam ignores them; they only take up room.
          </Text>
          {onCleanUp ? (
            confirmingCleanUp ? (
              <>
                <Button variant="neutral" onClick={() => setConfirmingCleanUp(false)}>
                  Leave them
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setConfirmingCleanUp(false);
                    onCleanUp();
                  }}
                >
                  Remove {staleCount}
                </Button>
              </>
            ) : (
              <Button variant="neutral" onClick={() => setConfirmingCleanUp(true)}>
                Clean up
              </Button>
            )
          ) : null}
        </div>
      ) : null}

      {games === null ? (
        <div className="flex items-center justify-center" style={{ padding: "4rem 0" }}>
          <Spinner />
        </div>
      ) : shown !== null && shown.length === 0 && games.length > 0 ? (
        <Text variant="secondary">No game in this collection matches “{filter.trim()}”.</Text>
      ) : games.length === 0 ? (
        // An empty collection is a legitimate state, not an error — a new one
        // starts here, and seeing it empty is the preview doing its job.
        <div className="flex flex-col items-start gap-2">
          <Text variant="secondary">
            Nothing in this collection yet. It will show up empty in Steam too.
          </Text>
          {/* The header's + is a small target to find when the page is
              otherwise blank, and an empty collection is exactly when you want
              to add something. */}
          {onAddGames ? (
            <Button variant="neutral" onClick={onAddGames}>
              Add games
            </Button>
          ) : null}
        </div>
      ) : (
        <div ref={listRef} style={{ flexShrink: 0 }}>
          <div style={{ height: rowWindow.padTop, flexShrink: 0 }} />
          <div ref={gridWrapperRef} style={{ flexShrink: 0 }}>
            <GameCardGrid minTileWidth={150}>
              {(shown ?? []).slice(rowWindow.start, rowWindow.end).map((g) => (
                <GameCard
                  key={g.appId}
                  imageUrl={artUrl(g.appId, "capsule")}
                  fallbackImageUrl={artUrl(g.appId, "header")}
                  title={g.name}
                  // Out of edit mode the tile opens the game, as it always
                  // has. In it, the tile picks — the same gesture as adding,
                  // so both halves of curating a collection behave alike.
                  onPick={() =>
                    editing
                      ? setSelected((prev) =>
                          prev.includes(g.appId)
                            ? prev.filter((x) => x !== g.appId)
                            : [...prev, g.appId],
                        )
                      : onPickGame(g.appId)
                  }
                  action={
                    editing ? (
                      <Button
                        variant={selectedSet.has(g.appId) ? "primary" : "neutral"}
                        size="sm"
                        onClick={() =>
                          setSelected((prev) =>
                            prev.includes(g.appId)
                              ? prev.filter((x) => x !== g.appId)
                              : [...prev, g.appId],
                          )
                        }
                      >
                        {selectedSet.has(g.appId) ? "Picked" : "Select"}
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </GameCardGrid>
          </div>
          <div style={{ height: rowWindow.padBottom, flexShrink: 0 }} />
        </div>
      )}
    </div>
  );
}
