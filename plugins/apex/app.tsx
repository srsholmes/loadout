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
  manualKarg?: string;
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
  /** How the kernel arg gets staged here: steamos | ostree | manual | unknown | none. */
  kargMode: string;
  /** We stage the kernel arg ourselves on this machine. */
  kargAutomatic: boolean;
  kargStagedUnknown: boolean;
  /** Our udev rule is on disk — the marker for "the block is meant to be on",
   *  which is what tells a pending apply from a pending revert. */
  udevRuleInstalled: boolean;
  distro: string;
}

interface StatusResult {
  unsupported: boolean;
  status?: XhciStatus;
  hidOxp?: HidOxpStatus;
  fingerprint?: FingerprintStatus;
  autoRecoverOnWake?: boolean;
  listenerRunning?: boolean;
  fingerprintBlockWanted?: boolean;
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
 * Reboot, behind a confirm the user has to move focus to.
 *
 * NOT a two-click confirm on one button. `a` is a RepeatableAction in the
 * nav controller (REPEAT_DELAY_MS 500, REPEAT_RATE_MS 200) and every repeat
 * dispatches a synthetic Enter that Button turns into an onClick — so a
 * single *held* A press would arm at t=0 and confirm at t=500ms and
 * power-cycle the device mid-game. No time-based guard fixes that; the
 * repeat train just keeps firing.
 *
 * Arming instead reveals a separate button. A held press keeps landing on
 * the one already focused, so it can never reach the confirm.
 */
function RebootButton({ call }: { call: (m: string, ...a: unknown[]) => Promise<unknown> }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);

  const confirm = useCallback(async () => {
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
  }, [call]);

