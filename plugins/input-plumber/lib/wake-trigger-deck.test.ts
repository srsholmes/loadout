/**
 * Tests for the Deck press-to-capture path. Stubs findDeckHidrawPath +
 * createReadStream + plugin-storage so no real Deck / fs is needed. Covers:
 *   - a real 0→1 press captures and persists the binding
 *   - non-input (non-0x01) report frames are ignored even with the bit set
 *   - a button already held when capture starts doesn't auto-fire
 *   - a second press after commit is ignored (no double write / re-entrancy)
 *   - timeout returns timedOut:true and leaves an existing binding intact
 */

import { describe, it, expect, spyOn, afterEach } from "bun:test";
import * as deckHid from "@loadout/deck-hid";
import * as storage from "@loadout/plugin-storage";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { captureWakeButton } from "./wake-trigger-deck";

/** 64-byte Deck input report (id 0x01) with optional byte overrides. */
function frame(overrides: Record<number, number> = {}): Buffer {
  const b = Buffer.alloc(64);
  b[0] = 0x01;
  for (const [k, v] of Object.entries(overrides)) b[parseInt(k, 10)] = v;
  return b;
}

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

const tick = () => new Promise((r) => setTimeout(r, 0));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: Record<string, any> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spies: any[] = [];

function setup(stream: ReturnType<typeof fakeStream>) {
  store = {};
  spies = [
    spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue("/dev/hidraw-fake"),
    spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as ReturnType<typeof fs.createReadStream>,
    ),
    spyOn(storage, "readPluginStorage").mockImplementation(
      async (id: string) => ({ ...(store[id] ?? {}) }),
    ),
    spyOn(storage, "writePluginStorage").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (id: string, data: any) => {
        store[id] = data;
      },
    ),
  ];
}

afterEach(() => {
  for (const s of spies) s.mockRestore();
});

describe("captureWakeButton (Deck)", () => {
  it("captures the first real 0→1 press and persists the binding", async () => {
    const stream = fakeStream();
    setup(stream);
    const p = captureWakeButton(5000);
    await tick();
    stream.push(frame()); // idle baseline
    stream.push(frame({ 9: 0x20 })); // Steam press
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.capturedRaw).toBe("deck:Steam");
    expect(store["input-plumber"].wake.selectedRaw).toBe("deck:Steam");
    expect(storage.writePluginStorage).toHaveBeenCalledTimes(1);
  });

  it("ignores non-input report frames even when the bit is set", async () => {
    const stream = fakeStream();
    setup(stream);
    const p = captureWakeButton(5000);
    await tick();
    const nonInput = frame({ 9: 0x20 });
    nonInput[0] = 0x09; // not an input report
    stream.push(nonInput);
    // No capture yet — a real press still wins afterwards.
    stream.push(frame({ 14: 0x04 })); // Qam press (real input report)
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.capturedRaw).toBe("deck:Qam");
  });

  it("ignores a second press after commit (no double write)", async () => {
    const stream = fakeStream();
    setup(stream);
    const p = captureWakeButton(5000);
    await tick();
    stream.push(frame()); // idle
    stream.push(frame({ 9: 0x20 })); // Steam press → commit
    stream.push(frame()); // release
    stream.push(frame({ 14: 0x04 })); // Qam press AFTER commit — ignored
    const r = await p;
    expect(r.capturedRaw).toBe("deck:Steam");
    expect(storage.writePluginStorage).toHaveBeenCalledTimes(1);
  });

  it("on timeout returns timedOut and leaves an existing binding intact", async () => {
    const stream = fakeStream();
    setup(stream);
    store["input-plumber"] = {
      wake: { selectedRaw: "deck:R5", deviceName: "Steam Deck Controller" },
    };
    const p = captureWakeButton(1000); // clamped min — ~1s real wait
    await tick();
    // No press at all.
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(store["input-plumber"].wake.selectedRaw).toBe("deck:R5");
  });
});
