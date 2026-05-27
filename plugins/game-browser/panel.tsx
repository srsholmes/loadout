import { useState, useCallback, useEffect, useMemo } from "react";
import { useBackend, Panel, Text, Spinner, Steam } from "@loadout/ui";

interface GameInfo {
  appId: string;
  name: string;
  sizeOnDisk: number;
  headerUrl: string;
  capsuleUrl: string;
}

export default function GameBrowserPanel() {
  const { call } = useBackend("game-browser");
  const [games, setGames] = useState<GameInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const loadGames = useCallback(async () => {
    setLoading(true);
    try {
      const result = await call("getGames");
      setGames(result as GameInfo[]);
    } catch (err) {
      console.error("[game-browser] Failed to load games:", err);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    loadGames();
  }, [loadGames]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return games;
    const q = filter.toLowerCase();
    return games.filter((g) => g.name.toLowerCase().includes(q));
  }, [games, filter]);

  const handleGameClick = (appId: string) => {
    // Navigate to the game's detail page in the Steam UI
    try {
      // SteamClient.Apps.RunGame or Navigation to game details
      const w = globalThis as unknown as { SteamClient?: { URL?: { ExecuteSteamURL: (url: string) => void } } };
      w.SteamClient?.URL?.ExecuteSteamURL(`steam://nav/games/details/${appId}`);
    } catch (err) {
      console.error("[game-browser] Failed to navigate to game:", err);
    }
  };

  if (loading) {
    return (
      <Panel title="Game Browser">
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 16 }}>
          <Spinner />
          <Text variant="secondary">Loading library...</Text>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Game Browser">
      {/* Search input */}
      <div style={{ marginBottom: 12 }}>
        <Steam.TextField
          value={filter}
          onChange={(e: Event) => setFilter((e.target as HTMLInputElement).value)}
          placeholder="Filter games..."
        />
      </div>

      {/* Game count */}
      <Text variant="secondary" style={{ marginBottom: 8, display: "block" }}>
        {filtered.length} game{filtered.length !== 1 ? "s" : ""}
        {filter.trim() ? ` matching "${filter}"` : " installed"}
      </Text>

      {/* Game list */}
      <Steam.ScrollPanel style={{ maxHeight: 400 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {filtered.map((game) => (
            <Steam.Focusable
              key={game.appId}
              onActivate={() => handleGameClick(game.appId)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 8px",
                borderRadius: 4,
                cursor: "pointer",
                background: "rgba(255,255,255,0.04)",
                transition: "background 0.15s",
              }}
              focusClassName="game-browser-focused"
            >
              <img
                src={game.capsuleUrl}
                alt={game.name}
                style={{
                  width: 120,
                  height: 45,
                  objectFit: "cover",
                  borderRadius: 3,
                  flexShrink: 0,
                  background: "rgba(0,0,0,0.3)",
                }}
                loading="lazy"
                onError={(e) => {
                  // Fall back to header image if capsule not available
                  const img = e.target as HTMLImageElement;
                  if (!img.dataset.fallback) {
                    img.dataset.fallback = "1";
                    img.src = game.headerUrl;
                  }
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <Text style={{
                  fontSize: 13,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}>
                  {game.name}
                </Text>
                {game.sizeOnDisk > 0 && (
                  <Text variant="secondary" style={{ fontSize: 11 }}>
                    {formatSize(game.sizeOnDisk)}
                  </Text>
                )}
              </div>
            </Steam.Focusable>
          ))}
        </div>
      </Steam.ScrollPanel>

      {/* Refresh button */}
      <div style={{ marginTop: 12 }}>
        <Steam.DialogButton
          onClick={async () => {
            setLoading(true);
            try {
              const result = await call("rescan");
              setGames(result as GameInfo[]);
            } finally {
              setLoading(false);
            }
          }}
        >
          Refresh Library
        </Steam.DialogButton>
      </div>

      <style>{`
        .game-browser-focused {
          background: rgba(255,255,255,0.12) !important;
          outline: 2px solid #1a9fff;
          outline-offset: -2px;
        }
      `}</style>
    </Panel>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
