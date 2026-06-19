/**
 * Pure time-aggregation and formatting helpers for the PlayTime plugin.
 *
 * All functions are side-effect-free so they can be tested without any
 * backend or DOM setup.
 */

import type { VdfObject, VdfNode } from "@loadout/vdf";

// --- Types (shared between backend and UI) ---

export interface GameSession {
  appId: string;
  gameName: string;
  startTime: number; // epoch ms
  endTime: number | null; // null = still running
}

export interface PlaytimeData {
  sessions: GameSession[];
  /**
   * Snapshot of the in-flight session, written by the backend heartbeat
   * every 60 s while a game is running. If we crash before
   * handleGameExit fires, the next _loadData picks this up and pushes
   * it into `sessions` as the orphan — with endTime within 60 s of the
   * crash, which is the best approximation we can give.
   */
  pendingActive?: GameSession | null;
}

export interface GameStats {
  appId: string;
  gameName: string;
  totalMs: number;
}

export interface PeriodStats {
  totalMs: number;
  gamesPlayed: number;
  games: GameStats[];
}

export interface Stats {
  today: PeriodStats;
  week: PeriodStats;
  month: PeriodStats;
  allTime: PeriodStats;
  weeklyBreakdown: { day: string; totalMs: number }[];
  /**
   * Per-range divisor for the UI's AVG/DAY metric. `allTime` is `null`
   * when there are no recorded sessions yet (UI should hide that tile).
   * Computed server-side because the UI doesn't see the raw session list.
   */
  daysInRange: { today: number; week: number; month: number; allTime: number | null };
}

export interface CurrentSession {
  appId: string;
  gameName: string;
  startTime: number;
  elapsedMs: number;
}

/**
 * One calendar day of the rolling 7-day window, carrying both the
 * day's total and its per-game breakdown. The UI uses `totalMs` for
 * the bar height and `games` to build the (day-filtered) "All games"
 * grid underneath.
 */
export interface DailyBreakdown {
  /** Short day label, e.g. "Mon". */
  day: string;
  /** Epoch ms at local start-of-day — stable React key + filter id. */
  dayStart: number;
  /** Sum of all game time on this day. */
  totalMs: number;
  /** Per-game totals for this day, sorted by totalMs descending. */
  games: GameStats[];
}

