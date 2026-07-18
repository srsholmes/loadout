import { useState, useEffect, useCallback } from "react";
import { FaWifi, FaTriangleExclamation, FaCircleCheck, FaRotate } from "react-icons/fa6";
import { Alert, Button, Spinner, Toggle, mountComponent, notify, useBackend } from "@loadout/ui";

export const icon = FaWifi;

interface LastRecovery {
  ok: boolean;
  stage: string;
  tier: string | null;
  iface: string | null;
  detail: string;
  at: number;
  source: string;
}

interface StatusResult {
  iface: string | null;
  nmConfigured: boolean;
  iwdPresent: boolean;
  iwdConfigured: boolean;
  runtime: "on" | "off" | null;
  configured: boolean;
  powerSaveDisabled: boolean;
  listenerRunning: boolean;
  autoRecover: boolean;
  recovering: boolean;
  lastRecovery: LastRecovery | null;
  watchdogSuspended: boolean;
  lastKnownDriver: { driver: string; iface: string } | null;
}

function Wifi() {
  const { call, useEvent } = useBackend("wifi");

  const [data, setData] = useState<StatusResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoverBusy, setRecoverBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);

  const refresh = useCallback(async () => {
    setData((await call("getStatus")) as StatusResult);
  }, [call]);

  useEvent({ event: "statusChanged", handler: () => refresh() });
  // Watchdog-initiated recoveries reflect in the UI too (spinner + result).
  useEvent({ event: "recoveryState", handler: () => refresh() });

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        const res = (await call("setPowerSaveDisabled", next)) as {
          success: boolean;
          error?: string;
        };
        if (!res.success) {
          notify(res.error ?? "Couldn't update the WiFi setting.", { kind: "error" });
        } else {
          notify(
            next ? "WiFi power saving disabled." : "WiFi power saving restored.",
            { kind: "success" },
          );
        }
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [call, refresh],
  );

  const handleRecover = useCallback(async () => {
    setRecoverBusy(true);
    try {
      const res = (await call("recoverRadio")) as LastRecovery;
      if (res.ok) {
        notify(
          res.iface ? `WiFi radio recovered — back as ${res.iface}.` : "WiFi radio recovered.",
          { kind: "success" },
        );
      } else {
        notify(res.detail || "WiFi recovery failed.", { kind: "error" });
      }
    } finally {
      setRecoverBusy(false);
      await refresh();
    }
  }, [call, refresh]);

  const handleToggleAutoRecover = useCallback(
    async (next: boolean) => {
      setAutoBusy(true);
      try {
        const res = (await call("setAutoRecover", next)) as { success: boolean; error?: string };
        if (!res.success) {
          notify(res.error ?? "Couldn't update auto-recover.", { kind: "error" });
        } else {
          notify(next ? "Auto-recover enabled — watching the radio." : "Auto-recover disabled.", {
            kind: "success",
          });
        }
      } finally {
        setAutoBusy(false);
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

  const on = data.powerSaveDisabled;
  const runtimeOff = data.runtime === "off";
  const recovering = recoverBusy || data.recovering;

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          <div className="card-body p-6">
            <div className="text-sm text-base-content/80 leading-relaxed">
              On some handhelds the WiFi radio parks itself in power-saving mode and never
              cleanly recovers, so the connection drops until you reboot. Turning power saving
              off keeps the link alive. This writes a NetworkManager setting (and an iwd quirk
              where iwd is used), applies it immediately without dropping your connection, and
              re-applies it every time the device wakes from sleep.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaWifi className="w-3 h-3" /> WiFi power saving
            </div>
          </div>
          <div className="card-body p-6 flex flex-col gap-4">
            <Alert
              variant={on ? "success" : "warning"}
              icon={on ? <FaCircleCheck size={14} /> : <FaTriangleExclamation size={14} />}
              title={on ? "Power saving disabled" : "Power saving on (default)"}
            >
              {on
                ? "WiFi power saving is off — the link should stay up across sleep."
                : "WiFi power saving is on. If your connection keeps dropping, turn it off below."}
            </Alert>

            <div className="text-[11px] text-base-content/45 mono">
              {data.iface ? `interface ${data.iface}` : "no wireless interface"} · runtime{" "}
              {data.runtime ?? "unknown"} · NetworkManager {data.nmConfigured ? "set" : "default"}
              {data.iwdPresent ? ` · iwd ${data.iwdConfigured ? "set" : "default"}` : ""}
            </div>

            {on && !runtimeOff && data.iface && (
              <Alert variant="warning" icon={<FaTriangleExclamation size={14} />} title="Reconnect to fully apply">
                Power saving is set to off but the radio still reports it on. It'll take full
                effect on the next reconnect or reboot.
              </Alert>
            )}

            <div className="flex justify-between items-start gap-4 pt-2">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm text-base-content font-medium">
                  Disable WiFi power saving
                </span>
                <span className="text-xs text-base-content/55 leading-relaxed">
                  Persists across reboots and re-applies on every wake. Reversible — turn it off
                  to restore the system default. May slightly increase idle power draw.
                </span>
              </div>
              <Toggle checked={on} disabled={busy} onChange={handleToggle} />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header flex items-center gap-2 py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaRotate className="w-3 h-3" /> Radio recovery
            </div>
          </div>
          <div className="card-body p-6 flex flex-col gap-4">
            <div className="text-sm text-base-content/80 leading-relaxed">
              If the WiFi firmware crashes, the radio shows as unavailable and the connection is
              gone until a reboot. This reloads the WiFi driver in place — escalating to a PCI
              reset of the card if the reload isn't enough — so you get back online without
              rebooting. Your saved network reconnects automatically afterwards.
            </div>

            {data.autoRecover && data.watchdogSuspended && (
              <Alert
                variant="warning"
                icon={<FaTriangleExclamation size={14} />}
                title="Auto-recovery paused"
              >
                Automatic recovery failed several times in a row and is paused. Press the button
                to try again, or toggle auto-recover off and on to reset it.
              </Alert>
            )}

            <div>
              <Button onClick={handleRecover} disabled={recovering}>
                <span className="flex items-center gap-2">
                  <FaRotate className={recovering ? "animate-spin" : undefined} size={13} />
                  {recovering ? "Recovering…" : "Recover WiFi radio"}
                </span>
              </Button>
            </div>

            <div className="text-xs text-base-content/55 leading-relaxed">
              Reloading the driver briefly drops WiFi even when it's working — avoid pressing
              this mid-download.
            </div>

            {data.lastRecovery && (
              <div className="text-[11px] text-base-content/45 mono">
                last recovery: {data.lastRecovery.ok ? "ok" : `failed at ${data.lastRecovery.stage}`}
                {data.lastRecovery.iface ? ` · ${data.lastRecovery.iface}` : ""} ·{" "}
                {data.lastRecovery.source}
                {data.lastRecovery.tier ? ` · ${data.lastRecovery.tier}` : ""}
              </div>
            )}

            <div className="flex justify-between items-start gap-4 pt-4 mt-1 border-t border-base-300">
              <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm text-base-content font-medium">Auto-recover radio</span>
                <span className="text-xs text-base-content/55 leading-relaxed">
                  Watches the radio and reloads the driver automatically if it crashes. Never
                  runs while WiFi is deliberately switched off. Persists across restarts.
                </span>
              </div>
              <Toggle
                checked={!!data.autoRecover}
                disabled={autoBusy}
                onChange={handleToggleAutoRecover}
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
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">WiFi</h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Power saving & radio recovery
      </span>
    </div>
  );
}

export const mount = mountComponent(Wifi);
export const mountHeader = mountComponent(Header);
