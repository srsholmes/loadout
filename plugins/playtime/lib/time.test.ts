import { describe, it, expect } from "bun:test";
import {
  startOfDay,
  startOfWeek,
  startOfMonth,
  aggregateSessions,
  getWeeklyBreakdown,
  computeStats,
  formatHoursStr,
  formatElapsed,
  colorFor,
  daysForRange,
} from "./time";
import type { GameSession } from "./time";

// ── Date helpers ─────────────────────────────────────────────────────────────

describe("startOfDay", () => {
  it("zeroes out hours, minutes, seconds, ms", () => {
    const ts = new Date("2025-06-15T14:30:45.123").getTime();
    const sod = startOfDay(ts);
    const d = new Date(sod);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  it("preserves the calendar date", () => {
    const ts = new Date("2025-06-15T14:30:45.123").getTime();
    const sod = startOfDay(ts);
    const d = new Date(sod);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(5); // June = month 5
    expect(d.getDate()).toBe(15);
  });
});

describe("startOfWeek", () => {
  it("returns Monday 00:00 for a Wednesday input", () => {
    // 2025-06-18 is a Wednesday
    const ts = new Date("2025-06-18T10:00:00").getTime();
    const sow = startOfWeek(ts);
    const d = new Date(sow);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getDate()).toBe(16); // Mon 16 Jun
    expect(d.getHours()).toBe(0);
  });

  it("returns Monday 00:00 when input is already Monday", () => {
    const ts = new Date("2025-06-16T08:00:00").getTime();
    const sow = startOfWeek(ts);
    const d = new Date(sow);
    expect(d.getDay()).toBe(1);
    expect(d.getDate()).toBe(16);
  });

  it("treats Sunday as end of the previous week (returns Mon 6 days earlier)", () => {
    const ts = new Date("2025-06-22T20:00:00").getTime(); // Sunday
    const sow = startOfWeek(ts);
    const d = new Date(sow);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getDate()).toBe(16); // Mon 16 Jun
  });
});

