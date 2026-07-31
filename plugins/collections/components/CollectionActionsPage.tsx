/**
 * Everything you can do to a collection that isn't editing its rules.
 *
 * Back lives in the shell's topbar, which `BuilderPage` renders for every
 * sub-page. In the body it scrolled away with the content — on a long page the
 * only way out ended up off-screen.
 *
 * A page rather than a dialog. Loadout is already an overlay over Steam, so a
 * modal here is a modal on top of a modal — and in desktop mode, where the
 * overlay is an ordinary window, a centred sheet with its own scrim reads as a
 * bug. `BuilderPage` gives it the plugin's own scroll box, B/Escape to pop one
 * level, and focus landing on the content rather than on "leave".
 *
 * The two kinds diverge here, and the page says why rather than hiding the
 * controls. A linked collection has no rules to edit; a managed one cannot
 * have games removed by hand, because the next sync would put them straight
 * back. Withholding a control silently is what makes a UI feel broken.
 */

import { useState } from "react";
import { Button, Text, TextInput } from "@loadout/ui";
import { BuilderPage } from "./BuilderPage";

export interface CollectionActionsPageProps {
  label: string;
  kind: "managed" | "linked";
  count: number;
  /** Steam recomputes a dynamic collection, so its contents are not ours. */
  autoMaintained: boolean;
  onBack: () => void;
  onRename: (label: string) => void;
  onDelete: () => void;
}

export function CollectionActionsPage({
  label,
  kind,
  count,
  autoMaintained,
  onBack,
  onRename,
  onDelete,
}: CollectionActionsPageProps) {
  const [name, setName] = useState(label);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const renamed = name.trim().length > 0 && name.trim() !== label;
  const isLinked = kind === "linked";

  return (
    <BuilderPage
      title={label}
      description={
        isLinked
          ? autoMaintained
            ? "A Steam collection. Steam decides what's in it."
            : "A collection that already existed in Steam."
          : `Built from rules · ${count} games`
      }
      onBack={onBack}
    >
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <Text variant="secondary">Name</Text>
          <div className="flex gap-2">
            <TextInput
              value={name}
              onChange={setName}
              placeholder="Collection name"
              // Typing a name and pressing Enter is what everyone does, more so
              // on a handheld where the on-screen keyboard's confirm is right
              // there and a separate button is easy to miss.
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !renamed) return;
                event.preventDefault();
                onRename(name.trim());
              }}
            />
            <Button variant="primary" disabled={!renamed} onClick={() => onRename(name.trim())}>
              Rename
            </Button>
          </div>
          {!isLinked ? (
            <Text variant="secondary">
              This is the name Steam uses too — it follows on the next sync.
            </Text>
          ) : null}
        </section>

        <section className="flex flex-col gap-2">
          <Text variant="secondary">Contents</Text>
          {isLinked ? (
            <Text variant="secondary">
              {autoMaintained
                ? "Steam works this one out from a filter, so its games can't be set here."
                : "Open the collection to add or remove games."}
            </Text>
          ) : (
            <Text variant="secondary">
              Rules decide what&apos;s in this one, and they re-run on every sync — a
              game that stops matching will leave it.
            </Text>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <Text variant="secondary">Delete</Text>
          {confirmingDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <Text variant="secondary">
                {isLinked
                  ? `Delete “${label}” from Steam? ${count} games stay in your library, but the collection is gone.`
                  : `Delete “${label}”? Its rules are not recoverable.`}
              </Text>
              <Button variant="neutral" onClick={() => setConfirmingDelete(false)}>
                Keep it
              </Button>
              {/* Two steps, not a typed confirmation: this destroys one
                  collection, not the user's whole library. But it *is* a real
                  Steam collection for the linked case — possibly one another
                  tool spent a long time generating — so it never happens on a
                  single press. */}
              <Button variant="danger" onClick={onDelete}>
                Delete
              </Button>
            </div>
          ) : (
            <Button variant="neutral" onClick={() => setConfirmingDelete(true)}>
              Delete this collection
            </Button>
          )}
        </section>
      </div>
    </BuilderPage>
  );
}
