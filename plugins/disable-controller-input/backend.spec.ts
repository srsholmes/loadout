import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import type { EmitPayload } from "@loadout/types";

/**
 * Disable Controller Input backend tests.
 *
 * The backend shells out to `busctl` for every InputPlumber interaction,
 * so the tests stub Bun.spawn and assert on the command lines that go
 * out plus the cache mutations / events that come back.
 *
 * No real DBus, no real /dev/input — these are pure unit tests of the
 * parser logic, the reconcile loop, and the persisted-cache state
 * machine.
 */

// ---------- plugin-storage mock ----------
// The backend reads/writes via @loadout/plugin-storage. Replace it
// with an in-memory shim that records the last write and serves it on
// the next read, mirroring what the real on-disk store does.

const storageBuckets = new Map<string, unknown>();
mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: async (id: string) => storageBuckets.get(id) ?? {},
  writePluginStorage: async (id: string, data: unknown) => {
    storageBuckets.set(id, data);
  },
  pluginStoragePath: (id: string) => `/tmp/test/${id}.json`,
}));

// Import the backend AFTER the mock so it picks up the shimmed module.
import DisableControllerInputBackend from "./backend";

// ---------- Bun.spawn helpers ----------

interface SpawnExpectation {
  /** Predicate that picks the call this expectation applies to. */
  match: (cmd: readonly string[]) => boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function makeSpawnStub(expectations: SpawnExpectation[]) {
  const calls: string[][] = [];
  const stub = (
    cmd: readonly string[] | string,
    _opts?: unknown,
  ) => {
    const argv = Array.isArray(cmd) ? (cmd as string[]) : [cmd as string];
    calls.push([...argv]);
    const exp = expectations.find((e) => e.match(argv));
    const stdout = exp?.stdout ?? "";
    const stderr = exp?.stderr ?? "";
    const code = exp?.exitCode ?? 0;
    return {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(stdout));
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(stderr));
          c.close();
        },
      }),
      exited: Promise.resolve(code),
    } as unknown as ReturnType<typeof Bun.spawn>;
  };
  return { stub, calls };
}

function isBusctl(cmd: readonly string[], ...tail: string[]): boolean {
  // cmd looks like ["busctl", "--system", "--no-pager", ...tail]
  if (cmd[0] !== "busctl") return false;
  const args = cmd.slice(3); // strip the three fixed flags
  if (args.length < tail.length) return false;
  for (let i = 0; i < tail.length; i++) {
    if (args[i] !== tail[i]) return false;
  }
  return true;
}

/** True if any element of cmd contains the substring `needle`. Use this
 *  for path / property-name matchers instead of Array.prototype.includes
 *  (which is exact-equality and won't match a substring inside a long
 *  DBus object path). */
function cmdHasSubstring(cmd: readonly string[], needle: string): boolean {
  return cmd.some((s) => s.includes(needle));
}

/** djb2 — must match the implementation in backend.ts so the test can
 *  pre-seed cache entries by name and have them survive the bus walk. */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return hash >>> 0;
}

