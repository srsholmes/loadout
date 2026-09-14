// Release drain for the InputPlumber intercept (ip-intercept.ts).
//
// IP's DBus target dedupes button events against a per-button last-value
// map that is only cleared when the target detaches — never on an
// InterceptMode change. If the press that CLOSES the overlay (A on a close
// control, or the wake button itself) reaches the DBus target but its
// release lands after we've flipped InterceptMode back to 0, the release
// goes to the gamepad target instead and the DBus target is left believing
// the button is still down. The next open's first press of that button is
// then a "duplicate" and never signalled — the user has to press twice.
//
// The drain keeps intercept on until every key that was held AT CLOSE TIME
// has been seen released (or a deadline passes). Only the snapshot counts:
// input that starts during the drain is not ours to wait for — it never
// touched the DBus target as a press, so it can't be stranded there.
//
// Pure — timers and the clock are injected so the state machine is unit-
// testable without spawning busctl/gdbus.

export type DrainOutcome = "immediate" | "complete" | "timeout";

export interface ReleaseDrainOptions {
  /** Upper bound on how long to wait for the snapshot to release. */
  maxMs: number;
  /** Deadline poll cadence. Completion is normally driven by poke(). */
  tickMs: number;
  /** Which keys are currently down — consulted on every poke() and tick. */
  isHeld: (key: string) => boolean;
  /** Called exactly once per start(): "immediate" when nothing was held,
   *  "complete" when the snapshot released, "timeout" at the deadline. */
  onFinish: (outcome: DrainOutcome, elapsedMs: number) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
}

export class ReleaseDrain {
  private readonly opts: Required<ReleaseDrainOptions>;
  private waitFor: Set<string> | null = null;
  private startedAt = 0;
  private timer: unknown = null;

  constructor(opts: ReleaseDrainOptions) {
    this.opts = {
      now: () => performance.now(),
      schedule: (fn, ms) => setInterval(fn, ms),
      unschedule: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      ...opts,
    };
  }

  /** True between start() and finish/cancel. */
  get active(): boolean {
    return this.waitFor !== null;
  }

  /** Begin draining `held` (the keys down right now). No-op if already
   *  active. Finishes synchronously with "immediate" when `held` is empty. */
  start(held: Iterable<string>): void {
    if (this.waitFor !== null) return;
    const snapshot = new Set(held);
    if (snapshot.size === 0) {
      this.opts.onFinish("immediate", 0);
      return;
    }
    this.waitFor = snapshot;
    this.startedAt = this.opts.now();
    this.timer = this.opts.schedule(() => this.check(), this.opts.tickMs);
  }

  /** Call after any input-state change. Finishes if the snapshot is up. */
  poke(): void {
    if (this.waitFor !== null) this.check();
  }

  /** Abandon the drain without calling onFinish. */
  cancel(): void {
    if (this.waitFor === null) return;
    this.clear();
  }

  private check(): void {
    if (this.waitFor === null) return;
    const elapsed = this.opts.now() - this.startedAt;
    let stillHeld = false;
    for (const key of this.waitFor) {
      if (this.opts.isHeld(key)) {
        stillHeld = true;
        break;
      }
    }
    if (stillHeld && elapsed < this.opts.maxMs) return;
    this.clear();
    this.opts.onFinish(stillHeld ? "timeout" : "complete", elapsed);
  }

  private clear(): void {
    if (this.timer !== null) this.opts.unschedule(this.timer);
    this.timer = null;
    this.waitFor = null;
  }
}
