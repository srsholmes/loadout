import { useState, useEffect, useCallback } from "react";
import { FaHardDrive, FaRotate, FaCircleCheck } from "react-icons/fa6";
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
}

interface StorageStatus {
  drives: StorageDrive[];
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

  const refresh = useCallback(async () => {
    setData((await call("getStatus")) as StorageStatus);
  }, [call]);

  useEvent({ event: "statusChanged", handler: () => refresh() });

  useEffect(() => {
    refresh();
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

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          <div className="card-body p-6">
            <div className="text-sm text-base-content/80 leading-relaxed">
              If a second internal SSD holding a Steam library stops showing up after a system or
              Steam update, it's usually just no longer mounted. This finds unmounted data drives and
              mounts them where Steam looks — and can pin the mount in{" "}
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
                        <span className="text-xs text-base-content/55">Mount on boot</span>
                        <Toggle
                          checked={d.inFstab}
                          disabled={bootBusyUuid === d.uuid}
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

export const mount = mountComponent(Storage);
export const mountHeader = mountComponent(Header);
