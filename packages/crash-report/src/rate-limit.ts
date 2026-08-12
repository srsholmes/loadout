/**
 * Rate limiting that survives process restarts.
 *
 * This is not politeness — it's the thing standing between one user's crash
 * loop and a blown ingest quota. A device stuck in a restart loop can emit
 * thousands of identical reports, which is both a cost problem and a signal
 * problem: the real bug drowns in duplicates of itself.
 *
 * The subtlety: an in-memory counter is useless here. A crash loop kills
 * the process, systemd restarts it (the overlay allows 20 starts a minute),
 * and an in-memory counter resets to zero on every iteration — so the loop
 * reports at full rate forever. State therefore lives on disk.
 *
 * The decision is a pure function over (state, now, fingerprint) so it can
 * be tested exhaustively, including across a simulated restart: persist the
 * returned state, hand it back to a fresh call, assert the limit still holds.
 */

export interface RateLimitState {
  v: 1;
  /** Start of the current rolling hour. */
  hourStart: number;
  hourCount: number;
  /** Start of the current rolling day. */
  dayStart: number;
  dayCount: number;
  /** Per-fingerprint counts within the current hour. */
  fps: Record<string, number>;
}

export interface Limits {
  windowMs: number;
  dayMs: number;
  maxPerHour: number;
  maxPerDay: number;
  maxPerFingerprintPerHour: number;
  /** Cap on distinct fingerprints tracked, so the state file stays small. */
  maxTrackedFingerprints: number;
}

/**
 * Chosen so a single pathological device costs at most ~600 events/month
 * against a 5,000 shared budget. The per-fingerprint cap is what actually
 * defeats a crash loop: a loop repeats one fault, so it hits that cap after
 * two reports and everything after is dropped locally.
 */
export const DEFAULT_LIMITS: Limits = {
  windowMs: 60 * 60 * 1000,
  dayMs: 24 * 60 * 60 * 1000,
  maxPerHour: 5,
  maxPerDay: 20,
  maxPerFingerprintPerHour: 2,
  maxTrackedFingerprints: 64,
};

export function freshState(now: number): RateLimitState {
  return { v: 1, hourStart: now, hourCount: 0, dayStart: now, dayCount: 0, fps: {} };
}

export type Decision =
  | { allow: true; state: RateLimitState }
  | { allow: false; state: RateLimitState; reason: "hour" | "day" | "duplicate" };

/**
 * Decide whether one event may be sent, and return the state to persist.
 *
 * The state is returned in both branches: a *denied* event still has to be
 * written back, because the windows may have rolled over. Persisting only
 * on success would pin the counters and leak quota.
 */
export function decide(
  state: RateLimitState,
  now: number,
  fp: string,
  limits: Limits = DEFAULT_LIMITS,
): Decision {
  let s = state;

  // Roll the windows forward before counting.
  if (now - s.hourStart >= limits.windowMs) {
    s = { ...s, hourStart: now, hourCount: 0, fps: {} };
  }
  if (now - s.dayStart >= limits.dayMs) {
    s = { ...s, dayStart: now, dayCount: 0 };
  }

  const fpCount = s.fps[fp] ?? 0;
  if (fpCount >= limits.maxPerFingerprintPerHour) {
    return { allow: false, state: s, reason: "duplicate" };
  }
  if (s.hourCount >= limits.maxPerHour) {
    return { allow: false, state: s, reason: "hour" };
  }
  if (s.dayCount >= limits.maxPerDay) {
    return { allow: false, state: s, reason: "day" };
  }

  const fps = { ...s.fps, [fp]: fpCount + 1 };
  // Bound the map so a fault that somehow varies its fingerprint every time
  // can't grow the state file without limit. Dropping the whole table is
  // fine — it only costs us dedup precision for the rest of the hour.
  const bounded =
    Object.keys(fps).length > limits.maxTrackedFingerprints ? { [fp]: fpCount + 1 } : fps;

  return {
    allow: true,
    state: { ...s, hourCount: s.hourCount + 1, dayCount: s.dayCount + 1, fps: bounded },
  };
}

/** Parse persisted JSON, falling back to a fresh window on anything unexpected. */
export function parseState(raw: string | null, now: number): RateLimitState {
  if (!raw) return freshState(now);
  try {
    const p = JSON.parse(raw) as Partial<RateLimitState>;
    if (
      p.v !== 1 ||
      typeof p.hourStart !== "number" ||
      typeof p.hourCount !== "number" ||
      typeof p.dayStart !== "number" ||
      typeof p.dayCount !== "number" ||
      typeof p.fps !== "object" ||
      p.fps === null
    ) {
      return freshState(now);
    }
    // Clock moved backwards (suspend/resume, NTP step). Treat as a new window
    // rather than trusting a future-dated start that would never roll over.
    if (p.hourStart > now || p.dayStart > now) return freshState(now);
    return {
      v: 1,
      hourStart: p.hourStart,
      hourCount: p.hourCount,
      dayStart: p.dayStart,
      dayCount: p.dayCount,
      fps: p.fps as Record<string, number>,
    };
  } catch {
    return freshState(now);
  }
}
