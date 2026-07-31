/**
 * Name a collection before building it.
 *
 * The first step of a two-step flow, and the reason it exists: "New" used to
 * create *"New collection"* and drop you straight into the rule builder, so
 * the name was something you discovered you had to fix afterwards, from a
 * different screen. The name is also what Steam shows, which makes it the one
 * decision worth taking first.
 *
 * A page, not a prompt — the same reasoning as everywhere else here: an
 * overlay over Steam has no business opening a modal on top of itself.
 */

import { useState } from "react";
import { Button, Text, TextInput } from "@loadout/ui";
import { BuilderPage } from "./BuilderPage";

export interface NewCollectionPageProps {
  /** Names already taken, so a clash is caught before Steam sees it. */
  existingNames: readonly string[];
  onBack: () => void;
  onCreate: (label: string) => void;
}

export function NewCollectionPage({ existingNames, onBack, onCreate }: NewCollectionPageProps) {
  const [name, setName] = useState("");

  const trimmed = name.trim();
  // Case-insensitive: Steam's sidebar shows "Backlog" and "backlog" as two
  // entries that look identical, which is nobody's intent.
  const clash = existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const ready = trimmed.length > 0 && !clash;

  return (
    <BuilderPage
      // The header echoes the name as you type it, so the thing Steam will
      // show is on screen in the place it will appear, rather than only in the
      // field you are typing into.
      title={trimmed.length > 0 ? trimmed : "New collection"}
      description="Name it first — this is the name Steam will show too."
      onBack={onBack}
      backLabel="Cancel"
      footer={
        <Button variant="primary" disabled={!ready} onClick={() => onCreate(trimmed)}>
          Create
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <TextInput
          value={name}
          onChange={setName}
          placeholder="e.g. Backlog, Short games, Couch co-op"
          autoFocus
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !ready) return;
            event.preventDefault();
            onCreate(trimmed);
          }}
        />
        {clash ? (
          <Text variant="secondary">
            You already have a collection called “{trimmed}”. Pick another name.
          </Text>
        ) : (
          <Text variant="secondary">
            You&apos;ll choose which games it holds next.
          </Text>
        )}
      </div>
    </BuilderPage>
  );
}
