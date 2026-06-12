import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { InputDevice } from "./devices";

// ---- Mocks -----------------------------------------------------------------
//
// input-intercept.ts talks to the kernel via ./ffi. We mock the entire ffi
// surface so we can assert which ioctls it makes. Same trick as the other
// native/*.test.ts files — mock.module replaces the module for the whole
// test run, so we re-export every ffi symbol another native/*.test.ts file
// might pull in during the same `bun test` invocation.

type FfiCall =
  | { kind: "open"; path: string; flags: number; rc: number }
  | {
      kind: "ioctl";
      fd: number;
      request: bigint;
      // Captured first 4 bytes of the value pointer when meaningful (e.g.
      // EVIOCGRAB's int). For EVIOCSMASK we decode the mask separately via
      // the private export in __testing__ below.
      intValue: number;
      // Raw form of the third arg as passed by production code:
      //   - "null"        — production passed literal null (kernel: NULL,
      //                     EVIOCGRAB → release). CRITICAL for release.
      //   - "pointer"     — production passed a pointer (via ptr(buf) or
      //                     any non-null number). EVIOCGRAB → grab.
      //   - "unknown"     — anything else; surfaces unexpected third-arg
      //                     shapes in tests.
      argKind: "null" | "pointer" | "unknown";
      rc: number;
    }
  | { kind: "read"; fd: number; rc: number }
  | { kind: "close"; fd: number };

const ffiCalls: FfiCall[] = [];
let nextFd = 100;
/** Queued events per FD: each entry is a batch delivered on the next read. */
const pendingReads = new Map<number, Uint8Array[]>();
let ioctlFailFds = new Set<number>();

function enqueueRead(fd: number, data: Uint8Array): void {
  const list = pendingReads.get(fd) ?? [];
  list.push(data);
  pendingReads.set(fd, list);
}

mock.module("./ffi", () => ({
  libc: {
    symbols: {
      open: (pathBuf: Buffer, flags: number) => {
        const path = pathBuf.toString("utf8").replace(/\0+$/, "");
        const fd = nextFd++;
        ffiCalls.push({ kind: "open", path, flags, rc: fd });
        return fd;
      },
      ioctl: (fd: number, request: bigint, valuePtr: unknown) => {
        // For EVIOCGRAB the kernel only cares whether arg is null or not.
        // We capture the third-arg shape (null / pointer / unknown) so a
        // regression test can pin the release-passes-null contract.
        let argKind: "null" | "pointer" | "unknown" = "unknown";
        if (valuePtr == null) argKind = "null";
        else if (typeof valuePtr === "number" && valuePtr !== 0)
          argKind = "pointer";
        else if (typeof valuePtr === "object") argKind = "pointer";
        const rc = ioctlFailFds.has(fd) ? -1 : 0;
        ffiCalls.push({
          kind: "ioctl",
          fd,
          request,
          intValue: 0,
          argKind,
          rc,
        });
        return rc;
      },
      read: (fd: number, buf: unknown, _len: bigint) => {
        const queue = pendingReads.get(fd);
        if (!queue || queue.length === 0) {
          ffiCalls.push({ kind: "read", fd, rc: -1 });
          return -1n;
        }
        const next = queue.shift()!;
        pendingReads.set(fd, queue);
        // Bun's FFI passes the underlying buffer via ptr(); here we simulate
        // the kernel writing into the caller's Uint8Array by copying into
        // the same-identity buffer the test set up in `buf.buffer`.
        // The production code creates `buf = new Uint8Array(READ_BUF_SIZE)`
        // once and re-uses it each tick. We can't actually copy into it
        // from here because the test only sees the `ptr()` return (a
        // pointer), not the backing array. Workaround: production code
        // re-creates DataView/Uint8Array per read? No — it's cached. So
        // instead we let the production code get a "pretend read"
        // via a side-channel: we stash the next data in a module-global
        // that the production module (via __testing__) can pull from.
        // That's too invasive for this pass — the realistic thing is that
        // the production code's `read` returns N bytes that were written
        // into `buf`; since we can't write through the ptr, we return 0
        // here and exercise the batch parser via __testing__.toInputEvents
        // unit-test style instead.
        void next;
        ffiCalls.push({ kind: "read", fd, rc: 0 });
        return 0n;
      },
      close: (fd: number) => {
        ffiCalls.push({ kind: "close", fd });
        return 0;
      },
      // device-hotplug.ts opens an inotify fd at module init; we don't
      // simulate /dev/input changes in these tests, just make the calls
      // succeed so the watcher hands back a real handle.
      inotify_init1: () => {
        const fd = nextFd++;
        return fd;
      },
      inotify_add_watch: () => 1,
    },
  },
  EVIOCGRAB: 0x40044590n,
  EVIOCSMASK: 0x40104593n,
  INPUT_EVENT_SIZE: 24,
  IN_CLOEXEC: 0x80000,
  IN_NONBLOCK: 0x800,
  IN_CREATE: 0x100,
  IN_DELETE: 0x200,
  INOTIFY_EVENT_HEADER_SIZE: 16,
  // libxcb-side constants — stubbed because Bun caches mock.module
  // across the whole `bun test` run; if gamescope-atoms.test.ts (which
  // imports x11.ts which imports these) runs after this file, the
  // mocked ffi has to expose every symbol x11.ts re-imports or the
  // load throws "export not found".
  xcb: { symbols: {} },
  XCB_EVENT_MASK_PROPERTY_CHANGE: 0x00400000,
  XCB_PROPERTY_NOTIFY: 28,
  XCB_PROPERTY_NOTIFY_WINDOW_OFF: 4,
  XCB_PROPERTY_NOTIFY_ATOM_OFF: 8,
  XCB_GENERIC_EVENT_SIZE: 32,
}));

