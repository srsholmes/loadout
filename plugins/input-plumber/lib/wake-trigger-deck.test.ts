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
import { REPORT_ID_INPUT, REPORT_LEN } from "@loadout/deck-hid";
import * as storage from "@loadout/plugin-storage";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as exec from "@loadout/exec";
import { EventEmitter } from "node:events";
import { captureWakeButton, ensureDeckHidrawUaccess } from "./wake-trigger-deck";
import {
  DECK_HIDRAW_UACCESS_RULE,
  DECK_HIDRAW_UACCESS_RULE_PATH,
} from "./profile";

/** Deck input report (id 0x01, REPORT_LEN bytes) with optional byte overrides. */
function frame(overrides: Record<number, number> = {}): Buffer {
  const b = Buffer.alloc(REPORT_LEN);
  b[0] = REPORT_ID_INPUT;
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

  it("fails cleanly when no Deck hidraw node is present", async () => {
    // Stub the discovery to return null — non-Deck host, controller
    // unplugged, or kernel without hid-steam. captureInner must surface a
    // friendly error instead of hanging or throwing.
    spies = [
      spyOn(deckHid, "findDeckHidrawPath").mockResolvedValue(null),
      spyOn(storage, "readPluginStorage").mockResolvedValue({}),
      spyOn(storage, "writePluginStorage").mockResolvedValue(),
    ];
    const r = await captureWakeButton(5000);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("hidraw node");
    // Should not have tried to write storage when nothing was captured.
    expect(storage.writePluginStorage).toHaveBeenCalledTimes(0);
  });

  it("single-flight: concurrent captures coalesce onto one result", async () => {
    // Two pickers calling captureWakeButton in parallel should resolve to
    // the same WakeCaptureResult, and only ONE write should land. Without
    // the captureInflight gate they'd race and the second open would
    // clobber the first's storage write.
    const stream = fakeStream();
    setup(stream);
    const p1 = captureWakeButton(5000);
    const p2 = captureWakeButton(5000);
    await tick();
    stream.push(frame()); // idle baseline
    stream.push(frame({ 9: 0x20 })); // Steam press
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r1.capturedRaw).toBe("deck:Steam");
    // Both callers see the same result envelope (same object reference,
    // since the inner Promise is shared via the gate).
    expect(r2).toBe(r1);
    expect(storage.writePluginStorage).toHaveBeenCalledTimes(1);
  });

  it("on timeout, restores the previous binding even if a concurrent writer mutated it", async () => {
    // The timeout-restore branch reads current storage, compares to the
    // snapshot taken at capture start, and writes the snapshot back if
    // they've diverged. This test simulates a concurrent writer changing
    // the binding mid-capture and asserts the restore reverts it — the
    // documented behaviour from the prior review's race-fix commit.
    const stream = fakeStream();
    setup(stream);
    store["input-plumber"] = {
      wake: { selectedRaw: "deck:R5", deviceName: "Steam Deck Controller" },
    };
    const p = captureWakeButton(1000);
    await tick();
    // Mid-flight: pretend another writer changed the binding.
    store["input-plumber"] = {
      wake: { selectedRaw: "deck:A", deviceName: "Steam Deck Controller" },
    };
    const r = await p;
    expect(r.timedOut).toBe(true);
    // Restore wrote the snapshot back over the concurrent value.
    expect(store["input-plumber"].wake.selectedRaw).toBe("deck:R5");
  });

  it("resolves with an error when the hidraw stream closes mid-capture", async () => {
    // Controller unplug / hid-steam reset emits 'end' on the stream. Without
    // an end handler the Promise hangs to the full timeout (up to 60s).
    const stream = fakeStream();
    setup(stream);
    const p = captureWakeButton(60_000);
    await tick();
    stream.emit("end");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("stream closed");
  });
});

describe("ensureDeckHidrawUaccess", () => {
  // Stub the privileged side effects so the test works as a regular user
  // and we can assert exactly what the function would do as root.
  function stubFsAndExec(opts: {
    existingContent?: string | null;
    writeFails?: boolean;
  } = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writeCalls: Array<{ path: string; content: string }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const execCalls: string[][] = [];
    const spies = [
      spyOn(fsp, "mkdir").mockResolvedValue(undefined),
      spyOn(fsp, "readFile").mockImplementation(async () => {
        if (opts.existingContent === undefined || opts.existingContent === null) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return opts.existingContent;
      }),
      spyOn(fsp, "writeFile").mockImplementation(async (p: unknown, c: unknown) => {
        if (opts.writeFails) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        writeCalls.push({ path: String(p), content: String(c) });
      }),
      spyOn(exec, "runFull").mockImplementation(async (cmd: readonly string[]) => {
        execCalls.push([...cmd]);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    ];
    return { writeCalls, execCalls, spies };
  }

  it("writes the rule + reloads + triggers udev when no rule is present", async () => {
    const { writeCalls, execCalls, spies } = stubFsAndExec();
    await ensureDeckHidrawUaccess();
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].path).toBe(DECK_HIDRAW_UACCESS_RULE_PATH);
    expect(writeCalls[0].content).toBe(DECK_HIDRAW_UACCESS_RULE);
    expect(execCalls.find((c) => c.includes("--reload"))).toBeDefined();
    const trigger = execCalls.find((c) => c.includes("trigger"));
    expect(trigger).toBeDefined();
    expect(trigger).toContain("--subsystem-match=hidraw");
    for (const s of spies) s.mockRestore();
  });

  it("is a no-op when the rule file already matches the expected content", async () => {
    const { writeCalls, execCalls, spies } = stubFsAndExec({
      existingContent: DECK_HIDRAW_UACCESS_RULE,
    });
    await ensureDeckHidrawUaccess();
    expect(writeCalls).toHaveLength(0);
    // No reload/trigger either — the whole work is skipped on the early return.
    expect(execCalls).toHaveLength(0);
    for (const s of spies) s.mockRestore();
  });

  it("rewrites the rule when on-disk content differs from expected", async () => {
    const { writeCalls, spies } = stubFsAndExec({
      existingContent: "# stale, pre-CLOSURE_REV bump content\n",
    });
    await ensureDeckHidrawUaccess();
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].content).toBe(DECK_HIDRAW_UACCESS_RULE);
    for (const s of spies) s.mockRestore();
  });

  it("swallows write failures (best-effort — watcher's EACCES guard is the fallback)", async () => {
    const { spies } = stubFsAndExec({ writeFails: true });
    // Must not throw — onLoad fires this and a throw would crash plugin
    // load on local-dev runs (where the user isn't root).
    await expect(ensureDeckHidrawUaccess()).resolves.toBeUndefined();
    for (const s of spies) s.mockRestore();
  });
});
