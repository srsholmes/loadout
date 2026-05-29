import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import NetworkInfoBackend from "./backend";

// Audit F-009: backend reads /sys/class/net/{iface}/address + /operstate
// directly instead of shelling out, and tests `wireless` dir existence
// via access(). Use spyOn on the fs/promises object rather than
// mock.module to avoid module-mock leakage across backend specs in the
// single bun test process.
import * as fsPromises from "node:fs/promises";

type SysfsTable = Record<string, string>;
let sysfsTable: SysfsTable = {};
let wirelessIfaces: Set<string> = new Set();

/**
 * Register sysfs reads for a fake interface so backend.getNetworkInfo()
 * can populate MAC + state + type without touching the real /sys.
 */
function fakeSysfs(
  iface: string,
  opts: { mac?: string; state?: string; wireless?: boolean },
) {
  if (opts.mac !== undefined)
    sysfsTable[`/sys/class/net/${iface}/address`] = opts.mac;
  if (opts.state !== undefined)
    sysfsTable[`/sys/class/net/${iface}/operstate`] = opts.state;
  if (opts.wireless) wirelessIfaces.add(iface);
}

// ── Mock Bun.spawn for shell commands ────────────────────────────

const mockSpawn = mock(() => ({
  stdout: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(""));
      controller.close();
    },
  }),
  stderr: new ReadableStream({
    start(controller) {
      controller.close();
    },
  }),
  exited: Promise.resolve(0),
  exitCode: 0,
  pid: 1234,
}));

const originalSpawn = Bun.spawn;

/** Set what all subsequent spawn calls return on stdout via a resolver map. */
function mockSpawnByCommand(resolver: (cmd: string[]) => string) {
  mockSpawn.mockImplementation((cmd: string[]) => ({
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(resolver(cmd)));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    exited: Promise.resolve(0),
    exitCode: 0,
    pid: 1234,
  }));
}