// --- Date boundary helpers ---

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfWeek(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  // Week starts on Monday
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

export function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// --- Aggregation ---

/**
 * Aggregate an array of sessions into per-game totals.
 *
 * Sessions that span the `periodStart` boundary are clamped so only
 * the portion inside the period counts. Active sessions (endTime=null)
 * are clamped to `now`.
 */
export function aggregateSessions(
  sessions: GameSession[],
  periodStart: number,
  now: number,
): PeriodStats {
  const gameMap = new Map<string, GameStats>();

  for (const s of sessions) {
    const start = Math.max(s.startTime, periodStart);
    const end = s.endTime ?? now;
    const duration = Math.max(0, end - start);

    const existing = gameMap.get(s.appId);
    if (existing) {
      existing.totalMs += duration;
    } else {
      gameMap.set(s.appId, {
        appId: s.appId,
        gameName: s.gameName,
        totalMs: duration,
      });
    }
  }

  const games = Array.from(gameMap.values()).sort((a, b) => b.totalMs - a.totalMs);
  const totalMs = games.reduce((sum, g) => sum + g.totalMs, 0);

  return { totalMs, gamesPlayed: games.length, games };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Build the rolling 7-day breakdown (oldest first, today last).
 */
export function getWeeklyBreakdown(
  sessions: GameSession[],
  now: number,
): { day: string; totalMs: number }[] {
  const days: { day: string; totalMs: number }[] = [];

  for (let i = 6; i >= 0; i--) {
    const dayStart = startOfDay(now - i * 86_400_000);
    const dayEnd = dayStart + 86_400_000;
    const date = new Date(dayStart);
    const dayLabel = DAY_NAMES[date.getDay()];

    let totalMs = 0;
    for (const s of sessions) {
      const sEnd = s.endTime ?? now;
      if (sEnd < dayStart || s.startTime >= dayEnd) continue;
      const start = Math.max(s.startTime, dayStart);
      const end = Math.min(sEnd, dayEnd);
      totalMs += Math.max(0, end - start);
    }

    days.push({ day: dayLabel, totalMs });
  }

  return days;
}

/**
 * Build the rolling 7-day breakdown WITH per-game totals (oldest first,
 * today last). Same day-clamping as `getWeeklyBreakdown`, but each day
 * also carries the per-game split so the UI can union games across the
 * user's selected days.
 */
export function getDailyGameBreakdown(
  sessions: GameSession[],
  now: number,
): DailyBreakdown[] {
  const days: DailyBreakdown[] = [];

  for (let i = 6; i >= 0; i--) {
    const dayStart = startOfDay(now - i * 86_400_000);
    const dayEnd = dayStart + 86_400_000;
    const date = new Date(dayStart);
    const dayLabel = DAY_NAMES[date.getDay()];

    const gameMap = new Map<string, GameStats>();
    let totalMs = 0;
    for (const s of sessions) {
      const sEnd = s.endTime ?? now;
      if (sEnd < dayStart || s.startTime >= dayEnd) continue;
      const start = Math.max(s.startTime, dayStart);
      const end = Math.min(sEnd, dayEnd);
      const duration = Math.max(0, end - start);
      if (duration <= 0) continue;

      totalMs += duration;
      const existing = gameMap.get(s.appId);
      if (existing) {
        existing.totalMs += duration;
      } else {
        gameMap.set(s.appId, {
          appId: s.appId,
          gameName: s.gameName,
          totalMs: duration,
        });
      }
    }

    const games = Array.from(gameMap.values()).sort(
      (a, b) => b.totalMs - a.totalMs,
    );
    days.push({ day: dayLabel, dayStart, totalMs, games });
  }

  return days;
}

/**
 * Compute full stats (today / week / month / allTime / weeklyBreakdown)
 * from a flat session list plus an optional active session.
 */
export function computeStats(
  persistedSessions: GameSession[],
  activeSession: GameSession | null,
  now: number,
): Stats {
  const all = activeSession
    ? [...persistedSessions, activeSession]
    : [...persistedSessions];

  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);

  // `endTime ?? now` for the comparison so an active session that
  // started before the period boundary (e.g. a play-through-midnight
  // session) is still included — without this coercion the filter
  // drops null-endTime sessions and the user sees 0 hours on the day
  // they're actively playing.
  const overlaps = (s: GameSession, periodStart: number) =>
    (s.endTime ?? now) >= periodStart;

  const todaySessions = all.filter((s) => overlaps(s, todayStart));
  const weekSessions = all.filter((s) => overlaps(s, weekStart));
  const monthSessions = all.filter((s) => overlaps(s, monthStart));

  return {
    today: aggregateSessions(todaySessions, todayStart, now),
    week: aggregateSessions(weekSessions, weekStart, now),
    month: aggregateSessions(monthSessions, monthStart, now),
    allTime: aggregateSessions(all, 0, now),
    weeklyBreakdown: getWeeklyBreakdown(all, now),
    daysInRange: {
      today: daysForRange("today", all, now) ?? 1,
      week: daysForRange("week", all, now) ?? 7,
      month: daysForRange("month", all, now) ?? new Date(now).getDate(),
      allTime: daysForRange("allTime", all, now),
    },
  };
}

// --- Steam lifetime playtime (localconfig.vdf) ---

/** Case-insensitive single-level lookup — Steam casing drifts between
 *  client versions (`Valve` vs `valve`), so don't hardcode it. */
function vdfGet(obj: VdfObject, key: string): VdfNode | undefined {
  const k = Object.keys(obj).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : obj[k];
}

/** Walk a case-insensitive key path, returning the object at the end. */
function vdfNavigate(root: VdfObject, path: string[]): VdfObject | null {
  let cur: VdfNode = root;
  for (const key of path) {
    if (typeof cur !== "object") return null;
    const next = vdfGet(cur, key);
    if (next === undefined) return null;
    cur = next;
  }
  return typeof cur === "object" ? cur : null;
}

/**
 * Pull per-app lifetime playtime (minutes) out of a parsed
 * localconfig.vdf. Path:
 *   UserLocalConfigStore > Software > Valve > Steam > apps > <appId> > Playtime
 *
 * Returns appId → minutes for apps that carry a recorded `Playtime`
 * (apps with no playtime entry are skipped). It's Steam's authoritative
 * lifetime total — the same number the library UI shows — available
 * locally with no login.
 */
export function extractSteamPlaytimeMinutes(
  root: VdfObject,
): Map<string, number> {
  const out = new Map<string, number>();
  const apps = vdfNavigate(root, [
    "UserLocalConfigStore",
    "Software",
    "Valve",
    "Steam",
    "apps",
  ]);
  if (!apps) return out;

  for (const [appId, node] of Object.entries(apps)) {
    if (typeof node !== "object") continue;
    const pt = vdfGet(node, "Playtime");
    if (typeof pt !== "string") continue;
    const minutes = Number(pt);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    out.set(appId, minutes);
  }
  return out;
}

// --- Display formatting ---

export function formatHoursNumber(ms: number): number {
  return ms / 3_600_000;
}

export function formatHoursStr(ms: number, digits = 1): string {
  const h = formatHoursNumber(ms);
  if (h < 0.05 && ms > 0) return "<0.1";
  return h.toFixed(digits);
}

export function formatElapsed(ms: number): string {
  if (ms < 60_000) return "< 1m";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

/** Deterministic accent-family color picked from a string (appId). */
export function colorFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `oklch(0.62 0.16 ${hue})`;
}

/** The four UI ranges the period selector exposes. */
export type RangeKey = "today" | "week" | "month" | "allTime";

/**
 * How many days the AVG/DAY divisor should use for a given range.
 *
 * - today: 1 (the total IS the day's value)
 * - week: 7
 * - month: day-of-month so we don't divide April-day-3 by 30 and get
 *   a misleading sub-hour average for a single day's play
 * - allTime: derived from the earliest session in `sessions` so the
 *   metric is "average per day played" not "average per total days"
 *
 * Returns `null` when no meaningful divisor exists (allTime with no
 * sessions yet). Callers should hide the AVG/DAY tile when null.
 */
export function daysForRange(
  range: RangeKey,
  sessions: GameSession[],
  now: number,
): number | null {
  switch (range) {
    case "today":
      return 1;
    case "week":
      return 7;
    case "month":
      return new Date(now).getDate();
    case "allTime": {
      if (sessions.length === 0) return null;
      const earliest = sessions.reduce(
        (min, s) => (s.startTime < min ? s.startTime : min),
        sessions[0].startTime,
      );
      const days = Math.max(
        1,
        Math.ceil((now - startOfDay(earliest)) / 86_400_000),
      );
      return days;
    }
  }
}
