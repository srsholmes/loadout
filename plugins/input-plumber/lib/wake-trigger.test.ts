/**
 * Overlay wake-trigger orchestration tests.
 *
 * wake-trigger.ts shells out to busctl via @loadout/exec (→ Bun.spawn),
 * writes files via node:fs/promises, and persists via @loadout/plugin-storage.
 * We stub all three: a busctl argv dispatcher, fs spies backed by an in-memory
 * map, and an in-memory storage bucket. No real DBus / fs / device required.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as pluginStorage from "@loadout/plugin-storage";
import * as fsp from "node:fs/promises";
import {
  getWakeStatus,
  setWakeButton,
  clearWakeButton,
  captureWakeButton,
  reloadPersistedProfile,
  reloadPersistedProfileWithRetry,
  restartInputPlumber,
} from "./wake-trigger";
import { PROFILE_PATH } from "./profile";

const PATH0 = "/org/shadowblip/InputPlumber/CompositeDevice0";

interface SpawnExpectation {
  match: (cmd: readonly string[]) => boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function makeSpawnStub(expectations: SpawnExpectation[]) {
  const calls: string[][] = [];
  const stub = (cmd: readonly string[] | string, _opts?: unknown) => {
    const argv = Array.isArray(cmd) ? (cmd as string[]) : [cmd as string];
    calls.push([...argv]);
    const exp = expectations.find((e) => e.match(argv));
    const mk = (s: string) =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(s));
          c.close();
        },
      });
    return {
      stdout: mk(exp?.stdout ?? ""),
      stderr: mk(exp?.stderr ?? ""),
      exited: Promise.resolve(exp?.exitCode ?? 0),
      kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  };
  return { stub, calls };
}

function has(cmd: readonly string[], needle: string): boolean {
  return cmd.some((s) => s.includes(needle));
}

/** A connected, capability-rich composite device on a non-Deck host. */
function happyPathExpectations(): SpawnExpectation[] {
  return [
    // service availability + path enumeration
    {
      match: (c) => c[0] === "busctl" && has(c, "tree"),
      stdout: `${PATH0}\n`,
    },
    {
      match: (c) => has(c, "get-property") && has(c, "Name"),
      stdout: 's "OrangePi Apex"',
    },
    {
      match: (c) => has(c, "get-property") && has(c, "Capabilities"),
      stdout: 'as 3 "Gamepad:Button:South" "Gamepad:Button:RightPaddle1" "Keyboard:KeyRecord"',
    },
    {
      match: (c) => has(c, "get-property") && has(c, "TargetDevices"),
      stdout: `ao 1 "${PATH0}/Target0"`,
    },
    {
      match: (c) => has(c, "get-property") && has(c, "DeviceType"),
      stdout: 's "xb360"',
    },
    {
      match: (c) => has(c, "call") && has(c, "LoadProfilePath"),
      stdout: "",
      exitCode: 0,
    },
    // systemctl / udevadm — always succeed
    { match: (c) => c[0] === "systemctl" || c[0] === "udevadm", exitCode: 0 },
  ];
}

