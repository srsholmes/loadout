import { describe, it, expect } from "bun:test";

import {
  createPerGameEngine,
  type GameProfile,
  type PerGameEnginePersistence,
  type PerGameState,
} from "./index";

interface FakePayload {
  watts: number;
}
interface FakeSnapshot {
  preWatts: number;
}

/** Drop-in in-memory persistence so the engine tests don't touch disk. */
function memoryPersistence<P>(
  initial?: PerGameState<P>,
): PerGameEnginePersistence<P> {
  let state: PerGameState<P> = initial
    ? { ...initial, profiles: [...initial.profiles] }
    : { perGameEnabled: false, profiles: [] };
  return {
    load: async () => ({
      perGameEnabled: state.perGameEnabled,
      profiles: state.profiles.map((p) => ({ ...p })),
    }),
    save: async (next) => {
      state = {
        perGameEnabled: next.perGameEnabled,
        profiles: next.profiles.map((p) => ({ ...p })),
      };
    },
  };
}

describe("createPerGameEngine", () => {
  it("returns empty state on first load", async () => {
    const engine = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence: memoryPersistence<FakePayload>(),
      onApply: async () => {},
      onSnapshot: async () => ({ preWatts: 15 }),
      onRestore: async () => {},
    });
    await engine.load();
    expect(engine.getProfiles()).toEqual([]);
    expect(engine.getActiveAppId()).toBeNull();
    expect(engine.isPerGameEnabled()).toBe(false);
  });

  it("setProfile persists and round-trips through a fresh load()", async () => {
    const persistence = memoryPersistence<FakePayload>();
    const a = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence,
      onApply: async () => {},
      onSnapshot: async () => ({ preWatts: 0 }),
      onRestore: async () => {},
    });
    await a.load();
    await a.setProfile(440, "TF2", { watts: 12 });
    await a.setProfile(730, "CSGO", { watts: 20 });

    const b = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence,
      onApply: async () => {},
      onSnapshot: async () => ({ preWatts: 0 }),
      onRestore: async () => {},
    });
    await b.load();
    expect(b.getProfiles()).toEqual([
      { appId: 440, gameName: "TF2", payload: { watts: 12 } },
      { appId: 730, gameName: "CSGO", payload: { watts: 20 } },
    ]);
  });

  it("setProfile overwrites an existing entry instead of duplicating", async () => {
    const engine = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence: memoryPersistence<FakePayload>(),
      onApply: async () => {},
      onSnapshot: async () => ({ preWatts: 0 }),
      onRestore: async () => {},
    });
    await engine.load();
    await engine.setProfile(440, "TF2", { watts: 12 });
    await engine.setProfile(440, "TF2", { watts: 18 });
    expect(engine.getProfiles()).toHaveLength(1);
    expect(engine.getProfile(440)?.payload.watts).toBe(18);
  });

  it("handleGameLaunch is a no-op when perGameEnabled is false", async () => {
    let applied = 0;
    const engine = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence: memoryPersistence<FakePayload>(),
      onApply: async () => {
        applied++;
      },
      onSnapshot: async () => ({ preWatts: 0 }),
      onRestore: async () => {},
    });
    await engine.load();
    await engine.setProfile(440, "TF2", { watts: 12 });
    await engine.handleGameLaunch(440, "TF2");
    expect(applied).toBe(0);
    expect(engine.getActiveAppId()).toBeNull();
  });

  it("handleGameLaunch snapshots, applies, and binds the appId", async () => {
    const calls: string[] = [];
    const engine = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence: memoryPersistence<FakePayload>(),
      onApply: async (payload, ctx) => {
        calls.push(`apply ${ctx.appId} ${payload.watts}`);
      },
      onSnapshot: async () => {
        calls.push("snapshot");
        return { preWatts: 15 };
      },
      onRestore: async (snap) => {
        calls.push(`restore ${snap.preWatts}`);
      },
    });
    await engine.load();
    await engine.setPerGameEnabled(true);
    await engine.setProfile(440, "TF2", { watts: 12 });
    await engine.handleGameLaunch(440, "TF2");
    expect(calls).toEqual(["snapshot", "apply 440 12"]);
    expect(engine.getActiveAppId()).toBe(440);
  });

  it("handleGameExit restores the snapshot for the bound appId", async () => {
    const calls: string[] = [];
    const engine = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence: memoryPersistence<FakePayload>(),
      onApply: async () => {},
      onSnapshot: async () => ({ preWatts: 15 }),
      onRestore: async (snap) => {
        calls.push(`restore ${snap.preWatts}`);
      },
    });
    await engine.load();
    await engine.setPerGameEnabled(true);
    await engine.setProfile(440, "TF2", { watts: 12 });
    await engine.handleGameLaunch(440, "TF2");
    await engine.handleGameExit(440);
    expect(calls).toEqual(["restore 15"]);
    expect(engine.getActiveAppId()).toBeNull();
  });

  it("handleGameExit ignores apps that aren't currently bound", async () => {
    let restored = 0;
    const engine = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence: memoryPersistence<FakePayload>(),
      onApply: async () => {},
      onSnapshot: async () => ({ preWatts: 15 }),
      onRestore: async () => {
        restored++;
      },
    });
    await engine.load();
    await engine.setPerGameEnabled(true);
    await engine.setProfile(440, "TF2", { watts: 12 });
    await engine.handleGameLaunch(440, "TF2");
    await engine.handleGameExit(730); // different appId
    expect(restored).toBe(0);
    expect(engine.getActiveAppId()).toBe(440);
  });

  it("guard returning false skips handleGameLaunch entirely", async () => {
    let applied = 0;
    let guardChecked = false;
    const engine = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence: memoryPersistence<FakePayload>(),
      onApply: async () => {
        applied++;
      },
      onSnapshot: async () => ({ preWatts: 0 }),
      onRestore: async () => {},
      guard: () => {
        guardChecked = true;
        return false;
      },
    });
    await engine.load();
    await engine.setPerGameEnabled(true);
    await engine.setProfile(440, "TF2", { watts: 12 });
    await engine.handleGameLaunch(440, "TF2");
    expect(guardChecked).toBe(true);
    expect(applied).toBe(0);
    expect(engine.getActiveAppId()).toBeNull();
  });

  it("removeProfile takes the entry out and persists", async () => {
    const persistence = memoryPersistence<FakePayload>();
    const engine = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence,
      onApply: async () => {},
      onSnapshot: async () => ({ preWatts: 0 }),
      onRestore: async () => {},
    });
    await engine.load();
    await engine.setProfile(440, "TF2", { watts: 12 });
    await engine.removeProfile(440);
    expect(engine.getProfile(440)).toBeNull();
    const after = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence,
      onApply: async () => {},
      onSnapshot: async () => ({ preWatts: 0 }),
      onRestore: async () => {},
    });
    await after.load();
    expect(after.getProfiles()).toEqual([]);
  });

  it("onActiveChanged fires on launch with the active profile and on exit with null", async () => {
    const events: Array<{ appId: number; watts: number } | null> = [];
    const engine = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence: memoryPersistence<FakePayload>(),
      onApply: async () => {},
      onSnapshot: async () => ({ preWatts: 0 }),
      onRestore: async () => {},
      onActiveChanged: (active) => {
        events.push(active ? { appId: active.appId, watts: active.payload.watts } : null);
      },
    });
    await engine.load();
    await engine.setPerGameEnabled(true);
    await engine.setProfile(440, "TF2", { watts: 12 });
    await engine.handleGameLaunch(440, "TF2");
    await engine.handleGameExit(440);
    expect(events).toEqual([{ appId: 440, watts: 12 }, null]);
  });

  it("custom persistence preserves out-of-band fields across writes", async () => {
    // Simulates audio-mixer's storage shape: per-game state lives at the
    // top level alongside other keys the engine doesn't know about.
    const storage: Record<string, unknown> = { apps: { spotify: { volume: 60 } } };
    const persistence: PerGameEnginePersistence<FakePayload> = {
      load: async () => ({
        perGameEnabled: Boolean(storage.perGameEnabled),
        profiles: Array.isArray(storage.gameProfiles)
          ? (storage.gameProfiles as GameProfile<FakePayload>[])
          : [],
      }),
      save: async (state) => {
        storage.perGameEnabled = state.perGameEnabled;
        storage.gameProfiles = state.profiles;
      },
    };
    const engine = createPerGameEngine<FakePayload, FakeSnapshot>({
      persistence,
      onApply: async () => {},
      onSnapshot: async () => ({ preWatts: 0 }),
      onRestore: async () => {},
    });
    await engine.load();
    await engine.setProfile(440, "TF2", { watts: 12 });
    expect((storage.apps as { spotify: { volume: number } }).spotify.volume).toBe(60);
    expect(storage.perGameEnabled).toBe(false);
    expect((storage.gameProfiles as unknown[]).length).toBe(1);
  });
});
