import type { EmitPayload, PluginBackend } from "@loadout/types";

export interface CurrentGame {
  appId: number;
  gameName: string;
  startTime: number;
}

export interface GameSessionRecord extends CurrentGame {
  endTime?: number;
}

export interface GameChangedEvent {
  currentGame: CurrentGame | null;
  recentSessions: GameSessionRecord[];
}

const RECENT_SESSIONS_LIMIT = 20;

export class GameDetectionService implements PluginBackend {
  private current: CurrentGame | null = null;
  private recent: GameSessionRecord[] = [];
  // Audit A-026: cache the appId+endTime signature of the last
  // broadcast so a no-op exit (e.g. plugin receives a phantom
  // game-exit for an appId we never tracked) doesn't trigger an
  // unnecessary emit + re-render on every subscriber. Seeded with the
  // empty-state signature so the very first no-op call also short-
  // circuits.
  private lastBroadcastSig: string = "none|";
  emit?: (payload: EmitPayload) => void;

  async handleGameLaunch(appId: number, gameName: string): Promise<void> {
    if (typeof appId !== "number" || !Number.isFinite(appId)) return;
    const startTime = Date.now();
    this.current = { appId, gameName: gameName ?? "", startTime };
    this.recent = [
      { appId, gameName: gameName ?? "", startTime },
      ...this.recent.filter((s) => s.appId !== appId),
    ].slice(0, RECENT_SESSIONS_LIMIT);
    this.broadcastChange();
  }

  async handleGameExit(appId: number): Promise<void> {
    const endTime = Date.now();
    const idx = this.recent.findIndex((s) => s.appId === appId && s.endTime === undefined);
    if (idx >= 0) {
      // idx comes from findIndex and is >= 0, so the element is in bounds;
      // the guard only satisfies the type checker.
      const session = this.recent[idx];
      if (session) {
        this.recent[idx] = { ...session, endTime };
      }
    }
    if (this.current && this.current.appId === appId) {
      this.current = null;
    }
    this.broadcastChange();
  }

  async getCurrentGame(): Promise<CurrentGame | null> {
    return this.current ? { ...this.current } : null;
  }

  async getRecentSessions(): Promise<GameSessionRecord[]> {
    return this.recent.map((s) => ({ ...s }));
  }

  private broadcastChange(): void {
    const sig = this.signature();
    if (sig === this.lastBroadcastSig) return;
    this.lastBroadcastSig = sig;
    const payload: GameChangedEvent = {
      currentGame: this.current ? { ...this.current } : null,
      recentSessions: this.recent.map((s) => ({ ...s })),
    };
    this.emit?.({ event: "gameChanged", data: payload });
  }

  private signature(): string {
    // Compact projection of the state that the payload exposes. Only
    // the fields a subscriber would care about (appId + endTime) drive
    // the signature; startTime intentionally not included so re-launch
    // of the same game still triggers an emit even if the launch event
    // fires within the same ms.
    const currentId = this.current?.appId ?? "none";
    const sessions = this.recent
      .map((s) => `${s.appId}:${s.endTime ?? "open"}`)
      .join(",");
    return `${currentId}|${sessions}`;
  }
}

export const GAME_DETECTION_SERVICE_ID = "__core:game-detection";
