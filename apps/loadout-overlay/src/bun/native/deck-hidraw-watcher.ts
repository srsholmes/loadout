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
import { open } from "node:fs/promises";
import {
  findDeckHidrawPath,
  findButton,
  splitReports,
  decodeNavState,
  REPORT_LEN,
  type DeckButton,
  type DeckNavState,
  isDeckStateReport,
} from "@loadout/deck-hid";
import type { WakeEvent } from "./input-intercept";
import type { InputEvent } from "./nav-controller";

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
  /** Fires with NavController-shaped InputEvents decoded from the full
   *  gamepad report while nav mode is active (see setNavActive). Never
   *  called while nav mode is off, so the idle wake path costs the same
   *  as before. */
  onNavEvents?: (events: InputEvent[]) => void;
  /** Fires ONCE if the stream dies on its own (error/end) — NOT on stop().
   *  When the watcher is the overlay's nav source (Deck strategy), a dead
   *  stream means nav AND the wake button are gone while the strategy would
   *  still freeze Steam on the next open; the caller must degrade or
   *  restart. */
  onDeath?: () => void;
}

export interface DeckHidrawWatcherHandle {
  /** Swap the active button. `null` arms the watcher but disables fires. */
  setBinding(button: string | null): void;
  /** Currently bound button name, or null. */
  getBinding(): string | null;
  /** Toggle full nav decoding (overlay open ↔ closed). Activation latches
   *  the first frame as a baseline WITHOUT emitting — a wake button still
   *  held from the opening press must not fire a nav action into the
   *  freshly-opened overlay. Deactivation clears all diff state. */
  setNavActive(active: boolean): void;
  /** False once the stream has died (error/end) or stop() was called. The
   *  strategy decision must not treat a dead watcher as a nav source. */
  isAlive(): boolean;
  /** Path of the hidraw node we opened, for diagnostics. */
  path(): string;
  /** Tear down the stream. Idempotent. */
  stop(): void;
}

const DEFAULT_LOG = (msg: string) => console.log(`[deck-hidraw] ${msg}`);

/** Stick values are quantized to this many steps per unit before diffing so
 *  ADC noise on a resting stick doesn't emit a continuous event stream. */
const STICK_QUANT = 128;

/** Values within this of center clamp to exactly 0 BEFORE quantization.
 *  Quantization alone can't silence a resting stick whose ADC noise
 *  straddles a step boundary — it would alternate between two quantized
 *  values at report rate (~250/s) and stream axis RPCs the whole time the
 *  overlay is open. The evdev path gets this for free from kernel fuzz
 *  filtering; the raw hidraw path must do its own. 0.10 comfortably covers
 *  the ±0.04 rest drift measured on a worn Jupiter stick while staying far
 *  below NavController's 0.5 nav deadzone and any deliberate scroll tilt. */
const STICK_DEADBAND = 0.1;

function quantize(v: number): number {
  if (Math.abs(v) < STICK_DEADBAND) return 0;
  // `+ 0` normalizes -0 → 0 so a centered stick always compares equal.
  return Math.round(v * STICK_QUANT) / STICK_QUANT + 0;
}

/** Pure: diff two decoded frames into NavController-shaped InputEvents.
 *  Buttons map to the same names the evdev path produces; the d-pad becomes
 *  synthetic Hat axes (−1/0/1) so NavController's axis→dpad edge/repeat
 *  logic is reused unchanged; sticks are quantized and emitted on change.
 *  View/Steam map to Select/Mode so NavController's modifier-suppression
 *  semantics stay consistent with evdev controllers. `prev = null` means
 *  "baseline frame" — nothing is emitted, the caller just stores it. */
