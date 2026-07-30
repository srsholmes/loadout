/**
 * Everything you can do to a tab that isn't editing its rules.
 *
 * The backend has had `deleteTab`, `reorderTabs` and `setTabs` since its first
 * commit, fully tested, with **no caller anywhere in the UI**. So a tab could
 * be created and never renamed, reordered, hidden or removed — and the only
 * visible affordance, "Edit rules", was hidden on builtin tabs, which made the
 * whole surface look absent rather than restricted.
 *
 * This is that surface. Built-ins keep their protections — their rules are
 * ours and they cannot be deleted — but they can still be hidden and moved,
 * and the page says why the other actions are unavailable rather than simply
 * omitting them.
 */

import { useState } from "react";
import { Button, Text, TextInput } from "@loadout/ui";
import { BuilderPage } from "./BuilderPage";
import type { Tab } from "../lib/types";

export interface TabActionsPageProps {
  tab: Tab;
  /** Position in the strip, for the move controls. */
  index: number;
  tabCount: number;
  onBack: () => void;
  onRename: (label: string) => void;
  onToggleVisible: () => void;
  onMove: (delta: number) => void;
  onEditRules: () => void;
  onDelete: () => void;
  onToggleMirror: () => void;
  /** Opens the sync screen. Absent when there is nothing to sync yet. */
  onOpenMirror?: () => void;
}

export function TabActionsPage({
  tab,
  index,
  tabCount,
  onBack,
  onRename,
  onToggleVisible,
  onMove,
  onEditRules,
  onDelete,
  onToggleMirror,
  onOpenMirror,
}: TabActionsPageProps) {
  const [label, setLabel] = useState(tab.label);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isBuiltin = tab.builtin !== undefined;
  const renamed = label.trim().length > 0 && label !== tab.label;

  return (
    <BuilderPage
      title={tab.label}
      description={isBuiltin ? "A built-in tab" : "Your tab"}
      onBack={onBack}
    >
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <Text variant="secondary">Name</Text>
          <div className="flex gap-2">
            <TextInput
              value={label}
              onChange={setLabel}
              placeholder="Tab name"
              // Typing a name and pressing Enter is what everyone does — more
              // so on a handheld, where the on-screen keyboard's confirm is
              // right there and the separate Rename button is easy to miss.
              // Without this the rename silently did nothing.
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !renamed) return;
                event.preventDefault();
                onRename(label.trim());
              }}
            />
            <Button
              variant="primary"
              disabled={!renamed}
              onClick={() => onRename(label.trim())}
            >
              Rename
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <Text variant="secondary">Rules</Text>
          {isBuiltin ? (
            <Text variant="secondary">
              Built-in tabs use rules we maintain, so they can&apos;t be edited —
              but you can hide this tab, or make your own from a template.
            </Text>
          ) : (
            <Button variant="neutral" onClick={onEditRules}>
              Edit rules
            </Button>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <Text variant="secondary">Show in Steam</Text>
          <Text variant="secondary">
            {tab.mirror.enabled
              ? `This tab is kept in a Steam collection called “${
                  tab.mirror.collectionName.trim() || tab.label
                }”, so it shows up in Steam's own library too.`
              : "Copy this tab into a Steam collection, so it shows up in Steam's own library as well as here."}
          </Text>
          <div className="flex flex-wrap gap-2">
            <Button variant="neutral" onClick={onToggleMirror}>
              {tab.mirror.enabled ? "Stop showing in Steam" : "Show in Steam"}
            </Button>
            {/* Nothing is written until the user looks at the plan and says
                so — these are writes to their Steam library, and some of them
                delete collections. */}
            {tab.mirror.enabled && onOpenMirror ? (
              <Button variant="primary" onClick={onOpenMirror}>
                Review &amp; sync
              </Button>
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <Text variant="secondary">Position</Text>
          <div className="flex flex-wrap gap-2">
            <Button variant="neutral" disabled={index <= 0} onClick={() => onMove(-1)}>
              Move left
            </Button>
            <Button
              variant="neutral"
              disabled={index >= tabCount - 1}
              onClick={() => onMove(1)}
            >
              Move right
            </Button>
            <Button variant="neutral" onClick={onToggleVisible}>
              {tab.visible ? "Hide from the strip" : "Show in the strip"}
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <Text variant="secondary">Delete</Text>
          {isBuiltin ? (
            <Text variant="secondary">
              Built-in tabs can be hidden but not deleted, so you can always get
              them back.
            </Text>
          ) : confirmingDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <Text variant="secondary">
                Delete “{tab.label}”? Its rules are not recoverable.
              </Text>
              <Button variant="neutral" onClick={() => setConfirmingDelete(false)}>
                Keep it
              </Button>
              {/* Two-step rather than a typed confirmation: this destroys one
                  tab, not the user's whole configuration. */}
              <Button variant="primary" onClick={onDelete}>
                Delete
              </Button>
            </div>
          ) : (
            <Button variant="neutral" onClick={() => setConfirmingDelete(true)}>
              Delete this tab
            </Button>
          )}
        </section>
      </div>
    </BuilderPage>
  );
}
