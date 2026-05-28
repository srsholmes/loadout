/**
 * Pure time-aggregation and formatting helpers for the PlayTime plugin.
 *
 * All functions are side-effect-free so they can be tested without any
 * backend or DOM setup.
 */

// --- Types (shared between backend and UI) ---

export interface GameSession {
  appId: string;
  gameName: string;
  startTime: number; // epoch ms
  endTime: number | null; // null = still running
}

export interface PlaytimeData {
  sessions: GameSession[];
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
}

export interface CurrentSession {
  appId: string;
  gameName: string;
  startTime: number;
  elapsedMs: number;
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

  const todaySessions = all.filter(
    (s) => s.startTime >= todayStart || (s.endTime !== null && s.endTime >= todayStart),
  );
  const weekSessions = all.filter(
    (s) => s.startTime >= weekStart || (s.endTime !== null && s.endTime >= weekStart),
  );
  const monthSessions = all.filter(
    (s) => s.startTime >= monthStart || (s.endTime !== null && s.endTime >= monthStart),
  );

  return {
    today: aggregateSessions(todaySessions, todayStart, now),
    week: aggregateSessions(weekSessions, weekStart, now),
    month: aggregateSessions(monthSessions, monthStart, now),
    allTime: aggregateSessions(all, 0, now),
    weeklyBreakdown: getWeeklyBreakdown(all, now),
  };
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
