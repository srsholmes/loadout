import { describe, test, expect, beforeEach } from "bun:test";
import {
  GameDetectionService,
  type GameChangedEvent,
} from "./game-detection";

describe("GameDetectionService", () => {
  let service: GameDetectionService;
  let events: GameChangedEvent[];

  beforeEach(() => {
    service = new GameDetectionService();
    events = [];
    service.emit = ({ event, data }) => {
      if (event === "gameChanged") events.push(data as GameChangedEvent);
    };
  });

  test("starts with no current game and no recent sessions", async () => {
    expect(await service.getCurrentGame()).toBeNull();
    expect(await service.getRecentSessions()).toEqual([]);
  });

  test("handleGameLaunch sets the current game and emits gameChanged", async () => {
    await service.handleGameLaunch(730, "Counter-Strike 2");
    const current = await service.getCurrentGame();
    expect(current).not.toBeNull();
    expect(current?.appId).toBe(730);
    expect(current?.gameName).toBe("Counter-Strike 2");
    expect(typeof current?.startTime).toBe("number");

    expect(events).toHaveLength(1);
    expect(events[0].currentGame?.appId).toBe(730);
    expect(events[0].recentSessions).toHaveLength(1);
  });

  test("handleGameExit clears the current game and emits gameChanged", async () => {
    await service.handleGameLaunch(730, "Counter-Strike 2");
    events.length = 0;

    await service.handleGameExit(730);

    expect(await service.getCurrentGame()).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0].currentGame).toBeNull();
  });

  test("recent sessions list is bounded and dedupes by appId", async () => {
    for (let i = 0; i < 25; i++) {
      await service.handleGameLaunch(i, `Game ${i}`);
    }
    const sessions = await service.getRecentSessions();
    expect(sessions.length).toBeLessThanOrEqual(20);
    // Most-recent first.
    expect(sessions[0].appId).toBe(24);
  });

  test("relaunching a game replaces its prior open record", async () => {
    await service.handleGameLaunch(730, "CS2");
    await service.handleGameLaunch(730, "CS2");
    const sessions = await service.getRecentSessions();
    expect(sessions.filter((s) => s.appId === 730)).toHaveLength(1);
  });

  test("handleGameLaunch ignores non-numeric appId", async () => {
    await service.handleGameLaunch(NaN, "Bad");
    expect(await service.getCurrentGame()).toBeNull();
    expect(events).toHaveLength(0);
  });

  test("emit is optional — methods don't throw without it", async () => {
    const s = new GameDetectionService();
    await s.handleGameLaunch(1, "A");
    await s.handleGameExit(1);
    expect(await s.getCurrentGame()).toBeNull();
  });

  test("handleGameExit for an unknown appId does not re-emit when state hasn't changed (A-026)", async () => {
    // No current game, nothing in recent — calling exit for a random
    // appId leaves both unchanged. Should not produce a duplicate emit.
    await service.handleGameExit(999);
    expect(events).toHaveLength(0);

    await service.handleGameLaunch(730, "CS2");
    await service.handleGameExit(730);
    expect(events).toHaveLength(2);
    events.length = 0;

    // Second exit for the same game (already ended) is a no-op — the
    // signature is unchanged from the previous broadcast, so we skip.
    await service.handleGameExit(730);
    expect(events).toHaveLength(0);
  });
});