describe("NetworkInfoBackend", () => {
  let backend: NetworkInfoBackend;
  let emittedEvents: EmitPayload[];
  let readFileSpy: ReturnType<typeof spyOn>;
  let accessSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    mockSpawn.mockClear();
    // @ts-expect-error -- mock
    Bun.spawn = mockSpawn;

    // Reset the sysfs fake table per test.
    sysfsTable = {};
    wirelessIfaces = new Set();

    // Spy on fs/promises methods — avoids mock.module leakage.
    readFileSpy = spyOn(fsPromises, "readFile").mockImplementation(
      (path: unknown) => {
        const p = path as string;
        if (p in sysfsTable) return Promise.resolve(sysfsTable[p]) as any;
        const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return Promise.reject(err);
      },
    );

    accessSpy = spyOn(fsPromises, "access").mockImplementation(
      (path: unknown) => {
        const p = path as string;
        const match = p.match(/\/sys\/class\/net\/([^/]+)\/wireless$/);
        if (match && wirelessIfaces.has(match[1])) return Promise.resolve();
        const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return Promise.reject(err);
      },
    );

    backend = new NetworkInfoBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    readFileSpy.mockRestore();
    accessSpy.mockRestore();
  });

  // ── Lifecycle ────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("onLoad resolves without error", async () => {
      await expect(backend.onLoad()).resolves.toBeUndefined();
    });

    it("onUnload resolves without error", async () => {
      await expect(backend.onUnload()).resolves.toBeUndefined();
    });

    it("does not emit any events on load", async () => {
      await backend.onLoad();
      expect(emittedEvents).toEqual([]);
    });
  });

  // ── getNetworkInfo ───────────────────────────────────────────

  describe("getNetworkInfo", () => {
    it("parses ip -o addr output into network interfaces", async () => {
      mockSpawnByCommand((cmd: string[]) => {
        const fullCmd = cmd.join(" ");
        if (fullCmd.includes("ip -o addr show")) {
          return [
            "2: eth0    inet 192.168.1.100/24 brd 192.168.1.255 scope global eth0",
            "3: wlan0    inet 10.0.0.50/24 brd 10.0.0.255 scope global wlan0",
          ].join("\n");
        }
        return "";
      });
      fakeSysfs("eth0", { mac: "aa:bb:cc:dd:ee:ff", state: "up" });
      fakeSysfs("wlan0", { mac: "aa:bb:cc:dd:ee:00", state: "up", wireless: true });

      const interfaces = await backend.getNetworkInfo();

      expect(interfaces.length).toBeGreaterThanOrEqual(1);
      const eth = interfaces.find((i) => i.name === "eth0");
      if (eth) {
        expect(eth.ip).toBe("192.168.1.100");
        expect(eth.state).toBe("up");
        expect(eth.mac).toBe("aa:bb:cc:dd:ee:ff");
        expect(eth.type).toBe("Ethernet");
      }
      const wlan = interfaces.find((i) => i.name === "wlan0");
      if (wlan) {
        expect(wlan.type).toBe("WiFi");
      }
    });

    it("skips loopback and IPv6 entries", async () => {
      mockSpawnByCommand((cmd: string[]) => {
        const fullCmd = cmd.join(" ");
        if (fullCmd.includes("ip -o addr show")) {
          return [
            "1: lo    inet 127.0.0.1/8 scope host lo",
            "2: eth0    inet6 ::1/128 scope host",
            "3: eth0    inet 192.168.1.100/24 brd 192.168.1.255 scope global eth0",
          ].join("\n");
        }
        return "";
      });
      fakeSysfs("eth0", { mac: "aa:bb:cc:dd:ee:ff", state: "up" });

      const interfaces = await backend.getNetworkInfo();
      expect(interfaces.every((i) => i.name !== "lo")).toBe(true);
      expect(interfaces.filter((i) => i.name === "eth0")).toHaveLength(1);
    });

    it("falls back to N/A mac and unknown state when sysfs reads fail", async () => {
      mockSpawnByCommand((cmd: string[]) => {
        const fullCmd = cmd.join(" ");
        if (fullCmd.includes("ip -o addr show")) {
          return "2: eth0    inet 192.168.1.100/24 brd 192.168.1.255 scope global eth0";
        }
        return "";
      });
      // No fakeSysfs() — readFile/access will reject.

      const interfaces = await backend.getNetworkInfo();
      const eth = interfaces.find((i) => i.name === "eth0");
      expect(eth?.mac).toBe("N/A");
      expect(eth?.state).toBe("unknown");
      expect(eth?.type).toBe("Ethernet");
    });

    it("returns empty array when ip command fails", async () => {
      mockSpawnByCommand(() => "");
      const interfaces = await backend.getNetworkInfo();
      expect(interfaces).toEqual([]);
    });
  });

  // ── getConnectionInfo ────────────────────────────────────────

  describe("getConnectionInfo", () => {
    it("parses nmcli output for WiFi info", async () => {
      mockSpawnByCommand((cmd: string[]) => {
        const fullCmd = cmd.join(" ");
        if (fullCmd.includes("nmcli")) {
          return "yes:MyNetwork:85:5180";
        }
        if (fullCmd.includes("iwconfig")) return "";
        return "";
      });

      const info = await backend.getConnectionInfo();
      expect(info.ssid).toBe("MyNetwork");
      expect(info.signal).toBe(85);
      expect(info.frequency).toBe("5180 MHz");
    });

    it("falls back to iwconfig when nmcli is empty", async () => {
      mockSpawnByCommand((cmd: string[]) => {
        const fullCmd = cmd.join(" ");
        if (fullCmd.includes("nmcli")) return "";
        if (fullCmd.includes("iwconfig")) {
          return [
            'wlan0     IEEE 802.11  ESSID:"FallbackNet"',
            "          Frequency:5.18 GHz  Bit Rate=866.7 Mb/s",
            "          Signal level=-45 dBm",
          ].join("\n");
        }
        return "";
      });

      const info = await backend.getConnectionInfo();
      expect(info.ssid).toBe("FallbackNet");
      expect(info.bitRate).toBe("866.7 Mb/s");
      // Signal: 2 * (-45 + 100) = 110, clamped to 100
      expect(info.signal).toBe(100);
    });

    it("falls back to /proc/net/wireless for signal", async () => {
      // Both nmcli and iwconfig return empty — no signal yet
      mockSpawnByCommand(() => "");

      // /proc/net/wireless read succeeds via readFile spy
      sysfsTable["/proc/net/wireless"] = [
        "Inter-| sta-|   Quality        |   Discarded packets",
        " face | tus |   link.  level.  noise.",
        " wlan0: 0001    50.  -60.  -95.    0      0      0",
      ].join("\n");

      const info = await backend.getConnectionInfo();
      // Signal: 2 * (-60 + 100) = 80
      expect(info.signal).toBe(80);
    });

    it("returns all nulls when no WiFi data available", async () => {
      mockSpawnByCommand(() => "");
      const info = await backend.getConnectionInfo();
      expect(info.ssid).toBeNull();
      expect(info.signal).toBeNull();
      expect(info.frequency).toBeNull();
      expect(info.bitRate).toBeNull();
    });

    it("nmcli ssid takes priority over iwconfig ssid", async () => {
      mockSpawnByCommand((cmd: string[]) => {
        const fullCmd = cmd.join(" ");
        if (fullCmd.includes("nmcli")) return "yes:NmcliNet:70:5180";
        if (fullCmd.includes("iwconfig"))
          return 'wlan0  ESSID:"IwconfigNet"  Bit Rate=433 Mb/s';
        return "";
      });

      const info = await backend.getConnectionInfo();
      expect(info.ssid).toBe("NmcliNet");
      expect(info.bitRate).toBe("433 Mb/s");
    });
  });
});