describe("startOfMonth", () => {
  it("returns the 1st at midnight", () => {
    const ts = new Date("2025-06-18T14:30:00").getTime();
    const som = startOfMonth(ts);
    const d = new Date(som);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});

// ── aggregateSessions ────────────────────────────────────────────────────────

describe("aggregateSessions", () => {
  const now = new Date("2025-06-18T12:00:00").getTime();

  it("returns zeros for empty session list", () => {
    const result = aggregateSessions([], 0, now);
    expect(result.totalMs).toBe(0);
    expect(result.gamesPlayed).toBe(0);
    expect(result.games).toEqual([]);
  });

  it("sums two sessions of the same game", () => {
    const sessions: GameSession[] = [
      { appId: "730", gameName: "CS2", startTime: now - 3_600_000, endTime: now - 1_800_000 },
      { appId: "730", gameName: "CS2", startTime: now - 900_000, endTime: now - 300_000 },
    ];
    const result = aggregateSessions(sessions, 0, now);
    expect(result.gamesPlayed).toBe(1);
    expect(result.totalMs).toBe(1_800_000 + 600_000);
  });

  it("treats different appIds as different games", () => {
    const sessions: GameSession[] = [
      { appId: "730", gameName: "CS2", startTime: now - 3_600_000, endTime: now - 1_800_000 },
      { appId: "570", gameName: "Dota 2", startTime: now - 1_800_000, endTime: now - 600_000 },
    ];
    const result = aggregateSessions(sessions, 0, now);
    expect(result.gamesPlayed).toBe(2);
  });

  it("clamps sessions to the periodStart boundary", () => {
    const periodStart = now - 1_800_000; // 30 min ago
    const sessions: GameSession[] = [
      // Started 2h ago, ended 1h ago — only 30 min falls in the period
      { appId: "730", gameName: "CS2", startTime: now - 7_200_000, endTime: now - 3_600_000 },
      // Fully inside
      { appId: "730", gameName: "CS2", startTime: now - 1_200_000, endTime: now - 600_000 },
    ];
    const result = aggregateSessions(sessions, periodStart, now);
    // First session: clamp start to periodStart → 0 ms (ended before periodStart)
    // Actually first session ends at now-3600000 which is before periodStart (now-1800000) → 0 ms
    // Second session: fully inside → 600000 ms
    expect(result.totalMs).toBe(600_000);
  });

  it("uses now as end for active sessions (endTime=null)", () => {
    const sessions: GameSession[] = [
      { appId: "730", gameName: "CS2", startTime: now - 3_600_000, endTime: null },
    ];
    const result = aggregateSessions(sessions, 0, now);
    expect(result.totalMs).toBe(3_600_000);
  });

  it("sorts games by totalMs descending", () => {
    const sessions: GameSession[] = [
      { appId: "570", gameName: "Dota 2", startTime: now - 1_200_000, endTime: now - 600_000 },
      { appId: "730", gameName: "CS2", startTime: now - 3_600_000, endTime: now - 0 },
    ];
    const result = aggregateSessions(sessions, 0, now);
    expect(result.games[0].appId).toBe("730"); // more time
    expect(result.games[1].appId).toBe("570");
  });
});

// ── getWeeklyBreakdown ───────────────────────────────────────────────────────

describe("getWeeklyBreakdown", () => {
  const now = new Date("2025-06-18T12:00:00").getTime();

  it("returns exactly 7 entries", () => {
    const breakdown = getWeeklyBreakdown([], now);
    expect(breakdown).toHaveLength(7);
  });

  it("every entry has a day label and numeric totalMs", () => {
    const breakdown = getWeeklyBreakdown([], now);
    for (const entry of breakdown) {
      expect(typeof entry.day).toBe("string");
      expect(entry.day.length).toBeGreaterThan(0);
      expect(typeof entry.totalMs).toBe("number");
    }
  });

  it("accumulates time correctly for today (last entry)", () => {
    const todayStart = startOfDay(now);
    const sessions: GameSession[] = [
      { appId: "730", gameName: "CS2", startTime: todayStart, endTime: todayStart + 3_600_000 },
    ];
    const breakdown = getWeeklyBreakdown(sessions, now);
    const todayEntry = breakdown[breakdown.length - 1];
    expect(todayEntry.totalMs).toBe(3_600_000);
  });

  it("ignores sessions outside the 7-day window", () => {
    const sessions: GameSession[] = [
      { appId: "730", gameName: "CS2", startTime: now - 8 * 86_400_000, endTime: now - 7 * 86_400_000 },
    ];
    const breakdown = getWeeklyBreakdown(sessions, now);
    const total = breakdown.reduce((s, d) => s + d.totalMs, 0);
    expect(total).toBe(0);
  });
});

// ── computeStats ─────────────────────────────────────────────────────────────

describe("computeStats", () => {
  it("includes the active session in all aggregations", () => {
    const now = Date.now();
    const active: GameSession = {
      appId: "730",
      gameName: "CS2",
      startTime: now - 1_800_000,
      endTime: null,
    };
    const stats = computeStats([], active, now);
    expect(stats.allTime.totalMs).toBeGreaterThan(0);
    expect(stats.today.totalMs).toBeGreaterThan(0);
  });

  it("returns zero stats with no sessions and no active session", () => {
    const stats = computeStats([], null, Date.now());
    expect(stats.allTime.totalMs).toBe(0);
    expect(stats.allTime.gamesPlayed).toBe(0);
    expect(stats.weeklyBreakdown).toHaveLength(7);
  });

  it("exposes today/week/month/allTime/weeklyBreakdown keys", () => {
    const stats = computeStats([], null, Date.now());
    expect(stats).toHaveProperty("today");
    expect(stats).toHaveProperty("week");
    expect(stats).toHaveProperty("month");
    expect(stats).toHaveProperty("allTime");
    expect(stats).toHaveProperty("weeklyBreakdown");
  });
});

// ── formatHoursStr ────────────────────────────────────────────────────────────

describe("formatHoursStr", () => {
  it("returns '<0.1' for tiny non-zero durations", () => {
    expect(formatHoursStr(1_000)).toBe("<0.1"); // 1 second
  });

  it("rounds to the requested number of decimal places", () => {
    expect(formatHoursStr(3_600_000, 1)).toBe("1.0");
    expect(formatHoursStr(5_400_000, 2)).toBe("1.50");
  });

  it("returns '0.0' for zero", () => {
    expect(formatHoursStr(0, 1)).toBe("0.0");
  });
});

// ── formatElapsed ─────────────────────────────────────────────────────────────

describe("formatElapsed", () => {
  it("returns '< 1m' for durations under a minute", () => {
    expect(formatElapsed(0)).toBe("< 1m");
    expect(formatElapsed(59_999)).toBe("< 1m");
  });

  it("returns minutes-only for sub-hour durations", () => {
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(90_000)).toBe("1m");
    expect(formatElapsed(3_540_000)).toBe("59m");
  });

  it("returns 'Xh Ym' for hour+ durations", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 0m");
    expect(formatElapsed(5_400_000)).toBe("1h 30m");
    expect(formatElapsed(7_260_000)).toBe("2h 1m");
  });
});