describe("DisableControllerInputBackend", () => {
  let backend: DisableControllerInputBackend;
  let emitted: EmitPayload[];
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    storageBuckets.clear();
    backend = new DisableControllerInputBackend();
    emitted = [];
    backend.emit = (p) => {
      emitted.push(p);
    };
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
  });

  // -----------------------------------------------------------------
  // Service detection
  // -----------------------------------------------------------------

  describe("onLoad", () => {
    it("flags unavailable when busctl tree returns non-zero", async () => {
      const { stub } = makeSpawnStub([
        { match: (c) => isBusctl(c, "tree"), exitCode: 1 },
      ]);
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

      await backend.onLoad();
      const list = await backend.listControllers();
      expect(list.unavailable).toBe(true);
    });

    it("walks the bus and seeds the cache when InputPlumber is present", async () => {
      const tree = [
        "/org/shadowblip/InputPlumber",
        "/org/shadowblip/InputPlumber/Manager",
        "/org/shadowblip/InputPlumber/CompositeDevice0",
      ].join("\n");
      const { stub } = makeSpawnStub([
        { match: (c) => isBusctl(c, "tree", "--list"), stdout: tree },
        {
          match: (c) =>
            isBusctl(c, "get-property") &&
            cmdHasSubstring(c, "/CompositeDevice0") &&
            cmdHasSubstring(c, "Name"),
          stdout: 's "Steam Deck Controller"',
        },
        // No targets -> empty TargetDevices array
        {
          match: (c) =>
            isBusctl(c, "get-property") && cmdHasSubstring(c, "TargetDevices"),
          stdout: "ao 0",
        },
      ]);
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

      await backend.onLoad();
      const list = await backend.listControllers();
      expect(list.unavailable).toBe(false);
      expect(list.controllers).toHaveLength(1);
      expect(list.controllers[0].name).toBe("Steam Deck Controller");
      expect(list.controllers[0].connected).toBe(true);
      expect(list.controllers[0].disabled).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // Persisted cache
  // -----------------------------------------------------------------

  describe("persistence", () => {
    it("hydrates the disabled flag from prior storage", async () => {
      storageBuckets.set("disable-controller-input", {
        version: 1,
        devices: [
          {
            hash: 12345,
            name: "Phantom Pad",
            lastDbusPath:
              "/org/shadowblip/InputPlumber/CompositeDevice9",
            lastSeenMs: 0,
            disabled: true,
            savedKinds: ["xb360"],
          },
        ],
      });
      // Service unavailable: skip bus walk entirely.
      const { stub } = makeSpawnStub([
        { match: (c) => isBusctl(c, "tree"), exitCode: 1 },
      ]);
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

      await backend.onLoad();
      const list = await backend.listControllers();
      expect(list.unavailable).toBe(true);
      expect(list.controllers).toHaveLength(1);
      expect(list.controllers[0].name).toBe("Phantom Pad");
      expect(list.controllers[0].disabled).toBe(true);
      // Not currently connected (no live walk possible).
      expect(list.controllers[0].connected).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // setDisabled while disconnected — no DBus side-effects
  // -----------------------------------------------------------------

  describe("setDisabled (offline device)", () => {
    it("flips intent and persists when device isn't on the bus", async () => {
      storageBuckets.set("disable-controller-input", {
        version: 1,
        devices: [
          {
            hash: 7,
            name: "Stale Pad",
            lastDbusPath:
              "/org/shadowblip/InputPlumber/CompositeDevice0",
            lastSeenMs: 0, // ancient — counts as offline
            disabled: false,
            savedKinds: [],
          },
        ],
      });
      // Bus tree returns success but with no composites — keeps `unavailable=false`
      // while the device stays offline.
      const { stub, calls } = makeSpawnStub([
        { match: (c) => isBusctl(c, "tree", "--list"), stdout: "" },
      ]);
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

      await backend.onLoad();
      const callsBefore = calls.length;
      const res = await backend.setDisabled(7, true);
      expect(res.ok).toBe(true);
      // No new busctl calls after setDisabled — the device is offline.
      expect(calls.length).toBe(callsBefore);

      const stored = storageBuckets.get("disable-controller-input") as {
        devices: { hash: number; disabled: boolean }[];
      };
      expect(stored.devices.find((d) => d.hash === 7)?.disabled).toBe(true);
      expect(emitted).toContainEqual({
        event: "controllersChanged",
        data: undefined,
      });
    });
  });

  // -----------------------------------------------------------------
  // setDisabled while connected — issues SetTargetDevices
  // -----------------------------------------------------------------

  describe("setDisabled (online device)", () => {
    it("snapshots savedKinds and silences with [\"null\"]", async () => {
      const tree = "/org/shadowblip/InputPlumber/CompositeDevice0";
      const { stub, calls } = makeSpawnStub([
        { match: (c) => isBusctl(c, "tree", "--list"), stdout: tree },
        {
          match: (c) =>
            isBusctl(c, "get-property") &&
            cmdHasSubstring(c, "/CompositeDevice0") &&
            cmdHasSubstring(c, "Name"),
          stdout: 's "External Pad"',
        },
        {
          match: (c) =>
            isBusctl(c, "get-property") &&
            cmdHasSubstring(c, "TargetDevices"),
          stdout:
            'ao 1 "/org/shadowblip/InputPlumber/devices/target/xb3600"',
        },
        {
          match: (c) =>
            isBusctl(c, "get-property") &&
            cmdHasSubstring(c, "/devices/target/xb3600") &&
            cmdHasSubstring(c, "DeviceType"),
          stdout: 's "xb360"',
        },
        {
          match: (c) =>
            isBusctl(c, "call") && cmdHasSubstring(c, "SetTargetDevices"),
          exitCode: 0,
        },
      ]);
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

      await backend.onLoad();
      const list = await backend.listControllers();
      const hash = list.controllers[0].hash;
      const res = await backend.setDisabled(hash, true);
      expect(res.ok).toBe(true);

      // Find the SetTargetDevices call and assert the args end with `as 1 null`.
      const setCall = calls.find(
        (c) => isBusctl(c, "call") && cmdHasSubstring(c, "SetTargetDevices"),
      );
      expect(setCall).toBeDefined();
      expect(setCall!.slice(-3)).toEqual(["as", "1", "null"]);

      const stored = storageBuckets.get("disable-controller-input") as {
        devices: { hash: number; disabled: boolean; savedKinds: string[] }[];
      };
      const dev = stored.devices.find((d) => d.hash === hash)!;
      expect(dev.disabled).toBe(true);
      expect(dev.savedKinds).toEqual(["xb360"]);
    });

    it("restores savedKinds on re-enable", async () => {
      // Pre-seed cache with a disabled device that has a known kind
      // list. Hash must match djb2(name) so the bus walk in onLoad
      // refreshes this entry rather than creating a duplicate.
      const name = "External Pad";
      const hash = djb2(name);
      storageBuckets.set("disable-controller-input", {
        version: 1,
        devices: [
          {
            hash,
            name,
            lastDbusPath:
              "/org/shadowblip/InputPlumber/CompositeDevice0",
            lastSeenMs: 0,
            disabled: true,
            savedKinds: ["xb360", "mouse"],
          },
        ],
      });
      // Live walk: device IS on the bus, currently silenced.
      const tree = "/org/shadowblip/InputPlumber/CompositeDevice0";
      const { stub, calls } = makeSpawnStub([
        { match: (c) => isBusctl(c, "tree", "--list"), stdout: tree },
        {
          match: (c) =>
            isBusctl(c, "get-property") && cmdHasSubstring(c, "Name"),
          stdout: 's "External Pad"',
        },
        // Currently has no real targets (silenced).
        {
          match: (c) =>
            isBusctl(c, "get-property") && cmdHasSubstring(c, "TargetDevices"),
          stdout: "ao 0",
        },
        {
          match: (c) =>
            isBusctl(c, "call") && cmdHasSubstring(c, "SetTargetDevices"),
          exitCode: 0,
        },
      ]);
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

      await backend.onLoad();
      const res = await backend.setDisabled(hash, false);
      expect(res.ok).toBe(true);

      const setCall = calls.find(
        (c) => isBusctl(c, "call") && cmdHasSubstring(c, "SetTargetDevices"),
      );
      expect(setCall).toBeDefined();
      // signature `as 2 xb360 mouse`
      expect(setCall!.slice(-4)).toEqual(["as", "2", "xb360", "mouse"]);
    });
  });

  // -----------------------------------------------------------------
  // forgetController
  // -----------------------------------------------------------------

  describe("forgetController", () => {
    it("removes a known device from the cache", async () => {
      storageBuckets.set("disable-controller-input", {
        version: 1,
        devices: [
          {
            hash: 42,
            name: "Removable Pad",
            lastDbusPath: "",
            lastSeenMs: 0,
            disabled: false,
            savedKinds: [],
          },
        ],
      });
      const { stub } = makeSpawnStub([
        { match: (c) => isBusctl(c, "tree"), exitCode: 1 },
      ]);
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

      await backend.onLoad();
      const res = await backend.forgetController(42);
      expect(res.ok).toBe(true);
      const stored = storageBuckets.get("disable-controller-input") as {
        devices: unknown[];
      };
      expect(stored.devices).toHaveLength(0);
    });

    it("returns an error for unknown hashes", async () => {
      const { stub } = makeSpawnStub([
        { match: (c) => isBusctl(c, "tree"), exitCode: 1 },
      ]);
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

      await backend.onLoad();
      const res = await backend.forgetController(99999);
      expect(res.ok).toBe(false);
      expect(res.error).toBeDefined();
    });
  });

  // -----------------------------------------------------------------
  // Audit D-009: busctl can hang during an InputPlumber restart. The
  // exec() helper now passes timeoutMs to runFull so the call fails
  // fast and the 2s reconcile loop keeps ticking instead of blocking
  // on the bus's default 25s timeout. The fixture below simulates a
  // hung busctl: spawn returns a process whose `exited` only resolves
  // when `kill()` is invoked (i.e. the timeout fires).
  // -----------------------------------------------------------------

  describe("busctl timeout (D-009)", () => {
    it("kills a hung busctl call so onLoad doesn't block forever", async () => {
      let killed = false;
      // The hanging exited promise: only resolves once kill() is called.
      let resolveExited: (code: number) => void = () => {};
      const exited = new Promise<number>((res) => {
        resolveExited = res;
      });
      const stub = (_cmd: readonly string[] | string, _opts?: unknown) => {
        return {
          stdout: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          exited,
          kill: () => {
            killed = true;
            // runFull treats kill+exited-resolution as a timed-out call.
            resolveExited(-1);
          },
        } as unknown as ReturnType<typeof Bun.spawn>;
      };
      spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

      // onLoad shells out to `busctl tree` first; with no timeout this
      // would block until the real bus daemon's default ~25s timeout.
      // The 5s ceiling in exec() should kill the call long before our
      // 10s test timeout fires.
      const t0 = Date.now();
      await backend.onLoad();
      const elapsed = Date.now() - t0;

      expect(killed).toBe(true);
      // Loose ceiling — the timeout is 5000ms; observed wallclock should
      // be under 7s with plenty of slack for CI jitter. The point is
      // "it didn't hang at the bus daemon's 25s".
      expect(elapsed).toBeLessThan(7000);
      // Service flagged unavailable because the bus call "failed".
      const list = await backend.listControllers();
      expect(list.unavailable).toBe(true);
    }, 10_000);
  });
});
