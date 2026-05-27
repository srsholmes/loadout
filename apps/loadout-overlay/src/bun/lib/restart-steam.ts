/**
 * The shutdown ladder for the `restartSteam` RPC handler.
 *
 * Original behaviour (Audit B-022): even when `spawn(["steam",
 * "-shutdown"])` threw synchronously (PATH issue, sandbox block, etc.),
 * the ladder still waited 3 s for the "graceful" deadline — pointless,
 * because Steam never received the shutdown signal in the first place.
 *
 * Fixed behaviour: if the graceful CLI didn't actually launch, skip the
 * 3 s wait and go straight to SIGTERM.
 *
 * Extracted into a pure function so the timing tradeoff is testable
 * without a real Steam process or Bun.spawn.
 */

export interface RestartSteamDeps {
  /** Try to spawn `steam -shutdown`. Returns true if launched, false if
   *  `spawn` threw synchronously (PATH miss, sandbox refusal, etc.). */
  trySpawnShutdown: () => boolean;
  /** True if the process with the captured PID is still alive. */
  isPidAlive: () => boolean;
  /** Send SIGTERM to the captured PID. */
  terminate: () => void;
  /** Send SIGKILL to the captured PID. */
  kill: () => void;
  /** Async delay primitive — injected so tests can fast-forward. */
  delay: (ms: number) => Promise<void>;
}

export type LadderStep =
  | "graceful-wait"
  | "skip-graceful"
  | "sigterm"
  | "sigterm-wait"
  | "sigkill"
  | "done";

/**
 * Run the ladder and return the sequence of steps taken. Tests use the
 * returned list to assert "graceful-wait was skipped when spawn failed".
 */
export async function runRestartSteamLadder(
  deps: RestartSteamDeps,
): Promise<LadderStep[]> {
  const steps: LadderStep[] = [];
  const gracefulSent = deps.trySpawnShutdown();
  if (gracefulSent) {
    steps.push("graceful-wait");
    // Poll up to 3s, 100ms tick.
    for (let elapsed = 0; elapsed < 3000; elapsed += 100) {
      if (!deps.isPidAlive()) {
        steps.push("done");
        return steps;
      }
      await deps.delay(100);
    }
  } else {
    // Audit B-022: spawn threw → no point waiting 3 s for a flush that
    // never started.
    steps.push("skip-graceful");
  }
  if (!deps.isPidAlive()) {
    steps.push("done");
    return steps;
  }
  steps.push("sigterm");
  deps.terminate();
  steps.push("sigterm-wait");
  for (let elapsed = 0; elapsed < 2000; elapsed += 100) {
    if (!deps.isPidAlive()) {
      steps.push("done");
      return steps;
    }
    await deps.delay(100);
  }
  if (deps.isPidAlive()) {
    steps.push("sigkill");
    deps.kill();
  }
  steps.push("done");
  return steps;
}
