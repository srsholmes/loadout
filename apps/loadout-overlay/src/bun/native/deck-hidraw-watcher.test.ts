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
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { startDeckHidrawWatcher } from "./deck-hidraw-watcher";

/** Build a 64-byte Deck input report with optional byte overrides. */
function frame(overrides: Record<number, number> = {}): Buffer {
  const b = Buffer.alloc(64);
  b[0] = 0x01;
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

  it("fires onWake once on 0→1 of the bound button and not on hold", async () => {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
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
  });

  it("stop() halts further fires", async () => {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
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
  });

  it("setBinding(null) disables fires until the next setBinding(name)", async () => {
    const findSpy = spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(
      "/dev/hidraw-fake",
    );
    const stream = fakeStream();
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
  });
});
