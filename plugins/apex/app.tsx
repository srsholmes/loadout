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

/** Mirrors the backend's shape — declared here rather than imported, so the
 *  frontend bundle never pulls in backend.ts. */
interface FingerprintHealNotice {
  restored: boolean;
  rebootRequired: boolean;
  error?: string;
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
  kargUnpersisted: boolean;
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

/**
 * Reboot, behind a two-click confirm.
 *
 * The shell has this pattern in Settings (`MaintenanceActionRow`) but it
 * isn't exported to plugins, so it's reproduced here for the same reason it
 * exists there: a stray d-pad press must not power-cycle the device
 * mid-game. Arming reverts after 4s.
 */
function RebootButton({ call }: { call: (m: string, ...a: unknown[]) => Promise<unknown> }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const onClick = useCallback(async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      const res = (await call("rebootDevice")) as { success: boolean; error?: string } | null;
      // Success normally never renders — the device is going down.
      if (!res?.success) notify(res?.error ?? "Couldn't reboot.", { kind: "error" });
    } catch (e) {
      notify(String(e), { kind: "error" });
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }, [armed, call]);

  return (
    <Button onClick={onClick} disabled={busy} variant={armed ? "danger" : undefined}>
      {busy ? "Restarting…" : armed ? "Click again to confirm" : "Restart device"}
    </Button>
  );
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
  const [healed, setHealed] = useState<FingerprintHealNotice | null>(null);

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
    // Only lands here when init() didn't already consume it — i.e. the user
    // opened the plugin before the toast fired, or the overlay restarted.
    call("getFingerprintHealNotice")
      .then((d) => setHealed(d as FingerprintHealNotice | null))
      .catch(() => setHealed(null));
  }, [refresh, call]);

  const handleRescanRumble = useCallback(async () => {
    setRumbleBusy(true);
    try {
      setRumble((await call("rescanRumble")) as RumbleInfo);
    } catch (e) {
      notify(String(e), { kind: "error" });
    } finally {
      setRumbleBusy(false);
    }
  }, [call]);

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

        {rumble && !rumble.available && (
          <div className="card">
            <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
              <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
                <FaGamepad className="w-3 h-3" /> Vibration
              </div>
            </div>
            <div className="card-body p-6 flex flex-col gap-4">
              <div className="text-sm text-base-content/80 leading-relaxed">
                Nothing here exposes <span className="mono">rumble_intensity</span>, so the rumble
                level can&apos;t be set. That usually means the{" "}
                <span className="mono">hid-oxp</span> driver isn&apos;t loaded — it needs a kernel
                carrying it, and it can be blacklisted (see below) — or this is a
                first-generation OneXPlayer, where the driver exposes RGB only.
              </div>
              <div>
                <Button onClick={() => void handleRescanRumble()} disabled={rumbleBusy}>
                  {rumbleBusy ? "Checking…" : "Check again"}
                </Button>
              </div>
            </div>
          </div>
        )}

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
                <>
                  <Alert
                    variant="warning"
                    icon={<FaTriangleExclamation size={14} />}
                    title="Reboot required"
                  >
                    A kernel-parameter change is staged. Reboot to finish applying the fingerprint
                    wake block.
                  </Alert>
                  {/* Only here: this is the one state where a reboot actually
                      helps. Never for kargUnpersisted, where rebooting is
                      what LOSES the karg. */}
                  <div>
                    <RebootButton call={call} />
                  </div>
                </>
              )}

              {healed?.restored && (
                <Alert
                  variant="success"
                  icon={<FaCircleCheck size={14} />}
                  title="Restored after a system update"
                >
                  The wake block had been removed — system updates regenerate the files it lives
                  in. It has been re-applied automatically
                  {healed.rebootRequired
                    ? ", though the kernel-argument layer needs a reboot to come back."
                    : ", and is in effect now."}
                </Alert>
              )}

              {data.fingerprint.kargUnpersisted && (
                <Alert
                  variant="info"
                  icon={<FaCircleInfo size={14} />}
                  title="Active, but not saved to your bootloader"
                >
                  The kernel argument is live on this boot but missing from the bootloader config —
                  a SteamOS update regenerates that file and drops it. The block still works right
                  now; switch it off and on again to write it back, so it survives the next reboot.
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

/**
 * Runs at overlay boot for every `loadOnStartup` plugin, before the user has
 * opened anything — so the self-heal can be reported without them going
 * looking for it.
 *
 * Pulls rather than subscribes: `emit` is fire-and-forget with no replay, and
 * the backend starts before the overlay connects, so a heal that already
 * finished would never be seen. `getFingerprintHealNotice` awaits any
 * in-flight heal and clears the notice, so this toasts once per backend
 * start.
 */
export async function init(api: {
  call: (method: string, ...args: unknown[]) => Promise<unknown>;
  subscribe: (event: string, handler: (data: unknown) => void) => () => void;
}): Promise<void> {
  // Start listening BEFORE the first await. The event fires once, on the
  // transition, so attaching it after the RPC round-trip can miss the window
  // opening in between and then wait forever. The shell registers its own
  // update-toast listener synchronously for the same reason.
  const visible = whenOverlayVisible();

  let notice: FingerprintHealNotice | null = null;
  try {
    notice = (await api.call("getFingerprintHealNotice")) as FingerprintHealNotice | null;
  } catch {
    // A backend that isn't up yet, or a device this plugin is inert on.
    visible.cancel();
    return;
  }
  if (!notice) {
    visible.cancel();
    return;
  }

  // The window boots hidden and the overlay unit starts at login, so a toast
  // fired now lands where nobody is looking and is gone before they open it.
  await visible.promise;

  if (notice.restored) {
    notify(
      notice.rebootRequired
        ? "Fingerprint wake block was restored after a system update. Reboot to finish re-applying it."
        : "Fingerprint wake block was restored after a system update.",
      { kind: "success", id: "apex-fp-healed", duration: 8000 },
    );
  } else {
    notify(`Couldn't restore the fingerprint wake block: ${notice.error ?? "unknown error"}`, {
      kind: "error",
      id: "apex-fp-healed",
      duration: 10000,
    });
  }
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
    cancel: () => window.removeEventListener("loadout:overlay-visibility", onVisible as EventListener),
  };
}

export const mount = mountComponent(Apex);
export const mountHeader = mountComponent(Header);