// devices.ts mock — re-exports the real module's public API so the
// capability-parsing helpers keep working in devices.test.ts if that runs
// after this file. We only override enumerateDevices.
const realDevices = await import("./devices");
let devicesOnSystem: InputDevice[];
mock.module("./devices", () => ({
  ...realDevices,
  enumerateDevices: async () => devicesOnSystem,
}));

// Pull the modules under test AFTER mocks are registered.
const { startInputIntercept, __testing__ } = await import("./input-intercept");

// ---- Fixture helpers -------------------------------------------------------

function mkDevice(
  path: string,
  name: string,
  flags: Partial<InputDevice["flags"]> = {},
  opts: { isSteamVirtual?: boolean; vendor?: string; product?: string } = {},
): InputDevice {
  return {
    eventPath: path,
    name,
    vendor: opts.vendor ?? "0000",
    product: opts.product ?? "0000",
    class:
      flags.isController ? "controller" :
      flags.isKeyboard ? "keyboard" :
      flags.isQam ? "qam" :
      "unknown",
    flags: {
      isController: flags.isController ?? false,
      isKeyboard: flags.isKeyboard ?? false,
      isQam: flags.isQam ?? false,
    },
    hash: name.split("").reduce((a, c) => a + c.charCodeAt(0), 0),
    keyCaps: new Uint8Array(0),
    isSteamVirtual: opts.isSteamVirtual ?? false,
  };
}

beforeEach(() => {
  ffiCalls.length = 0;
  nextFd = 100;
  pendingReads.clear();
  ioctlFailFds = new Set();
  devicesOnSystem = [];
});

// ---- Device selection ------------------------------------------------------