export function navStateToInputEvents(
  prev: DeckNavState | null,
  cur: DeckNavState,
): InputEvent[] {
  if (!prev) return [];
  const out: InputEvent[] = [];

  const button = (name: "A" | "B" | "X" | "Y" | "LB" | "RB" | "Mode" | "Select", p: boolean, c: boolean) => {
    if (p !== c) out.push({ kind: "button", button: name, pressed: c });
  };
  button("A", prev.a, cur.a);
  button("B", prev.b, cur.b);
  button("X", prev.x, cur.x);
  button("Y", prev.y, cur.y);
  button("LB", prev.l1, cur.l1);
  button("RB", prev.r1, cur.r1);
  button("Select", prev.view, cur.view);
  button("Mode", prev.steam, cur.steam);

  const hat = (neg: boolean, pos: boolean): number => (pos ? 1 : neg ? -1 : 0);
  const prevHatX = hat(prev.dpadLeft, prev.dpadRight);
  const curHatX = hat(cur.dpadLeft, cur.dpadRight);
  if (prevHatX !== curHatX) out.push({ kind: "axis", axis: "HatX", value: curHatX });
  const prevHatY = hat(prev.dpadUp, prev.dpadDown);
  const curHatY = hat(cur.dpadUp, cur.dpadDown);
  if (prevHatY !== curHatY) out.push({ kind: "axis", axis: "HatY", value: curHatY });

  const stick = (axis: "LeftStickX" | "LeftStickY" | "RightStickX" | "RightStickY", p: number, c: number) => {
    const pq = quantize(p);
    const cq = quantize(c);
    if (pq !== cq) out.push({ kind: "axis", axis, value: cq });
  };
  stick("LeftStickX", prev.lx, cur.lx);
  stick("LeftStickY", prev.ly, cur.ly);
  stick("RightStickX", prev.rx, cur.rx);
  stick("RightStickY", prev.ry, cur.ry);

  return out;
}

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

  // Pre-flight open via the promise API so permission failures (EACCES on
  // hosts that haven't pre-granted the deck user rw on /dev/hidrawN, e.g.
  // a non-SteamOS handheld where the user isn't yet in the `input` group)
  // surface synchronously here instead of as a deferred 'error' event on a
  // stream we'd already returned a handle for. Without this the caller
  // gets a live-looking handle that's silently dead and the F16 evdev
  // fallback never gets to take over.
  let stream: ReadStream;
  try {
    const fh = await open(path, "r");
    // createReadStream takes ownership of the fd; on stream end / error it
    // closes the underlying fd, so we don't double-close.
    stream = createReadStream(path, { fd: fh.fd, autoClose: true });
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
   *  on 0→1, but the user's finger stays down for a hundred-ish milliseconds
   *  after that — comfortably within the inotify + debounce window from
   *  storage write to setBinding. Without this gate, that residual hold
   *  reads as a fresh press → onWake fires immediately → the still-open
   *  picker dismisses → user reads it as a crash. */
  let suppressNextEdge = true;
  let stopped = false;
  let buf: Buffer = Buffer.alloc(0);
  /** Overlay-open nav decoding. `prevNav === null` while active means "next
   *  frame is the baseline" — latch it without emitting (the wake button is
   *  usually still held when the overlay opens). */
  let navActive = false;
  let prevNav: DeckNavState | null = null;

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
      if (!isDeckStateReport(report)) continue;
      // We track only the SINGLE bound bit's transitions. Decoding the full
      // button map per frame is unnecessary on the hot path — chase the one
      // bit and bail. (Less GC pressure than building a Map every report.)
      if (bound) {
        // splitReports only yields full REPORT_LEN (64-byte) frames and
        // bound.byte is always < 64, so this index is provably in-bounds;
        // ?? 0 is behaviour-identical for the bitwise test and drops the `!`.
        const cur = ((report[bound.byte] ?? 0) & (1 << bound.bit)) !== 0;
        if (cur && !lastBitValue && !suppressNextEdge) {
          opts.onWake("QamToggle");
        }
        lastBitValue = cur;
        suppressNextEdge = false;
      }
      // Full nav decode — only while the overlay is open. Runs after the
      // wake-bit chase so a wake press that CLOSES the overlay still fires
      // even when nav mode is active for that same frame.
      if (navActive && opts.onNavEvents) {
        const nav = decodeNavState(report);
        if (nav) {
          const events = navStateToInputEvents(prevNav, nav);
          prevNav = nav;
          if (events.length > 0) opts.onNavEvents(events);
        }
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
    opts.onDeath?.();
  });
  stream.on("end", () => {
    if (stopped) return;
    log(`stream end on ${path} — watcher stopped.`);
    stopped = true;
    opts.onDeath?.();
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
    setNavActive(active: boolean): void {
      navActive = active;
      // Entering OR leaving nav mode drops the diff baseline: on entry the
      // next frame latches silently (held wake button must not fire); on
      // exit stale state must not leak into the next overlay session.
      prevNav = null;
    },
    isAlive(): boolean {
      return !stopped;
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
