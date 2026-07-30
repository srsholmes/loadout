/**
 * The plugin's settings, and the home of Steam syncing.
 *
 * Syncing started life as a per-tab "Review & sync" button, which put a
 * manual, destructive-looking action in front of the user every time a rule
 * changed. That is the wrong shape: keeping tabs and Steam collections in step
 * is a *mode*, not a chore. Turn it on once and it stays true.
 *
 * The dry run is still reachable — it is the only way to see a delete before
 * it happens, and the only way to understand a name conflict — but it is no
 * longer the price of using the feature.
 */

import { Button, Text, Toggle } from "@loadout/ui";
import { BuilderPage } from "./BuilderPage";

export interface SettingsPageProps {
  /** Keep Steam collections in step with the tabs, automatically. */
  autoSync: boolean;
  /** How many tabs are set to appear in Steam. */
  mirroredCount: number;
  /** A sync was wanted while Steam was unreachable, and is still owed. */
  pendingSync: boolean;
  readOnly: boolean;
  onBack: () => void;
  onToggleAutoSync: (next: boolean) => void;
  onOpenMirror: () => void;
}

export function SettingsPage({
  autoSync,
  mirroredCount,
  pendingSync,
  readOnly,
  onBack,
  onToggleAutoSync,
  onOpenMirror,
}: SettingsPageProps) {
  return (
    <BuilderPage
      title="Settings"
      description="How Collections behaves."
      onBack={onBack}
    >
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-4">
            <Text>Sync with Steam</Text>
            <Toggle checked={autoSync} disabled={readOnly} onChange={onToggleAutoSync} />
          </div>
          <Text variant="secondary">
            Keeps a Steam collection up to date for every tab set to show in
            Steam, so they appear in Steam&apos;s own library. Syncs whenever a
            tab or its rules change.
          </Text>

          {mirroredCount === 0 ? (
            // Turning this on with nothing to sync looks broken. Say so here
            // rather than letting the user hunt for the missing step.
            <Text variant="secondary">
              No tabs are set to show in Steam yet. Open a tab&apos;s options and
              turn on “Show in Steam” to add one.
            </Text>
          ) : (
            <Text variant="secondary">
              {mirroredCount === 1
                ? "1 tab is set to show in Steam."
                : `${mirroredCount} tabs are set to show in Steam.`}
            </Text>
          )}

          {pendingSync ? (
            <Text variant="secondary">
              A sync is still owed — Steam wasn&apos;t reachable last time. It
              will run on its own once Steam is back.
            </Text>
          ) : null}
        </section>

        <section className="flex flex-col gap-2">
          <Text variant="secondary">Review</Text>
          <Text variant="secondary">
            See exactly what syncing would change in Steam before it happens,
            including anything being removed.
          </Text>
          <div>
            <Button variant="neutral" onClick={onOpenMirror}>
              Review changes
            </Button>
          </div>
        </section>

        {readOnly ? (
          <Text variant="secondary">
            These settings were written by a newer version of Loadout, so they
            can&apos;t be changed here.
          </Text>
        ) : null}
      </div>
    </BuilderPage>
  );
}