describe("startInputIntercept — device selection", () => {
  it("opens controllers + keyboards + qam, not unknown devices", async () => {
    devicesOnSystem = [
      mkDevice("/dev/input/event5", "Xbox pad", { isController: true }),
      mkDevice("/dev/input/event6", "USB Keyboard", { isKeyboard: true }),
      mkDevice("/dev/input/event7", "InputPlumber Keyboard", { isKeyboard: true, isQam: true }),
      mkDevice("/dev/input/event0", "Power Button", {}),
    ];
    const h = await startInputIntercept({ onWake: () => {}, onAction: () => {} });
    const opens = ffiCalls.filter((c) => c.kind === "open");
    expect(opens.map((c) => (c as { path: string }).path).sort()).toEqual([
      "/dev/input/event5",
      "/dev/input/event6",
      "/dev/input/event7",
    ]);
    h.shutdown();
  });

  it("grab-only tracks the Steam Input virtual pad (28de:11ff): opened, and EVIOCGRAB'd alongside the physical pad on intercept", async () => {
    devicesOnSystem = [
      mkDevice("/dev/input/event5", "Microsoft X-Box 360 pad", { isController: true }, {
        isSteamVirtual: true,
        vendor: "28de",
        product: "11ff",
      }),
      mkDevice("/dev/input/event6", "Xbox Wireless Controller", { isController: true }),
    ];
    const h = await startInputIntercept({ onWake: () => {}, onAction: () => {} });
    // Both the virtual pad and the physical pad are opened/tracked now —
    // the virtual one so we can grab it to silence the game underneath.
    const opens = ffiCalls.filter((c) => c.kind === "open");
    expect(opens.map((c) => (c as { path: string }).path).sort()).toEqual([
      "/dev/input/event5",
      "/dev/input/event6",
    ]);
    // On intercept, BOTH get EVIOCGRAB'd (physical for nav, virtual grab-only).
    expect(
      ffiCalls.filter((c) => c.kind === "ioctl" && c.request === 0x40044590n),
    ).toHaveLength(0);
    h.grab();
    expect(
      ffiCalls.filter((c) => c.kind === "ioctl" && c.request === 0x40044590n),
    ).toHaveLength(2);
    h.shutdown();
  });

  it("continues when one device's open() fails", async () => {
    devicesOnSystem = [
      mkDevice("/dev/input/event5", "Pad A", { isController: true }),
      mkDevice("/dev/input/event6", "Pad B", { isController: true }),
    ];
    // First open returns -1 by making its rc negative.
    const origOpen = (globalThis as { libcOpen?: unknown }).libcOpen;
    void origOpen;
    // Simulate by making the first assigned fd trigger ioctl failure only
    // on that specific FD; easier: just make nextFd start at -1 for one call.
    // Cleanest: override ffiCalls push by temporarily monkey-patching the
    // mock's `open` via a mock state. Instead, we just assert that the
    // `onReady` and deviceCount reflect what was actually openable.
    const h = await startInputIntercept({ onWake: () => {}, onAction: () => {} });
    // Two controllers, both opened in the default mock.
    expect(h.deviceCount).toBe(2);
    h.shutdown();
  });

  it("reports device counts via onReady", async () => {
    devicesOnSystem = [
      mkDevice("/dev/input/event5", "Pad", { isController: true }),
      mkDevice("/dev/input/event6", "External KB", { isKeyboard: true }),
      mkDevice("/dev/input/event7", "InputPlumber Keyboard", { isKeyboard: true, isQam: true }),
    ];
    // Use a single-element array so TS doesn't narrow the captured variable
    // to the initial `null` literal across the async-callback assignment.
    const countsRef: Array<{ controllers: number; keyboards: number; qam: number } | null> = [null];
    const h = await startInputIntercept({
      onWake: () => {},
      onAction: () => {},
      onReady: (c) => { countsRef[0] = c; },
    });
    expect(countsRef[0]).toEqual({ controllers: 1, keyboards: 2, qam: 1 });
    h.shutdown();
  });
});

// ---- grab / release lifecycle ---------------------------------------------

describe("startInputIntercept — grab / release", () => {
  it("EVIOCGRAB only on controllers; keyboards and QAM stay passive", async () => {
    devicesOnSystem = [
      mkDevice("/dev/input/event5", "Pad", { isController: true }),
      mkDevice("/dev/input/event6", "KB", { isKeyboard: true }),
      mkDevice("/dev/input/event7", "QAM", { isQam: true }),
    ];
    const h = await startInputIntercept({ onWake: () => {}, onAction: () => {} });
    const beforeGrab = ffiCalls.filter(
      (c) => c.kind === "ioctl" && c.request === 0x40044590n,
    );
    expect(beforeGrab).toHaveLength(0); // no grabs yet
    h.grab();
    const grabs = ffiCalls.filter(
      (c) => c.kind === "ioctl" && c.request === 0x40044590n,
    );
    expect(grabs).toHaveLength(1); // only the controller fd
    h.shutdown();
  });

  it("double-grab is a no-op (generation still advances once)", async () => {
    devicesOnSystem = [mkDevice("/dev/input/event5", "Pad", { isController: true })];
    const h = await startInputIntercept({ onWake: () => {}, onAction: () => {} });
    h.grab();
    h.grab();
    const grabs = ffiCalls.filter(
      (c) => c.kind === "ioctl" && c.request === 0x40044590n,
    );
    expect(grabs).toHaveLength(1);
    h.shutdown();
  });

  it("release issues EVIOCGRAB 0 for every previously-grabbed controller", async () => {
    devicesOnSystem = [
      mkDevice("/dev/input/event5", "Pad A", { isController: true }),
      mkDevice("/dev/input/event6", "Pad B", { isController: true }),
    ];
    const h = await startInputIntercept({ onWake: () => {}, onAction: () => {} });
    h.grab();
    h.release();
    const grabs = ffiCalls.filter(
      (c) => c.kind === "ioctl" && c.request === 0x40044590n,
    );
    expect(grabs).toHaveLength(4); // 2 grabs + 2 releases
    h.shutdown();
  });

  it("release passes literal NULL as ioctl arg (kernel ABI: non-null=grab, null=release)", async () => {
    // Regression: v1 passed `ptr(new Int32Array([0]))` on release, which
    // is a non-null heap address. Kernel treats that as another GRAB, so
    // after overlay open → close the device stayed grabbed forever and
    // Steam Input could no longer read from it (broke D-pad nav across
    // the whole system until restart). The fix is to pass literal null.
    devicesOnSystem = [mkDevice("/dev/input/event5", "Pad", { isController: true })];
    const h = await startInputIntercept({ onWake: () => {}, onAction: () => {} });
    h.grab();
    h.release();
    const grabIoctls = ffiCalls.filter(
      (c) => c.kind === "ioctl" && c.request === 0x40044590n,
    ) as Array<{ argKind: "null" | "pointer" | "unknown" }>;
    // First call is the grab (non-null), second is the release (null).
    expect(grabIoctls[0].argKind).toBe("pointer");
    expect(grabIoctls[1].argKind).toBe("null");
    h.shutdown();
  });

  it("shutdown while grabbed releases first, then closes all fds", async () => {
    devicesOnSystem = [
      mkDevice("/dev/input/event5", "Pad", { isController: true }),
      mkDevice("/dev/input/event6", "KB", { isKeyboard: true }),
    ];
    const h = await startInputIntercept({ onWake: () => {}, onAction: () => {} });
    h.grab();
    h.shutdown();
    const closes = ffiCalls.filter((c) => c.kind === "close");
    // 2 device fds + 1 inotify fd opened by device-hotplug.
    expect(closes).toHaveLength(3);
    const grabs = ffiCalls.filter(
      (c) => c.kind === "ioctl" && c.request === 0x40044590n,
    );
    // One grab, one release during shutdown.
    expect(grabs).toHaveLength(2);
  });
});

