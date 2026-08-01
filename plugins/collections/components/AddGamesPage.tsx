/**
 * Add games to a collection Steam already owns.
 *
 * The other half of the linked-collection story: removing a game has worked
 * from the detail grid for a while, but there was no way to put one back, so
 * an accidental Remove was permanent as far as this plugin was concerned.
 *
 * **Everything is on screen from the start**, alphabetically, as the same
 * cards the rest of the plugin uses — installed and not alike. A search box
 * you have to type into first only works if you already know what you are
 * looking for, and browsing is most of what adding to a collection *is*. The
 * filter narrows what is shown; it is not the way in.
 *
 * Windowed with the same machinery as the collection grid, because "all of
 * them" is 2501 cards on the dev device and mounting that many stalls CEF on
 * a handheld. See `lib/windowing.ts`; the spacer arithmetic is explained in
 * `CollectionDetail`.
 *
 * Selections accumulate, so several games go in on one write: each confirm is
 * a Steam Cloud round trip, and doing one per game turns adding five games
 * into five chances to fail halfway.
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
import { FaChevronLeft } from "react-icons/fa6";
import { useVisibleRows } from "../hooks/useVisibleRows";

export interface AddGamesCandidate {
  appId: string;
  name: string;
  /** Drives the "Installed" note, so the list doesn't hide where a game is. */
  installed?: boolean;
}

export interface AddGamesPageProps {
  /** The collection being added to — named in the header. */
  label: string;
  /** Everything in the library, already excluding current members. */
  candidates: readonly AddGamesCandidate[];
  /**
   * Whether the library snapshot has arrived.
   *
   * Without it, a snapshot that failed or hadn't landed produced an empty
   * candidate list and the page said "every game in your library is already in
   * this collection" — a confident, false statement about the user's library,
   * dressed as an ordinary empty state.
   */
  libraryLoaded?: boolean;
  onBack: () => void;
  onAdd: (appIds: string[]) => void;
}

const artUrl = (appId: string, kind: "capsule" | "header") =>
  `http://localhost:33820/api/steam-grid/${appId}/${kind}`;

export function AddGamesPage({
  label,
  candidates,
  libraryLoaded = true,
  onBack,
  onAdd,
}: AddGamesPageProps) {
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>([]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridWrapperRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const chosenSet = useMemo(() => new Set(chosen), [chosen]);

  // B on a controller cancels the picker rather than leaving the plugin, the
  // same as every other sub-page here.
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

  // Sorted once per library, then filtered — `localeCompare` over 2500 names
  // on every keystroke is the one thing here worth not repeating.
  const sorted = useMemo(
    () => [...candidates].sort((a, b) => a.name.localeCompare(b.name)),
    [candidates],
  );
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? sorted.filter((g) => g.name.toLowerCase().includes(q)) : sorted;
  }, [sorted, filter]);

  const rowWindow = useVisibleRows({
    total: shown.length,
    gridWrapperRef,
    listRef,
    scrollRef,
  });

  const toggle = (appId: string) =>
    setChosen((prev) =>
      prev.includes(appId) ? prev.filter((x) => x !== appId) : [...prev, appId],
    );

  return (
    <div
      ref={scrollRef}
      className="p-7 h-full overflow-y-auto flex flex-col gap-3"
      style={{ overflowX: "hidden", position: "relative" }}
    >
      <PluginHeader>
        <div className="flex items-center justify-between gap-4 w-full min-w-0">
          <div className="flex flex-col gap-0.5 min-w-0">
            <h1 className="text-xl font-semibold m-0 leading-tight truncate">Add to {label}</h1>
            <span className="text-[11.5px] text-base-content/55 truncate leading-tight">
              {chosen.length === 0
                ? `${shown.length} of ${candidates.length} games not in it yet`
                : `${chosen.length} picked · ${shown.length} shown`}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <SearchField
              value={filter}
              onChange={setFilter}
              onClear={() => setFilter("")}
              placeholder="Filter…"
              width={200}
            />
            <Button
              variant="primary"
              disabled={chosen.length === 0}
              onClick={() => onAdd([...chosen])}
            >
              {chosen.length === 0
                ? "Add"
                : `Add ${chosen.length} game${chosen.length === 1 ? "" : "s"}`}
            </Button>
            <IconButton onClick={back} title="Cancel" ariaLabel="Cancel">
              <FaChevronLeft size={13} />
            </IconButton>
          </div>
        </div>
      </PluginHeader>

      {!libraryLoaded ? (
        <div className="flex items-center gap-2">
          <Spinner size={16} />
          <Text variant="secondary">Reading your library…</Text>
        </div>
      ) : candidates.length === 0 ? (
        <Text variant="secondary">
          Every game in your library is already in this collection.
        </Text>
      ) : shown.length === 0 ? (
        <Text variant="secondary">
          Nothing matches “{filter.trim()}”. It may already be in this collection.
        </Text>
      ) : (
        <div ref={listRef} style={{ flexShrink: 0 }}>
          <div style={{ height: rowWindow.padTop, flexShrink: 0 }} />
          <div ref={gridWrapperRef} style={{ flexShrink: 0 }}>
            <GameCardGrid minTileWidth={150}>
              {shown.slice(rowWindow.start, rowWindow.end).map((g) => (
                <GameCard
                  key={g.appId}
                  imageUrl={artUrl(g.appId, "capsule")}
                  fallbackImageUrl={artUrl(g.appId, "header")}
                  title={g.name}
                  subtitle={g.installed ? "Installed" : undefined}
                  // The card itself picks it. Adding is the only thing this
                  // page does, so making the tile inert and the small button
                  // the only target would be a needless second press.
                  onPick={() => toggle(g.appId)}
                  action={
                    <Button
                      variant={chosenSet.has(g.appId) ? "primary" : "neutral"}
                      size="sm"
                      onClick={() => toggle(g.appId)}
                    >
                      {chosenSet.has(g.appId) ? "Picked" : "Add"}
                    </Button>
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
