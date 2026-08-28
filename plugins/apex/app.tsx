import { useState, useEffect, useCallback } from "react";
import { FaGamepad, FaTriangleExclamation, FaCircleCheck, FaCircleInfo, FaRotate, FaMicrochip, FaFingerprint } from "react-icons/fa6";
import {
  Alert,
  Button,
  SegmentedItem,
  Spinner,
  Toggle,
  mountComponent,
  notify,
  useBackend,
} from "@loadout/ui";
import { intensityLabel } from "./lib/rumble";
import type { RumbleInfo } from "./lib/rumble-control";

export const icon = FaGamepad;

/** The levels a device's range covers, inclusive. */
function rumbleLevels(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

interface XhciStatus {
  pciDeviceExists: boolean;
  driverBound: boolean;
  gamepadPresent: boolean;
  gamepadUnknown?: boolean;
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
  /** False when this board's GPIO pin is unconfirmed, so the karg path is
   *  unavailable and PME blocking is the whole of the fix. */
  kargApplicable: boolean;
  distro: string;
}

interface StatusResult {
  unsupported: boolean;
  status?: XhciStatus;
  hidOxp?: HidOxpStatus;
  fingerprint?: FingerprintStatus;
  autoRecoverOnWake?: boolean;
  listenerRunning?: boolean;
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
  const [rumble, setRumble] = useState<RumbleInfo | null>(null);
  const [rumbleBusy, setRumbleBusy] = useState(false);

  const refresh = useCallback(async () => {
    setData((await call("getStatus")) as StatusResult);
  }, [call]);

  useEvent({ event: "statusChanged", handler: () => refresh() });
  useEvent({
    event: "rumbleChanged",
    handler: useCallback((d: unknown) => setRumble(d as RumbleInfo), []),
  });

  useEffect(() => {
    refresh();
    call("getRumbleInfo")
      .then((d) => setRumble(d as RumbleInfo))
      .catch(() => setRumble(null));
  }, [refresh, call]);

  const handleSetRumble = useCallback(
    async (level: number) => {
      setRumbleBusy(true);
      // Optimistic: the write is a single sysfs poke and the control
      // shouldn't lag the press.
      setRumble((prev) => (prev ? { ...prev, intensity: level, source: "stored" } : prev));
      try {
        const res = (await call("setRumbleIntensity", level)) as
          | { success: boolean; error?: string; info?: RumbleInfo }
          | null;
        if (!res?.success) {
          notify(res?.error ?? "Couldn't change the rumble intensity.", { kind: "error" });
          setRumble((await call("getRumbleInfo")) as RumbleInfo);
        } else if (res.info) {
          setRumble(res.info);
        }
      } catch (e) {
        notify(String(e), { kind: "error" });
      } finally {
        setRumbleBusy(false);
      }
    },
    [call],
  );

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

  const handleRemoveBlacklist = useCallback(async () => {
    setBlacklistBusy(true);
    try {
      const res = (await call("removeHidOxpBlacklist")) as {
        success: boolean;
        error?: string;
        hidOxp?: HidOxpStatus;
      };
      if (!res.success) {
        notify(res.error ?? "Couldn't remove the driver blacklist.", { kind: "error" });
      } else {
        notify("hid-oxp blacklist removed — reboot to restore the driver.", {
          kind: "success",
        });
      }
    } finally {
      setBlacklistBusy(false);
      await refresh();
    }
  }, [call, refresh]);

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
                Not a OneXPlayer handheld
              </div>
              <div className="text-sm text-base-content/80 leading-relaxed">
                These fixes target OneXPlayer hardware — the gamepad recovery rebinds the USB
                controller its internal pad sits behind, and the fingerprint block targets the
                reader on those boards. Neither applies here.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const status = data.status!;
  const healthy = status.gamepadPresent;
  // On a OneXPlayer we haven't measured, the pad may enumerate under ids we
  // don't know. Say that rather than offering a rebind that can't report
  // success — the recovery only works on the OneXPlayer HID MCU.
  const gamepadUnknown = status.gamepadUnknown === true;
  const hidOxp = data.hidOxp;

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          <div className="card-body p-6">
            <div className="text-sm text-base-content/80 leading-relaxed">
              On OneXPlayer handhelds the xHCI USB controller can die when the device wakes from
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
              variant={healthy ? "success" : gamepadUnknown ? "info" : "warning"}
              icon={
                healthy ? (
                  <FaCircleCheck size={14} />
                ) : gamepadUnknown ? (
                  <FaCircleInfo size={14} />
                ) : (
                  <FaTriangleExclamation size={14} />
                )
              }
              title={
                healthy
                  ? "Controller healthy"
                  : gamepadUnknown
                    ? "Gamepad not recognised"
                    : "Controller missing"
              }
            >
              {status.summary}
            </Alert>

            <div className="text-[11px] text-base-content/45 mono">
              controller {status.controller} · driver {status.driverBound ? "bound" : "unbound"} ·
              gamepad{" "}
              {status.gamepadPresent ? "present" : gamepadUnknown ? "unrecognised" : "absent"}
            </div>

            <div className="mt-2">
              <Button onClick={handleRecover} disabled={busy || gamepadUnknown}>
                <span className="flex items-center gap-2">
                  <FaRotate className={busy ? "animate-spin" : undefined} size={13} />
                  {busy ? "Recovering…" : "Recover gamepad"}
                </span>
              </Button>
            </div>

            <div className="text-xs text-base-content/55 leading-relaxed">
              {gamepadUnknown
                ? "Unavailable on this device: recovery works by rebinding the USB controller the gamepad sits behind, and we can't tell which one that is here. Rebinding the wrong one would reset whatever else is attached to it."
                : "Safe to run any time — if the controller is already working it does nothing, so there's no harm in pressing it."}
            </div>

            <div className="flex justify-between items-start gap-4 pt-4 mt-1 border-t border-base-300">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm text-base-content font-medium">
                  Recover automatically on wake
                </span>
                <span className="text-xs text-base-content/55 leading-relaxed">
                  {gamepadUnknown
                    ? "Unavailable while the gamepad can't be identified — this would run the same unsafe rebind unattended, on every wake."
                    : "Run this recovery whenever the device wakes from sleep, so you never have to press the button. Only rebinds if the gamepad is actually missing."}
                </span>
              </div>
              <Toggle
                checked={!!data.autoRecoverOnWake}
                // Can't be armed on a device where recovery is unavailable —
                // but if it's already on (ids were recognised, then the pad
                // dropped), it must stay switchable OFF or the user is stuck
                // with a listener they can see and can't stop.
                disabled={autoWakeBusy || (gamepadUnknown && !data.autoRecoverOnWake)}
                onChange={handleToggleAutoWake}
              />
            </div>
          </div>
        </div>

        {rumble?.available && (
          <div className="card">
            <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
              <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
                <FaGamepad className="w-3 h-3" /> Vibration
              </div>
            </div>
            <div className="card-body p-6 flex flex-col gap-4">
              <div className="flex items-baseline justify-between gap-3">
                <div className="metric-label">Rumble intensity</div>
                <div className="mono text-sm">
                  {rumble.intensity === null
                    ? "—"
                    : intensityLabel(rumble.intensity, { min: rumble.min, max: rumble.max })}
                </div>
              </div>

              <div className="segmented flex w-full">
                {rumbleLevels(rumble.min, rumble.max).map((level) => (
                  <SegmentedItem
                    key={level}
                    className="flex-1"
                    disabled={rumbleBusy}
                    active={rumble.intensity === level}
                    onSelect={() => void handleSetRumble(level)}
                  >
                    {level === rumble.min ? "Off" : String(level)}
                  </SegmentedItem>
                ))}
              </div>

              <div className="text-xs text-base-content/55 leading-relaxed">
                A master level for the built-in gamepad&apos;s motors, applied by the firmware.
                Games and Steam Input still decide what rumbles and how strongly — this scales all
                of it, including in titles that ignore Steam&apos;s own rumble setting.
              </div>

              {rumble.source === "driver" && (
                <div className="text-xs text-base-content/45 leading-relaxed">
                  Showing the driver&apos;s current value. It resets to maximum whenever the driver
                  reloads, so it may not match what you last felt — pick a level to pin it.
                </div>
              )}
            </div>
          </div>
        )}

        {hidOxp?.blacklisted && (
          <div className="card">
            <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
              <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
                <FaMicrochip className="w-3 h-3" /> Driver blacklist
              </div>
            </div>
            <div className="card-body p-6 flex flex-col gap-4">
              <div className="text-sm text-base-content/80 leading-relaxed">
                The OneXPlayer <span className="mono">hid-oxp</span> driver is currently blacklisted
                on this device — an older workaround for the built-in gamepad dropping out on wake.
                <span className="font-medium"> Recover automatically on wake</span> (above) is the
                fix now, so you can safely remove the blacklist and restore the driver. Doing so
                also restores the controls that live in this driver — rumble intensity, gamepad
                mode and button remapping.
              </div>

              {hidOxp.rebootRequired && (
                <Alert
                  variant="warning"
                  icon={<FaTriangleExclamation size={14} />}
                  title="Reboot required"
                >
                  The blacklist is set but <span className="mono">hid-oxp</span> is still loaded.
                  Reboot to apply it.
                </Alert>
              )}

              <div>
                <Button onClick={handleRemoveBlacklist} disabled={blacklistBusy}>
                  <span className="flex items-center gap-2">
                    <FaRotate className={blacklistBusy ? "animate-spin" : undefined} size={13} />
                    {blacklistBusy ? "Removing…" : "Remove blacklist"}
                  </span>
                </Button>
              </div>

              <div className="text-xs text-base-content/55 leading-relaxed">
                Removes <span className="mono">/etc/modprobe.d/hid-oxp.conf</span> and restores the
                driver on the next reboot.
              </div>
            </div>
          </div>
        )}

        {data.fingerprint?.supported && (
          <div className="card">
            <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
              <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
                <FaFingerprint className="w-3 h-3" /> Fingerprint wake
              </div>
            </div>
            <div className="card-body p-6 flex flex-col gap-4">
              <div className="text-sm text-base-content/80 leading-relaxed">
                The power button's fingerprint sensor wakes the device from sleep on a light touch —
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

              {!data.fingerprint.kargActive &&
                data.fingerprint.kargApplicable &&
                data.fingerprint.distro !== "steamos" && (
                  <div className="text-xs text-base-content/55 leading-relaxed">
                    On {data.fingerprint.distro || "this distro"} the GPIO kernel arg can&apos;t be
                    applied automatically yet. Add{" "}
                    <span className="mono">gpiolib_acpi.ignore_wake=AMDI0030:00@58</span> to your
                    kernel command line and reboot to fully block the touch wake.
                  </div>
                )}

              {!data.fingerprint.kargApplicable && (
                <div className="text-xs text-base-content/55 leading-relaxed">
                  Wake from the reader is blocked at its USB controller, which is derived from your
                  hardware. There&apos;s a second, belt-and-braces kernel argument we apply on the
                  Apex, but it names a specific GPIO pin on that board — we don&apos;t know this
                  model&apos;s, and the wrong pin is worse than none.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">OneXPlayer</h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Gamepad + fingerprint fixes
      </span>
    </div>
  );
}

export const mount = mountComponent(Apex);
export const mountHeader = mountComponent(Header);