// ── colorFor ─────────────────────────────────────────────────────────────────

describe("colorFor", () => {
  it("returns an oklch color string", () => {
    const c = colorFor("730");
    expect(c).toMatch(/^oklch\([\d.]+ [\d.]+ \d+\)$/);
  });

  it("is deterministic", () => {
    expect(colorFor("730")).toBe(colorFor("730"));
  });

  it("produces different colors for different keys", () => {
    expect(colorFor("730")).not.toBe(colorFor("570"));
  });
});

// ── Cross-midnight active session (regression guard) ─────────────────────────

describe("computeStats — active session crossing midnight", () => {
  it("includes the today-portion of an active session that started yesterday", () => {
    const now = new Date("2025-06-15T01:00:00").getTime(); // 1am today
    const startedYesterday = new Date("2025-06-14T23:00:00").getTime(); // 11pm yesterday
    const active: GameSession = {
      appId: "730",
      gameName: "Live Game",
      startTime: startedYesterday,
      endTime: null,
    };

    const stats = computeStats([], active, now);

    // Today should hold the 1 hour from midnight → 1am.
    expect(stats.today.totalMs).toBe(3_600_000);
    expect(stats.today.games).toHaveLength(1);
    expect(stats.today.games[0].gameName).toBe("Live Game");
  });

  it("also includes the active session in week when it crosses the boundary", () => {
    // Derive the week boundary from `now` so the test is tz-agnostic.
    const now = new Date("2025-06-16T00:30:00").getTime();
    const weekStart = startOfWeek(now);
    // Started 30 min before the week boundary; still running. Expected
    // week.totalMs = now - weekStart (the in-period portion only).
    const active: GameSession = {
      appId: "730",
      gameName: "Late Night",
      startTime: weekStart - 1_800_000,
      endTime: null,
    };

    const stats = computeStats([], active, now);
    expect(stats.week.totalMs).toBe(now - weekStart);
  });
});

// ── daysForRange ─────────────────────────────────────────────────────────────

describe("daysForRange", () => {
  const now = new Date("2025-06-15T12:00:00").getTime(); // 15th of month

  it("returns 1 for today", () => {
    expect(daysForRange("today", [], now)).toBe(1);
  });

  it("returns 7 for week", () => {
    expect(daysForRange("week", [], now)).toBe(7);
  });

  it("returns day-of-month for month", () => {
    expect(daysForRange("month", [], now)).toBe(15);
  });

  it("returns null for allTime when there are no sessions", () => {
    expect(daysForRange("allTime", [], now)).toBeNull();
  });

  it("returns days-since-earliest-session for allTime", () => {
    const tenDaysAgo = now - 10 * 86_400_000;
    const sessions: GameSession[] = [
      {
        appId: "1",
        gameName: "X",
        startTime: tenDaysAgo,
        endTime: tenDaysAgo + 3_600_000,
      },
    ];
    // 10 calendar days ago to now → 10 or 11 depending on hour, but
    // startOfDay clamps to midnight so it's exactly 10 full days plus
    // today's 12 hours → ceil to 11.
    expect(daysForRange("allTime", sessions, now)).toBe(11);
  });
});
