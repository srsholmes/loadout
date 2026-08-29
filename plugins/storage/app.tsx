import { useState, useEffect, useCallback, useRef } from "react";
import {
  FaHardDrive,
  FaRotate,
  FaCircleCheck,
  FaTriangleExclamation,
  FaWandMagicSparkles,
} from "react-icons/fa6";
import { Button, Spinner, Toggle, mountComponent, notify, useBackend } from "@loadout/ui";

export const icon = FaHardDrive;

interface StorageDrive {
  path: string;
  label: string | null;
  uuid: string;
  fstype: string;
  size: number;
  mounted: boolean;
  mountpoint: string | null;
  suggestedMountpoint: string;
  steamLibraryFound: boolean;
  inFstab: boolean;
  /** The user's stored choice. Undefined on a backend older than this field. */
  autoMountWanted?: boolean;
  /** Pinned by an /etc/fstab entry Loadout didn't write — read-only to us. */
  externallyPinned?: boolean;
}

interface StorageStatus {
  drives: StorageDrive[];
}

/** What the backend's boot reconcile did, if anything. */
export interface StorageHealNotice {
  repinned: string[];
  remounted: string[];
  unpinned: string[];
  failed: { name: string; error: string }[];
}

/** Join drive names for a sentence: "Games", "Games and SD", "A, B and C". */
function listNames(names: string[]): string {
  const quoted = names.map((n) => `\u201c${n}\u201d`);
  if (quoted.length <= 1) return quoted[0] ?? "";
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/** "was"/"were", "it"/"them" — for a list whose length we only know at runtime. */
const was = (n: number) => (n === 1 ? "was" : "were");
const it = (n: number) => (n === 1 ? "it" : "them");

/**
 * One sentence for what the reconcile did, shared by the startup toast and
 * the page banner so they can never drift apart.
 *
 * Every clause names the drives it applies to. An earlier version said
 * "…put it back and mounted the drive", which on a machine where one entry
 * vanished and a DIFFERENT drive lost the boot race named only the first and
 * credited the second's mount to it.
 *
 * Failures win over successes and are listed with their own causes: a drive
 * we couldn't bring back is the only part the user has to act on, and
 * reporting one cause for several drives sends them after the wrong
 * diagnosis for all but the first.
 */
export function healSummary(
  notice: StorageHealNotice,
): { kind: "success" | "error"; message: string } | null {
  const { repinned = [], remounted = [], unpinned = [], failed = [] } = notice;
  if (failed.length) {
    // "restore" is wrong for two of the three sources — a failed unpin and a
    // failed mount both land here — so the wording stays neutral about which.
    const causes = failed.map((f) => `${listNames([f.name])}: ${f.error}`).join("; ");
    const noun = `boot mount${failed.length === 1 ? "" : "s"}`;
    return { kind: "error", message: `Loadout couldn't fix the ${noun} for ${causes}` };
  }
  const clauses: string[] = [];
  if (repinned.length) {
    // Hedged, not asserted: an /etc that regenerates on update is the usual
    // cause but not the only one, and this plugin runs on every distro.
    clauses.push(
      `the boot mount${repinned.length === 1 ? "" : "s"} for ${listNames(repinned)} ` +
        `${was(repinned.length)} missing ` +
        `(a system update usually does this), so Loadout put ${it(repinned.length)} back`,
    );
  }
  // Named separately: these are not necessarily the same drives as above.
  const mountedOnly = remounted.filter((n) => !repinned.includes(n));
  if (mountedOnly.length) {
    clauses.push(
      `${listNames(mountedOnly)} ${was(mountedOnly.length)} pinned but not mounted, ` +
        `so Loadout mounted ${it(mountedOnly.length)}`,
    );
  } else if (remounted.length) {
    clauses.push(`and mounted ${it(remounted.length)}`);
  }
  if (unpinned.length) {
    clauses.push(
      `${listNames(unpinned)} ${was(unpinned.length)} still set to mount on boot, ` +
        `so Loadout removed ${it(unpinned.length)}`,
    );
  }
  if (!clauses.length) return null;
  const joined = clauses.join(clauses.length === 2 && clauses[1]?.startsWith("and ") ? " " : "; ");
  return { kind: "success", message: `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.` };
}

interface MountResult {
  success: boolean;
  mountpoint: string;
  steamLibraryFound: boolean;
  error?: string;
}

/** Human-readable drive size, e.g. "465.8 GB" / "2.0 TB". */
function fmtSize(bytes: number): string {
  if (!bytes) return "";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TB`;
  return `${gib >= 100 ? gib.toFixed(0) : gib.toFixed(1)} GB`;
}

function Storage() {
  const { call, useEvent } = useBackend("storage");

  const [data, setData] = useState<StorageStatus | null>(null);
  const [detectBusy, setDetectBusy] = useState(false);
  const [mountBusyUuid, setMountBusyUuid] = useState<string | null>(null);
  const [bootBusyUuid, setBootBusyUuid] = useState<string | null>(null);
  const [heal, setHeal] = useState<StorageHealNotice | null>(null);
  const ackedRef = useRef(false);

  const refresh = useCallback(async () => {
    setData((await call("getStatus")) as StorageStatus);
  }, [call]);

  // The page shows the reconcile result too, not just the startup toast: a
  // user who opens the plugin later — because their games went missing —
  // should still find out what happened. It reads the "page" surface, which
  // the toast doesn't consume; sharing one flag meant the toast (which fires
  // on the first overlay open, before any navigation) always got there first
  // and this banner was unreachable. Acked on display so it shows once.
  useEffect(() => {
    let live = true;
    void (async () => {
      const notice = (await call("getHealNotice", "page").catch(
        () => null,
      )) as StorageHealNotice | null;
      if (!live || !notice || !healSummary(notice)) return;
      setHeal(notice);
    })();
    return () => {
      live = false;
    };
  }, [call]);

  useEvent({ event: "statusChanged", handler: () => refresh() });

  useEffect(() => {
    // Unhandled otherwise: a rejecting getStatus left the page on its spinner
    // forever AND produced an unhandled rejection.
    void refresh().catch(() => setData({ drives: [] }));
  }, [refresh]);

  const handleDetectDrives = useCallback(async () => {
    setDetectBusy(true);
    try {
      const res = (await call("detectDrives")) as StorageStatus;
      const unmounted = res.drives?.filter((d) => !d.mounted).length ?? 0;
      notify(
        unmounted > 0
          ? `Found ${unmounted} unmounted drive${unmounted === 1 ? "" : "s"}.`
          : "No unmounted data drives found.",
        { kind: "success" },
      );
      await refresh();
    } finally {
      setDetectBusy(false);
    }
  }, [call, refresh]);

  const handleMountDrive = useCallback(
    async (uuid: string) => {
      setMountBusyUuid(uuid);
      try {
        const res = (await call("mountDrive", uuid)) as MountResult;
        if (res.success) {
          notify(
            res.steamLibraryFound
              ? `Mounted at ${res.mountpoint} — Steam library found.`
              : `Mounted at ${res.mountpoint}.`,
            { kind: "success" },
          );
        } else {
          notify(res.error ?? "Couldn't mount the drive.", { kind: "error" });
        }
        await refresh();
      } finally {
        setMountBusyUuid(null);
      }
    },
    [call, refresh],
  );

  const handleToggleAutoMount = useCallback(
    async (uuid: string, next: boolean) => {
      setBootBusyUuid(uuid);
      try {
        const res = (await call("setDriveAutoMount", uuid, next)) as {
          success: boolean;
          error?: string;
        };
        if (!res.success) {
          notify(res.error ?? "Couldn't update the boot-mount setting.", { kind: "error" });
        } else {
          notify(next ? "Drive will mount on boot." : "Removed from boot mounts.", {
            kind: "success",
          });
        }
      } finally {
        setBootBusyUuid(null);
        await refresh();
      }
    },
    [call, refresh],
  );

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size={32} />
      </div>
    );
  }

  const drives = data.drives ?? [];
  const healed = heal ? healSummary(heal) : null;
  // Acked only once the banner is actually on screen. Acking when the RPC
  // returned consumed the notice while the page was still behind its spinner,
  // so a slow or failing getStatus swallowed it and nothing ever showed it —
  // including a failed heal the user has to act on.
  if (healed && !ackedRef.current) {
    ackedRef.current = true;
    void call("ackHealNotice", "page").catch(() => {});
  }

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        {healed && (
          <div
            className={`card border ${healed.kind === "error" ? "border-error/40" : "border-success/40"}`}
          >
            <div className="card-body p-5 flex flex-row items-start gap-3">
              {healed.kind === "error" ? (
                <FaTriangleExclamation className="text-error shrink-0 mt-0.5" size={14} />
              ) : (
                <FaWandMagicSparkles className="text-success shrink-0 mt-0.5" size={14} />
              )}
              <div className="text-sm text-base-content/80 leading-relaxed">{healed.message}</div>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-body p-6">
            <div className="text-sm text-base-content/80 leading-relaxed">
              If a second internal SSD holding a Steam library stops showing up after a system or
              Steam update, it's usually just no longer mounted. This finds unmounted data drives
              and mounts them where Steam looks — and can pin the mount in{" "}
              <span className="mono">/etc/fstab</span> so an update can't quietly drop it again. It
              only ever mounts an existing filesystem; it never formats or repairs anything.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaHardDrive className="w-3 h-3" /> Storage drive
            </div>
          </div>
          <div className="card-body p-6 flex flex-col gap-4">
            <div>
              <Button onClick={handleDetectDrives} disabled={detectBusy}>
                <span className="flex items-center gap-2">
                  <FaRotate className={detectBusy ? "animate-spin" : undefined} size={13} />
                  {detectBusy ? "Detecting…" : "Detect drives"}
                </span>
              </Button>
            </div>

            {drives.length === 0 ? (
              <div className="text-xs text-base-content/55 leading-relaxed">
                No data drives detected yet. Press “Detect drives” to scan for an unmounted Steam
                library.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {drives.map((d) => (
                  <div
                    key={d.uuid}
                    className="rounded-lg border border-base-300 p-4 flex flex-col gap-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-col gap-1 min-w-0">
                        <span className="text-sm font-medium text-base-content truncate">
                          {d.label || d.path}
                        </span>
                        <span className="text-[11px] text-base-content/45 mono truncate">
                          {[
                            fmtSize(d.size),
                            d.fstype,
                            d.mounted ? `mounted ${d.mountpoint}` : "not mounted",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                      {d.steamLibraryFound && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded bg-success/15 text-success whitespace-nowrap">
                          Steam library found
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-3 pt-1">
                      {d.mounted ? (
                        <span className="text-xs text-success flex items-center gap-1.5">
                          <FaCircleCheck size={12} /> Mounted
                        </span>
                      ) : (
                        <Button
                          onClick={() => handleMountDrive(d.uuid)}
                          disabled={mountBusyUuid === d.uuid}
                        >
                          <span className="flex items-center gap-2">
                            {mountBusyUuid === d.uuid ? "Mounting…" : "Mount"}
                          </span>
                        </Button>
                      )}

                      <div className="flex items-center gap-2 whitespace-nowrap">
                        <span className="text-xs text-base-content/55">
                          {d.externallyPinned ? "Pinned in /etc/fstab" : "Mount on boot"}
                        </span>
                        <Toggle
                          // Stored intent, not the derived /etc state: after an
                          // update eats the entry the intent survives, and a
                          // toggle fed from inFstab would spring back to off.
                          checked={d.autoMountWanted ?? d.inFstab}
                          // …but an entry the user wrote is theirs. Its options
                          // are ones we can't reason about, and showing a switch
                          // we would refuse to honour is worse than showing none.
                          disabled={bootBusyUuid === d.uuid || !!d.externallyPinned}
                          onChange={(next) => handleToggleAutoMount(d.uuid, next)}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">Storage</h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Detect &amp; mount game drives
      </span>
    </div>
  );
}

/**
 * Runs at overlay boot for every `loadOnStartup` plugin, before the user has
 * opened anything — so a drive we quietly put back can be reported without
 * them going looking for it.
 *
 * Pulls rather than subscribes: `emit` is fire-and-forget with no replay, and
 * the backend starts before the overlay connects, so a reconcile that already
 * finished would never be seen. `getHealNotice` awaits an in-flight reconcile
 * and leaves the notice in place until we ack it, so it survives a webview
 * reload. Acking the "toast" surface does not hide it from the plugin page,
 * which consumes its own.
 */
export async function init(api: {
  call: (method: string, ...args: unknown[]) => Promise<unknown>;
  subscribe: (event: string, handler: (data: unknown) => void) => () => void;
}): Promise<void> {
  // Start listening BEFORE the first await. The event fires once, on the
  // transition, so attaching it after the RPC round-trip can miss the window
  // opening in between and then wait forever.
  const visible = whenOverlayVisible();

  let notice: StorageHealNotice | null = null;
  try {
    notice = (await api.call("getHealNotice", "toast")) as StorageHealNotice | null;
  } catch {
    // A backend that isn't up yet.
    visible.cancel();
    return;
  }
  const summary = notice ? healSummary(notice) : null;
  if (!summary) {
    visible.cancel();
    return;
  }

  // Detached, not awaited: the window boots hidden and the overlay unit
  // starts at login, so this can wait hours. runStartupInits awaits every
  // init() in a Promise.all, and blocking that on one plugin's user
  // interaction would pin the whole startup chain.
  void visible.promise.then(async () => {
    notify(summary.message, {
      kind: summary.kind,
      id: "storage-boot-heal",
      duration: summary.kind === "error" ? 10000 : 8000,
    });
    await api.call("ackHealNotice", "toast").catch(() => {});
  });
}

/**
 * Resolve once the overlay window is actually on screen. The listener is
 * attached synchronously by the caller; `cancel` detaches it on paths that
 * end up with nothing to say.
 */
function whenOverlayVisible(): { promise: Promise<void>; cancel: () => void } {
  let onVisible: ((e: Event) => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    onVisible = (e: Event) => {
      if ((e as CustomEvent<{ isOpen: boolean }>).detail?.isOpen) {
        window.removeEventListener("loadout:overlay-visibility", onVisible as EventListener);
        resolve();
      }
    };
    window.addEventListener("loadout:overlay-visibility", onVisible as EventListener);
  });
  return {
    promise,
    cancel: () =>
      window.removeEventListener("loadout:overlay-visibility", onVisible as EventListener),
  };
}

export const mount = mountComponent(Storage);
export const mountHeader = mountComponent(Header);
