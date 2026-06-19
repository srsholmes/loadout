import { useState, useEffect, useCallback, useRef } from "react";
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
  Spinner,
  mountComponent,
  mountHeaderStub,
  notify,
  useBackend,
} from "@loadout/ui";
import type { BluetoothDevice, AdapterInfo } from "./lib/parse";

export const icon = FaBluetoothB;

// After `bluetoothctl power on/off` returns, the adapter can take a
// second or two to actually report the new state via `bluetoothctl
// show`. Poll a handful of times rather than trusting a single early
// read (which used to clobber the optimistic value straight back).
const POWER_POLL_MS = 500;
const POWER_POLL_TRIES = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  // Target power state of an in-flight togglePower, or null when idle.
  // Used both to ignore contradictory adapterChanged ticks mid-toggle
  // and to bail the confirm-poll if the user toggles again.
  const pendingPowerRef = useRef<boolean | null>(null);
  // Guards the awaited confirm-poll from setState-ing after unmount.
  const mountedRef = useRef(true);

  useEvent({
    event: "deviceChanged",
    handler: (data) => {
      const changed = data as BluetoothDevice;
      setDevices((prev) => prev.map((d) => (d.mac === changed.mac ? changed : d)));
    },
  });

  useEvent({
    event: "adapterChanged",
    handler: (data) => {
      const info = data as AdapterInfo;
      // While a power toggle is settling, ignore backend poll ticks that
      // disagree with the requested state so a mid-transition read can't
      // bounce the UI back.
      if (pendingPowerRef.current !== null && info.powered !== pendingPowerRef.current) {
        return;
      }
      setAdapter(info);
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

  // Tracked timers — short-deferred refresh()/stopScan calls that
  // mustn't fire after unmount, otherwise setState lands on a torn-
  // down component and React warns. Stored as a Set so add/remove
  // are O(1) and the style stays consistent (no mix of .push +
  // = .filter()).
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const schedule = useCallback(
    (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const id = setTimeout(() => {
        timersRef.current.delete(id);
        fn();
      }, ms);
      timersRef.current.add(id);
      return id;
    },
    [],
  );
  // Dedicated slot for the 15 s scan-stop deferred call — needs to be
  // cancelable independently of the generic timers above so that a
  // user-initiated stop or restart within the 15 s window doesn't let
  // a stale timer fire and kill the new scan.
  const scanStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      mountedRef.current = false;
      for (const id of timersRef.current) clearTimeout(id);
      timersRef.current.clear();
      if (scanStopTimerRef.current !== null) {
        clearTimeout(scanStopTimerRef.current);
        scanStopTimerRef.current = null;
      }
    },
    [],
  );

  const handleTogglePower = useCallback(async () => {
    if (!adapter) return;
    const next = !adapter.powered;
    pendingPowerRef.current = next;
    setAdapter((prev) => (prev ? { ...prev, powered: next } : prev));

    try {
      await call("togglePower", next);
    } catch (err) {
      // Command actually failed (e.g. rfkill block) — revert the
      // optimistic flip and surface it rather than leaving a lie on screen.
      console.error("[bluetooth] togglePower failed:", err);
      pendingPowerRef.current = null;
      setAdapter((prev) => (prev ? { ...prev, powered: !next } : prev));
      notify(`Couldn't turn Bluetooth ${next ? "on" : "off"}`, { kind: "error" });
      return;
    }

    // Poll until the adapter confirms the requested state. Keep the
    // optimistic value visible meanwhile; a transient "not yet" read
    // must not flip the UI back.
    for (let i = 0; i < POWER_POLL_TRIES; i++) {
      await sleep(POWER_POLL_MS);
      // Bail if unmounted or the user toggled again (new target wins).
      if (!mountedRef.current || pendingPowerRef.current !== next) return;
      let info: AdapterInfo;
      try {
        info = (await call("getAdapterInfo")) as AdapterInfo;
      } catch {
        continue;
      }
      if (!mountedRef.current || pendingPowerRef.current !== next) return;
      if (info.powered === next) {
        pendingPowerRef.current = null;
        setAdapter(info);
        return;
      }
    }

    // Never converged — accept reality and tell the user if it didn't power on.
    pendingPowerRef.current = null;
    try {
      const finalInfo = (await call("getAdapterInfo")) as AdapterInfo;
      if (!mountedRef.current) return;
      setAdapter(finalInfo);
      if (next && !finalInfo.powered) {
        notify("Bluetooth didn't power on", { kind: "error" });
      }
    } catch {
      /* leave the optimistic value in place */
    }
  }, [adapter, call]);

  const withBusy = useCallback(
    async (mac: string, fn: () => Promise<void>) => {
      setBusyDevices((prev) => new Set(prev).add(mac));
      try {
        await fn();
      } finally {
        setBusyDevices((prev) => {
          const next = new Set(prev);
          next.delete(mac);
          return next;
        });
      }
    },
    [],
  );

  const handleConnect = useCallback(
    (mac: string) => withBusy(mac, async () => {
      try {
        await call("connectDevice", mac);
        setDevices((prev) => prev.map((d) => (d.mac === mac ? { ...d, connected: true } : d)));
      } catch (err) { console.error("[bluetooth] Connect failed:", err); }
    }),
    [call, withBusy],
  );

  const handleDisconnect = useCallback(
    (mac: string) => withBusy(mac, async () => {
      try {
        await call("disconnectDevice", mac);
        setDevices((prev) => prev.map((d) => (d.mac === mac ? { ...d, connected: false } : d)));
      } catch (err) { console.error("[bluetooth] Disconnect failed:", err); }
    }),
    [call, withBusy],
  );

  const handleScan = useCallback(async () => {
    // A prior 15 s auto-stop timer may still be pending. Always cancel
    // it before deciding what to do — otherwise a manual stop + restart
    // within 15 s lets the old timer fire mid-second-scan and silently
    // kill the new discovery.
    if (scanStopTimerRef.current !== null) {
      clearTimeout(scanStopTimerRef.current);
      scanStopTimerRef.current = null;
    }
    if (scanning) {
      await call("stopScan");
      setScanning(false);
    } else {
      setScanning(true);
      await call("startScan");
      const id = setTimeout(async () => {
        scanStopTimerRef.current = null;
        await call("stopScan");
        setScanning(false);
        refresh();
      }, 15000);
      scanStopTimerRef.current = id;
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

/** Mount this plugin into a container element. */
export const mount = mountComponent(BluetoothManager);

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot — the actual header
 * content is portaled from inside `mount()` via `<PluginHeader>` so
 * power state, scan state, and the toggle callbacks share the body's
 * React tree without any cross-root pub/sub.
 */
export const mountHeader = mountHeaderStub;
