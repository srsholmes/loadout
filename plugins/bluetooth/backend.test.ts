import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";
import type { EmitPayload } from "@loadout/types";

// Mock @loadout/exec — must come before importing the SUT.
// Use mock.module (not spyOn) for a third-party package; capture the
// mock fn first so we can control its return value per-test.
const mockRun = mock(() => Promise.resolve({ stdout: "", exitCode: 0 }));
mock.module("@loadout/exec", () => ({
  run: mockRun,
  // spawn is used by startScan — let tests override Bun.spawn directly
  spawn: (...args: any[]) => Bun.spawn(...args),
}));

import BluetoothBackend from "./backend";

describe("BluetoothBackend", () => {
  let backend: BluetoothBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(() => {
    backend = new BluetoothBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
    mockRun.mockClear();
    // Tests never call onLoad(), so pollInterval is never armed — no
    // need to clearInterval here.
  });

  // ---------------------------------------------------------------------------
  // getDevices — bluetoothctl output parsing
  // ---------------------------------------------------------------------------

  describe("getDevices()", () => {
    it("returns empty array when bluetoothctl returns empty output", async () => {
      mockRun.mockImplementation(() => Promise.resolve({ stdout: "" }));
      const devices = await backend.getDevices();
      expect(devices).toEqual([]);
    });

    it("parses a single paired device", async () => {
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("devices")) {
          return Promise.resolve({
            stdout: "Device AA:BB:CC:DD:EE:FF Sony WH-1000XM5\n",
          });
        }
        if (cmd.includes("info")) {
          return Promise.resolve({
            stdout: [
              "Device AA:BB:CC:DD:EE:FF (public)",
              "\tName: Sony WH-1000XM5",
              "\tAlias: Sony WH-1000XM5",
              "\tClass: 0x00240404",
              "\tIcon: audio-headset",
              "\tPaired: yes",
              "\tBonded: yes",
              "\tTrusted: yes",
              "\tBlocked: no",
              "\tConnected: yes",
              "\tLegacyPairing: no",
            ].join("\n"),
          });
        }
        return Promise.resolve({ stdout: "" });
      });

      const devices = await backend.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0]).toEqual({
        mac: "AA:BB:CC:DD:EE:FF",
        name: "Sony WH-1000XM5",
        connected: true,
        paired: true,
        type: "audio",
      });
    });

    it("parses multiple devices with different types", async () => {
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("devices")) {
          return Promise.resolve({
            stdout: [
              "Device AA:BB:CC:DD:EE:01 Xbox Controller",
              "Device AA:BB:CC:DD:EE:02 Keychron K2",
              "Device AA:BB:CC:DD:EE:03 Unknown Gadget",
            ].join("\n"),
          });
        }
        if (cmd.includes("info")) {
          const mac = cmd[cmd.length - 1];
          if (mac === "AA:BB:CC:DD:EE:01") {
            return Promise.resolve({
              stdout: "Icon: input-gaming\nPaired: yes\nConnected: yes\n",
            });
          }
          if (mac === "AA:BB:CC:DD:EE:02") {
            return Promise.resolve({
              stdout: "Icon: input-keyboard\nPaired: yes\nConnected: no\n",
            });
          }
          return Promise.resolve({
            stdout: "Icon: phone\nPaired: no\nConnected: no\n",
          });
        }
        return Promise.resolve({ stdout: "" });
      });

      const devices = await backend.getDevices();
      expect(devices).toHaveLength(3);

      expect(devices[0].type).toBe("input");
      expect(devices[0].connected).toBe(true);

      expect(devices[1].type).toBe("keyboard");
      expect(devices[1].connected).toBe(false);
      expect(devices[1].paired).toBe(true);

      expect(devices[2].type).toBe("unknown");
      expect(devices[2].paired).toBe(false);
    });

    it("skips lines that don't match the Device pattern", async () => {
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("devices")) {
          return Promise.resolve({
            stdout: [
              "Device AA:BB:CC:DD:EE:FF Headphones",
              "some garbage line",
              "",
              "not a device line at all",
            ].join("\n"),
          });
        }
        if (cmd.includes("info")) {
          return Promise.resolve({
            stdout: "Icon: audio-headphone\nPaired: yes\nConnected: no\n",
          });
        }
        return Promise.resolve({ stdout: "" });
      });

      const devices = await backend.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].mac).toBe("AA:BB:CC:DD:EE:FF");
    });

    it("handles info fetch failure gracefully", async () => {
      mockRun.mockImplementation((cmd: string[]) => {
        if (cmd.includes("devices")) {
          return Promise.resolve({
            stdout: "Device AA:BB:CC:DD:EE:FF Test Device\n",
          });
        }
        if (cmd.includes("info")) {
          return Promise.reject(new Error("bluetoothctl not found"));
        }
        return Promise.resolve({ stdout: "" });
      });

      const devices = await backend.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0]).toEqual({
        mac: "AA:BB:CC:DD:EE:FF",
        name: "Test Device",
        connected: false,
        paired: false,
        type: "unknown",
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getAdapterInfo — adapter output parsing
  // ---------------------------------------------------------------------------

  describe("getAdapterInfo()", () => {
    it("parses adapter info correctly when powered on", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({
          stdout: [
            "Controller AA:BB:CC:DD:EE:FF BlueZ 5.66 [default]",
            "\tName: deck-bluetooth",
            "\tAlias: deck-bluetooth",
            "\tClass: 0x000000",
            "\tPowered: yes",
            "\tDiscoverable: no",
            "\tDiscovering: yes",
            "\tPairable: yes",
          ].join("\n"),
        }),
      );

      const info = await backend.getAdapterInfo();
      expect(info.powered).toBe(true);
      expect(info.discovering).toBe(true);
      expect(info.name).toBe("deck-bluetooth");
      expect(info.address).toBe("AA:BB:CC:DD:EE:FF");
    });

    it("returns defaults when output is empty", async () => {
      mockRun.mockImplementation(() => Promise.resolve({ stdout: "" }));

      const info = await backend.getAdapterInfo();
      expect(info.powered).toBe(false);
      expect(info.discovering).toBe(false);
      expect(info.name).toBe("Unknown");
      expect(info.address).toBe("Unknown");
    });

    it("detects powered off and not discovering", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({
          stdout: [
            "Controller 00:11:22:33:44:55 BlueZ",
            "\tName: my-adapter",
            "\tPowered: no",
            "\tDiscovering: no",
          ].join("\n"),
        }),
      );

      const info = await backend.getAdapterInfo();
      expect(info.powered).toBe(false);
      expect(info.discovering).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // connectDevice / disconnectDevice — cache updates
  // ---------------------------------------------------------------------------

  describe("connectDevice()", () => {
    it("updates the cache to connected=true", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "Connection successful" }),
      );

      const result = await backend.connectDevice("AA:BB:CC:DD:EE:FF");
      expect(result).toBe("Connection successful");
      expect((backend as any).lastDeviceState.get("AA:BB:CC:DD:EE:FF")).toBe(true);
    });
  });

  describe("disconnectDevice()", () => {
    it("updates the cache to connected=false", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "Successful disconnected" }),
      );

      const result = await backend.disconnectDevice("AA:BB:CC:DD:EE:FF");
      expect(result).toBe("Successful disconnected");
      expect((backend as any).lastDeviceState.get("AA:BB:CC:DD:EE:FF")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // togglePower
  // ---------------------------------------------------------------------------

  describe("togglePower()", () => {
    it("calls bluetoothctl power on", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "Changing power on succeeded" }),
      );

      await backend.togglePower(true);
      expect(mockRun).toHaveBeenCalled();
      const callArgs = mockRun.mock.calls[0][0] as string[];
      expect(callArgs).toContain("power");
      expect(callArgs).toContain("on");
    });

    it("calls bluetoothctl power off", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "Changing power off succeeded" }),
      );

      await backend.togglePower(false);
      const callArgs = mockRun.mock.calls[0][0] as string[];
      expect(callArgs).toContain("power");
      expect(callArgs).toContain("off");
    });
  });

  // ---------------------------------------------------------------------------
  // startScan / stopScan
  // ---------------------------------------------------------------------------

  describe("startScan()", () => {
    it("returns scanning started message", async () => {
      const mockSpawn = spyOn(Bun, "spawn").mockReturnValue({
        kill: () => {},
        exited: Promise.resolve(0),
      } as any);

      const result = await backend.startScan();
      expect(result).toBe("Scanning started");

      mockSpawn.mockRestore();
    });
  });

  describe("stopScan()", () => {
    it("calls bluetoothctl scan off", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "Discovery stopped" }),
      );

      const result = await backend.stopScan();
      expect(result).toBe("Discovery stopped");
      const callArgs = mockRun.mock.calls[0][0] as string[];
      expect(callArgs).toContain("scan");
      expect(callArgs).toContain("off");
    });
  });
});
