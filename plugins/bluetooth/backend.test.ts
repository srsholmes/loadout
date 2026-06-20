import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";

// Mock @loadout/exec — must come before importing the SUT. The backend
// drives BlueZ through `busctl` (and rfkill) via runFull; scanning uses
// spawn. Capture the mock fns so each test can script bus responses.
const mockRunFull = mock(() =>
  Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
);
const mockSpawn = mock(() => ({ kill() {} }));
mock.module("@loadout/exec", () => ({
  runFull: mockRunFull,
  spawn: mockSpawn,
}));

import BluetoothBackend from "./backend";

// ---- bus response builders -------------------------------------------------

const ADAPTER = "/org/bluez/hci0";
const DEV = (mac: string) => `${ADAPTER}/dev_${mac.replace(/:/g, "_")}`;

const ok = (stdout: string) => Promise.resolve({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, code = 1) =>
  Promise.resolve({ stdout: "", stderr, exitCode: code });

/** True if a busctl invocation's args contain all of `needles`. */
const has = (cmd: string[], ...needles: string[]) =>
  needles.every((n) => cmd.includes(n));

/**
 * Build a runFull implementation from a small fixture describing the
 * adapter + devices, so individual tests only override what they care
 * about.
 */
function fakeBus(opts: {
  /** Device MACs present under the adapter (in tree order). */
  macs?: string[];
  adapter?: { powered: boolean; discovering: boolean; name: string; address: string };
  /** Per-MAC device props. */
  devices?: Record<
    string,
    { connected: boolean; paired: boolean; name?: string; icon?: string }
  >;
  /** No adapter on the bus at all. */
  noAdapter?: boolean;
}) {
  const macs = opts.macs ?? [];
  return (cmd: string[]) => {
    // tree --list
    if (has(cmd, "tree", "--list")) {
      if (opts.noAdapter) return ok("/\n/org\n/org/bluez");
      const lines = ["/", "/org", "/org/bluez", ADAPTER, ...macs.map(DEV)];
      return ok(lines.join("\n"));
    }
    // adapter get-property (Powered Discovering Name Address)
    if (has(cmd, "get-property", "org.bluez.Adapter1")) {
      const a = opts.adapter ?? {
        powered: true,
        discovering: false,
        name: "steamdeck",
        address: "E0:D5:5D:EC:F2:5B",
      };
      return ok(
        [
          `b ${a.powered}`,
          `b ${a.discovering}`,
          `s "${a.name}"`,
          `s "${a.address}"`,
        ].join("\n"),
      );
    }
    // device get-property
    if (has(cmd, "get-property", "org.bluez.Device1")) {
      const path = cmd[cmd.indexOf("get-property") + 2];
      const mac = macs.find((m) => DEV(m) === path);
      const d = mac ? opts.devices?.[mac] : undefined;
      if (has(cmd, "Connected", "Paired")) {
        return ok([`b ${d?.connected ?? false}`, `b ${d?.paired ?? false}`].join("\n"));
      }
      if (has(cmd, "Name")) return ok(`s "${d?.name ?? "Device"}"`);
      if (has(cmd, "Icon")) {
        return d?.icon ? ok(`s "${d.icon}"`) : fail("No such property", 1);
      }
    }
    return ok("");
  };
}

// ---------------------------------------------------------------------------

describe("BluetoothBackend (busctl / D-Bus)", () => {
  let backend: BluetoothBackend;
  let emitted: EmitPayload[];

  beforeEach(() => {
    backend = new BluetoothBackend();
    emitted = [];
    backend.emit = (p: EmitPayload) => emitted.push(p);
    mockRunFull.mockClear();
    mockSpawn.mockClear();
    mockRunFull.mockImplementation(() => ok(""));
  });

  // ---- getAdapterInfo -----------------------------------------------------

  describe("getAdapterInfo()", () => {
    it("reads adapter state over D-Bus (this is the fix: bluetoothctl returned empty)", async () => {
      mockRunFull.mockImplementation(
        fakeBus({
          adapter: {
            powered: true,
            discovering: true,
            name: "steamdeck",
            address: "E0:D5:5D:EC:F2:5B",
          },
        }) as any,
      );
      const info = await backend.getAdapterInfo();
      expect(info).toEqual({
        powered: true,
        discovering: true,
        name: "steamdeck",
        address: "E0:D5:5D:EC:F2:5B",
      });
    });

    it("detects powered off", async () => {
      mockRunFull.mockImplementation(
        fakeBus({
          adapter: { powered: false, discovering: false, name: "steamdeck", address: "AA:BB:CC:DD:EE:FF" },
        }) as any,
      );
      const info = await backend.getAdapterInfo();
      expect(info.powered).toBe(false);
    });

    it("returns Unknown defaults when no adapter is on the bus", async () => {
      mockRunFull.mockImplementation(fakeBus({ noAdapter: true }) as any);
      const info = await backend.getAdapterInfo();
      expect(info).toEqual({
        powered: false,
        discovering: false,
        name: "Unknown",
        address: "Unknown",
      });
    });
  });

  // ---- getDevices ---------------------------------------------------------

  describe("getDevices()", () => {
    it("returns [] when no adapter is present", async () => {
      mockRunFull.mockImplementation(fakeBus({ noAdapter: true }) as any);
      expect(await backend.getDevices()).toEqual([]);
    });

    it("parses devices with type from Icon", async () => {
      mockRunFull.mockImplementation(
        fakeBus({
          macs: ["98:7A:14:88:C5:77", "AA:BB:CC:DD:EE:02"],
          devices: {
            "98:7A:14:88:C5:77": { connected: true, paired: true, name: "Xbox Controller", icon: "input-gaming" },
            "AA:BB:CC:DD:EE:02": { connected: false, paired: true, name: "Keychron", icon: "input-keyboard" },
          },
        }) as any,
      );
      const devices = await backend.getDevices();
      expect(devices).toHaveLength(2);
      expect(devices[0]).toEqual({
        mac: "98:7A:14:88:C5:77",
        name: "Xbox Controller",
        connected: true,
        paired: true,
        type: "input",
      });
      expect(devices[1].type).toBe("keyboard");
      expect(devices[1].connected).toBe(false);
    });

    it("tolerates a missing Icon (type unknown)", async () => {
      mockRunFull.mockImplementation(
        fakeBus({
          macs: ["AA:BB:CC:DD:EE:FF"],
          devices: { "AA:BB:CC:DD:EE:FF": { connected: true, paired: true, name: "BLE Tag" } },
        }) as any,
      );
      const [dev] = await backend.getDevices();
      expect(dev.type).toBe("unknown");
      expect(dev.connected).toBe(true);
    });

    it("preserves cached connection state on a transient device read error", async () => {
      (backend as any).lastDeviceState.set("AA:BB:CC:DD:EE:FF", true);
      mockRunFull.mockImplementation((cmd: string[]) => {
        if (has(cmd, "tree", "--list")) return ok(["/org/bluez", ADAPTER, DEV("AA:BB:CC:DD:EE:FF")].join("\n"));
        if (has(cmd, "get-property", "org.bluez.Device1")) return fail("DBus hiccup", 1);
        return ok("");
      });
      const [dev] = await backend.getDevices();
      expect(dev.connected).toBe(true); // cache preserved → no phantom deviceChanged
      expect(dev.type).toBe("unknown");
    });
  });

  // ---- togglePower --------------------------------------------------------

  describe("togglePower()", () => {
    it("clears the rfkill soft block before setting Powered=true", async () => {
      mockRunFull.mockImplementation(fakeBus({}) as any);
      await backend.togglePower(true);

      const cmds = mockRunFull.mock.calls.map((c) => c[0] as string[]);
      const rfkillIdx = cmds.findIndex((a) => a[0] === "rfkill" && a.includes("unblock"));
      const setIdx = cmds.findIndex(
        (a) => has(a, "set-property", "org.bluez.Adapter1", "Powered", "true"),
      );
      expect(rfkillIdx).toBeGreaterThanOrEqual(0);
      expect(setIdx).toBeGreaterThanOrEqual(0);
      expect(rfkillIdx).toBeLessThan(setIdx);
    });

    it("does NOT touch rfkill when powering off", async () => {
      mockRunFull.mockImplementation(fakeBus({}) as any);
      await backend.togglePower(false);
      const usedRfkill = mockRunFull.mock.calls.some((c) => (c[0] as string[])[0] === "rfkill");
      expect(usedRfkill).toBe(false);
    });

    it("still powers on when rfkill is unavailable", async () => {
      mockRunFull.mockImplementation((cmd: string[]) => {
        if (cmd[0] === "rfkill") return Promise.reject(new Error("no rfkill"));
        return fakeBus({})(cmd);
      });
      await backend.togglePower(true);
      const setOn = mockRunFull.mock.calls.some((c) =>
        has(c[0] as string[], "set-property", "Powered", "true"),
      );
      expect(setOn).toBe(true);
    });

    it("throws when BlueZ rejects the power change", async () => {
      mockRunFull.mockImplementation((cmd: string[]) => {
        if (has(cmd, "tree", "--list")) return ok(["/org/bluez", ADAPTER].join("\n"));
        if (has(cmd, "set-property")) return fail("org.bluez.Error.Blocked", 1);
        return ok("");
      });
      await expect(backend.togglePower(true)).rejects.toThrow(/power on failed/i);
    });
  });

  // ---- connect / disconnect ----------------------------------------------

  describe("connectDevice() / disconnectDevice()", () => {
    it("connects via Device1.Connect and caches connected=true", async () => {
      mockRunFull.mockImplementation((cmd: string[]) => {
        if (has(cmd, "tree", "--list")) return ok(["/org/bluez", ADAPTER].join("\n"));
        if (has(cmd, "call", "Connect")) return ok("");
        return ok("");
      });
      const res = await backend.connectDevice("AA:BB:CC:DD:EE:FF");
      expect(res).toBe("Connection successful");
      expect((backend as any).lastDeviceState.get("AA:BB:CC:DD:EE:FF")).toBe(true);
      const connectCall = mockRunFull.mock.calls.find((c) => has(c[0] as string[], "call", "Connect"));
      expect((connectCall![0] as string[])).toContain(DEV("AA:BB:CC:DD:EE:FF"));
    });

    it("throws and does NOT cache when Connect fails (non-zero exit)", async () => {
      mockRunFull.mockImplementation((cmd: string[]) => {
        if (has(cmd, "tree", "--list")) return ok(["/org/bluez", ADAPTER].join("\n"));
        if (has(cmd, "call", "Connect")) return fail("org.bluez.Error.Failed", 1);
        return ok("");
      });
      await expect(backend.connectDevice("AA:BB:CC:DD:EE:FF")).rejects.toThrow(/connect failed/i);
      expect((backend as any).lastDeviceState.has("AA:BB:CC:DD:EE:FF")).toBe(false);
    });

    it("disconnects via Device1.Disconnect and caches connected=false", async () => {
      mockRunFull.mockImplementation((cmd: string[]) => {
        if (has(cmd, "tree", "--list")) return ok(["/org/bluez", ADAPTER].join("\n"));
        return ok("");
      });
      await backend.disconnectDevice("AA:BB:CC:DD:EE:FF");
      expect((backend as any).lastDeviceState.get("AA:BB:CC:DD:EE:FF")).toBe(false);
    });
  });

  // ---- scanning -----------------------------------------------------------

  describe("scan", () => {
    it("startScan spawns a long-lived bluetoothctl process", async () => {
      await backend.startScan();
      const cmd = mockSpawn.mock.calls[0][0] as unknown as string[];
      expect(cmd).toEqual(["bluetoothctl", "scan", "on"]);
    });

    it("stopScan kills the scan process", async () => {
      let killed = false;
      mockSpawn.mockImplementation(() => ({ kill: () => { killed = true; } }) as any);
      await backend.startScan();
      await backend.stopScan();
      expect(killed).toBe(true);
    });
  });

  // ---- poll loop emits ----------------------------------------------------

  describe("_poll()", () => {
    const poll = () => (backend as unknown as { _poll(): Promise<void> })._poll();

    it("emits adapterChanged when power flips between polls", async () => {
      let powered = false;
      mockRunFull.mockImplementation((cmd: string[]) =>
        fakeBus({
          adapter: { powered, discovering: false, name: "steamdeck", address: "AA:BB:CC:DD:EE:FF" },
        })(cmd),
      );
      await poll(); // first read: powered=false, seeds lastAdapter, no emit
      expect(emitted.find((e) => e.event === "adapterChanged")).toBeUndefined();
      powered = true;
      await poll();
      expect(emitted.find((e) => e.event === "adapterChanged")).toBeDefined();
    });

    it("emits deviceChanged when a device's connected state flips", async () => {
      let connected = false;
      mockRunFull.mockImplementation((cmd: string[]) =>
        fakeBus({
          macs: ["AA:BB:CC:DD:EE:FF"],
          devices: { "AA:BB:CC:DD:EE:FF": { connected, paired: true, name: "Pad", icon: "input-gaming" } },
        })(cmd),
      );
      await poll(); // seed
      connected = true;
      await poll();
      const ev = emitted.find((e) => e.event === "deviceChanged");
      expect(ev).toBeDefined();
    });
  });
});
