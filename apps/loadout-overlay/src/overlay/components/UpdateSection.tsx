/**
 * Settings → About → software update rows (issue #173).
 *
 * Drives the whole self-update flow over the host RPC surface:
 * "Check for updates" (always allowed — ignores the skipped version),
 * "Update now" with the same two-step arming confirm the Maintenance
 * rows use, "Skip this version" (persists `updateSkippedVersion` so
 * the startup toast in App.tsx stays quiet for that release), and a
 * progress readout polled from the Bun host while an update runs.
 *
 * Version sources: the backend's /api/status `version` is canonical
 * (it's what the root service actually runs); OVERLAY_VERSION is the
 * overlay bundle's own version. The check compares against the OLDER
 * of the two so a half-applied update (backend advanced, overlay not,
 * or vice-versa) still offers the repair — the backend allows a
 * same-version reinstall for exactly this case. When neither parses as
 * x.y.z this is a dev build and the whole feature disables itself.
 */

import { useEffect, useRef, useState } from "react";
import { Button, notify } from "@loadout/ui";
import { parseVersion, compareVersions, versionsEqual } from "@loadout/types";
import { apiUrl, authHeaders } from "../lib/backend";
import { OVERLAY_VERSION } from "../version";
import { useConfigValue, setConfigValue } from "../lib/userConfig";
import {
  applyUpdate,
  checkForUpdate,
  getUpdateStatus,
  type UpdateCheckResult,
  type UpdateStatus,
} from "../lib/host";

type CheckState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "checked"; result: UpdateCheckResult };

/** The older of two version strings (for the update check), skipping
 *  any that don't parse. Returns null when neither parses (dev build). */
function olderParseableVersion(a: string, b: string): string | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa && pb) return compareVersions(pa, pb) <= 0 ? a : b;
  if (pa) return a;
  if (pb) return b;
  return null;
}

function isActivePhase(phase: UpdateStatus["phase"]): boolean {
  return phase !== "error"; // "idle" never appears mid-run; every other phase is live
}

