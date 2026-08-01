/**
 * Starting a new collection: pick a preset, or name your own.
 *
 * Presets lead, and that ordering is the point. An empty rule tree matches the
 * whole library, so "New" on its own used to hand you a collection of
 * everything and leave the interesting part as homework — and naming it meant
 * opening the on-screen keyboard and picking out letters with a thumbstick.
 * A preset arrives named, ruled and priced, so the whole flow is two presses
 * and no typing.
 *
 * Every preset carries the count it would produce **before** you commit to it,
 * from the same local evaluation the rule builder uses. That is what stops the
 * gallery offering a dozen collections that turn out to be empty on this
 * particular library — the ones that match nothing say so, in place.
 *
 * A page, not a prompt — the same reasoning as everywhere else here: an
 * overlay over Steam has no business opening a modal on top of itself.
 */

import { useEffect, useMemo, useState } from "react";
import { Button, Spinner, Text, TextInput, useFocusable } from "@loadout/ui";
import { BuilderPage } from "./BuilderPage";
import { evaluateCollection } from "../lib/evaluate";
import { NEED_LABELS, metadataNeedsMet, presets, unmetNeeds } from "../lib/presets";
import type { CollectionPreset, GameFacts } from "../lib/presets";
import type { EvalGame, FactKey } from "../lib/types";

export interface NewCollectionPageProps {
  /** Names already taken, so a clash is caught before Steam sees it. */
  existingNames: readonly string[];
  /** The library, for pricing each preset. Empty until the snapshot lands. */
  games: readonly EvalGame[];
  /**
   * Whether the library snapshot has arrived.
   *
   * Until it has, `metadataNeedsMet` sees nothing and every preset that reads
   * anything is greyed out with "Needs play history" — blaming the user's
   * library for an outage of ours, and leaving the D-pad nothing to reach.
   */
  libraryLoaded?: boolean;
  /** Facts a resolver can supply — decides whether HowLongToBeat is offered. */
  availableFacts?: ReadonlySet<FactKey>;
  onBack: () => void;
  /** Build from a preset: named, ruled, and ready to look at. */
  onPickPreset: (preset: CollectionPreset) => void;
  /** Start from scratch under a name of your own. */
  onCreate: (label: string) => void;
  /**
   * A create attempt has finished and failed, so the page unlocks.
   *
   * Without it the page stays locked on a lie: the spinner keeps spinning and
   * the header keeps saying it is building something that isn't happening,
   * with every preset disabled and no way back except leaving.
   */
  failedAt?: number;
  /** Injected for deterministic dates in specs. */
  now?: number;
}

interface PricedPreset {
  preset: CollectionPreset;
  /** `null` when the library can't answer what this preset asks. */
  count: number | null;
  /** Sources it needs that are missing, already in prose. */
  missing: string[];
}

