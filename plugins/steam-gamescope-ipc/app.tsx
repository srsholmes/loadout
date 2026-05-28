import { useState, useEffect, useCallback } from "react";
import { FaTv, FaPlay } from "react-icons/fa6";
import {
  mountComponent,
  useBackend,
  useCurrentGame,
  GAME_DETECTION_SERVICE_ID,
  Button,
  Spinner,
  TextInput,
  type GameSessionRecord,
} from "@loadout/ui";

export const icon = FaTv;

type GameSession = GameSessionRecord;

interface GameState {
  currentGame: GameSession | null;
  recentSessions: GameSession[];
}

function SteamGamescopeIpcPanel() {
  // Game state now lives in the loader's __core:game-detection service.
  // useCurrentGame gives us the live current-game; we fetch recents
  // directly from the same service and refresh them when current
  // changes (game launch / exit).
  const { call: callGameDetection, useEvent: useGameDetectionEvent } =
    useBackend(GAME_DETECTION_SERVICE_ID);
  const currentGame = useCurrentGame();
  const [recentSessions, setRecentSessions] = useState<GameSession[]>([]);
  const [launchAppId, setLaunchAppId] = useState("");
  const [loading, setLoading] = useState(true);
  const [elapsed, setElapsed] = useState("");

  const loadRecents = useCallback(async () => {
    try {
      const sessions = (await callGameDetection(
        "getRecentSessions",
      )) as GameSession[];
      setRecentSessions(sessions ?? []);
    } catch (err) {
      console.error("[steam-gamescope-ipc] Failed to load sessions:", err);
    } finally {
      setLoading(false);
    }
  }, [callGameDetection]);

  useGameDetectionEvent({
    event: "gameChanged",
    handler: () => {
      // Re-fetch recents whenever the active game flips.
      loadRecents();
    },
  });

  useEffect(() => {
    loadRecents();
  }, [loadRecents]);

  const state: GameState = { currentGame, recentSessions };

  // Update elapsed time every second when a game is running
  useEffect(() => {
    if (!state.currentGame) {
      setElapsed("");
      return;
    }
    const update = () => setElapsed(formatDuration(Date.now() - state.currentGame!.startTime));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [state.currentGame]);

  const handleLaunchGame = useCallback(() => {
    const appId = parseInt(launchAppId, 10);
    if (isNaN(appId) || appId <= 0) return;
    try {
      const w = globalThis as unknown as {
        SteamClient?: { URL?: { ExecuteSteamURL: (url: string) => void } };
      };
      w.SteamClient?.URL?.ExecuteSteamURL(`steam://rungameid/${appId}`);
    } catch (err) {
      console.error("[steam-gamescope-ipc] Failed to launch game:", err);
    }
  }, [launchAppId]);

  if (loading) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="flex items-center justify-center h-64">
            <Spinner size={32} />
          </div>
        </div>
      </div>
    );
  }

  const connected = state.currentGame !== null;
  const launchDisabled = !launchAppId.trim() || isNaN(parseInt(launchAppId, 10));

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          {/* HEADER — icon tile + title + status chip */}
          <div className="subsection">
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <FaTv className="w-5 h-5" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Steam Gamescope IPC</div>
                <div
                  className="mono"
                  style={{ fontSize: 11.5, color: "var(--fg-3)" }}
                >
                  steam://rungameid · session bridge
                </div>
              </div>
              <div className={connected ? "chip chip-success" : "chip"}>
                {connected ? "● CONNECTED" : "● IDLE"}
              </div>
            </div>
          </div>

          {/* NOW PLAYING */}
          <div className="subsection">
            <div className="subsection-label">Now Playing</div>
            {state.currentGame ? (
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <img
                  src={`https://cdn.cloudflare.steamstatic.com/steam/apps/${state.currentGame.appId}/header.jpg`}
                  alt={state.currentGame.gameName}
                  style={{
                    width: 160,
                    height: 75,
                    objectFit: "cover",
                    borderRadius: 8,
                    background: "var(--bg-inset)",
                  }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>
                    {state.currentGame.gameName}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2 }}
                  >
                    AppID {state.currentGame.appId}
                  </div>
                  {elapsed && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--fg-2)",
                        marginTop: 4,
                      }}
                    >
                      Playing for {elapsed}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div
                className="subsection-desc"
                style={{ color: "var(--fg-3)", fontSize: 13 }}
              >
                No game currently running.
              </div>
            )}
          </div>

          {/* LAUNCH GAME */}
          <div className="subsection">
            <div className="subsection-label">Launch Game</div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <TextInput
                  value={launchAppId}
                  onChange={(v) => setLaunchAppId(v)}
                  placeholder="Enter AppID (e.g. 730)"
                />
              </div>
              <Button
                variant="primary"
                onClick={handleLaunchGame}
                disabled={launchDisabled}
              >
                <FaPlay className="w-3 h-3" /> Launch
              </Button>
            </div>
          </div>

          {/* RECENT SESSIONS — live feed */}
          <div className="subsection">
            <div className="subsection-label">Live IPC Feed</div>
            {state.recentSessions.length === 0 && !state.currentGame ? (
              <div
                className="subsection-desc"
                style={{ color: "var(--fg-3)", fontSize: 13 }}
              >
                No session events yet.
              </div>
            ) : (
              <div
                style={{
                  padding: 14,
                  background: "var(--bg-inset)",
                  borderRadius: 10,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  color: "var(--fg-2)",
                  maxHeight: 180,
                  overflow: "auto",
                  lineHeight: 1.7,
                }}
              >
                {state.currentGame && (
                  <FeedLine
                    timestamp={formatTime(state.currentGame.startTime)}
                    key_="launch.appid"
                    value={String(state.currentGame.appId)}
                  />
                )}
                {state.currentGame && (
                  <FeedLine
                    timestamp={formatTime(state.currentGame.startTime)}
                    key_="launch.title"
                    value={`"${state.currentGame.gameName}"`}
                  />
                )}
                {state.recentSessions.map((session, i) => {
                  const duration = session.endTime
                    ? formatDuration(session.endTime - session.startTime)
                    : "in-progress";
                  return (
                    <div key={`${session.appId}-${session.startTime}-${i}`}>
                      <FeedLine
                        timestamp={formatTime(session.endTime ?? session.startTime)}
                        key_="session.end"
                        value={`${session.gameName} · ${duration}`}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FeedLine({
  timestamp,
  key_,
  value,
}: {
  timestamp: string;
  key_: string;
  value: string;
}) {
  return (
    <div>
      <span style={{ color: "var(--fg-3)" }}>[{timestamp}]</span>{" "}
      <span style={{ color: "var(--accent)" }}>{key_} =</span>{" "}
      <span>{value}</span>
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

export const mount = mountComponent(SteamGamescopeIpcPanel);

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        Gamescope IPC
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Compositor state & live feed
      </span>
    </div>
  );
}

export const mountHeader = mountComponent(Header);