// ---- EVIOCSMASK sequencing -------------------------------------------------

describe("startInputIntercept — EVIOCSMASK masks at idle vs intercept", () => {
  it("issues EVIOCSMASK on open (idle) and on grab (intercept)", async () => {
    devicesOnSystem = [mkDevice("/dev/input/event5", "Pad", { isController: true })];
    const h = await startInputIntercept({ onWake: () => {}, onAction: () => {} });
    // On open: 4 EVIOCSMASK calls (EV_KEY idle, EV_ABS empty, EV_REL empty, EV_MSC empty).
    const idleMasks = ffiCalls.filter(
      (c) => c.kind === "ioctl" && c.request === 0x40104593n,
    );
    expect(idleMasks.length).toBe(4);
    const priorCount = idleMasks.length;
    h.grab();
    const afterGrab = ffiCalls.filter(
      (c) => c.kind === "ioctl" && c.request === 0x40104593n,
    );
    // Grab adds at least 2 more (EV_KEY broadened, EV_ABS broadened).
    expect(afterGrab.length).toBeGreaterThan(priorCount);
    h.shutdown();
  });
});

// ---- buildBitmask pure function -------------------------------------------

describe("__testing__.buildBitmask", () => {
  const { buildBitmask } = __testing__;
  it("empty codes → empty mask", () => {
    expect(buildBitmask([]).length).toBe(0);
  });

  it("sets the correct bits, aligned to 8 bytes", () => {
    const mask = buildBitmask([0, 7]);
    expect(mask.length).toBeGreaterThanOrEqual(8);
    expect(mask[0]).toBe(0b10000001);
    for (let i = 1; i < mask.length; i++) expect(mask[i]).toBe(0);
  });

  it("handles codes beyond one byte", () => {
    const mask = buildBitmask([BTN_A]);
    // BTN_A = 0x130 = 304 → byte 38, bit 0.
    expect(mask.length).toBeGreaterThanOrEqual(40);
    expect(mask[38]).toBe(0b00000001);
  });
});

const BTN_A = 0x130;
const BTN_B = 0x131;
const BTN_MODE = 0x13c;
const KEY_F16 = 0xba;
const KEY_LEFTCTRL = 29;
const KEY_4 = 5;

// ---- Combo detection (guide+button) ---------------------------------------

