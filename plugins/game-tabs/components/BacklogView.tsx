import { useMemo } from "react";
import {
  FaPlay,
  FaTrash,
  FaChevronUp,
  FaChevronDown,
  FaPlus,
} from "react-icons/fa6";
import { Button, IconButton, useFocusable } from "@loadout/ui";
import type { GameInfo } from "@loadout/types";
import type { BacklogEntry, BacklogStatus } from "../lib/types";
import { groupBacklog, STATUS_LABELS } from "../lib/backlog";

const STATUS_VARIANT: Record<BacklogStatus, string> = {
  playing: "chip-accent",
  toPlay: "chip-info",
  beaten: "chip-success",
  dropped: "chip-neutral",
};

const GROUP_HEADINGS: Record<BacklogStatus, string> = {
  playing: "Now Playing",
  toPlay: "Up Next",
  beaten: "Beaten",
  dropped: "Dropped",
};

function BacklogRow({
  entry,
  game,
  isCurrent,
  isFirst,
  isLast,
  onLaunch,
  onCycleStatus,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  entry: BacklogEntry;
  game: GameInfo | undefined;
  isCurrent: boolean;
  isFirst: boolean;
  isLast: boolean;
  onLaunch: () => void;
  onCycleStatus: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onLaunch });
  const name = game?.name ?? `App ${entry.appId}`;

  return (
    <div
      ref={ref}
      className={[
        "flex items-center gap-3 rounded-[10px] border px-3 py-2.5 transition-all duration-150",
        focused ? "border-[var(--accent)] scale-[1.01]" : "border-[var(--line)]",
      ].join(" ")}
      style={{
        background: isCurrent ? "var(--accent-soft)" : "var(--bg-inset)",
        ...(focused ? { animation: "focusPulse 2s ease-in-out infinite" } : {}),
      }}
    >
      {game && (
        <img
          src={game.capsuleUrl}
          alt=""
          className="rounded object-cover shrink-0"
          style={{ width: 34, height: 48 }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      )}
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-[13px] font-medium truncate">{name}</span>
        <button
          type="button"
          onClick={onCycleStatus}
          className={`chip ${STATUS_VARIANT[entry.status]} self-start mt-1 cursor-pointer`}
          title="Change status"
        >
          {STATUS_LABELS[entry.status]}
        </button>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <IconButton onClick={onMoveUp} disabled={isFirst} title="Move up" ariaLabel="Move up">
          <FaChevronUp size={11} />
        </IconButton>
        <IconButton onClick={onMoveDown} disabled={isLast} title="Move down" ariaLabel="Move down">
          <FaChevronDown size={11} />
        </IconButton>
        <IconButton onClick={onLaunch} title="Launch" ariaLabel="Launch" variant="accent">
          <FaPlay size={11} />
        </IconButton>
        <IconButton onClick={onRemove} title="Remove from backlog" ariaLabel="Remove" variant="danger">
          <FaTrash size={11} />
        </IconButton>
      </div>
    </div>
  );
}

export function BacklogView({
  backlog,
  library,
  currentGameAppId,
  onLaunch,
  onCycleStatus,
  onSwap,
  onRemove,
  onAddGames,
}: {
  backlog: BacklogEntry[];
  library: GameInfo[];
  currentGameAppId: string | null;
  onLaunch: (game: GameInfo | undefined, appId: string) => void;
  onCycleStatus: (appId: string) => void;
  /** Swap the manual order of two adjacent-in-group entries. */
  onSwap: (aAppId: string, bAppId: string) => void;
  onRemove: (appId: string) => void;
  onAddGames: () => void;
}) {
  const byId = useMemo(() => {
    const m = new Map<string, GameInfo>();
    for (const g of library) m.set(g.appId, g);
    return m;
  }, [library]);

  const groups = useMemo(() => groupBacklog(backlog), [backlog]);

  if (backlog.length === 0) {
    return (
      <div className="card">
        <div className="text-center py-12 flex flex-col items-center gap-3">
          <div className="text-[var(--fg-3)]">
            Your backlog is empty. Add games you want to play through.
          </div>
          <Button variant="primary" onClick={onAddGames}>
            <span className="flex items-center gap-1.5">
              <FaPlus size={11} /> Add games
            </span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-end">
        <Button variant="primary" size="sm" onClick={onAddGames}>
          <span className="flex items-center gap-1.5">
            <FaPlus size={10} /> Add games
          </span>
        </Button>
      </div>
      {groups.map((group) => (
        <div key={group.status} className="flex flex-col gap-2">
          <div className="subsection-label">
            {GROUP_HEADINGS[group.status]}{" "}
            <span className="text-[var(--fg-3)]">({group.entries.length})</span>
          </div>
          {group.entries.map((entry, i) => (
            <BacklogRow
              key={entry.appId}
              entry={entry}
              game={byId.get(entry.appId)}
              isCurrent={currentGameAppId === entry.appId}
              isFirst={i === 0}
              isLast={i === group.entries.length - 1}
              onLaunch={() => onLaunch(byId.get(entry.appId), entry.appId)}
              onCycleStatus={() => onCycleStatus(entry.appId)}
              onMoveUp={() => {
                const prev = group.entries[i - 1];
                if (prev) onSwap(entry.appId, prev.appId);
              }}
              onMoveDown={() => {
                const next = group.entries[i + 1];
                if (next) onSwap(entry.appId, next.appId);
              }}
              onRemove={() => onRemove(entry.appId)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
