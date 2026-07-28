/**
 * Watcher tests — stub findDeckHidrawPath + createReadStream so we don't need
 * a real Deck. Verifies:
 *   - returns null when no Deck hidraw is found (graceful no-op on non-Deck)
 *   - 0→1 transition on the bound bit fires onWake once
 *   - holding the button down does NOT spam onWake
 *   - rebinding via setBinding while a (different) button is held doesn't
 *     count the held bit as a fresh press on the next frame
 *   - stop() halts further fires
 */

import { describe, it, expect, spyOn, mock } from "bun:test";
import * as deckHid from "@loadout/deck-hid";
import { REPORT_ID_INPUT, REPORT_LEN, decodeNavState } from "@loadout/deck-hid";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { EventEmitter } from "node:events";
import { startDeckHidrawWatcher, navStateToInputEvents } from "./deck-hidraw-watcher";
import type { InputEvent } from "./nav-controller";

/** The watcher pre-flights with fs.promises.open before constructing a
 *  stream from the resulting fd — that's how it surfaces EACCES sync.
 *  Tests don't want a real fd, so we hand back a stub FileHandle. */
function stubOpenOk() {
  return spyOn(fsp, "open").mockResolvedValue({
    fd: 999, // any number — createReadStream is stubbed below
    close: async () => undefined,
  } as unknown as fsp.FileHandle);
}

/** Build a Deck input report (REPORT_LEN bytes) with optional byte overrides. */
/** Realistic Deck state frame — header `01 00 09 40`. See makeReport in
 *  packages/deck-hid/src/index.test.ts. */
function frame(overrides: Record<number, number> = {}): Buffer {
  const b = Buffer.alloc(REPORT_LEN);
  b[0] = REPORT_ID_INPUT;
  b[1] = 0x00;
  b[2] = 0x09;
  b[3] = 0x40;
  for (const [k, v] of Object.entries(overrides)) b[parseInt(k, 10)] = v;
  return b;
}

/** Make a fake hidraw stream: an EventEmitter pretending to be a ReadStream. */
function fakeStream() {
  const ee = new EventEmitter() as EventEmitter & {
    destroy: () => void;
    push: (b: Buffer) => void;
  };
  ee.destroy = () => {
    /* no-op for tests */
  };
  ee.push = (b: Buffer) => ee.emit("data", b);
  return ee;
}

