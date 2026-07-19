import { useMemo, useState } from "react";
import { FaCheck } from "react-icons/fa6";
import {
  Button,
  fuzzySearchGames,
  friendlyCollectionName,
  GameCard,
  GameCardGrid,
  SearchField,
  Select,
  type SelectOption,
} from "@loadout/ui";
import type { GameCollection, GameInfo } from "@loadout/types";
import { Modal } from "./shared";

const ALL_GAMES = "__all__";
const STEAM_ONLY = "__steam__";
const SHORTCUT_ONLY = "__shortcut__";

/**
 * Full-library multi-select picker. Reused for building a tab's
 * hand-picked whitelist and for adding games to the backlog. Mirrors the
 * SteamGridDB / LSFG-VK picker: fuzzy search + a source/collection filter
 * dropdown over the `__core:game-library` list.
 */
export function GamePicker({
  library,
  collections,
  initialSelected = [],
  title,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  library: GameInfo[];
  collections: GameCollection[];
  initialSelected?: string[];
  title: string;
  confirmLabel: string;
  onConfirm: (appIds: string[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected),
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>(ALL_GAMES);

  const filterOptions = useMemo<SelectOption<string>[]>(() => {
    const total = library.length;
    const steam = library.filter((g) => g.source === "steam").length;
    const shortcut = library.filter((g) => g.source === "shortcut").length;
    const opts: SelectOption<string>[] = [
      { value: ALL_GAMES, label: `All games${total ? ` (${total})` : ""}` },
      { value: STEAM_ONLY, label: `Steam only (${steam})` },
    ];
    if (shortcut > 0) {
      opts.push({ value: SHORTCUT_ONLY, label: `Non-Steam only (${shortcut})` });
    }
    for (const c of collections) {
      opts.push({ value: c.id, label: `${friendlyCollectionName(c.id)} (${c.count})` });
    }
    return opts;
  }, [library, collections]);

  const shown = useMemo(() => {
    let list = library;
    if (filter === STEAM_ONLY) list = list.filter((g) => g.source === "steam");
    else if (filter === SHORTCUT_ONLY)
      list = list.filter((g) => g.source === "shortcut");
    else if (filter !== ALL_GAMES)
      list = list.filter((g) => g.tags?.includes(filter));
    return fuzzySearchGames(list, query);
  }, [library, filter, query]);

  const toggle = (appId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });
  };

  const addedCount = selected.size - initialSelected.length;
  const confirmText =
    addedCount > 0
      ? `${confirmLabel} (${selected.size})`
      : `${confirmLabel} (${selected.size})`;

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="neutral" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(Array.from(selected))}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2 mb-4">
        <SearchField
          value={query}
          onChange={setQuery}
          onClear={() => setQuery("")}
        />
        <div style={{ minWidth: 190 }}>
          <Select value={filter} onChange={setFilter} options={filterOptions} />
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="text-center py-10 text-[var(--fg-3)]">
          No games match the current search / filter.
        </div>
      ) : (
        <GameCardGrid minTileWidth={130}>
          {shown.map((game) => {
            const isSel = selected.has(game.appId);
            return (
              <GameCard
                key={game.appId}
                imageUrl={game.capsuleUrl}
                fallbackImageUrl={game.headerUrl}
                title={game.name}
                highlighted={isSel}
                collections={game.tags}
                topRightBadge={
                  isSel ? (
                    <span className="chip chip-accent flex items-center gap-1">
                      <FaCheck size={9} />
                    </span>
                  ) : undefined
                }
                onPick={() => toggle(game.appId)}
              />
            );
          })}
        </GameCardGrid>
      )}
    </Modal>
  );
}
