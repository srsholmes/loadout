import { useState, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  PluginHeader,
  PluginProvider,
  SegmentedItem,
  useBackend,
  useCurrentGame,
} from "@loadout/ui";
import {
  type GameStats,
  type Stats,
  type CurrentSession,
  formatHoursNumber,
  formatHoursStr,
  formatElapsed,
  colorFor,
} from "./lib/time";

export { FaHourglassHalf as icon } from "react-icons/fa6";

// --- Types (UI-only) ---

interface PeriodStats {
  totalMs: number;
  gamesPlayed: number;
  games: GameStats[];
}

interface DayBreakdown {
  day: string;
  totalMs: number;
}

type RangeKey = "today" | "week" | "month" | "allTime";
const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "allTime", label: "All" },
];

// --- Subcomponents ---

function NowPlayingHeader({ session }: { session: CurrentSession }) {
  const [elapsed, setElapsed] = useState(session.elapsedMs);

  useEffect(() => {
    setElapsed(Date.now() - session.startTime);
    const interval = setInterval(() => {
      setElapsed(Date.now() - session.startTime);
    }, 1000);
    return () => clearInterval(interval);
  }, [session.startTime]);

  return (
    <div
      className="subsection"
      style={{ display: "flex", alignItems: "center", gap: 14 }}
    >
      <span
        className="shrink-0"
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          background: "var(--color-success)",
          boxShadow: "0 0 10px var(--color-success)",
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{session.gameName}</div>
        <div
          className="mono"
          style={{ fontSize: 11.5, color: "var(--fg-3)" }}
        >
          {formatElapsed(elapsed)} elapsed
        </div>
      </div>
      <div className="chip chip-success">NOW PLAYING</div>
    </div>
  );
}