  return (
    <div className="flex gap-2 flex-wrap items-center">
      <Button onClick={() => setArmed(true)} disabled={busy}>
        Restart device
      </Button>
      {armed && (
        <>
          <Button onClick={() => void confirm()} disabled={busy} variant="danger">
            {busy ? "Restarting…" : "Confirm restart"}
          </Button>
          <span className="text-xs text-base-content/55">Closes any running game.</span>
        </>
      )}
    </div>
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
    // A rejected getStatus (RPC timeout while rpm-ostree is busy, backend
    // restarting) used to leave `data` null forever with the page on its
    // spinner, plus an unhandled rejection.
    try {
      setData((await call("getStatus")) as StatusResult);
    } catch (e) {
      notify(`Couldn't read device status: ${e}`, { kind: "error", id: "apex-status" });
    }
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
      .then((d) => {
        const n = d as FingerprintHealNotice | null;
        setHealed(n);
        // Rendered it, so it has served its purpose.
        if (n) void call("ackFingerprintHealNotice").catch(() => {});
      })
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
            next
              ? "Controller wake blocked. One wake path still needs a kernel argument — see the panel."
              : "Controller wake restored. The kernel argument is still live — see the panel.",
            { kind: "success" },
          );
        } else if (res.rebootRequired) {
          notify(`Reboot required to finish ${next ? "blocking" : "restoring"} fingerprint wake.`, {
            kind: "success",
          });
        } else {
          notify(next ? "Fingerprint wake blocked." : "Fingerprint wake restored.", { kind: "success" });
        }
      } catch (e) {
        // setFingerprintBlock can outlive the RPC cap (rpm-ostree staging a
        // deployment). Without this the user got no feedback at all.
        notify(String(e), { kind: "error" });
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
                    Disables the sensor&apos;s USB-controller wake
                    {data.fingerprint.kargAutomatic
                      ? " and adds a kernel parameter for the GPIO wake line."
                      : data.fingerprint.kargMode === "none"
                        ? "; the GPIO wake line needs a kernel parameter naming a pin we haven't measured on this model."
                        : "; the GPIO wake line needs a kernel parameter we can't add automatically on this system."}
                  </span>
                </div>
                <Toggle
                  checked={!!data.fingerprintBlockWanted}
                  disabled={fpBusy}
                  onChange={handleToggleFingerprint}
                />
              </div>

              {/* The switch reflects the user's choice, so it can sit ON while
                  nothing is in effect — a failed apply, or a staged read we
                  couldn't make. Without this the panel showed a control in
                  the on position and no indication anywhere that it wasn't. */}
              {data.fingerprintBlockWanted &&
                !data.fingerprint.applied &&
                !data.fingerprint.rebootPending && (
                  <Alert
                    variant="warning"
                    icon={<FaTriangleExclamation size={14} />}
                    title="Asked for, but not in effect"
                  >
                    The wake block is switched on but isn&apos;t currently applied. Switch it off
                    and on again to retry
                    {data.fingerprint.kargStagedUnknown
                      ? " — we also couldn't read what your next boot will carry."
                      : "."}
                  </Alert>
                )}

              {data.fingerprint.rebootPending && (
                <>
                  <Alert
                    variant="warning"
                    icon={<FaTriangleExclamation size={14} />}
                    title="Reboot required"
                  >
                    {/* rebootPending covers both directions — staged-not-live
                        (a pending apply) and live-not-staged with the rule
                        gone (a pending revert). The udev rule tells them
                        apart; saying "applying" for a revert told a user who
                        had just switched it OFF the opposite of the truth. */}
                    {data.fingerprint.udevRuleInstalled
                      ? "A kernel-parameter change is staged. Reboot to finish applying the fingerprint wake block."
                      : "The wake block is off, but its kernel parameter is still live on this boot. Reboot to finish removing it."}
                  </Alert>
                  {/* Only here: this is the one state where a reboot actually
                      helps. Never for kargUnpersisted, where rebooting is
                      what LOSES the karg. */}
                  <div>
                    <RebootButton call={call} />
                  </div>
                </>
              )}

              {healed && !healed.restored && (
                <Alert
                  variant="warning"
                  icon={<FaTriangleExclamation size={14} />}
                  title="Couldn't restore the wake block"
                >
                  A system update removed the wake block and re-applying it failed
                  {healed.error ? `: ${healed.error}` : "."}{" "}
                  {healed.manualKarg
                    ? "Add this to your kernel command line and reboot instead: "
                    : "Switching it off and on again should put it back."}
                  {healed.manualKarg && <span className="mono">{healed.manualKarg}</span>}
                </Alert>
              )}

              {healed?.restored && (
                <Alert
                  variant="success"
                  icon={<FaCircleCheck size={14} />}
                  title="Restored after a system update"
                >
                  The wake block had been removed — system updates regenerate the files it lives
                  in. It has been re-applied automatically
                  {healed.manualKarg
                    ? ", but the GPIO layer still needs a kernel argument this distro won't let us add — see below."
                    : healed.rebootRequired
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
                  The kernel argument is live on this boot but missing from the boot configuration
                  — a system update can regenerate that and drop it. The block still works right
                  now; switch it off and on again to write it back, so it survives the next reboot.
                </Alert>
              )}

              {/* The touch has two independent wake paths and this one closes
                  only with a kernel arg, so these are genuinely incomplete
                  blocks — not niceties. */}
              {data.fingerprint.applied &&
                !data.fingerprint.kargActive &&
                data.fingerprint.kargMode === "manual" && (
                <Alert
                  variant="warning"
                  icon={<FaTriangleExclamation size={14} />}
                  title="One wake path is still open"
                >
                  <div className="flex flex-col gap-2">
                    <div className="leading-relaxed">
                      The reader&apos;s USB controller is blocked, but the GPIO wake line needs a
                      kernel argument and {data.fingerprint.distro || "this distro"}&apos;s
                      bootloader isn&apos;t one we manage. Until you add it, a touch can still wake
                      the device. Add:
                    </div>
                    <div className="mono text-[11px]">
                      gpiolib_acpi.ignore_wake=AMDI0030:00@58
                    </div>
                    <div className="leading-relaxed">to your kernel command line, then reboot.</div>
                    <div className="leading-relaxed text-base-content/45">
                      We do this automatically on SteamOS and on Bazzite (and other rpm-ostree
                      images). Elsewhere — CachyOS and Arch included — the bootloader isn&apos;t one
                      we edit, so this step is yours.
                    </div>
                  </div>
                </Alert>
              )}

              {data.fingerprint.applied && data.fingerprint.kargMode === "unknown" && (
                <Alert
                  variant="warning"
                  icon={<FaTriangleExclamation size={14} />}
                  title="One wake path is still open"
                >
                  The reader&apos;s USB controller is blocked, but we couldn&apos;t identify this
                  system well enough to add the kernel argument the GPIO wake line needs. Add{" "}
                  <span className="mono">gpiolib_acpi.ignore_wake=AMDI0030:00@58</span> to your
                  kernel command line and reboot.
                </Alert>
              )}

              {data.fingerprint.applied && data.fingerprint.kargMode === "none" && (
                <Alert
                  variant="warning"
                  icon={<FaTriangleExclamation size={14} />}
                  title="One wake path is still open"
                >
                  Wake from the reader is blocked at its USB controller, which is derived from your
                  hardware. The second path needs a kernel argument naming a specific GPIO pin — we
                  know the Apex&apos;s, but not this model&apos;s, and the wrong pin is worse than
                  none. A touch may still wake the device.
                </Alert>
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

  // Detached, not awaited: the window boots hidden and the overlay unit
  // starts at login, so this can wait hours. runStartupInits awaits every
  // init() in a Promise.all, and blocking that on one plugin's user
  // interaction would pin the whole startup chain.
  const shown = notice;
  void visible.promise.then(async () => {
    if (shown.restored) {
      notify(
        shown.manualKarg
          ? "Fingerprint wake block was partly restored after a system update — open the plugin to finish it."
          : shown.rebootRequired
            ? "Fingerprint wake block was restored after a system update. Reboot to finish re-applying it."
            : "Fingerprint wake block was restored after a system update.",
        { kind: "success", id: "apex-fp-healed", duration: 8000 },
      );
    } else {
      notify(`Couldn't restore the fingerprint wake block: ${shown.error ?? "unknown error"}`, {
        kind: "error",
        id: "apex-fp-healed",
        duration: 10000,
      });
    }
    // Only now: reading no longer consumes, so the plugin page can still
    // render the same notice if the user got there first.
    await api.call("ackFingerprintHealNotice").catch(() => {});
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
    cancel: () => window.removeEventListener("loadout:overlay-visibility", onVisible as EventListener),
  };
}

export const mount = mountComponent(Apex);
export const mountHeader = mountComponent(Header);