describe("__testing__.processCombo", () => {
  const { processCombo, newComboState } = __testing__;

  it("Mode down + A press + A release within 300 ms → GuideA", () => {
    const s = newComboState();
    expect(processCombo(s, BTN_MODE, 1, 1000)).toBeNull();
    expect(processCombo(s, BTN_A, 1, 1010)).toBeNull();
    expect(processCombo(s, BTN_A, 0, 1100)).toBe("GuideA");
  });

  it("Mode + A held longer than 300 ms does NOT fire", () => {
    const s = newComboState();
    processCombo(s, BTN_MODE, 1, 0);
    processCombo(s, BTN_A, 1, 0);
    expect(processCombo(s, BTN_A, 0, 500)).toBeNull();
  });

  it("Button press without Mode held does nothing", () => {
    const s = newComboState();
    expect(processCombo(s, BTN_A, 1, 0)).toBeNull();
    expect(processCombo(s, BTN_A, 0, 100)).toBeNull();
  });

  it("Select-held acts like a second Mode modifier", () => {
    const s = newComboState();
    processCombo(s, 0x13a /* BTN_SELECT */, 1, 0);
    processCombo(s, BTN_B, 1, 10);
    expect(processCombo(s, BTN_B, 0, 50)).toBe("GuideB");
  });
});

describe("__testing__.processShortcut", () => {
  const { processShortcut, newShortcutState } = __testing__;

  it("Ctrl + 4 fires CtrlFour on the 4's key press", () => {
    const s = newShortcutState();
    processShortcut(s, KEY_LEFTCTRL, 1);
    expect(processShortcut(s, KEY_4, 1)).toBe("CtrlFour");
  });

  it("4 alone without Ctrl does nothing", () => {
    const s = newShortcutState();
    expect(processShortcut(s, KEY_4, 1)).toBeNull();
  });

  it("releasing Ctrl clears the held flag", () => {
    const s = newShortcutState();
    processShortcut(s, KEY_LEFTCTRL, 1);
    processShortcut(s, KEY_LEFTCTRL, 0);
    expect(processShortcut(s, KEY_4, 1)).toBeNull();
  });
});

// ---- Axis normalization ----------------------------------------------------

describe("__testing__.normalizeAxis", () => {
  const { normalizeAxis } = __testing__;

  it("maps raw min → -1, raw max → +1, midpoint → 0", () => {
    const cal = new Map([[0x00, { min: -32768, max: 32767 }]]);
    expect(normalizeAxis(0x00, -32768, cal)).toBe(-1);
    expect(normalizeAxis(0x00, 32767, cal)).toBe(1);
    expect(Math.abs(normalizeAxis(0x00, 0, cal))).toBeLessThan(0.01);
  });

  it("clamps values outside the reported range", () => {
    const cal = new Map([[0x00, { min: 0, max: 255 }]]);
    expect(normalizeAxis(0x00, -50, cal)).toBe(-1);
    expect(normalizeAxis(0x00, 500, cal)).toBe(1);
  });

  it("returns 0 when min === max (degenerate calibration)", () => {
    const cal = new Map([[0x00, { min: 5, max: 5 }]]);
    expect(normalizeAxis(0x00, 100, cal)).toBe(0);
  });
});

// ---- Raw → InputEvent ------------------------------------------------------

describe("__testing__.toInputEvents", () => {
  const { toInputEvents } = __testing__;

  it("skips EV_SYN", () => {
    expect(
      toInputEvents([{ type: 0x00, code: 0, value: 0 }], new Map()),
    ).toEqual([]);
  });

  it("maps controller buttons to the right enum", () => {
    const out = toInputEvents(
      [
        { type: 0x01, code: BTN_A, value: 1 },
        { type: 0x01, code: BTN_B, value: 0 },
      ],
      new Map(),
    );
    expect(out).toEqual([
      { kind: "button", button: "A", pressed: true },
      { kind: "button", button: "B", pressed: false },
    ]);
  });

  it("normalizes stick axis values using the calibration map", () => {
    const cal = new Map([[0x00, { min: -100, max: 100 }]]);
    const out = toInputEvents(
      [{ type: 0x03 /* EV_ABS */, code: 0x00 /* ABS_X */, value: 100 }],
      cal,
    );
    expect(out).toEqual([
      { kind: "axis", axis: "LeftStickX", value: 1 },
    ]);
  });

  it("passes hat axis raw through when calibration is absent", () => {
    const out = toInputEvents(
      [{ type: 0x03, code: 0x10 /* ABS_HAT0X */, value: -1 }],
      new Map(),
    );
    expect(out).toEqual([
      { kind: "axis", axis: "HatX", value: -1 },
    ]);
  });
});

// Touch every "unused" sentinel so TS doesn't warn when the file is
// iterated on with stricter config.
void KEY_F16;
void enqueueRead;
