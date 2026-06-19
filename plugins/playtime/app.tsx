import { useState, useEffect, useMemo } from "react";
import {
  PluginHeader,
  SegmentedItem,
  GameCard,
  NowPlaying,
  useFocusable,
  mountComponent,
  mountHeaderStub,
  useBackend,
  useCurrentGame,
} from "@loadout/ui";
import { steamArtworkUrls } from "@loadout/steam-paths/artwork";
import {
  type GameStats,
  type Stats,
  type CurrentSession,
  type DailyBreakdown,
  type RangeKey,
  formatHoursNumber,
  formatHoursStr,
  formatElapsed,
} from "./lib/time";

export { FaHourglassHalf as icon } from "react-icons/fa6";

// --- Types (UI-only) ---

interface PeriodStats {
  totalMs: number;
  gamesPlayed: number;
  games: GameStats[];
}

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "allTime", label: "All" },
];

// Pixel height the tallest day bar fills. Bars are sized in pixels
// (not `%`) because a percentage height inside an auto-height flex
// column collapses to `minHeight` for every bar — the original "all
// bars the same height" bug.
const DAY_BAR_AREA_PX = 84;

// --- Subcomponents ---

/** Live "Nm elapsed" counter for the running session, dropped into the
 *  shared NowPlaying hero's metadata slot. */
function SessionElapsed({ session }: { session: CurrentSession }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - session.startTime);

  useEffect(() => {
    setElapsed(Date.now() - session.startTime);
    const id = setInterval(() => {
      setElapsed(Date.now() - session.startTime);
    }, 1000);
    return () => clearInterval(id);
  }, [session.startTime]);

  return (
    <span
      className="mono"
      style={{ fontSize: 12, color: "var(--color-success)" }}
    >
      {formatElapsed(elapsed)} elapsed
    </span>
  );
}

/** A single day in the filter row: a proportional-height bar that
 *  toggles whether that day's games count toward the grid below. */
function DayFilterBar({
  label,
  hoursLabel,
  heightPx,
  selected,
  isToday,
  onToggle,
}: {
  label: string;
  hoursLabel: string;
  heightPx: number;
  selected: boolean;
  isToday: boolean;
  onToggle: () => void;
}) {
  const { ref } = useFocusable({ onEnterPress: onToggle });
  const [focused, setFocused] = useState(false);

  // Mirror GameCard's ref-merge so spatial-nav focuses the button.
  const setRef = (node: HTMLButtonElement | null) => {
    (ref as { current: HTMLElement | null }).current = node;
  };

  const barColor = !selected
    ? "var(--bg-2)"
    : isToday
      ? "var(--accent)"
      : "var(--accent-soft)";

  return (
    <button
      ref={setRef}
      type="button"
      onClick={onToggle}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      aria-pressed={selected}
      title={`${label} · ${hoursLabel}h — ${selected ? "shown" : "hidden"} (tap to filter)`}
      className={[
        "flex flex-col items-center gap-1.5 rounded-md py-1 transition-all",
        focused ? "ring-2 ring-[var(--accent)] scale-[1.04]" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        flex: 1,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        opacity: selected ? 1 : 0.5,
      }}
    >
      <div
        style={{
          height: DAY_BAR_AREA_PX,
          width: "100%",
          display: "flex",
          alignItems: "flex-end",
        }}
      >
        <div
          style={{
            width: "100%",
            height: Math.max(4, heightPx),
            minHeight: 4,
            borderRadius: 4,
            background: barColor,
            border: selected ? "none" : "1px dashed var(--line)",
          }}
        />
      </div>
      <div className="mono" style={{ fontSize: 10, color: "var(--fg-3)" }}>
        {label.charAt(0)}
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-2)" }}>
        {hoursLabel}h
      </div>
    </button>
  );
}

/** Time-played bar shown under each game tile — the same idea as
 *  recomp's download bar, but its length tracks play time. */
function TimeBar({ ms, maxMs }: { ms: number; maxMs: number }) {
  const pct = maxMs > 0 ? Math.max(6, (ms / maxMs) * 100) : 0;
  return (
    <div className="flex flex-col gap-1 w-full">
      <div
        className="h-1.5 w-full rounded-full overflow-hidden"
        style={{ background: "var(--bg-2)" }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: "var(--accent)" }}
        />
      </div>
      <span
        className="mono"
        style={{ fontSize: 10.5, color: "var(--fg-2)" }}
      >
        {formatElapsed(ms)}
      </span>
    </div>
  );
}

/** A game tile in the "All Games" grid — shared GameCard art with the
 *  time-played bar in the subtitle slot. */