export function UpdateSection() {
  const [backendVersion, setBackendVersion] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>({ state: "idle" });
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [armed, setArmed] = useState(false);
  const [skippedVersion, setSkippedVersion] = useConfigValue<string | null>(
    "updateSkippedVersion",
    null,
  );
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Synchronous in-flight guard — render state (`updating`) lags a
  // double A-press, and a second applyUpdate both re-sets and then (on
  // the "already in progress" error) clears `updatePendingTag`, killing
  // the post-restart toast. This ref flips before any await.
  const inFlightRef = useRef(false);

  function stopPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startStatusPoll() {
    stopPoll();
    // A single transient RPC failure (getUpdateStatus → null) must NOT
    // be read as "done" — during the heavy backend/swap phases the host
    // can miss a poll. Tolerate a run of nulls; only an explicit
    // idle/error from the host is terminal. If the host truly vanishes
    // (dev, host crash) give up after ~11s of silence.
    let consecutiveNulls = 0;
    pollRef.current = setInterval(async () => {
      const s = await getUpdateStatus();
      if (s === null) {
        if (++consecutiveNulls > 15) {
          stopPoll();
          inFlightRef.current = false;
          // Drive the UI to a terminal ERROR, not just stop polling —
          // otherwise `updating` stays true, the progress row keeps
          // rendering (frozen at its last %, e.g. 80%) with NO button,
          // and the user can neither retry nor check. Surfacing an
          // error restores the Check/Update button so they can retry.
          setUpdateStatus({
            phase: "error",
            message: "Lost contact with the updater — reopen Settings and try again.",
          });
        }
        return;
      }
      consecutiveNulls = 0;
      setUpdateStatus(s);
      if (s.phase === "error" || s.phase === "idle") {
        stopPoll();
        inFlightRef.current = false;
      }
    }, 700);
  }

  useEffect(() => {
    fetch(apiUrl("/api/status"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((j: { version?: unknown }) => {
        if (typeof j.version === "string") setBackendVersion(j.version);
      })
      .catch(() => {});
    // Resume an update that was already running when Settings was
    // (re)opened — the component may have been unmounted (user pressed
    // B) mid-update, and the Bun host holds the authoritative status.
    // Also surface a terminal error that occurred while unmounted (e.g.
    // the restart watchdog fired), so a failed update isn't silently
    // hidden behind a fresh "Check for updates" row on reopen.
    getUpdateStatus()
      .then((s) => {
        if (!s) return;
        if (s.phase === "error") {
          setUpdateStatus(s);
        } else if (s.phase !== "idle" && isActivePhase(s.phase)) {
          inFlightRef.current = true;
          setUpdateStatus(s);
          startStatusPoll();
        }
      })
      .catch(() => {});
    return () => stopPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arming auto-expires, same as MaintenanceActionRow — a stray d-pad
  // press shouldn't leave a hot "confirm" button behind.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const installedVersion =
    olderParseableVersion(backendVersion ?? OVERLAY_VERSION, OVERLAY_VERSION) ?? OVERLAY_VERSION;
  const devBuild =
    parseVersion(backendVersion ?? OVERLAY_VERSION) === null &&
    parseVersion(OVERLAY_VERSION) === null;
  const versionsDiverge =
    backendVersion !== null && !versionsEqual(backendVersion, OVERLAY_VERSION);

  const available =
    check.state === "checked" && check.result.available && check.result.tag ? check.result : null;
  const updating =
    updateStatus !== null && updateStatus.phase !== "idle" && updateStatus.phase !== "error";

  async function handleCheck() {
    if (check.state === "checking" || updating) return;
    setCheck({ state: "checking" });
    const result = await checkForUpdate(installedVersion);
    setCheck({ state: "checked", result });
  }

  async function handleUpdate(tag: string) {
    if (updating || inFlightRef.current) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    inFlightRef.current = true;
    // Marker for the post-restart "Updated to vX.Y.Z" toast: App.tsx
    // compares it against the running version on next boot. Written
    // BEFORE the update so it persists across the backend restart.
    setConfigValue("updatePendingTag", tag);
    const res = await applyUpdate(tag);
    if (!res.success) {
      inFlightRef.current = false;
      setConfigValue("updatePendingTag", null);
      notify(res.error ?? "Update failed to start.", { kind: "error", id: "loadout-update" });
      return;
    }
    setUpdateStatus({ phase: "downloading", pct: 0, tag });
    startStatusPoll();
  }

  function handleSkip(tag: string) {
    setSkippedVersion(tag);
    notify(`You won't be notified about ${tag} again.`, { id: "loadout-update" });
  }

  const rows: React.ReactNode[] = [];

  // Backend/overlay divergence — normally invisible; surfaces after a
  // partial update so the fix ("Check for updates" then update) is
  // obvious. The check compares against the older version, so the
  // update button will appear.
  if (versionsDiverge) {
    rows.push(
      <div key="server-version" className="flex justify-between items-center min-h-[44px]">
        <div className="pr-4">
          <div className="text-sm text-base-content">Server version</div>
          <div className="text-xs text-base-content/50 mt-0.5">
            The plugin server and overlay versions differ — running an update will bring both to the
            latest release.
          </div>
        </div>
        <code className="text-sm text-warning bg-warning/10 px-3 py-1 rounded-lg font-mono">
          {backendVersion}
        </code>
      </div>,
    );
  }

  if (devBuild) {
    rows.push(
      <div key="dev" className="flex justify-between items-center min-h-[44px]">
        <div className="pr-4">
          <div className="text-sm text-base-content">Software update</div>
          <div className="text-xs text-base-content/50 mt-0.5">
            Dev build — automatic updates are disabled. Use{" "}
            <code className="font-mono">bun run build-and-install</code> instead.
          </div>
        </div>
      </div>,
    );
  } else if (updating && updateStatus) {
    rows.push(
      <div key="progress" className="min-h-[44px]">
        <div className="flex justify-between items-center mb-2">
          <div className="text-sm text-base-content">
            {updateStatus.phase === "restarting"
              ? "Restarting overlay…"
              : `Updating to ${updateStatus.tag ?? ""}`}
          </div>
          <span className="text-xs font-mono text-base-content/50">
            {updateStatus.pct != null ? `${updateStatus.pct}%` : ""}
          </span>
        </div>
        <div
          className="h-1.5 rounded-full bg-base-300 overflow-hidden"
          role="progressbar"
          aria-valuenow={updateStatus.pct ?? 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Update progress"
        >
          <div
            className="h-full bg-primary rounded-full transition-all"
            style={{ width: `${updateStatus.pct ?? 0}%` }}
          />
        </div>
        <div className="text-xs text-base-content/50 mt-2">
          {updateStatus.message ?? "Working…"} The overlay will close and reopen when the update
          finishes; your game keeps running.
        </div>
      </div>,
    );
  } else {
    // One PRIMARY button that morphs (Check → Update → confirm) and is
    // never unmounted across those transitions, so controller focus
    // stays put (matches MaintenanceActionRow's in-place morph rather
    // than swapping button elements under focus). "Skip" appears beside
    // it only when an update is available.
    const failed = updateStatus?.phase === "error" ? updateStatus.message : null;
    const checking = check.state === "checking";
    const primaryLabel = available
      ? armed
        ? "Press again to confirm"
        : `Update to ${available.tag}`
      : checking
        ? "Checking…"
        : "Check for updates";
    const primaryVariant = available && armed ? "danger" : available ? "primary" : "default";
    const onPrimary = available
      ? () => void handleUpdate(available.tag!)
      : () => void handleCheck();

    rows.push(
      <div key="check" className="flex justify-between items-center min-h-[44px]">
        <div className="pr-4">
          <div className="text-sm text-base-content">Software update</div>
          <div className="text-xs text-base-content/50 mt-0.5">
            {failed ? (
              <span className="text-error">Update failed: {failed}</span>
            ) : available ? (
              <>
                Loadout {available.tag} is available.
                {skippedVersion === available.tag && " (Notifications skipped.)"}
              </>
            ) : check.state === "checked" ? (
              (check.result.error ?? "You're on the latest version.")
            ) : (
              "Downloads the latest release and restarts the overlay — no terminal needed."
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {available && skippedVersion !== available.tag && (
            <Button onClick={() => handleSkip(available.tag!)}>Skip this version</Button>
          )}
          <Button variant={primaryVariant} onClick={onPrimary} disabled={checking}>
            {primaryLabel}
          </Button>
        </div>
      </div>,
    );
  }

  return <>{rows}</>;
}