describe("wake-trigger orchestration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spawnSpy: ReturnType<typeof spyOn<any, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fsSpies: ReturnType<typeof spyOn<any, any>>[] = [];
  const storage = new Map<string, unknown>();
  const writtenFiles = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    writtenFiles.clear();

    spyOn(pluginStorage, "readPluginStorage").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (id: string) => (storage.get(id) ?? {}) as any,
    );
    spyOn(pluginStorage, "writePluginStorage").mockImplementation(
      async (id: string, data: unknown) => {
        storage.set(id, data);
      },
    );

    fsSpies.length = 0;
    fsSpies.push(
      spyOn(fsp, "mkdir").mockImplementation(async () => undefined),
      spyOn(fsp, "writeFile").mockImplementation(async (p: unknown, content: unknown) => {
        writtenFiles.set(String(p), String(content));
      }),
      spyOn(fsp, "rm").mockImplementation(async () => undefined),
      // DMI read → non-Deck host by default.
      spyOn(fsp, "readFile").mockImplementation(async (p: unknown) => {
        if (String(p).includes("product_name")) return "OrangePi Apex";
        if (String(p).includes("sys_vendor")) return "OrangePi";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
    );
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    for (const s of fsSpies) s.mockRestore();
  });

  it("getWakeStatus reports IP active, non-Deck, and pickable buttons", async () => {
    const { stub } = makeSpawnStub(happyPathExpectations());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

    const status = await getWakeStatus();
    expect(status.ipActive).toBe(true);
    expect(status.isDeck).toBe(false);
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0].name).toBe("OrangePi Apex");
    const names = status.devices[0].buttons.map((b) => b.name).sort();
    expect(names).toEqual(["KeyRecord", "RightPaddle1", "South"]);
    expect(status.selectedRaw).toBeNull();
  });

  it("setWakeButton renders the profile, loads it, and persists the choice", async () => {
    const { stub, calls } = makeSpawnStub(happyPathExpectations());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

    const r = await setWakeButton("Gamepad:Button:RightPaddle1");
    expect(r.ok).toBe(true);

    // Wrote the profile with the chosen mapping, preserving the xb360 target.
    const profile = writtenFiles.get(PROFILE_PATH);
    expect(profile).toBeDefined();
    expect(profile).toContain("button: RightPaddle1");
    expect(profile).toContain("- xb360");
    expect(profile).toContain("- keyboard");
    expect(profile).toContain("keyboard: KeyF16");

    // Issued a LoadProfilePath call against the device path + profile path.
    const loadCall = calls.find((c) => has(c, "LoadProfilePath"));
    expect(loadCall).toBeDefined();
    expect(loadCall).toContain(PATH0);
    expect(loadCall).toContain(PROFILE_PATH);

    // Persisted the selection.
    const persisted = storage.get("input-plumber") as {
      wake?: { selectedRaw?: string };
    };
    expect(persisted.wake?.selectedRaw).toBe("Gamepad:Button:RightPaddle1");
  });

  it("setWakeButton fails cleanly when InputPlumber is absent on a non-Deck host", async () => {
    const { stub } = makeSpawnStub([
      { match: (c) => c[0] === "busctl" && has(c, "tree"), exitCode: 1 },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

    const r = await setWakeButton("Gamepad:Button:RightPaddle1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not running");
  });

  it("clearWakeButton forgets the selection and loads a no-mapping profile", async () => {
    const { stub, calls } = makeSpawnStub(happyPathExpectations());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);
    storage.set("input-plumber", {
      wake: { selectedRaw: "Gamepad:Button:RightPaddle1", deviceName: "OrangePi Apex" },
    });

    const r = await clearWakeButton();
    expect(r.ok).toBe(true);
    expect(writtenFiles.get(PROFILE_PATH)).toContain("mapping: []");
    expect(calls.find((c) => has(c, "LoadProfilePath"))).toBeDefined();
    const persisted = storage.get("input-plumber") as {
      wake?: { selectedRaw: string | null };
    };
    expect(persisted.wake?.selectedRaw).toBeNull();
  });

  it("reloadPersistedProfile is a no-op when nothing is bound", async () => {
    const { stub, calls } = makeSpawnStub(happyPathExpectations());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

    const r = await reloadPersistedProfile();
    expect(r.ok).toBe(true);
    // No work was done — no busctl calls at all.
    expect(calls).toHaveLength(0);
  });

  it("reloadPersistedProfile re-loads the persisted button after a reboot", async () => {
    const { stub, calls } = makeSpawnStub(happyPathExpectations());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);
    storage.set("input-plumber", {
      wake: {
        selectedRaw: "Gamepad:Button:RightPaddle1",
        deviceName: "OrangePi Apex",
      },
    });

    const r = await reloadPersistedProfile();
    expect(r.ok).toBe(true);
    expect(writtenFiles.get(PROFILE_PATH)).toContain("button: RightPaddle1");
    expect(calls.find((c) => has(c, "LoadProfilePath"))).toBeDefined();
  });

  it("restartInputPlumber resets the start-limit before restarting (so rapid presses can't brick IP)", async () => {
    const { stub, calls } = makeSpawnStub(happyPathExpectations());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

    const r = await restartInputPlumber();
    expect(r.ok).toBe(true);

    const resetIdx = calls.findIndex(
      (c) => c[0] === "systemctl" && has(c, "reset-failed") && has(c, "inputplumber"),
    );
    const restartIdx = calls.findIndex(
      (c) => c[0] === "systemctl" && has(c, "restart") && has(c, "inputplumber"),
    );
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(restartIdx).toBeGreaterThanOrEqual(0);
    // reset-failed must precede the restart, else a start-limit-hit state stays
    // stuck and the recovery button can't recover.
    expect(resetIdx).toBeLessThan(restartIdx);
  });

  it("captureWakeButton restores the previous binding when the catch-all load fails", async () => {
    // First LoadProfilePath call (catch-all capture profile) fails; second
    // call (the restore) succeeds. Without the fix the catch-all stays loaded
    // and the user's previously bound button silently stops working.
    let loadCount = 0;
    const exps: SpawnExpectation[] = [
      ...happyPathExpectations().filter((e) => !e.match(["busctl", "call", "LoadProfilePath"])),
      {
        match: (c) => has(c, "call") && has(c, "LoadProfilePath"),
        get exitCode() {
          loadCount += 1;
          // 1st = capture load (fails). 2nd = restore load (succeeds).
          return loadCount === 1 ? 1 : 0;
        },
        stderr: "synthetic LoadProfilePath failure",
      },
    ];

    // Pre-seed a prior binding so restorePreviousBinding has something to
    // re-render to (rather than the cleared profile).
    storage.set("input-plumber", {
      wake: {
        selectedRaw: "Gamepad:Button:RightPaddle1",
        deviceName: "OrangePi Apex",
      },
    });

    const { stub } = makeSpawnStub(exps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

    const r = await captureWakeButton(1000);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("LoadProfilePath (capture)");
    // Restore ran (a 2nd LoadProfilePath call) — the test would fail with
    // loadCount === 1 if the restore branch was skipped.
    expect(loadCount).toBeGreaterThanOrEqual(2);
    // Final PROFILE_PATH content is the previous binding, not the catch-all.
    const final = writtenFiles.get(PROFILE_PATH) ?? "";
    expect(final).toContain("button: RightPaddle1");
    expect(final).not.toContain("KeyF13"); // catch-all sentinel keys absent
  });

  // ── Deck branch ───────────────────────────────────────────────────────
  // On Deck the IP path is bypassed entirely in favour of the hidraw
  // watcher (see issue #86). These tests cover the Deck-side public API:
  // status reports a synthetic device with the hardcoded button list,
  // setWakeButton accepts deck:* identifiers and persists them via
  // plugin-storage, no busctl / fs side effects happen.

  function deckDmi(): void {
    fsSpies[3].mockImplementation(async (p: unknown) => {
      if (String(p).includes("product_name")) return "Jupiter";
      if (String(p).includes("sys_vendor")) return "Valve";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  }

  it("getWakeStatus on Deck reports a synthetic device with the hardcoded button list", async () => {
    deckDmi();
    const { stub, calls } = makeSpawnStub([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

    const status = await getWakeStatus();
    expect(status.isDeck).toBe(true);
    expect(status.ipActive).toBe(true); // semantic = "picker can act"
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0].name).toBe("Steam Deck Controller");
    const names = status.devices[0].buttons.map((b) => b.name).sort();
    expect(names).toContain("Steam");
    expect(names).toContain("Qam");
    expect(names).toContain("L4");
    // All buttons are flagged as recommended on Deck.
    expect(status.devices[0].buttons.every((b) => b.recommended)).toBe(true);
    // No busctl/systemctl/udevadm — the Deck path is pure.
    expect(calls).toHaveLength(0);
  });

  it("setWakeButton on Deck persists a deck:* binding without touching IP", async () => {
    deckDmi();
    const { stub, calls } = makeSpawnStub([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

    const r = await setWakeButton("deck:Steam");
    expect(r.ok).toBe(true);

    const persisted = storage.get("input-plumber") as {
      wake?: { selectedRaw?: string; deviceName?: string };
    };
    expect(persisted.wake?.selectedRaw).toBe("deck:Steam");
    expect(persisted.wake?.deviceName).toBe("Steam Deck Controller");
    // No profile file written, no busctl/systemctl/udevadm.
    expect(writtenFiles.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("setWakeButton on Deck rejects unknown identifiers", async () => {
    deckDmi();
    const { stub } = makeSpawnStub([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

    const r = await setWakeButton("Gamepad:Button:RightPaddle1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Unknown Deck button identifier");
  });

  it("clearWakeButton on Deck wipes the persisted binding (no IP calls)", async () => {
    deckDmi();
    storage.set("input-plumber", {
      wake: { selectedRaw: "deck:Steam", deviceName: "Steam Deck Controller" },
    });
    const { stub, calls } = makeSpawnStub([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(stub as any);

    const r = await clearWakeButton();
    expect(r.ok).toBe(true);
    const persisted = storage.get("input-plumber") as {
      wake?: { selectedRaw: string | null };
    };
    expect(persisted.wake?.selectedRaw).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

// reloadPersistedProfileWithRetry drives the boot reload with retries. It
// takes injectable `reload` + `wait` so we exercise the loop directly —
// no DBus, no real 2s sleeps.
describe("reloadPersistedProfileWithRetry", () => {
  const noWait = async () => {};

  it("calls reload once and returns when it succeeds first try", async () => {
    let calls = 0;
    const res = await reloadPersistedProfileWithRetry({
      wait: noWait,
      reload: async () => {
        calls++;
        return { ok: true };
      },
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not wait when nothing is bound (immediate ok)", async () => {
    let waitCount = 0;
    const res = await reloadPersistedProfileWithRetry({
      reload: async () => ({ ok: true }),
      wait: async () => {
        waitCount++;
      },
    });
    expect(res.ok).toBe(true);
    expect(waitCount).toBe(0);
  });

  it("retries a transient failure, then succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    const retries: Array<{ attempt: number; error: string }> = [];
    const res = await reloadPersistedProfileWithRetry({
      delayMs: 2000,
      wait: async (ms) => {
        waits.push(ms);
      },
      onRetry: (attempt, error) => retries.push({ attempt, error }),
      reload: async () => {
        calls++;
        return calls < 3
          ? { ok: false, error: "Bound device not connected; wake button not reloaded." }
          : { ok: true };
      },
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(3); // failed twice, succeeded on the third
    expect(waits).toEqual([2000, 2000]); // one wait after each failure
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("gives up after `attempts` and returns the last failure (no trailing wait)", async () => {
    let calls = 0;
    let waitCount = 0;
    const res = await reloadPersistedProfileWithRetry({
      attempts: 5,
      wait: async () => {
        waitCount++;
      },
      reload: async () => {
        calls++;
        return { ok: false, error: "still not ready" };
      },
    });
    expect(res).toEqual({ ok: false, error: "still not ready" });
    expect(calls).toBe(5); // exactly `attempts` tries
    expect(waitCount).toBe(4); // no sleep after the final attempt
  });

  it("honors a custom attempts count", async () => {
    let calls = 0;
    const res = await reloadPersistedProfileWithRetry({
      attempts: 2,
      wait: noWait,
      reload: async () => {
        calls++;
        return { ok: false, error: "nope" };
      },
    });
    expect(res.ok).toBe(false);
    expect(calls).toBe(2);
  });
});