describe("deck-hidraw-watcher", () => {
  it("returns null when no Deck hidraw is present", async () => {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(null);
    const handle = await startDeckHidrawWatcher({ onWake: () => {} });
    expect(handle).toBeNull();
    findSpy.mockRestore();
  });

  it("returns null and logs when open fails (EACCES on non-SteamOS handhelds)", async () => {
    // Pre-flight open is what surfaces permission failures synchronously.
    // Before this guard, createReadStream succeeded against the path but
    // the first read fired an async 'error' event, so the caller had a
    // live-looking handle that was silently dead.
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const openSpy = spyOn(fsp, "open").mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
    );
    const logs: string[] = [];
    const handle = await startDeckHidrawWatcher({
      onWake: () => {},
      log: (msg) => logs.push(msg),
    });
    expect(handle).toBeNull();
    expect(logs.some((m) => m.includes("EACCES"))).toBe(true);
    expect(logs.some((m) => m.includes("F16 evdev"))).toBe(true);
    findSpy.mockRestore();
    openSpy.mockRestore();
  });

  it("fires onWake once on 0→1 of the bound button and not on hold", async () => {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
    const openSpy = stubOpenOk();
    const streamSpy = spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    );
    const onWake = mock(() => {});

    const handle = await startDeckHidrawWatcher({
      onWake,
      initialButton: "Steam",
      log: () => {},
    });
    expect(handle).not.toBeNull();

    // idle frame — no press
    stream.push(frame());
    expect(onWake).toHaveBeenCalledTimes(0);

    // Steam pressed (byte 9 bit 5 = 0x20)
    stream.push(frame({ 9: 0x20 }));
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledWith("QamToggle");

    // still held — no additional fires
    stream.push(frame({ 9: 0x20 }));
    stream.push(frame({ 9: 0x20 }));
    expect(onWake).toHaveBeenCalledTimes(1);

    // released and pressed again — second fire
    stream.push(frame());
    stream.push(frame({ 9: 0x20 }));
    expect(onWake).toHaveBeenCalledTimes(2);

    handle!.stop();
    findSpy.mockRestore();
    streamSpy.mockRestore();
    openSpy.mockRestore();
  });

  it("rebinding with setBinding does not fire when the new button is already held", async () => {
    // Regression test for the "press R5 to bind it → overlay immediately
    // toggles closed" bug: the press-to-capture flow commits on 0→1, but
    // the user's finger is still down for ~100ms after that, often spanning
    // the watcher's plugin-storage poll interval. The watcher must NOT
    // count that residual hold as a fresh press.
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
    const openSpy = stubOpenOk();
    const streamSpy = spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    );
    const onWake = mock(() => {});

    const handle = await startDeckHidrawWatcher({
      onWake,
      initialButton: "Steam",
      log: () => {},
    });
    // QAM (byte 14 bit 2 = 0x04) physically pressed; Steam isn't bound,
    // so nothing fires. Just establishes "QAM is currently held".
    stream.push(frame({ 14: 0x04 }));
    expect(onWake).toHaveBeenCalledTimes(0);

    // User just captured QAM as their wake button — binding flips to QAM
    // while QAM is still held by the user's finger.
    handle!.setBinding("Qam");

    // First frame after rebind with QAM still held: the suppress-next-edge
    // gate consumes the spurious 0→1 (lastBitValue was 0 because we'd
    // never tracked QAM, cur is 1). No fire.
    stream.push(frame({ 14: 0x04 }));
    expect(onWake).toHaveBeenCalledTimes(0);

    // User releases QAM (cur=false). No fire (release transition).
    stream.push(frame());
    expect(onWake).toHaveBeenCalledTimes(0);

    // User presses QAM again — a real, fresh 0→1. Fires.
    stream.push(frame({ 14: 0x04 }));
    expect(onWake).toHaveBeenCalledTimes(1);

    handle!.stop();
    findSpy.mockRestore();
    streamSpy.mockRestore();
    openSpy.mockRestore();
  });

  it("stop() halts further fires", async () => {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
    const openSpy = stubOpenOk();
    const streamSpy = spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    );
    const onWake = mock(() => {});

    const handle = await startDeckHidrawWatcher({
      onWake,
      initialButton: "Steam",
      log: () => {},
    });
    handle!.stop();
    // Press the bound button after stop — must not fire.
    stream.push(frame({ 9: 0x20 }));
    expect(onWake).toHaveBeenCalledTimes(0);

    findSpy.mockRestore();
    streamSpy.mockRestore();
    openSpy.mockRestore();
  });

  it("setBinding(null) disables fires until the next setBinding(name)", async () => {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
    const openSpy = stubOpenOk();
    const streamSpy = spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    );
    const onWake = mock(() => {});

    const handle = await startDeckHidrawWatcher({
      onWake,
      initialButton: "Steam",
      log: () => {},
    });
    handle!.setBinding(null);
    stream.push(frame({ 9: 0x20 }));
    expect(onWake).toHaveBeenCalledTimes(0);

    handle!.setBinding("Steam");
    stream.push(frame()); // release, so the next frame is a real 0→1
    stream.push(frame({ 9: 0x20 }));
    expect(onWake).toHaveBeenCalledTimes(1);

    handle!.stop();
    findSpy.mockRestore();
    streamSpy.mockRestore();
    openSpy.mockRestore();
  });

  it("ignores non-input report frames even when the bound bit is set", async () => {
    // The hidraw stream interleaves report types; only report id 0x01 carries
    // button state. A non-0x01 frame whose byte-9 payload happens to have
    // bit 5 set must NOT be read as a Steam press — otherwise unrelated
    // report traffic toggles the overlay open at random.
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
    const openSpy = stubOpenOk();
    const streamSpy = spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    );
    const onWake = mock(() => {});

    const handle = await startDeckHidrawWatcher({
      onWake,
      initialButton: "Steam",
      log: () => {},
    });

    // Idle input frame first to consume the startup edge-suppress so this
    // test isolates the non-input-filter behaviour from that one-shot gate.
    stream.push(frame());
    expect(onWake).toHaveBeenCalledTimes(0);

    // A non-input report (id 0x09) with byte 9 bit 5 set — must be skipped
    // without touching edge state.
    const nonInput = frame({ 9: 0x20 });
    nonInput[0] = 0x09;
    stream.push(nonInput);
    expect(onWake).toHaveBeenCalledTimes(0);

    // A real input report with the same bit set still fires — the skip must
    // not have corrupted lastBitValue (0→1 must still register).
    stream.push(frame({ 9: 0x20 }));
    expect(onWake).toHaveBeenCalledTimes(1);

    handle!.stop();
    findSpy.mockRestore();
    streamSpy.mockRestore();
    openSpy.mockRestore();
  });
});

