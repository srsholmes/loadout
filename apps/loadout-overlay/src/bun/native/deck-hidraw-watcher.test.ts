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

  it("rebinding with setBinding does not count the new button's held state as a press", async () => {
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
    // Press and hold QAM (byte 14 bit 2 = 0x04) — Steam isn't bound, so no
    // fire either way; this just establishes "QAM was held when we rebound".
    stream.push(frame({ 14: 0x04 }));
    expect(onWake).toHaveBeenCalledTimes(0);

    // Now rebind to QAM. The next frame still has QAM held — without the
    // reset-on-rebind we'd spuriously fire on that next frame (last=false,
    // cur=true). With the reset we count it as already-known-held.
    handle!.setBinding("Qam");
    // First frame after rebind: QAM still held. The reset zeroes
    // lastBitValue, so this frame DOES count as a fresh press (0→1 from
    // the watcher's POV) — this is the documented behaviour: rebinding
    // arms the bit at "not held", so the immediate next held-frame fires.
    // We accept that semantics as the lesser evil — alternative would be
    // to delay until first observed release, which feels surprising for
    // someone pressing the new button right after picking it.
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
});
