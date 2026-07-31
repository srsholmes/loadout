/**
 * Add games to a collection Steam already owns.
 *
 * The other half of the linked-collection story: removing a game has worked
 * from the detail grid for a while, but there was no way to put one back, so
 * an accidental Remove was permanent as far as this plugin was concerned.
 *
 * **Search-first, not scroll-first.** The dev device holds 2501 games, and a
 * picker you have to scroll through with a thumbstick is not a picker. The
 * list starts empty with a prompt, fills in as you type, and caps what it
 * renders — a search matching 900 games is a search that needs refining, not
 * 900 rows to mount. The cap is stated rather than silent, because a list that
 * quietly stops short is how you conclude a game isn't in your library.
 *
 * Selections accumulate, so several games go in on one write: each confirm is
 * a Steam Cloud round trip, and doing one per game turns adding five games
 * into five chances to fail halfway.
 */

import { useMemo, useState } from "react";
import { Button, SearchField, Text, useFocusable } from "@loadout/ui";
import { BuilderPage } from "./BuilderPage";

/** Rows rendered at once. Enough to browse, few enough to stay instant. */
const MAX_ROWS = 40;

export interface AddGamesPageProps {
  /** The collection being added to — named in the header. */
  label: string;
  /** Everything in the library, already excluding current members. */
  candidates: ReadonlyArray<{ appId: string; name: string }>;
  onBack: () => void;
  onAdd: (appIds: string[]) => void;
}

export function AddGamesPage({ label, candidates, onBack, onAdd }: AddGamesPageProps) {
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<ReadonlyArray<{ appId: string; name: string }>>([]);

  const chosenIds = useMemo(() => new Set(chosen.map((g) => g.appId)), [chosen]);

  const { rows, total } = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length === 0) return { rows: [], total: 0 };
    const hits = candidates.filter((g) => g.name.toLowerCase().includes(q));
    return { rows: hits.slice(0, MAX_ROWS), total: hits.length };
  }, [candidates, search]);

  const toggle = (game: { appId: string; name: string }) =>
    setChosen((prev) =>
      prev.some((g) => g.appId === game.appId)
        ? prev.filter((g) => g.appId !== game.appId)
        : [...prev, game],
    );

  return (
    <BuilderPage
      title={label}
      description={
        chosen.length === 0
          ? "Search your library and pick what to add."
          : `${chosen.length} to add — search for more, or add them now.`
      }
      onBack={onBack}
      backLabel="Cancel"
      footer={
        <Button variant="primary" disabled={chosen.length === 0} onClick={() => onAdd(chosen.map((g) => g.appId))}>
          {chosen.length === 0
            ? "Add"
            : `Add ${chosen.length} game${chosen.length === 1 ? "" : "s"}`}
        </Button>
      }
    >
      <SearchField
        value={search}
        onChange={setSearch}
        onClear={() => setSearch("")}
        placeholder="Search your library…"
        width="100%"
      />

      {/* Chosen games stay visible while you keep searching — otherwise the
          only record of what you picked is a number in the header, and a
          mis-tap is invisible until after the write. */}
      {chosen.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((g) => (
            <PickedChip key={g.appId} name={g.name} onRemove={() => toggle(g)} />
          ))}
        </div>
      ) : null}

      {search.trim().length === 0 ? (
        <Text variant="secondary">
          {candidates.length === 0
            ? "Every game in your library is already in this collection."
            : `Type to search ${candidates.length} games that aren't in it yet.`}
        </Text>
      ) : rows.length === 0 ? (
        <Text variant="secondary">
          Nothing matches “{search.trim()}”. It may already be in this collection.
        </Text>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((g) => (
            <GameRow
              key={g.appId}
              name={g.name}
              picked={chosenIds.has(g.appId)}
              onToggle={() => toggle(g)}
            />
          ))}
          {total > rows.length ? (
            <Text variant="secondary">
              Showing {rows.length} of {total} matches — keep typing to narrow it down.
            </Text>
          ) : null}
        </div>
      )}
    </BuilderPage>
  );
}

/**
 * One candidate. `useFocusable` rather than a bare `<button>` — the D-pad
 * cannot see a raw button, so on a controller the list would be unreachable.
 */
function GameRow({
  name,
  picked,
  onToggle,
}: {
  name: string;
  picked: boolean;
  onToggle: () => void;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onToggle });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      className={`flex items-center justify-between gap-3 text-left rounded-lg px-3 py-2 border ${
        focused ? "border-primary/60 bg-base-200" : "border-base-300"
      }`}
    >
      <span className="text-sm truncate">{name}</span>
      <span className="text-[11.5px] text-base-content/70 shrink-0">
        {picked ? "Picked" : "Add"}
      </span>
    </button>
  );
}

function PickedChip({ name, onRemove }: { name: string; onRemove: () => void }) {
  const { ref, focused } = useFocusable({ onEnterPress: onRemove });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onRemove}
      aria-label={`Don't add ${name}`}
      className={`text-[11.5px] rounded-full px-2.5 py-1 border ${
        focused ? "border-primary/60 bg-base-200" : "border-base-300"
      }`}
    >
      {name} ✕
    </button>
  );
}
