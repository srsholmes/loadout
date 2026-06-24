import { useState, useEffect, useCallback } from "react";
import { FaGamepad, FaTriangleExclamation, FaCircleCheck, FaRotate, FaMicrochip } from "react-icons/fa6";
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

interface StatusResult {
  unsupported: boolean;
  status?: XhciStatus;
  hidOxp?: HidOxpStatus;
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
  const [blacklistBusy, setBlacklistBusy] = useState(false);

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
