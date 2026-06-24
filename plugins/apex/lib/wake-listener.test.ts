import { describe, it, expect } from "bun:test";
import {
  makePrepareForSleepParser,
  startWakeListener,
  DBUS_MONITOR_CMD,
  type WakeDeps,
  type WakeProc,
} from "./wake-listener";

/**
 * Wake-listener tests. The dbus-monitor subprocess is injected, so these
 * are pure unit tests of the PrepareForSleep parser and the start/stop
 * orchestration — no D-Bus, no root.
 */

// A realistic dbus-monitor signal header for PrepareForSleep.
const HEADER =
  "signal time=123.4 sender=:1.3 -> destination=(null destination) serial=42 " +
  "path=/org/freedesktop/login1; interface=org.freedesktop.login1.Manager; member=PrepareForSleep";

describe("makePrepareForSleepParser", () => {
  it("returns resume on header followed by boolean false", () => {
    const parse = makePrepareForSleepParser();
    expect(parse(HEADER)).toBeNull();
    expect(parse("   boolean false")).toBe("resume");
  });

  it("returns suspend on header followed by boolean true", () => {
    const parse = makePrepareForSleepParser();
    expect(parse(HEADER)).toBeNull();
    expect(parse("   boolean true")).toBe("suspend");
  });

  it("tolerates a blank line between header and the boolean arg", () => {
    const parse = makePrepareForSleepParser();
    parse(HEADER);
    expect(parse("")).toBeNull();
    expect(parse("   boolean false")).toBe("resume");
  });

  it("ignores a boolean line that wasn't preceded by a PrepareForSleep header", () => {
    const parse = makePrepareForSleepParser();
    expect(parse("   boolean false")).toBeNull();
  });

  it("re-arms for each subsequent signal (suspend then resume)", () => {
    const parse = makePrepareForSleepParser();
    parse(HEADER);
    expect(parse("   boolean true")).toBe("suspend");
    parse(HEADER);
    expect(parse("   boolean false")).toBe("resume");
  });
});

/** A fake monitor that records its command and lets the test feed lines. */
function makeFakeDeps(): {
  deps: WakeDeps;
  emit: (line: string) => void;
  killed: () => number;
  cmd: () => string[] | null;
} {
  let onLine: ((line: string) => void) | null = null;
  let kills = 0;
  let cmd: string[] | null = null;
  const deps: WakeDeps = {
    spawn: (args) => {
      cmd = args.cmd;
      onLine = args.onLine;
      const proc: WakeProc = { kill: () => void kills++ };
      args.onSpawn(proc);
    },
  };
  return {
    deps,
    emit: (line) => onLine?.(line),
    killed: () => kills,
    cmd: () => cmd,
  };
}

describe("startWakeListener", () => {
  it("spawns the filtered system-bus PrepareForSleep monitor", () => {
    const f = makeFakeDeps();
    startWakeListener(f.deps, () => {});
    expect(f.cmd()).toEqual([...DBUS_MONITOR_CMD]);
  });

  it("fires onResume once per resume, never on suspend", () => {
    const f = makeFakeDeps();
    let resumes = 0;
    startWakeListener(f.deps, () => void resumes++);

    f.emit(HEADER);
    f.emit("   boolean true"); // suspend — no callback
    expect(resumes).toBe(0);

    f.emit(HEADER);
    f.emit("   boolean false"); // resume
    expect(resumes).toBe(1);
  });

  it("stop() kills the monitor process", () => {
    const f = makeFakeDeps();
    const handle = startWakeListener(f.deps, () => {});
    expect(f.killed()).toBe(0);
    handle.stop();
    expect(f.killed()).toBe(1);
  });

  it("stop() before the process spawns still kills it once it arrives", () => {
    // Defer onSpawn to model the async spawn racing behind a fast stop().
    let deliver: (() => void) | null = null;
    let kills = 0;
    const deps: WakeDeps = {
      spawn: (args) => {
        deliver = () => args.onSpawn({ kill: () => void kills++ });
      },
    };
    const handle = startWakeListener(deps, () => {});
    handle.stop(); // stop before the process is delivered
    deliver?.(); // now the process arrives
    expect(kills).toBe(1);
  });
});