describe("deck-hidraw-watcher nav mode", () => {
  /** Boilerplate: stubbed Deck stream + started watcher with nav sink. */
  async function startWithNav() {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
    const openSpy = stubOpenOk();
    const streamSpy = spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    );
    const onWake = mock(() => {});
    const navBatches: InputEvent[][] = [];
    const handle = await startDeckHidrawWatcher({
      onWake,
      initialButton: "Steam",
      log: () => {},
      onNavEvents: (events) => navBatches.push(events),
    });
    const restore = () => {
      handle!.stop();
      findSpy.mockRestore();
      streamSpy.mockRestore();
      openSpy.mockRestore();
    };
    return { stream, onWake, navBatches, handle: handle!, restore };
  }

  it("emits nothing while nav mode is off", async () => {
    const t = await startWithNav();
    t.stream.push(frame());
    t.stream.push(frame({ 8: 0x80 })); // A pressed
    expect(t.navBatches).toHaveLength(0);
    t.restore();
  });

  it("latches the first frame as a silent baseline, then emits edges", async () => {
    const t = await startWithNav();
    t.handle.setNavActive(true);
    // First frame arrives with A ALREADY held (wake button was "A") —
    // baseline latch, no emission.
    t.stream.push(frame({ 8: 0x80 }));
    expect(t.navBatches).toHaveLength(0);
    // Release → one batch with the A release edge.
    t.stream.push(frame());
    expect(t.navBatches).toHaveLength(1);
    expect(t.navBatches[0]).toEqual([
      { kind: "button", button: "A", pressed: false },
    ]);
    // Fresh press → press edge.
    t.stream.push(frame({ 8: 0x80 }));
    expect(t.navBatches[1]).toEqual([
      { kind: "button", button: "A", pressed: true },
    ]);
    t.restore();
  });

  it("maps the d-pad to Hat axes and sticks to quantized axis events", async () => {
    const t = await startWithNav();
    t.handle.setNavActive(true);
    t.stream.push(frame()); // baseline
    // dpadRight (byte 9 bit 1) + left stick pushed fully right.
    const f = frame({ 9: 0x02 });
    f.writeInt16LE(32767, 48);
    t.stream.push(f);
    expect(t.navBatches).toHaveLength(1);
    expect(t.navBatches[0]).toContainEqual({ kind: "axis", axis: "HatX", value: 1 });
    expect(t.navBatches[0]).toContainEqual({ kind: "axis", axis: "LeftStickX", value: 1 });
    // Back to neutral → both return to 0.
    t.stream.push(frame());
    expect(t.navBatches[1]).toContainEqual({ kind: "axis", axis: "HatX", value: 0 });
    expect(t.navBatches[1]).toContainEqual({ kind: "axis", axis: "LeftStickX", value: 0 });
    t.restore();
  });

  it("suppresses sub-quantum stick jitter", async () => {
    const t = await startWithNav();
    t.handle.setNavActive(true);
    t.stream.push(frame()); // baseline
    const jitter = frame();
    jitter.writeInt16LE(60, 48); // ~0.0018 — far below one 1/128 quantum
    t.stream.push(jitter);
    expect(t.navBatches).toHaveLength(0);
    t.restore();
  });

  it("wake still fires while nav mode is active", async () => {
    const t = await startWithNav();
    t.handle.setNavActive(true);
    t.stream.push(frame()); // baseline + consumes startup edge-suppress
    t.stream.push(frame({ 9: 0x20 })); // Steam (bound wake button) pressed
    expect(t.onWake).toHaveBeenCalledTimes(1);
    // The same press also reached nav as a Mode edge (Steam → Mode).
    expect(t.navBatches[0]).toContainEqual({
      kind: "button",
      button: "Mode",
      pressed: true,
    });
    t.restore();
  });

  it("setNavActive(false) stops emission and re-arming re-latches the baseline", async () => {
    const t = await startWithNav();
    t.handle.setNavActive(true);
    t.stream.push(frame()); // baseline
    t.stream.push(frame({ 8: 0x80 }));
    expect(t.navBatches).toHaveLength(1);

    t.handle.setNavActive(false);
    t.stream.push(frame()); // A released while closed — must not emit
    expect(t.navBatches).toHaveLength(1);

    t.handle.setNavActive(true);
    // Re-open with B already held: silent baseline again.
    t.stream.push(frame({ 8: 0x20 }));
    expect(t.navBatches).toHaveLength(1);
    t.stream.push(frame());
    expect(t.navBatches[1]).toEqual([
      { kind: "button", button: "B", pressed: false },
    ]);
    t.restore();
  });

  it("decodes nav from each report of a coalesced chunk", async () => {
    const t = await startWithNav();
    t.handle.setNavActive(true);
    t.stream.push(frame()); // baseline
    // One chunk holding press-then-release — two batches, in order.
    t.stream.push(Buffer.concat([frame({ 8: 0x80 }), frame()]));
    expect(t.navBatches).toHaveLength(2);
    expect(t.navBatches[0]).toEqual([{ kind: "button", button: "A", pressed: true }]);
    expect(t.navBatches[1]).toEqual([{ kind: "button", button: "A", pressed: false }]);
    t.restore();
  });

  it("ignores non-input reports in nav mode too", async () => {
    const t = await startWithNav();
    t.handle.setNavActive(true);
    t.stream.push(frame()); // baseline
    const nonInput = frame({ 8: 0xff });
    nonInput[0] = 0x09;
    t.stream.push(nonInput);
    expect(t.navBatches).toHaveLength(0);
    t.restore();
  });
});

