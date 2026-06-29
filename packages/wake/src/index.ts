/**
 * Wake listener — fires a callback when the system resumes from sleep.
 *
 * Tails logind's `PrepareForSleep` D-Bus signal via `dbus-monitor` on the
 * system bus. The signal carries a boolean: `true` is emitted just before
 * suspend, `false` once the system has resumed. Most callers only care about
 * resume (`false`): that's when post-sleep hardware fixes need re-applying
 * (the Apex's xHCI controller dying, WiFi power-save re-enabling, …).
 *
 * logind is present identically on SteamOS, Bazzite and CachyOS, so this is
 * the portable cross-distro wake hook — there's no systemd-sleep script to
 * install, nothing to clean up on disable, and it survives suspend because
 * the backend that owns it runs as a root system service.
 *
 * The subprocess and the line parsing are dependency-injected (`WakeDeps`)
 * so the orchestration is unit-testable without a real D-Bus. Wire `spawn`
 * to `@loadout/exec`'s `runStreaming` in production; note the consuming
 * plugin must declare the `dbus-monitor` command permission in its manifest.
 */

/** The minimal handle we need on the spawned monitor: a way to kill it. */
export interface WakeProc {
  kill: () => void;
}

export interface WakeDeps {
  /**
   * Start the streaming monitor. Wired to `@loadout/exec`'s `runStreaming`
   * in prod: it should deliver each output line to `onLine` and hand the
   * spawned process to `onSpawn` so we can kill it on stop.
   */
  spawn: (args: {
    cmd: string[];
    onLine: (line: string) => void;
    onSpawn: (proc: WakeProc) => void;
  }) => void;
  /** Optional progress sink. */
  log?: (message: string) => void;
}

/** Watch only the PrepareForSleep signal on the system bus. */
export const DBUS_MONITOR_CMD = [
  "dbus-monitor",
  "--system",
  "type='signal',interface='org.freedesktop.login1.Manager',member='PrepareForSleep'",
] as const;

export interface StopHandle {
  stop: () => void;
}

/**
 * Stateful parser for `dbus-monitor` output. dbus-monitor prints a signal
 * header line followed by the argument on the next line, e.g.:
 *
 *   signal time=… interface=org.freedesktop.login1.Manager … member=PrepareForSleep
 *      boolean false
 *
 * We arm on a header line whose member is `PrepareForSleep`, then read the
 * following `boolean <true|false>` line. `false` = resume, `true` = suspend.
 * Returns `"resume"`, `"suspend"`, or `null` for any line that isn't the
 * boolean we're waiting on. The monitor is filtered to PrepareForSleep, so
 * no other signal headers interleave.
 */
export function makePrepareForSleepParser(): (line: string) => "resume" | "suspend" | null {
  let armed = false;
  return (line: string) => {
    if (line.includes("member=PrepareForSleep")) {
      armed = true;
      return null;
    }
    if (!armed) return null;
    const m = /boolean\s+(true|false)/.exec(line);
    if (!m) return null; // blank/whitespace line between header and arg — keep waiting
    armed = false;
    return m[1] === "false" ? "resume" : "suspend";
  };
}

/**
 * Start listening for resume events. Calls `onResume` once per resume.
 * Returns a handle whose `stop()` kills the monitor (and pre-empts a kill
 * if `stop()` races ahead of the async spawn).
 */
export function startWakeListener(deps: WakeDeps, onResume: () => void): StopHandle {
  const parse = makePrepareForSleepParser();
  let proc: WakeProc | null = null;
  let stopped = false;

  deps.spawn({
    cmd: [...DBUS_MONITOR_CMD],
    onSpawn: (p) => {
      proc = p;
      if (stopped) p.kill(); // stop() arrived before the process existed
    },
    onLine: (line) => {
      if (parse(line) === "resume") {
        deps.log?.("resume detected");
        onResume();
      }
    },
  });

  return {
    stop: () => {
      stopped = true;
      proc?.kill();
      proc = null;
    },
  };
}
