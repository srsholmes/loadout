/**
 * Plugin settings, and the home of Steam syncing.
 *
 * The gear used to run a sync directly, which is why pressing it usually just
 * produced "Already up to date" — a settings icon that performs an action, and
 * most of the time appears to do nothing at all.
 *
 * Syncing lives here as a *mode*: turn it on once and every later edit follows.
 * The manual button stays for the times you want it now, and the last report
 * stays visible so a collection losing a game is something you read rather
 * than something you notice later.
 */

import { Button, Text, Toggle } from "@loadout/ui";
import { BuilderPage } from "./BuilderPage";

export interface SyncChange {
  label: string;
  kind: "created" | "updated" | "deleted";
  added: string[];
  removed: string[];
  addedCount: number;
  removedCount: number;
}

export interface SettingsPageProps {
  autoSync: boolean;
  /** How many collections this plugin maintains — the ones a sync writes. */
  managedCount: number;
  /** A sync was wanted while Steam was unreachable, and is still owed. */
  pendingSync: boolean;
  busy: boolean;
  lastSync: SyncChange[] | null;
  /** What the last sync refused to write, and why. Never silently dropped. */
  blocked?: Array<{ label: string; reason: string }>;
  onBack: () => void;
  onToggleAutoSync: (next: boolean) => void;
  onSyncNow: () => void;
}

/** One change as a sentence. Names a couple of games — "Portal 2 left" answers
 *  the question a bare "1 removed" provokes. */
export function describeChange(c: SyncChange): string {
  if (c.kind === "created") return `${c.label} — created with ${c.addedCount} games`;
  if (c.kind === "deleted") return `${c.label} — removed from Steam`;

  const parts: string[] = [];
  if (c.addedCount > 0) parts.push(`${c.addedCount} added${listOf(c.added)}`);
  if (c.removedCount > 0) parts.push(`${c.removedCount} removed${listOf(c.removed)}`);
  return `${c.label} — ${parts.join(", ")}`;
}

function listOf(names: string[]): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? ` (${shown}, …)` : ` (${shown})`;
}

export function SettingsPage({
  autoSync,
  managedCount,
  pendingSync,
  busy,
  lastSync,
  blocked = [],
  onBack,
  onToggleAutoSync,
  onSyncNow,
}: SettingsPageProps) {
  return (
    <BuilderPage title="Settings" description="How Collections behaves." onBack={onBack}>
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <Text>Sync when I leave</Text>
            <Toggle checked={autoSync} onChange={onToggleAutoSync} />
          </div>
          <Text variant="secondary">
            Writes your rule-built collections into Steam when you close this
            plugin, rather than while you are still working in it. The ones that
            were already in Steam are left alone.
          </Text>
          <Text variant="secondary">
            A sync reads your whole library and writes to Steam Cloud, so doing
            it mid-edit made the plugin look frozen. Use the sync button in the
            header when you want it immediately.
          </Text>

          {managedCount === 0 ? (
            // Turning this on with nothing to write looks broken. Say so here
            // rather than letting the user hunt for the missing step.
            <Text variant="secondary">
              Nothing to sync yet — the collections on the grid all came from
              Steam. Press New to build one from rules.
            </Text>
          ) : (
            <Text variant="secondary">
              {managedCount === 1
                ? "1 collection is built from rules."
                : `${managedCount} collections are built from rules.`}
            </Text>
          )}

          {pendingSync ? (
            <Text variant="secondary">
              Steam is behind — changes are waiting to be written. They go out
              when you leave, or when you press Sync.
            </Text>
          ) : null}

          <div>
            <Button variant="neutral" disabled={busy} onClick={onSyncNow}>
              {busy ? "Syncing…" : "Sync now"}
            </Button>
          </div>
        </section>

        {blocked.length > 0 ? (
          <section className="flex flex-col gap-1">
            <Text variant="secondary">Couldn&apos;t sync</Text>
            <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
              {blocked.map((b) => (
                <li key={b.label}>
                  <Text variant="secondary">
                    {b.label} — {b.reason}
                  </Text>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {lastSync ? (
          <section className="flex flex-col gap-1">
            <Text variant="secondary">Last sync</Text>
            {lastSync.length === 0 ? (
              <Text variant="secondary">Nothing changed.</Text>
            ) : (
              <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                {lastSync.map((c) => (
                  <li key={`${c.kind}-${c.label}`}>
                    <Text variant="secondary">{describeChange(c)}</Text>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </BuilderPage>
  );
}
