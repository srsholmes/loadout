/**
 * The sync screen: what will happen to the user's Steam collections, shown
 * before anything happens to them.
 *
 * A dry run is not politeness here. Every other write in this plugin lands in
 * our own config file, where a mistake costs a tab. These writes land in the
 * user's Steam library, are synced to Steam Cloud, and include deletions. The
 * plan is shown in full — creates, updates, renames, deletes and the things we
 * are refusing to touch — and `Sync` is the only thing that acts on it.
 *
 * Conflicts and drift are listed even though they are not writes, because they
 * are the two states where the honest answer is "you decide": a name already
 * taken by a collection we did not make, and a collection someone has edited
 * by hand since we last wrote it.
 */

import { Button, Text } from "@loadout/ui";
import { BuilderPage } from "./BuilderPage";
import type { MirrorPlan } from "../lib/mirror";

export interface MirrorPageProps {
  plan: MirrorPlan | null;
  summary: string;
  /** tabId → display name, including tabs that no longer exist. */
  tabLabels: Record<string, string>;
  busy: boolean;
  /** Set when the last preview or sync failed — usually Steam not running. */
  error: string | null;
  onBack: () => void;
  onRefresh: () => void;
  onSync: () => void;
}

function name(labels: Record<string, string>, tabId: string): string {
  return labels[tabId] ?? tabId;
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <Text variant="secondary">{title}</Text>
      {hint ? <Text variant="secondary">{hint}</Text> : null}
      <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>{children}</ul>
    </section>
  );
}

export function MirrorPage({
  plan,
  summary,
  tabLabels,
  busy,
  error,
  onBack,
  onRefresh,
  onSync,
}: MirrorPageProps) {
  const nothingToDo =
    plan !== null &&
    plan.creates.length === 0 &&
    plan.updates.length === 0 &&
    plan.renames.length === 0 &&
    plan.deletes.length === 0;

  return (
    <BuilderPage
      title="Show tabs in Steam"
      description="Your tabs, copied into Steam collections so they appear in Steam's own library."
      onBack={onBack}
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <Text variant="secondary">
            {error} Steam has to be running for tabs to reach its library.
          </Text>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Text>{plan === null ? "Checking Steam…" : summary}</Text>
          <Button variant="neutral" disabled={busy} onClick={onRefresh}>
            Refresh
          </Button>
          <Button
            variant="primary"
            disabled={busy || plan === null || nothingToDo}
            onClick={onSync}
          >
            {busy ? "Syncing…" : "Sync"}
          </Button>
        </div>

        {plan === null ? null : (
          <>
            {plan.creates.length > 0 ? (
              <Section title="New collections">
                {plan.creates.map((c) => (
                  <li key={c.tabId}>
                    <Text variant="secondary">
                      “{c.name}” — {c.appIds.length} games
                    </Text>
                  </li>
                ))}
              </Section>
            ) : null}

            {plan.updates.length > 0 ? (
              <Section title="Updated">
                {plan.updates.map((u) => (
                  <li key={u.tabId}>
                    <Text variant="secondary">
                      “{u.name}” — {u.add.length} added, {u.remove.length} removed
                    </Text>
                  </li>
                ))}
              </Section>
            ) : null}

            {plan.renames.length > 0 ? (
              <Section title="Renamed">
                {plan.renames.map((r) => (
                  <li key={r.tabId}>
                    <Text variant="secondary">
                      “{r.from}” → “{r.to}”
                    </Text>
                  </li>
                ))}
              </Section>
            ) : null}

            {plan.deletes.length > 0 ? (
              <Section
                title="Deleted"
                hint="Only collections this plugin created are ever removed."
              >
                {plan.deletes.map((d) => (
                  <li key={d.tabId}>
                    <Text variant="secondary">
                      “{d.name}” —{" "}
                      {d.reason === "tab-deleted"
                        ? "its tab is gone"
                        : "you turned mirroring off"}
                    </Text>
                  </li>
                ))}
              </Section>
            ) : null}

            {plan.conflicts.length > 0 ? (
              <Section
                title="Needs a different name"
                hint="A collection with this name already exists and this plugin didn't make it, so it's left alone. Rename the tab to sync it."
              >
                {plan.conflicts.map((c) => (
                  <li key={c.tabId}>
                    <Text variant="secondary">
                      “{name(tabLabels, c.tabId)}” wants “{c.name}”, which already has{" "}
                      {c.existingCount} games in it
                    </Text>
                  </li>
                ))}
              </Section>
            ) : null}

            {plan.drifted.length > 0 ? (
              <Section
                title="Edited in Steam"
                hint="Syncing will put these back to what the tab's rules say."
              >
                {plan.drifted.map((d) => (
                  <li key={d.tabId}>
                    <Text variant="secondary">
                      “{name(tabLabels, d.tabId)}” — {d.unexpectedAdds.length} added and{" "}
                      {d.unexpectedRemoves.length} removed by hand
                    </Text>
                  </li>
                ))}
              </Section>
            ) : null}

            {plan.skipped.length > 0 ? (
              <Section title="Skipped">
                {plan.skipped.map((s) => (
                  <li key={s.tabId}>
                    <Text variant="secondary">
                      “{name(tabLabels, s.tabId)}” — {s.reason}
                    </Text>
                  </li>
                ))}
              </Section>
            ) : null}

            {nothingToDo && plan.conflicts.length === 0 && plan.skipped.length === 0 ? (
              <Text variant="secondary">
                Every mirrored tab already matches its Steam collection.
              </Text>
            ) : null}
          </>
        )}
      </div>
    </BuilderPage>
  );
}
