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
 * fallback when the backend is unreachable or predates the field.
 * When neither parses as x.y.z this is a dev build and the whole
 * feature disables itself.
 */

import { useEffect, useRef, useState } from "react";
import { Button, notify } from "@loadout/ui";
import { parseVersion, versionsEqual } from "@loadout/types";
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

  useEffect(() => {
    fetch(apiUrl("/api/status"), { headers: authHeaders() })
      .then((r) => r.json())
      .then((j: { version?: unknown }) => {
        if (typeof j.version === "string") setBackendVersion(j.version);
      })
      .catch(() => {});
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Arming auto-expires, same as MaintenanceActionRow — a stray d-pad
  // press shouldn't leave a hot "confirm" button behind.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const installedVersion =
    backendVersion && parseVersion(backendVersion) ? backendVersion : OVERLAY_VERSION;
  const devBuild = parseVersion(installedVersion) === null;
  const versionsDiverge =
    backendVersion !== null && !versionsEqual(backendVersion, OVERLAY_VERSION);

  const available =
    check.state === "checked" && check.result.available && check.result.tag
      ? check.result
      : null;
  const updating =
    updateStatus !== null && updateStatus.phase !== "idle" && updateStatus.phase !== "error";

  async function handleCheck() {
    if (check.state === "checking" || updating) return;
    setCheck({ state: "checking" });
    const result = await checkForUpdate(installedVersion);
    setCheck({ state: "checked", result });
  }

  function startStatusPoll() {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const s = await getUpdateStatus();
      setUpdateStatus(s);
      // "restarting" keeps polling — the overlay process dies out from
      // under us anyway. Stop on error so the buttons come back.
      if (s.phase === "error" || s.phase === "idle") {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 700);
  }

  async function handleUpdate(tag: string) {
    if (updating) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    // Marker for the post-restart "Updated to vX.Y.Z" toast: App.tsx
    // compares it against the running version on next boot. Written
    // BEFORE the update so it persists across the backend restart.
    setConfigValue("updatePendingTag", tag);
    const res = await applyUpdate(tag);
    if (!res.success) {
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
  // partial update so the fix ("Update now" again) is obvious.
  if (versionsDiverge) {
    rows.push(
      <div key="server-version" className="flex justify-between items-center min-h-[44px]">
        <div className="pr-4">
          <div className="text-sm text-base-content">Server version</div>
          <div className="text-xs text-base-content/50 mt-0.5">
            The plugin server and overlay versions differ — running an update
            will bring both to the latest release.
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
        <div className="h-1.5 rounded-full bg-base-300 overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all"
            style={{ width: `${updateStatus.pct ?? 0}%` }}
          />
        </div>
        <div className="text-xs text-base-content/50 mt-2">
          {updateStatus.message ?? "Working…"} The overlay will close and reopen
          when the update finishes; your game keeps running.
        </div>
      </div>,
    );
  } else {
    const failed = updateStatus?.phase === "error" ? updateStatus.message : null;
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
          {available ? (
            <>
              {skippedVersion !== available.tag && (
                <Button onClick={() => handleSkip(available.tag!)}>
                  Skip this version
                </Button>
              )}
              <Button
                variant={armed ? "danger" : "primary"}
                onClick={() => void handleUpdate(available.tag!)}
              >
                {armed ? "Click again to confirm" : `Update to ${available.tag}`}
              </Button>
            </>
          ) : (
            <Button onClick={() => void handleCheck()} disabled={check.state === "checking"}>
              {check.state === "checking" ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </div>
      </div>,
    );
  }

  return <>{rows}</>;
}