function GameGridCard({ game, maxMs }: { game: GameStats; maxMs: number }) {
  const art = steamArtworkUrls(game.appId);
  return (
    <GameCard
      imageUrl={art.capsule}
      fallbackImageUrl={art.header}
      title={game.gameName}
      subtitle={<TimeBar ms={game.totalMs} maxMs={maxMs} />}
    />
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
  const [days, setDays] = useState<DailyBreakdown[]>([]);
  const [currentSession, setCurrentSession] = useState<CurrentSession | null>(null);
  const [range, setRange] = useState<RangeKey>("week");
  // Day filters: all 7 rolling days selected by default. Indices map to
  // the `days` array (oldest → today).
  const [selectedDays, setSelectedDays] = useState<Set<number>>(
    () => new Set([0, 1, 2, 3, 4, 5, 6]),
  );

  const refreshData = useMemo(
    () => () => {
      call("getStats").then((s) => setStats(s as Stats));
      call("getDailyBreakdown").then((d) =>
        setDays((d as DailyBreakdown[] | null) ?? []),
      );
    },
    [call],
  );

  // Subscribe to session updates
  useEvent({
    event: "sessionUpdate",
    handler: (data) => {
      setCurrentSession(data as CurrentSession | null);
      refreshData();
    },
  });

  // Fetch initial data on mount
  useEffect(() => {
    refreshData();
    call("getCurrentSession").then((s) =>
      setCurrentSession(s as CurrentSession | null),
    );
  }, [call, refreshData]);

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

  // Day-filter bars: heights are proportional to each day's total time.
  const maxBarMs = Math.max(1, ...days.map((d) => d.totalMs));
  const lastBarIdx = days.length - 1;

  const toggleDay = (i: number) => {
    setSelectedDays((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  // "All games" grid: union the per-game totals across the selected
  // days, then sort by most-played.
  const filteredGames = useMemo(() => {
    const map = new Map<string, GameStats>();
    days.forEach((d, i) => {
      if (!selectedDays.has(i)) return;
      for (const g of d.games) {
        const existing = map.get(g.appId);
        if (existing) existing.totalMs += g.totalMs;
        else map.set(g.appId, { ...g });
      }
    });
    return Array.from(map.values()).sort((a, b) => b.totalMs - a.totalMs);
  }, [days, selectedDays]);

  const maxGameMs = Math.max(1, ...filteredGames.map((g) => g.totalMs));
  const allDaysSelected = selectedDays.size === days.length && days.length > 0;

  const sessionsEstimate = period?.gamesPlayed ?? 0;
  // Divisor for AVG/DAY varies by range: 1 for today, 7 for week, day-of-
  // month for month, days-since-first-session for allTime. Backend
  // computes this so we don't need the raw session list in the UI.
  const divisor =
    range === "allTime"
      ? stats?.daysInRange.allTime ?? null
      : stats?.daysInRange[range] ?? null;
  const avgPerDay =
    period && divisor !== null && divisor > 0
      ? formatHoursStr(period.totalMs / divisor, 1)
      : "—";
  const topGameMs =
    period && period.games.length > 0 ? period.games[0].totalMs : 0;

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
            {/* NOW PLAYING — shared hero (artwork + logo) with a live
                elapsed counter. Self-hides when no game is running. */}
            <NowPlaying>
              {currentSession ? (
                <SessionElapsed session={currentSession} />
              ) : null}
            </NowPlaying>

            {/* HEADLINE METRIC + DAY FILTER BARS. The period selector in
                the topbar drives the headline; the day bars below double
                as filters for the "All Games" grid. */}
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

              {days.length > 0 && (
                <>
                  <div
                    className="subsection-label"
                    style={{ marginTop: 18, marginBottom: 8 }}
                  >
                    Filter by day{" "}
                    <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>
                      · tap to toggle
                      {allDaysSelected ? "" : ` · ${selectedDays.size}/${days.length}`}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "flex-end",
                    }}
                  >
                    {days.map((b, i) => (
                      <DayFilterBar
                        key={b.dayStart}
                        label={b.day}
                        hoursLabel={formatHoursStr(b.totalMs, 1)}
                        heightPx={(b.totalMs / maxBarMs) * DAY_BAR_AREA_PX}
                        selected={selectedDays.has(i)}
                        isToday={i === lastBarIdx}
                        onToggle={() => toggleDay(i)}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* ALL GAMES — grid of every game played on the selected
                days, ordered by most-played, each with a time bar. */}
            <div className="subsection">
              <div className="subsection-label">All Games</div>
              {filteredGames.length === 0 ? (
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--fg-3)",
                    padding: "8px 2px",
                  }}
                >
                  {selectedDays.size === 0
                    ? "No days selected — tap a day above to show its games."
                    : "No games played on the selected days yet."}
                </div>
              ) : (
                <div className="grid grid-cols-4 sidebar-collapsed:grid-cols-6 gap-2.5">
                  {filteredGames.map((g) => (
                    <GameGridCard key={g.appId} game={g} maxMs={maxGameMs} />
                  ))}
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
                <InsetStat
                  label="AVG / DAY"
                  value={avgPerDay}
                  unit={avgPerDay === "—" ? undefined : "h"}
                />
                <InsetStat
                  label="TOP GAME"
                  value={topGameMs > 0 ? formatHoursStr(topGameMs, 1) : "0"}
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
  const [liveElapsed, setLiveElapsed] = useState<number | null>(null);

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

  // Drive the live elapsed timer locally. We depend on the primitive
  // appId + startTime (captured in scope first so the linter is happy
  // with non-optional-chain deps) — the interval resets cleanly on a
  // game change but doesn't churn on every emit that creates a new
  // session object reference for the same underlying boundary state.
  const sessionAppId = session?.appId ?? null;
  const sessionStart = session?.startTime ?? null;
  useEffect(() => {
    if (sessionAppId === null || sessionAppId !== targetAppId || sessionStart === null) {
      setLiveElapsed(null);
      return;
    }
    const tick = () => setLiveElapsed(Date.now() - sessionStart);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sessionAppId, sessionStart, targetAppId]);

  // Refetch the per-game total only on game boundary transitions — not
  // every emit. `sessionAppId` flips between null and the running appId
  // so this reruns on launch/exit but stays stable during play.
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
  }, [call, targetAppId, sessionAppId]);

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

/** Mount this plugin into a container element. */
export const mount = mountComponent(PlayTime);

export const mountHomeWidget = mountComponent(PlayTimeHomeWidget);

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot — the actual header
 * content is portaled from inside `mount()` via `<PluginHeader>`.
 */
export const mountHeader = mountHeaderStub;
