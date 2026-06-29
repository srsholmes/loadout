import { useState, useEffect, useCallback } from "react";
import { FaGamepad, FaTriangleExclamation, FaCircleCheck, FaRotate, FaMicrochip, FaFingerprint, FaHardDrive } from "react-icons/fa6";
import { Alert, Button, Spinner, Toggle, mountComponent, notify, useBackend } from "@loadout/ui";

export const icon = FaGamepad;

interface XhciStatus {
  pciDeviceExists: boolean;
  driverBound: boolean;
  gamepadPresent: boolean;
  controller: string;
  deadInLog: boolean;
  summary: string;
}

interface HidOxpStatus {
  blacklisted: boolean;
  moduleLoaded: boolean;
  rebootRequired: boolean;
}

interface FingerprintStatus {
  supported: boolean;
  applied: boolean;
  rebootPending: boolean;
  kargActive: boolean;
  distro: string;
}

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

interface StatusResult {
  unsupported: boolean;
  status?: XhciStatus;
  hidOxp?: HidOxpStatus;
  fingerprint?: FingerprintStatus;
  storage?: StorageStatus;
  autoRecoverOnWake?: boolean;
  listenerRunning?: boolean;
}

/** Human-readable drive size, e.g. "465.8 GB" / "2.0 TB". */
function formatSize(bytes: number): string {
  if (!bytes) return "";
  const gib = bytes / 1024 ** 3;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TB`;
  return `${gib >= 100 ? gib.toFixed(0) : gib.toFixed(1)} GB`;
}

interface FingerprintResult {
  success: boolean;
  rebootRequired: boolean;
  manualKarg?: string;
  error?: string;
}

interface RecoverResult {
  success: boolean;
  controller: string;
  steps: string[];
  gamepadPresent: boolean;
  alreadyHealthy?: boolean;
  unsupported?: boolean;
  error?: string;
}

function Apex() {
  const { call, useEvent } = useBackend("apex");

  const [data, setData] = useState<StatusResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoWakeBusy, setAutoWakeBusy] = useState(false);
  const [blacklistBusy, setBlacklistBusy] = useState(false);
  const [fpBusy, setFpBusy] = useState(false);
  const [detectBusy, setDetectBusy] = useState(false);
  const [mountBusyUuid, setMountBusyUuid] = useState<string | null>(null);
  const [bootBusyUuid, setBootBusyUuid] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setData((await call("getStatus")) as StatusResult);
  }, [call]);

  useEvent({ event: "statusChanged", handler: () => refresh() });

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRecover = useCallback(async () => {
    setBusy(true);
    try {
      const res = (await call("recover")) as RecoverResult;
      if (res.alreadyHealthy) {
        notify("Controller already working — nothing to recover.", {
          kind: "success",
        });
      } else if (res.success) {
        notify(`Gamepad recovered — rebound ${res.controller}.`, {
          kind: "success",
        });
      } else {
        notify(res.error ?? "Recovery failed — gamepad didn't come back.", {
          kind: "error",
        });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [call, refresh]);

  const handleToggleAutoWake = useCallback(
    async (next: boolean) => {
      setAutoWakeBusy(true);
      try {
        const res = (await call("setAutoRecoverOnWake", next)) as {
          success: boolean;
          error?: string;
        };
        if (!res.success) {
          notify(res.error ?? "Couldn't update the setting.", { kind: "error" });
        }
      } finally {
        setAutoWakeBusy(false);
        await refresh();
      }
    },
    [call, refresh],
  );

  const handleToggleBlacklist = useCallback(
    async (next: boolean) => {
      setBlacklistBusy(true);
      try {
        const res = (await call("setHidOxpBlacklist", next)) as {
          success: boolean;
          error?: string;
          hidOxp?: HidOxpStatus;
        };
        if (!res.success) {
          notify(res.error ?? "Couldn't update the driver blacklist.", { kind: "error" });
        } else if (res.hidOxp?.rebootRequired) {
          notify("Driver blacklisted — reboot to apply.", { kind: "success" });
        } else if (next) {
          notify("hid-oxp driver blacklisted.", { kind: "success" });
        } else {
          notify("hid-oxp driver blacklist removed.", { kind: "success" });
        }
      } finally {
        setBlacklistBusy(false);
        await refresh();
      }
    },
    [call, refresh],
  );

  const handleToggleFingerprint = useCallback(
    async (next: boolean) => {
      setFpBusy(true);
      try {
        const res = (await call("setFingerprintBlock", next)) as FingerprintResult;
        if (!res.success) {
          notify(res.error ?? "Couldn't update the fingerprint setting.", { kind: "error" });
        } else if (res.manualKarg) {
          notify(
            `Controller wake ${next ? "blocked" : "restored"}. Your distro needs a manual kernel arg — see the panel.`,
            { kind: "success" },
          );
        } else if (res.rebootRequired) {
          notify(`Reboot required to finish ${next ? "blocking" : "restoring"} fingerprint wake.`, {
            kind: "success",
          });
        } else {
          notify(next ? "Fingerprint wake blocked." : "Fingerprint wake restored.", { kind: "success" });
        }
      } finally {
        setFpBusy(false);
        await refresh();
      }
    },
    [call, refresh],
  );

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

  if (data.unsupported) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="card">
            <div className="card-body p-6">
              <div className="subsection-label mb-2 flex items-center gap-2">
                <FaTriangleExclamation className="w-3 h-3" />
                Not a OneXPlayer Apex
              </div>
              <div className="text-sm text-base-content/80 leading-relaxed">
                This plugin only does anything on the OneXPlayer Apex. The gamepad-recovery fix
                rebinds Apex-specific USB hardware, so it stays disabled on other devices.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const status = data.status!;
  const healthy = status.gamepadPresent;
  const hidOxp = data.hidOxp;
  const drives = data.storage?.drives ?? [];

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          <div className="card-body p-6">
            <div className="text-sm text-base-content/80 leading-relaxed">
              On the OneXPlayer Apex the xHCI USB controller can die when the device wakes from
              sleep, which drops the built-in gamepad off the bus — it looks dead and restarting
              InputPlumber doesn't help. This rebinds the controller so the pad re-enumerates.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaGamepad className="w-3 h-3" /> Gamepad recovery
            </div>
          </div>
          <div className="card-body p-6 flex flex-col gap-4">
            <Alert
              variant={healthy ? "success" : "warning"}
              icon={healthy ? <FaCircleCheck size={14} /> : <FaTriangleExclamation size={14} />}
              title={healthy ? "Controller healthy" : "Controller missing"}
            >
              {status.summary}
            </Alert>

            <div className="text-[11px] text-base-content/45 mono">
              controller {status.controller} · driver {status.driverBound ? "bound" : "unbound"} ·
              gamepad {status.gamepadPresent ? "present" : "absent"}
            </div>

            <div className="mt-2">
              <Button onClick={handleRecover} disabled={busy}>
                <span className="flex items-center gap-2">
                  <FaRotate className={busy ? "animate-spin" : undefined} size={13} />
                  {busy ? "Recovering…" : "Recover gamepad"}
                </span>
              </Button>
            </div>

            <div className="text-xs text-base-content/55 leading-relaxed">
              Safe to run any time — if the controller is already working it does nothing, so
              there's no harm in pressing it.
            </div>

            <div className="flex justify-between items-start gap-4 pt-4 mt-1 border-t border-base-300">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm text-base-content font-medium">
                  Recover automatically on wake
                </span>
                <span className="text-xs text-base-content/55 leading-relaxed">
                  Run this recovery whenever the device wakes from sleep, so you never have to
                  press the button. Only rebinds if the gamepad is actually missing.
                </span>
              </div>
              <Toggle
                checked={!!data.autoRecoverOnWake}
                disabled={autoWakeBusy}
                onChange={handleToggleAutoWake}
              />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaMicrochip className="w-3 h-3" /> Driver blacklist
            </div>
          </div>
          <div className="card-body p-6 flex flex-col gap-4">
            <div className="text-sm text-base-content/80 leading-relaxed">
              Blacklisting the OneXPlayer <span className="mono">hid-oxp</span> driver stops it
              binding the built-in gamepad, which in testing keeps the USB controller alive across
              sleep far more reliably — preventing the drop-out rather than recovering from it.
              Takes effect after a reboot.
            </div>

            <div className="text-xs text-base-content/55 leading-relaxed">
              <span className="mono">hid-oxp</span> normally provides paddle mapping, RGB and
              vibration — but those keep working without it: InputPlumber reads the controller
              directly for input and paddles, Loadout's RGB plugin drives the lighting, and rumble
              comes from the Xbox driver. It's a temporary workaround until the driver bug is fixed
              upstream.
            </div>

            {hidOxp?.rebootRequired && (
              <Alert
                variant="warning"
                icon={<FaTriangleExclamation size={14} />}
                title="Reboot required"
              >
                The blacklist is set but <span className="mono">hid-oxp</span> is still loaded.
                Reboot to apply it.
              </Alert>
            )}

            <div className="flex justify-between items-start gap-4">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm text-base-content font-medium">
                  Blacklist the hid-oxp driver
                </span>
                <span className="text-xs text-base-content/55 leading-relaxed">
                  Temporary fix if the gamepad keeps dying on wake. InputPlumber and Loadout's RGB
                  plugin cover paddles, RGB and rumble, so nothing should break. Reversible — turn it
                  off and reboot to restore the driver.
                </span>
              </div>
              <Toggle
                checked={!!hidOxp?.blacklisted}
                disabled={blacklistBusy}
                onChange={handleToggleBlacklist}
              />
            </div>
          </div>
        </div>

        {data.fingerprint?.supported && (
          <div className="card">
            <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
              <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
                <FaFingerprint className="w-3 h-3" /> Fingerprint wake
              </div>
            </div>
            <div className="card-body p-6 flex flex-col gap-4">
              <div className="text-sm text-base-content/80 leading-relaxed">
                The power button's fingerprint sensor wakes the Apex from sleep on a light touch —
                annoying in a bag. This blocks it as a wake source; a deliberate power-button{" "}
                <span className="font-medium">press</span> still wakes the device.
              </div>

              <div className="flex justify-between items-start gap-4">
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-sm text-base-content font-medium">
                    Block fingerprint wake
                  </span>
                  <span className="text-xs text-base-content/55 leading-relaxed">
                    Disables the sensor's USB-controller wake and adds a kernel parameter for the
                    GPIO wake line.
                  </span>
                </div>
                <Toggle
                  checked={!!data.fingerprint.applied}
                  disabled={fpBusy}
                  onChange={handleToggleFingerprint}
                />
              </div>

              {data.fingerprint.rebootPending && (
                <Alert variant="warning" icon={<FaTriangleExclamation size={14} />} title="Reboot required">
                  A kernel-parameter change is staged. Reboot to finish applying the fingerprint
                  wake block.
                </Alert>
              )}

              {!data.fingerprint.kargActive && data.fingerprint.distro !== "steamos" && (
                <div className="text-xs text-base-content/55 leading-relaxed">
                  On {data.fingerprint.distro || "this distro"} the GPIO kernel arg can't be applied
                  automatically yet. Add{" "}
                  <span className="mono">gpiolib_acpi.ignore_wake=AMDI0030:00@58</span> to your
                  kernel command line and reboot to fully block the touch wake.
                </div>
              )}
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaHardDrive className="w-3 h-3" /> Storage drive
            </div>
          </div>
          <div className="card-body p-6 flex flex-col gap-4">
            <div className="text-sm text-base-content/80 leading-relaxed">
              If a second internal SSD holding a Steam library stops showing up after a SteamOS or
              Steam update, it's usually just no longer mounted. This finds unmounted data drives and
              mounts them where Steam looks — and can pin the mount in{" "}
              <span className="mono">/etc/fstab</span> so an update can't quietly drop it again. It
              only ever mounts an existing filesystem; it never formats or repairs anything.
            </div>

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
                            formatSize(d.size),
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
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">Apex</h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        OneXPlayer Apex fixes
      </span>
    </div>
  );
}

export const mount = mountComponent(Apex);
export const mountHeader = mountComponent(Header);