export function NewCollectionPage({
  existingNames,
  games,
  libraryLoaded = true,
  availableFacts,
  onBack,
  onPickPreset,
  onCreate,
  failedAt,
  now,
}: NewCollectionPageProps) {
  const [name, setName] = useState("");
  /**
   * A preset has been picked and the collection is being made.
   *
   * Locks the whole gallery, because creating one takes a beat — reading the
   * library, writing the rules, opening the result — and a press that shows no
   * sign of having registered gets pressed again. That is how five identical
   * collections got made.
   */
  const [picked, setPicked] = useState<string | null>(null);
  /** The from-scratch Create has been pressed. Same beat, same lock. */
  const [creating, setCreating] = useState(false);

  // The parent bumps `failedAt` when an attempt comes back an error; it stays
  // on this page, so the lock has to lift here.
  useEffect(() => {
    if (failedAt === undefined) return;
    setPicked(null);
    setCreating(false);
  }, [failedAt]);

  /** Something is being built: the page is inert until it lands. */
  const busy = picked !== null || creating;

  const priced = useMemo<PricedPreset[]>(() => {
    const nowSec = now ?? Math.floor(Date.now() / 1000);
    const met = metadataNeedsMet(
      games.map((g) => g.meta as GameFacts),
      availableFacts,
    );
    return presets(nowSec).map((preset) => {
      const missing = unmetNeeds(preset, met).map((n) => NEED_LABELS[n]);
      if (missing.length > 0) return { preset, count: null, missing };
      const count = evaluateCollection(preset.build(preset.id), games, {
        now: nowSec * 1000,
      }).matched.length;
      return { preset, count, missing };
    });
  }, [games, availableFacts, now]);

  const trimmed = name.trim();
  /** What is being built, for the header to name while it happens. */
  const busyLabel =
    picked === null ? trimmed : (priced.find((p) => p.preset.id === picked)?.preset.label ?? "");
  // Case-insensitive: Steam's sidebar shows "Backlog" and "backlog" as two
  // entries that look identical, which is nobody's intent.
  const taken = (label: string) =>
    existingNames.some((n) => n.toLowerCase() === label.toLowerCase());
  const clash = trimmed.length > 0 && taken(trimmed);
  const ready = trimmed.length > 0 && !clash;

  return (
    <BuilderPage
      // The header echoes the name as you type it, so the thing Steam will
      // show is on screen in the place it will appear, rather than only in the
      // field you are typing into.
      title={trimmed.length > 0 ? trimmed : "New collection"}
      description={
        busy
          ? `Building “${busyLabel}” — reading your library and writing the rules.`
          : "Name one of your own, or start from a preset."
      }
      onBack={onBack}
      backLabel="Cancel"
      busy={busy}
    >
      <section className="flex flex-col gap-2">
        <Text variant="secondary">Name your own</Text>
        <div className="flex gap-2">
          <TextInput
            value={name}
            onChange={setName}
            placeholder="e.g. Backlog, Short games, Couch co-op"
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !ready || busy) return;
              event.preventDefault();
              setCreating(true);
              onCreate(trimmed);
            }}
          />
          <Button
            variant="primary"
            disabled={!ready || busy}
            onClick={() => {
              setCreating(true);
              onCreate(trimmed);
            }}
          >
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
        {clash ? (
          <Text variant="secondary">
            You already have a collection called “{trimmed}”. Pick another name.
          </Text>
        ) : trimmed.length === 0 ? (
          // Create stays disabled until there is a name, and a button that does
          // nothing when pressed is indistinguishable from a broken one — more
          // so on a handheld, where getting at a keyboard is a deliberate act.
          <Text variant="secondary">
            Type a name to enable Create — the keyboard button is in the footer. Or pick a preset
            above and skip the typing entirely.
          </Text>
        ) : (
          <Text variant="secondary">
            It starts out matching your whole library; rules narrow it down.
          </Text>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-base-300 pt-3">
        <Text variant="secondary">Or start from a preset</Text>
        {!libraryLoaded ? (
          <div className="flex items-center gap-2">
            <Spinner size={16} />
            <Text variant="secondary">
              Reading your library — presets are priced against it, so they arrive in a moment.
            </Text>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          {priced.map((p) => (
            <PresetRow
              key={p.preset.id}
              priced={p}
              libraryLoaded={libraryLoaded}
              alreadyExists={taken(p.preset.label)}
              busy={picked === p.preset.id}
              locked={busy}
              onPick={() => {
                setPicked(p.preset.id);
                onPickPreset(p.preset);
              }}
            />
          ))}
        </div>
      </section>
    </BuilderPage>
  );
}

/**
 * One preset. A `useFocusable` wrapper rather than a bare `<button>` — the
 * D-pad cannot see a raw button, so on a controller the gallery would be
 * unreachable.
 */
function PresetRow({
  priced,
  libraryLoaded,
  alreadyExists,
  busy,
  locked,
  onPick,
}: {
  priced: PricedPreset;
  /** False while the snapshot is still coming; nothing is priced yet. */
  libraryLoaded: boolean;
  alreadyExists: boolean;
  /** This is the one being made. */
  busy: boolean;
  /** Some preset is being made — one at a time. */
  locked: boolean;
  onPick: () => void;
}) {
  const { preset, count, missing } = priced;
  // While the library is still arriving nothing can be priced, and "Needs play
  // history" would be blaming the user for our own outage.
  const unavailable = libraryLoaded && missing.length > 0;
  // A preset that cannot work here, or that duplicates a collection you
  // already have, is still shown — with the reason. Dropping it silently
  // invites the question of where it went.
  const blocked = !libraryLoaded || unavailable || alreadyExists || locked;
  // `focusable: !blocked` matters as much as the disabled attribute: a
  // disabled control left in the focus tree is one the D-pad stops on and A
  // does nothing to, which reads as the plugin having hung.
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      if (!blocked) onPick();
    },
    focusable: !blocked,
  });

  const note = busy
    ? "Building it…"
    : !libraryLoaded
      ? "…"
      : unavailable
      ? `Needs ${missing.join(" and ")}`
      : alreadyExists
        ? "You have this one"
        : count === 0
          ? "Nothing matches — yet"
          : `→ ${count} game${count === 1 ? "" : "s"}`;

  return (
    <button
      ref={ref}
      type="button"
      disabled={blocked}
      onClick={onPick}
      className={`flex items-center justify-between gap-3 text-left rounded-lg px-3 py-2 border ${
        focused ? "border-primary/60 bg-base-200" : "border-base-300"
      }`}
      style={{ opacity: blocked ? 0.55 : 1 }}
    >
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium truncate">{preset.label}</span>
        <span className="text-[11.5px] text-base-content/55 truncate">{preset.description}</span>
      </span>
      <span className="text-[11.5px] text-base-content/70 shrink-0">{note}</span>
    </button>
  );
}
