// In-memory ring buffer for the overlay webview's console output.
//
// The webview's logs only ever go to the CEF dev console — nothing
// persists them. The Settings "Export logs" action (issue #130) needs
// the UI side's logs alongside the server log file, so we patch the
// console methods once at boot to mirror every call into a bounded
// buffer. The originals still fire, so DevTools / stdout are unchanged.
//
// Bounded to MAX_ENTRIES so a long session (or a chatty plugin) can't
// grow this without limit; oldest entries fall off the front.

const MAX_ENTRIES = 2000;

type LogLevel = "LOG" | "INFO" | "WARN" | "ERROR" | "DEBUG";

interface LogEntry {
  ts: number;
  level: LogLevel;
  text: string;
}

const buffer: LogEntry[] = [];
let installed = false;

/** Stringify one console argument for the flat log file. Strings pass
 *  through; Errors include their stack; everything else is JSON with a
 *  circular-reference guard, falling back to String() on failure. */
function serializeArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (arg === undefined) return "undefined";
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(arg, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    return json ?? String(arg);
  } catch {
    return String(arg);
  }
}

function record(level: LogLevel, args: unknown[]): void {
  const text = args.map(serializeArg).join(" ");
  buffer.push({ ts: Date.now(), level, text });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

/**
 * Patch console.{log,info,warn,error,debug} so every call is mirrored
 * into the buffer. Idempotent — calling twice is a no-op. Call as early
 * as possible at boot so the most output is captured.
 */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;

  const levels: Array<["log" | "info" | "warn" | "error" | "debug", LogLevel]> = [
    ["log", "LOG"],
    ["info", "INFO"],
    ["warn", "WARN"],
    ["error", "ERROR"],
    ["debug", "DEBUG"],
  ];

  // Index the console as a loose record so we can swap methods in place;
  // the typed Console interface marks them as read-only.
  const con = console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const [method, level] of levels) {
    const original = con[method];
    if (typeof original !== "function") continue;
    con[method] = (...args: unknown[]) => {
      try {
        record(level, args);
      } catch {
        // never let capture break the real console call
      }
      original.apply(console, args);
    };
  }
}

/**
 * Render the captured buffer as a flat, timestamped log block. One line
 * per entry: `2026-06-20T14:32:07.123Z [WARN] message`. Multi-line
 * entries (stack traces) keep their newlines.
 */
export function getCapturedLogs(): string {
  if (buffer.length === 0) return "(no UI logs captured this session)";
  return buffer
    .map((e) => `${new Date(e.ts).toISOString()} [${e.level}] ${e.text}`)
    .join("\n");
}

/** Test seam — drop everything captured so far. */
export function clearCapturedLogs(): void {
  buffer.length = 0;
}