describe("navStateToInputEvents", () => {
  const neutral = (): NonNullable<ReturnType<typeof decodeNavState>> =>
    decodeNavState(frame())!;

  it("returns [] for a null prev (baseline latch)", () => {
    expect(navStateToInputEvents(null, neutral())).toEqual([]);
  });

  it("maps every button edge to the evdev-path names", () => {
    const cur = {
      ...neutral(),
      a: true, b: true, x: true, y: true,
      l1: true, r1: true, view: true, steam: true,
    };
    const events = navStateToInputEvents(neutral(), cur);
    for (const button of ["A", "B", "X", "Y", "LB", "RB", "Select", "Mode"] as const) {
      expect(events).toContainEqual({ kind: "button", button, pressed: true });
    }
  });

  it("resolves opposing d-pad bits with positive direction winning", () => {
    // Physically near-impossible, but the mapping must stay deterministic.
    const cur = { ...neutral(), dpadLeft: true, dpadRight: true };
    const events = navStateToInputEvents(neutral(), cur);
    expect(events).toContainEqual({ kind: "axis", axis: "HatX", value: 1 });
  });

  it("does not emit for qam/menu (wake-path and unmapped buttons)", () => {
    const cur = { ...neutral(), qam: true, menu: true };
    expect(navStateToInputEvents(neutral(), cur)).toEqual([]);
  });
});

describe("deck-hidraw-watcher stick dead-band", () => {
  it("silences rest drift that straddles a quantization boundary", async () => {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
    const openSpy = stubOpenOk();
    const streamSpy = spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    );
    const navBatches: InputEvent[][] = [];
    const handle = await startDeckHidrawWatcher({
      onWake: () => {},
      initialButton: "Steam",
      log: () => {},
      onNavEvents: (events) => navBatches.push(events),
    });
    const t = {
      handle: handle!,
      stream,
      navBatches,
      restore: () => {
        handle!.stop();
        findSpy.mockRestore();
        streamSpy.mockRestore();
        openSpy.mockRestore();
      },
    };
    t.handle.setNavActive(true);
    t.stream.push(frame()); // baseline
    // Alternate around a 1/128 boundary (raw 128 ≈ 0.0039, raw 384 ≈ 0.0117
    // — both inside the 0.10 dead-band). Without the dead-band this would
    // emit an axis RPC per report, forever.
    for (let i = 0; i < 10; i++) {
      const f = frame();
      f.writeInt16LE(i % 2 === 0 ? 128 : 384, 52); // RightStickX
      t.stream.push(f);
    }
    expect(t.navBatches).toHaveLength(0);
    // Measured Jupiter rest drift (~0.04 ≈ raw 1300) also stays silent.
    const drift = frame();
    drift.writeInt16LE(1300, 48);
    t.stream.push(drift);
    expect(t.navBatches).toHaveLength(0);
    // A deliberate tilt still gets through.
    const tilt = frame();
    tilt.writeInt16LE(16384, 52); // ~0.5
    t.stream.push(tilt);
    expect(t.navBatches).toHaveLength(1);
    expect(t.navBatches[0]![0]).toEqual({
      kind: "axis",
      axis: "RightStickX",
      value: expect.closeTo(0.5, 1),
    });
    t.restore();
  });
});

