import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  FaArrowsRotate,
  FaBluetoothB,
  FaMagnifyingGlass,
  FaPowerOff,
} from "react-icons/fa6";
import {
  Button,
  IconButton,
  PluginHeader,
  PluginProvider,
  Spinner,
  useBackend,
} from "@loadout/ui";
import type { BluetoothDevice, AdapterInfo } from "./lib/parse";

export const icon = FaBluetoothB;

/** Map device type to a text hint shown next to the name. */
function deviceTypeLabel(type: BluetoothDevice["type"]): string {
  switch (type) {
    case "audio":    return "Headphones";
    case "input":    return "Controller";
    case "keyboard": return "Keyboard";
    default:         return "Device";
  }
}

function BluetoothManager() {
  const { call, useEvent } = useBackend("bluetooth");

  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [adapter, setAdapter] = useState<AdapterInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [busyDevices, setBusyDevices] = useState<Set<string>>(new Set());

  useEvent({
    event: "deviceChanged",
    handler: (data) => {
      const changed = data as BluetoothDevice;
      setDevices((prev) => prev.map((d) => (d.mac === changed.mac ? changed : d)));
    },
  });

  const refresh = useCallback(async () => {
    try {
      const [devs, info] = await Promise.all([call("getDevices"), call("getAdapterInfo")]);
      setDevices(devs as BluetoothDevice[]);
      setAdapter(info as AdapterInfo);
    } catch (err) {
      console.error("[bluetooth] Failed to refresh:", err);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => { refresh(); }, [refresh]);

  // Tracked timers — we have three short-deferred refresh()/stopScan
  // calls that mustn't fire after unmount, otherwise setState lands
  // on a torn-down component and React warns. All scheduled work is
  // stored here and cleared on unmount.
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const schedule = useCallback(
    (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const id = setTimeout(() => {
        timersRef.current = timersRef.current.filter((t) => t !== id);
        fn();
      }, ms);
      timersRef.current.push(id);
      return id;
    },
    [],
  );
  useEffect(
    () => () => {
      for (const id of timersRef.current) clearTimeout(id);
      timersRef.current = [];
    },
    [],
  );

  const handleTogglePower = useCallback(async () => {
    if (!adapter) return;
    const next = !adapter.powered;
    setAdapter((prev) => (prev ? { ...prev, powered: next } : prev));
    await call("togglePower", next);
    schedule(refresh, 500);
  }, [adapter, call, refresh, schedule]);

  const withBusy = async (mac: string, fn: () => Promise<void>) => {
    setBusyDevices((prev) => new Set(prev).add(mac));
    try { await fn(); } finally {
      setBusyDevices((prev) => {
        const next = new Set(prev);
        next.delete(mac);
        return next;
      });
    }
  };

  const handleConnect = useCallback(
    (mac: string) => withBusy(mac, async () => {
      try {
        await call("connectDevice", mac);
        setDevices((prev) => prev.map((d) => (d.mac === mac ? { ...d, connected: true } : d)));
      } catch (err) { console.error("[bluetooth] Connect failed:", err); }
    }),
    [call],
  );

  const handleDisconnect = useCallback(
    (mac: string) => withBusy(mac, async () => {
      try {
        await call("disconnectDevice", mac);
        setDevices((prev) => prev.map((d) => (d.mac === mac ? { ...d, connected: false } : d)));
      } catch (err) { console.error("[bluetooth] Disconnect failed:", err); }
    }),
    [call],
  );

  const handleScan = useCallback(async () => {
    if (scanning) {
      await call("stopScan");
      setScanning(false);
    } else {
      setScanning(true);
      await call("startScan");
      schedule(async () => {
        await call("stopScan");
        setScanning(false);
        refresh();
      }, 15000);
    }
    schedule(refresh, 3000);
  }, [scanning, call, refresh, schedule]);

  const connectedCount = devices.filter((d) => d.connected).length;

  // Dynamic topbar header. Power state, scan state, and the toggle
  // callbacks are shared with the body by closure — the header
  // portals into the shell's reserved 60px topbar via
  // `<PluginHeader>` (same React tree, no cross-root plumbing).
  // Spinner rendered up here while `loading` is true so the topbar
  // never reads stale adapter state mid-fetch.
  const headerNode = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            Bluetooth
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            Pair devices without leaving your game
          </span>
        </div>

        {!loading && (
          <div className="flex items-center gap-2 shrink-0">
            <span className={adapter?.powered ? "chip chip-success" : "chip"}>
              ● {adapter?.powered ? "POWERED ON" : "POWERED OFF"}
            </span>
            {adapter?.powered ? (
              <IconButton
                onClick={handleScan}
                title={scanning ? "Stop scan" : "Scan for nearby devices"}
                ariaLabel={scanning ? "Stop scan" : "Scan for nearby devices"}
                variant="accent"
              >
                {scanning ? (
                  <FaArrowsRotate size={11} className="animate-spin" />
                ) : (
                  <FaMagnifyingGlass size={11} />
                )}
              </IconButton>
            ) : (
              <IconButton
                onClick={handleTogglePower}
                title="Turn adapter on"
                ariaLabel="Turn adapter on"
                variant="accent"
              >
                <FaPowerOff size={11} />
              </IconButton>
            )}
            {adapter?.powered && (
              <IconButton
                onClick={handleTogglePower}
                title="Turn adapter off"
                ariaLabel="Turn adapter off"
              >
                <FaPowerOff size={11} />
              </IconButton>
            )}
          </div>
        )}
      </div>
    </PluginHeader>
  );

  if (loading) {
    return (
      <>
        {headerNode}
        <div className="flex items-center justify-center h-full">
          <Spinner size={32} />
        </div>
      </>
    );
  }

  return (
    <>
      {headerNode}
      <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          {/* Adapter identity, power toggle, scan, and status pill
              all live in the portaled topbar header — the body owns
              only the device list. */}
          {adapter?.powered && (
            <div className="p-0">
              <div className="flex items-center justify-between px-5.5 pt-5 pb-3">
                <div className="subsection-label mb-0">Devices ({devices.length})</div>
                <span className="chip">{connectedCount} connected</span>
              </div>
              {scanning && (
                <div className="subsection-desc flex items-center gap-2 px-5.5 pb-3">
                  <Spinner size={14} /> Scanning for nearby devices (15 seconds)…
                </div>
              )}
              {devices.length === 0 ? (
                <div className="subsection-desc px-5.5 pb-5">
                  No paired devices found. Use system settings to pair a device first.
                </div>
              ) : (
                devices.map((device, i) => {
                  const isBusy = busyDevices.has(device.mac);
                  return (
                    <div
                      key={device.mac}
                      className={`flex items-center gap-3.5 px-4.5 py-3.5 ${i > 0 ? "border-t border-base-300" : ""}`}
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{
                          background: device.connected ? "var(--color-success)" : "var(--fg-3)",
                          boxShadow: device.connected
                            ? "0 0 0 3px color-mix(in oklab, var(--color-success) 25%, transparent)"
                            : "none",
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{device.name}</div>
                        <div className="mono text-[11px] text-base-content/50 truncate">
                          {deviceTypeLabel(device.type)} · {device.mac}
                        </div>
                      </div>
                      {isBusy ? (
                        <Spinner size={18} />
                      ) : device.connected ? (
                        <Button onClick={() => handleDisconnect(device.mac)}>Disconnect</Button>
                      ) : (
                        <Button variant="primary" onClick={() => handleConnect(device.mac)}>
                          Connect
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
      </div>
    </>
  );
}

/**
 * Collapse mount boilerplate into a factory per PLAYBOOK.md.
 * Each exported mount fn is one line.
 */
function mountComponent(
  Component: React.ComponentType,
  extraProps?: Record<string, unknown>,
) {
  return (
    container: HTMLElement,
    opts?: { parentFocusKey?: string; headerSlot?: HTMLElement | null },
  ): (() => void) => {
    const root = createRoot(container);
    root.render(
      <PluginProvider
        parentFocusKey={opts?.parentFocusKey}
        headerSlot={opts?.headerSlot ?? null}
        {...(extraProps ?? {})}
      >
        <Component />
      </PluginProvider>,
    );
    return () => root.unmount();
  };
}

export const mount = mountComponent(BluetoothManager);

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot — the actual header
 * content is portaled from inside `mount()` via `<PluginHeader>` so
 * power state, scan state, and the toggle callbacks share the body's
 * React tree without any cross-root pub/sub.
 */
export function mountHeader(): () => void {
  return () => {};
}
