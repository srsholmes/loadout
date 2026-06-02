/**
 * Steam Deck native wake-button watcher.
 *
 * Opens /dev/hidrawN (the Deck's gamepad interface) and watches a single
 * caller-configured button for 0→1 transitions, firing `onWake("QamToggle")`
 * on each press. Runs in parallel with Steam Input — the kernel hid-steam
 * driver allows multiple concurrent readers on the same hidraw node, so
 * Steam Input's per-game configs, Lizard mode, gyro, chord detection, and
 * trackpad-as-mouse are all preserved.
 *
 * Lifecycle:
 *   - `startDeckHidrawWatcher(opts)` returns a handle or null. Null means
 *     "not a Deck, or we couldn't open the hidraw" — the caller should
 *     fall through to the existing F16 evdev wake path.
 *   - `handle.setBinding(buttonName | null)` swaps the live binding without
 *     restarting the stream. Null disables the watcher (no presses fire).
 *   - `handle.stop()` tears down the stream.
 *
 * Failure handling:
 *   - Open EACCES / ENOENT → returns null. Logs a one-line warning so the
 *     journal records WHY the Deck wake isn't active. The picker UI surfaces
 *     a "needs setup" state in a later turn (issue #86 §"What the runtime
 *     watcher needs to handle").
 *   - Stream `error` while running → logs and self-destructs. The next overlay
 *     restart re-tries; we don't auto-reconnect here because the realistic
 *     failure (controller unplugged or driver reset) is out of scope for
 *     this first cut.
 */

import { createReadStream, type ReadStream } from "node:fs";
import {
  findDeckHidrawPath,
  findButton,
  splitReports,
  REPORT_ID_INPUT,
  REPORT_LEN,
  type DeckButton,
} from "@loadout/deck-hid";
import type { WakeEvent } from "./input-intercept";

export interface DeckHidrawWatcherOptions {
  /** Fires when the bound button transitions 0→1. Always passes
   *  "QamToggle" — same shape as the F16 evdev path so onWake routing in
   *  index.ts doesn't need to branch. */
  onWake: (event: WakeEvent) => void;
  /** Initial button binding (e.g. "Steam", "L4"). Null = watcher armed but
   *  no button fires; user picks one via the input-plumber plugin picker. */
  initialButton?: string | null;
  /** Optional log sink. Defaults to console.log with a [deck-hidraw] prefix. */
  log?: (msg: string) => void;
}

export interface DeckHidrawWatcherHandle {
  /** Swap the active button. `null` arms the watcher but disables fires. */
  setBinding(button: string | null): void;
  /** Currently bound button name, or null. */
  getBinding(): string | null;
  /** Path of the hidraw node we opened, for diagnostics. */
  path(): string;
  /** Tear down the stream. Idempotent. */
  stop(): void;
}

const DEFAULT_LOG = (msg: string) => console.log(`[deck-hidraw] ${msg}`);

/**
 * Start a watcher. Returns null when we can't or shouldn't run — non-Deck
 * host, ACL denial, hidraw node unavailable. Callers should not treat null
 * as an error; the F16 evdev path stays the fallback.
 */
export async function startDeckHidrawWatcher(
  opts: DeckHidrawWatcherOptions,
): Promise<DeckHidrawWatcherHandle | null> {
  const log = opts.log ?? DEFAULT_LOG;
  const path = await findDeckHidrawPath();
  if (!path) {
    // No Deck gamepad interface found — not a Deck, controller unplugged,
    // or running under a kernel without hid-steam. Quietly bow out.
    return null;
  }

  let stream: ReadStream;
  try {
    stream = createReadStream(path);
  } catch (err) {
    log(
      `open failed for ${path}: ${err instanceof Error ? err.message : String(err)} — ` +
        "Deck wake button disabled; F16 evdev path will be used.",
    );
    return null;
  }

  let bound: DeckButton | null = findButton(opts.initialButton ?? null);
  let lastBitValue = false;
  /** One-shot: after a (re)bind, ignore the first observed transition so the
   *  watcher doesn't fire just because the user is still holding the button
   *  they captured. The press-to-capture flow in wake-trigger-deck commits
   *  on 0→1, but the user's finger is still down for a hundred-ish
   *  milliseconds after that — within the watcher's 2s storage poll. Without
   *  this gate, that residual hold reads as a fresh press → onWake fires
   *  immediately → the still-open picker dismisses → user reads it as a
   *  crash. */
  let suppressNextEdge = true;
  let stopped = false;
  let buf: Buffer = Buffer.alloc(0);

  log(`watching ${path}; initial binding = ${bound?.name ?? "<none>"}`);

  const onChunk = (chunk: Buffer): void => {
    if (stopped) return;
    // Coalesced reads happen; split into 64-byte frames and decode each.
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (const report of splitReports(buf)) {
      // The hidraw stream interleaves report types; only id 0x01 carries
      // button state. Skip everything else WITHOUT touching edge state —
      // reading a non-input frame's bytes would both misfire and corrupt
      // lastBitValue, desyncing the next real press.
      if (report[0] !== REPORT_ID_INPUT) continue;
      // We track only the SINGLE bound bit's transitions. Decoding the full
      // button map per frame is unnecessary on the hot path — chase the one
      // bit and bail. (Less GC pressure than building a Map every report.)
      if (bound) {
        const cur = (report[bound.byte] & (1 << bound.bit)) !== 0;
        if (cur && !lastBitValue && !suppressNextEdge) {
          opts.onWake("QamToggle");
        }
        lastBitValue = cur;
        suppressNextEdge = false;
      }
    }
    // Keep only the trailing partial report (rare; defensive).
    const consumed = Math.floor(buf.length / REPORT_LEN) * REPORT_LEN;
    buf = consumed === buf.length ? Buffer.alloc(0) : buf.subarray(consumed);
  };

  stream.on("data", (data: string | Buffer) => {
    onChunk(typeof data === "string" ? Buffer.from(data) : data);
  });
  stream.on("error", (err: Error) => {
    if (stopped) return;
    log(`stream error on ${path}: ${err.message} — watcher stopped.`);
    stopped = true;
    try {
      stream.destroy();
    } catch {
      /* ignore */
    }
  });
  stream.on("end", () => {
    if (stopped) return;
    log(`stream end on ${path} — watcher stopped.`);
    stopped = true;
  });

  return {
    setBinding(name: string | null): void {
      const next = findButton(name);
      // Arm the one-shot edge gate: on the next frame, we'll latch the
      // bit's CURRENT physical state into lastBitValue without firing,
      // so a button already held at rebind time doesn't trip a spurious
      // press. Subsequent frames behave normally.
      suppressNextEdge = true;
      lastBitValue = false;
      bound = next;
      log(`binding → ${next?.name ?? "<none>"}`);
    },
    getBinding(): string | null {
      return bound?.name ?? null;
    },
    path(): string {
      return path;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      log(`stopped (${path})`);
    },
  };
}