describe("deck-hidraw-watcher death signal", () => {
  it("fires onDeath on stream error (not on stop) and flips isAlive", async () => {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
    const openSpy = stubOpenOk();
    const streamSpy = spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    );
    const onDeath = mock(() => {});
    const handle = await startDeckHidrawWatcher({
      onWake: () => {},
      initialButton: "Steam",
      log: () => {},
      onDeath,
    });
    expect(handle!.isAlive()).toBe(true);
    stream.emit("error", new Error("device unplugged"));
    expect(onDeath).toHaveBeenCalledTimes(1);
    expect(handle!.isAlive()).toBe(false);
    // stop() after death is idempotent and does NOT re-fire onDeath.
    handle!.stop();
    expect(onDeath).toHaveBeenCalledTimes(1);
    findSpy.mockRestore();
    streamSpy.mockRestore();
    openSpy.mockRestore();
  });

  it("does not fire onDeath on a deliberate stop()", async () => {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
    const openSpy = stubOpenOk();
    const streamSpy = spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    );
    const onDeath = mock(() => {});
    const handle = await startDeckHidrawWatcher({
      onWake: () => {},
      log: () => {},
      onDeath,
    });
    handle!.stop();
    expect(onDeath).toHaveBeenCalledTimes(0);
    expect(handle!.isAlive()).toBe(false);
    findSpy.mockRestore();
    streamSpy.mockRestore();
    openSpy.mockRestore();
  });
});

describe("deck-hidraw-watcher wake-button-is-a-nav-button (production-shaped)", () => {
  it("a closing wake press does not leak a nav edge; reopening re-latches", async () => {
    // Wake bound to "A" — also a nav button. Production wiring: onWake runs
    // toggleOverlay synchronously, which flips setNavActive. The closing
    // press's wake fires BEFORE the same frame's nav decode (wake-bit chase
    // runs first in onChunk), so by decode time navActive is false and no
    // "A" edge may leak into a NavController that release() has just reset.
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
    const openSpy = stubOpenOk();
    const streamSpy = spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    );
    const navBatches: InputEvent[][] = [];
    let isOpen = false;
    let handleRef: Awaited<ReturnType<typeof startDeckHidrawWatcher>> = null;
    const handle = await startDeckHidrawWatcher({
      // Mirrors toggleOverlay: synchronous open/close flipping nav mode.
      onWake: () => {
        isOpen = !isOpen;
        handleRef!.setNavActive(isOpen);
      },
      initialButton: "A",
      log: () => {},
      onNavEvents: (events) => navBatches.push(events),
    });
    handleRef = handle;

    stream.push(frame()); // consume startup edge-suppress
    // OPEN press: wake fires, nav mode activates mid-frame; the same frame
    // becomes the silent baseline (A held) — no nav emission.
    stream.push(frame({ 8: 0x80 }));
    expect(isOpen).toBe(true);
    expect(navBatches).toHaveLength(0);
    // Release while open — the baseline held A releases; NavController-side
    // this is a no-op (never counted as pressed), but the edge itself is
    // fine to emit.
    stream.push(frame());
    expect(navBatches).toHaveLength(1);
    expect(navBatches[0]).toEqual([
      { kind: "button", button: "A", pressed: false },
    ]);
    // CLOSE press: wake fires first (overlay closes, nav deactivates), so
    // the same frame's decode is skipped — NO nav press edge leaks.
    stream.push(frame({ 8: 0x80 }));
    expect(isOpen).toBe(false);
    expect(navBatches).toHaveLength(1);

    handle!.stop();
    findSpy.mockRestore();
    streamSpy.mockRestore();
    openSpy.mockRestore();
  });
});
