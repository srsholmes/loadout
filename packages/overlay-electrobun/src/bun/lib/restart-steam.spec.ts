import { describe, expect, it, mock } from "bun:test";
import { runRestartSteamLadder } from "./restart-steam";

/**
 * Audit B-022: when `spawn(["steam", "-shutdown"])` throws synchronously,
 * the old ladder still slept 3 s for "graceful shutdown to flush" even
 * though Steam never got the shutdown signal. Verify the ladder now
 * skips the wait when spawn fails.
 */
describe("runRestartSteamLadder (B-022)", () => {
  function makeDelay() {
    const calls: number[] = [];
    const delay = mock(async (ms: number) => {
      calls.push(ms);
    });
    return { delay, calls };
  }

  it("skips the 3s graceful-wait when spawn throws synchronously", async () => {
    const { delay, calls } = makeDelay();
    // Steam dies immediately after SIGTERM in this scenario.
    let alive = true;
    let sigterms = 0;
    const steps = await runRestartSteamLadder({
      trySpawnShutdown: () => false, // spawn threw
      isPidAlive: () => alive,
      terminate: () => {
        sigterms++;
        alive = false;
      },
      kill: () => {
        /* unreached */
      },
      delay,
    });

    expect(steps[0]).toBe("skip-graceful");
    // No 3000ms-worth of 100ms sleeps were ever issued for the graceful
    // window (we may still have a few inside sigterm-wait but those
    // exit on the first poll because terminate() already cleared alive).
    expect(calls.filter((ms) => ms === 100).length).toBeLessThanOrEqual(1);
    expect(sigterms).toBe(1);
    expect(steps).toContain("sigterm");
    expect(steps[steps.length - 1]).toBe("done");
  });

  it("runs the full graceful-wait when spawn succeeds", async () => {
    const { delay } = makeDelay();
    // Steam survives the whole graceful window, then dies on SIGTERM.
    let alive = true;
    const steps = await runRestartSteamLadder({
      trySpawnShutdown: () => true,
      isPidAlive: () => alive,
      terminate: () => {
        alive = false;
      },
      kill: () => {
        /* unreached */
      },
      delay,
    });

    expect(steps[0]).toBe("graceful-wait");
    expect(steps).toContain("sigterm");
    expect(steps[steps.length - 1]).toBe("done");
  });

  it("exits early on graceful path when Steam dies before the deadline", async () => {
    const { delay } = makeDelay();
    let alive = true;
    let polls = 0;
    const steps = await runRestartSteamLadder({
      trySpawnShutdown: () => true,
      isPidAlive: () => {
        polls++;
        if (polls > 3) alive = false; // dies after the third poll
        return alive;
      },
      terminate: () => {
        /* never reached */
      },
      kill: () => {
        /* never reached */
      },
      delay,
    });

    expect(steps).toEqual(["graceful-wait", "done"]);
  });
});