function InsetStat({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: string | number;
  unit?: string;
  tone?: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-inset)",
        padding: 12,
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: "var(--fg-3)",
          letterSpacing: "0.08em",
          marginBottom: 4,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        className="metric-value mono"
        style={{ fontSize: 22, color: tone ?? "var(--fg-1)" }}
      >
        {value}
        {unit && (
          <span
            style={{ fontSize: 11, color: "var(--fg-3)", marginLeft: 4 }}
          >
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

// --- Main screen ---

function PlayTime() {
  const { call, useEvent } = useBackend("playtime");

  const [stats, setStats] = useState<Stats | null>(null);
  const [currentSession, setCurrentSession] = useState<CurrentSession | null>(null);
  const [range, setRange] = useState<RangeKey>("week");

  // Subscribe to session updates
  useEvent({
    event: "sessionUpdate",
    handler: (data) => {
      setCurrentSession(data as CurrentSession | null);
      call("getStats").then((s) => setStats(s as Stats));
    },
  });

  // Fetch initial data on mount
  useEffect(() => {
    call("getStats").then((s) => setStats(s as Stats));
    call("getCurrentSession").then((s) =>
      setCurrentSession(s as CurrentSession | null),
    );
  }, [call]);

  const period = stats ? (stats[range] as PeriodStats) : null;

  const rangeLabel = useMemo(() => {
    switch (range) {
      case "today":
        return "today";
      case "week":
        return "week";
      case "month":
        return "month";
      case "allTime":
        return "all time";
    }
  }, [range]);

  const totalHours = period ? formatHoursNumber(period.totalMs) : 0;
  const topGames = period ? period.games.slice(0, 5) : [];

  // For the bar chart: always show the rolling 7-day breakdown.
  const bars = (stats?.weeklyBreakdown ?? []) as DayBreakdown[];
  const maxBarMs = Math.max(1, ...bars.map((b) => b.totalMs));
  const lastBarIdx = bars.length - 1;

  const sessionsEstimate = period?.gamesPlayed ?? 0;
  const avgPerDay = period ? formatHoursStr(period.totalMs / 7, 1) : "0";

  const headerNode = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            PlayTime
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {currentSession
              ? `Now playing · ${currentSession.gameName}`
              : "Session history & stats"}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="segmented flex">
            {RANGE_OPTIONS.map((opt) => (
              <SegmentedItem
                key={opt.key}
                onSelect={() => setRange(opt.key)}
                active={range === opt.key}
              >
                {opt.label}
              </SegmentedItem>
            ))}
          </div>
        </div>
      </div>
    </PluginHeader>
  );

  return (
    <>
      {headerNode}
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="card">
            {/* NOW PLAYING (only if a session is live) */}
            {currentSession && <NowPlayingHeader session={currentSession} />}

            {/* HEADER: total hours + 7-day bars. Period selector lives
                in the portaled topbar header, so the body just shows
                the headline metric for the active period. */}
            <div className="subsection">
              <div className="subsection-label mb-0.5">This {rangeLabel}</div>
              <div className="metric-value mono" style={{ fontSize: 40 }}>
                {totalHours.toFixed(1)}
                <span
                  style={{
                    fontSize: 16,
                    marginLeft: 6,
                    color: "var(--fg-3)",
                  }}
                >
                  hours
                </span>
              </div>

              {bars.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "flex-end",
                    height: 100,
                    marginTop: 18,
                  }}
                >
                  {bars.map((b, i) => {
                    const pct = (b.totalMs / maxBarMs) * 100;
                    return (
                      <div
                        key={`${b.day}-${i}`}
                        style={{
                          flex: 1,
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            flex: 1,
                            width: "100%",
                            display: "flex",
                            alignItems: "flex-end",
                          }}
                        >
                          <div
                            style={{
                              width: "100%",
                              height: `${pct}%`,
                              background:
                                i === lastBarIdx
                                  ? "var(--accent)"
                                  : "var(--accent-soft)",
                              borderRadius: 4,
                              minHeight: 4,
                            }}
                          />
                        </div>
                        <div
                          className="mono"
                          style={{ fontSize: 10, color: "var(--fg-3)" }}
                        >
                          {b.day.charAt(0)}
                        </div>
                        <div
                          className="mono"
                          style={{ fontSize: 10.5, color: "var(--fg-2)" }}
                        >
                          {formatHoursStr(b.totalMs, 1)}h
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* MOST PLAYED */}
            <div className="subsection">
              <div className="subsection-label">Most Played</div>
              {topGames.length === 0 ? (
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--fg-3)",
                    padding: "8px 2px",
                  }}
                >
                  No games played in this range yet.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 4 }}>
                  {topGames.map((g) => {
                    const color = colorFor(g.appId);
                    const pct =
                      period && period.totalMs > 0
                        ? (g.totalMs / period.totalMs) * 100
                        : 0;
                    return (
                      <div
                        key={g.appId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "10px 12px",
                          background: "var(--bg-inset)",
                          borderRadius: 8,
                        }}
                      >
                        <div
                          style={{
                            width: 4,
                            height: 28,
                            borderRadius: 2,
                            background: color,
                            flexShrink: 0,
                          }}
                        />
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {g.gameName}
                          </div>
                          <div
                            className="mono"
                            style={{
                              fontSize: 10.5,
                              color: "var(--fg-3)",
                            }}
                          >
                            {formatElapsed(g.totalMs)}
                          </div>
                        </div>
                        <div
                          style={{
                            width: 140,
                            height: 6,
                            background: "var(--bg-2)",
                            borderRadius: 3,
                            overflow: "hidden",
                            flexShrink: 0,
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.max(pct, 2)}%`,
                              height: "100%",
                              background: color,
                            }}
                          />
                        </div>
                        <span
                          className="mono"
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            width: 56,
                            textAlign: "right",
                          }}
                        >
                          {formatHoursStr(g.totalMs, 1)}h
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* STATS */}
            <div className="subsection">
              <div className="subsection-label">Stats</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: 8,
                }}
              >
                <InsetStat label="GAMES" value={sessionsEstimate} />
                <InsetStat label="TOTAL" value={totalHours.toFixed(1)} unit="h" />
                <InsetStat label="AVG / DAY" value={avgPerDay} unit="h" />
                <InsetStat
                  label="TOP GAME"
                  value={topGames[0] ? formatHoursStr(topGames[0].totalMs, 1) : "0"}
                  unit="h"
                  tone="var(--accent)"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Homepage widget. Shows the running game's session timer + total time
 * when a game is active; falls back to today's totals otherwise.
 */
function PlayTimeHomeWidget() {
  const { call, useEvent } = useBackend("playtime");
  const currentGame = useCurrentGame();
  const targetAppId = currentGame ? String(currentGame.appId) : null;

  const [session, setSession] = useState<CurrentSession | null>(null);
  const [totalMs, setTotalMs] = useState<number | null>(null);
  const [todayMs, setTodayMs] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  // Re-render once a second so the live elapsed timer counts up smoothly.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    call("getCurrentSession")
      .then((s) => {
        if (alive) setSession((s as CurrentSession | null) ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [call]);

  useEvent({
    event: "sessionUpdate",
    handler: (data) => setSession((data as CurrentSession | null) ?? null),
  });

  useEffect(() => {
    let alive = true;
    if (!targetAppId) {
      setTotalMs(null);
      call("getStats")
        .then((s) => {
          if (alive) setTodayMs((s as Stats).today.totalMs);
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }
    setTodayMs(null);
    call("getGameSessions", targetAppId)
      .then((rows) => {
        if (!alive) return;
        const list = rows as { startTime: number; endTime: number | null }[];
        const sum = list.reduce((acc, s) => {
          const end = s.endTime ?? Date.now();
          return acc + Math.max(0, end - s.startTime);
        }, 0);
        setTotalMs(sum);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [call, targetAppId, session]);

  // Compute live elapsed for the running session (independent of polling).
  const liveElapsed =
    session && targetAppId === session.appId
      ? Date.now() - session.startTime
      : null;

  // Reference `tick` so React re-renders the live elapsed every second.
  void tick;

  if (currentGame) {
    return (
      <div className="card-body">
        <div className="flex items-center justify-between mb-3.5">
          <div className="card-title">PLAYTIME</div>
          <div className="chip chip-accent truncate max-w-[60%]">
            {currentGame.gameName || `App ${currentGame.appId}`}
          </div>
        </div>
        <div className="flex items-baseline gap-2 mb-2">
          <div className="metric-value mono">
            {liveElapsed !== null ? formatElapsed(liveElapsed) : "—"}
          </div>
          <div className="metric-unit">this session</div>
        </div>
        <div className="row">
          <span className="row-label">Total time</span>
          <span className="row-value mono">
            {totalMs !== null ? formatElapsed(totalMs) : "—"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="card-body">
      <div className="flex items-center justify-between mb-3.5">
        <div className="card-title">PLAYTIME</div>
        <div className="chip">No game running</div>
      </div>
      <div className="flex items-baseline gap-2">
        <div className="metric-value mono">
          {todayMs !== null ? formatElapsed(todayMs) : "—"}
        </div>
        <div className="metric-unit">today</div>
      </div>
    </div>
  );
}

// --- Mount functions ---

/**
 * Mount this plugin into a container element.
 * Called by the overlay shell when this plugin is selected.
 * Returns an unmount function.
 */
export function mount(
  container: HTMLElement,
  opts?: { parentFocusKey?: string; headerSlot?: HTMLElement | null },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider
      parentFocusKey={opts?.parentFocusKey}
      headerSlot={opts?.headerSlot ?? null}
    >
      <PlayTime />
    </PluginProvider>,
  );
  return () => root.unmount();
}

export function mountHomeWidget(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <PlayTimeHomeWidget />
    </PluginProvider>,
  );
  return () => root.unmount();
}

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot — the actual header
 * content is portaled from inside `mount()` via `<PluginHeader>`.
 */
export function mountHeader(): () => void {
  return () => {};
}
