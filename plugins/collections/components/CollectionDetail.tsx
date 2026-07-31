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

import { useRef, useState } from "react";
import {
  Button,
  GameCard,
  GameCardGrid,
  IconButton,
  PluginHeader,
  Spinner,
  Text,
} from "@loadout/ui";
import { FaChevronLeft, FaGear, FaPlus, FaTrash, FaXmark } from "react-icons/fa6";
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
   * Add games by hand. Offered on the same terms as {@link onRemoveGame}: a
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
   * Drop one game. Offered only for a linked, non-dynamic collection: a
   * managed one would get the game straight back on the next sync, and Steam
   * recomputes a dynamic one.
   */
  onRemoveGame?: (appId: string) => void;
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
  onRemoveGame,
}: CollectionDetailProps) {
  /** The bin has been pressed and is showing what it would do. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingCleanUp, setConfirmingCleanUp] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridWrapperRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const rowWindow = useVisibleRows({
    total: games?.length ?? 0,
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
              {games === null ? "Loading…" : `${games.length} games`}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* A bin icon alone is one press away from destroying a collection
                somebody else's tool may have spent a long time generating, and
                an icon cannot say what it is about to delete. Pressing it
                spells the consequence out as a red button instead — the second
                press is the one that acts. */}
            {confirmingDelete ? (
              <>
                <Button variant="danger" onClick={onDelete}>
                  Remove collection
                </Button>
                <IconButton
                  onClick={() => setConfirmingDelete(false)}
                  title="Keep it"
                  ariaLabel="Keep it"
                  size={26}
                >
                  <FaXmark size={11} />
                </IconButton>
              </>
            ) : (
              <IconButton
                onClick={() => setConfirmingDelete(true)}
                title="Remove collection"
                ariaLabel="Remove collection"
                size={26}
              >
                <FaTrash size={11} />
              </IconButton>
            )}
            {onAddGames ? (
              <IconButton onClick={onAddGames} title="Add games" ariaLabel="Add games" size={26}>
                <FaPlus size={11} />
              </IconButton>
            ) : null}
            <IconButton onClick={onOptions} title="Options" ariaLabel="Options" size={26}>
              <FaGear size={11} />
            </IconButton>
            <IconButton onClick={onBack} title="Back" ariaLabel="Back" size={26}>
              <FaChevronLeft size={11} />
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
              {games.slice(rowWindow.start, rowWindow.end).map((g) => (
                <GameCard
                  key={g.appId}
                  imageUrl={artUrl(g.appId, "capsule")}
                  fallbackImageUrl={artUrl(g.appId, "header")}
                  title={g.name}
                  onPick={() => onPickGame(g.appId)}
                  action={
                    onRemoveGame ? (
                      <Button variant="neutral" size="sm" onClick={() => onRemoveGame(g.appId)}>
                        Remove
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
