import { runFull, runStreaming } from "@loadout/exec";
import type {
  LegendaryListEntry,
  LegendaryInstalledEntry,
  LegendaryInfoEntry,
} from "./types";
import type { PipelineEmit } from "../../types";

/** Login page legendary opens for OAuth — surfaced to the UI as the URL the user has to visit. */
export const EPIC_LOGIN_URL = "https://legendary.gl/epiclogin";

/** Progress regex — legendary's install stream prints lines like
 *  `[DLManager] INFO: = Progress: 12.34%, ETA: 00:05:12` and
 *  `Progress: 12.3% (123/1000 MiB)` depending on version. Both match. */
const PROGRESS_RE = /Progress:\s*([\d.]+)\s*%/i;

/**
 * Parse a single line of `legendary install` stdout. Returns the
 * percent if the line is a progress marker, else null.
 */
export function parseProgressLine(line: string): number | null {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/** Parse the URL legendary prints during `auth --import`. We fall
 *  back to the canonical login URL if we can't find it in stdout. */
export function parseAuthUrl(stdout: string): string {
  const m = stdout.match(/https?:\/\/\S*epiclogin\S*/i);
  return m ? m[0] : EPIC_LOGIN_URL;
}

/**
 * Epic AppName format — alphanumerics + optional `_` / `-`. Real
 * library entries are 32-char hex IDs, but legendary also accepts
 * human-readable mirror names like `Fortnite`. Anything outside
 * this pattern is suspect: most worryingly an attacker-controlled
 * `.mancpn` file in a scan path could plant `AppName` values like
 * `--config-file=/path/to/evil.toml` that we'd shovel straight
 * into legendary's argv. Argv (not shell) means no command
 * injection, but legendary parses leading `--…` as flags.
 */
const APP_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const APP_NAME_MAX_LEN = 128;

function assertAppName(appName: string): void {
  if (typeof appName !== "string") {
    throw new Error(`Invalid AppName: ${JSON.stringify(appName)}. Must be a string.`);
  }
  if (appName.length === 0 || appName.length > APP_NAME_MAX_LEN) {
    throw new Error(
      `Invalid AppName: length ${appName.length}, expected 1..${APP_NAME_MAX_LEN}.`,
    );
  }
  if (!APP_NAME_RE.test(appName)) {
    throw new Error(
      `Invalid AppName: ${JSON.stringify(appName)}. Expected alphanumerics, underscores or dashes (must start with alnum/underscore).`,
    );
  }
}

/** Wraps a legendary subprocess. The binary path is resolved by the
 *  caller and threaded through every call. */
export class Legendary {
  constructor(private readonly binary: string) {}

  async version(): Promise<string> {
    const { stdout } = await runFull([this.binary, "--version"], {
      timeoutMs: 10_000,
    });
    return stdout.trim();
  }

  /**
   * Probe auth state. `legendary status --offline --json` reports
   * `account` when authed. `legendary auth --check` exits 0 when a
   * session token exists. We try the cheap check first.
   */
  async authStatus(): Promise<"unknown" | "authed" | "expired"> {
    const probe = await runFull([this.binary, "status", "--offline"], {
      timeoutMs: 10_000,
    });
    if (probe.exitCode !== 0) return "unknown";
    // legendary prints "Epic account: <name>" when authed, "Not logged in" otherwise.
    if (/Epic account/i.test(probe.stdout)) return "authed";
    if (/Not logged in|No account/i.test(probe.stdout)) return "unknown";
    // Tokens can be present-but-expired; legendary surfaces this as a
    // warning. Treat anything that mentions expiry as such.
    if (/expired|refresh failed/i.test(probe.stdout + probe.stderr)) return "expired";
    return "unknown";
  }

  /**
   * Hand back the URL the user has to open. Older legendary builds
   * accept a manual `--code` exchange flow — the URL itself is stable
   * (https://legendary.gl/epiclogin). We don't actually start the
   * `legendary auth --import` subprocess here because it would
   * hang on interactive stdin in non-interactive contexts; the UI
   * just hands the user the URL.
   */
  async startAuth(): Promise<{ url: string }> {
    return { url: EPIC_LOGIN_URL };
  }

  /**
   * Exchange the auth code the user pasted from the redirect URL.
   *
   * Caveat: legendary 0.20.x only accepts the code via `--code <hex>`
   * on argv. That puts the code in `/proc/<pid>/cmdline`, visible
   * to any other process running as the same user for the lifetime
   * of the subprocess (3-30 s). The code is single-use and expires
   * in minutes anyway, so the practical risk is bounded — but it's
   * worth noting that *any* local process running as this user can
   * already do worse things than steal a one-time auth code (read
   * `~/.config/legendary/user.json` directly, e.g.), so this isn't
   * the marginal exposure of concern.
   *
   * Upstream doesn't currently expose a stdin / file / env variant.
   * If a future legendary release adds one we should switch.
   */
  async completeAuth(code: string): Promise<void> {
    const trimmed = code.trim();
    const { exitCode, stderr } = await runFull(
      [this.binary, "auth", "--code", trimmed],
      { timeoutMs: 30_000 },
    );
    if (exitCode !== 0) {
      // Scrub the auth code itself from any echoed-back stderr —
      // legendary tends to log the value it received on failure, and
      // the error message flows up to console / journal. The code
      // is single-use and short-lived (Epic auth codes expire in
      // minutes), but logging it is still poor hygiene.
      const scrubbed = trimmed
        ? stderr.split(trimmed).join("<redacted>")
        : stderr;
      throw new Error(
        `legendary auth failed (exit ${exitCode}): ${scrubbed.trim() || "no output"}`,
      );
    }
  }

  async signOut(): Promise<void> {
    await runFull([this.binary, "auth", "--delete"], { timeoutMs: 10_000 });
  }

  /** Full library, JSON. May take a few seconds on first call. */
  async listLibrary(): Promise<LegendaryListEntry[]> {
    const { stdout, stderr, exitCode } = await runFull(
      [this.binary, "list", "--json"],
      { timeoutMs: 60_000 },
    );
    if (exitCode !== 0) {
      throw new Error(
        `legendary list failed (exit ${exitCode}): ${stderr.trim() || "no output"}`,
      );
    }
    return safeJsonArray<LegendaryListEntry>(stdout);
  }

  /**
   * Per-title detail. Slower than `listInstalled` but returns the
   * canonical executable + launch parameters legendary's manifest
   * captured at install time — required for building a working
   * Steam shortcut that doesn't go through `legendary launch`.
   */
  async info(appName: string): Promise<LegendaryInfoEntry | null> {
    assertAppName(appName);
    const { stdout, exitCode } = await runFull(
      [this.binary, "info", appName, "--json"],
      { timeoutMs: 30_000 },
    );
    if (exitCode !== 0) return null;
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as LegendaryInfoEntry;
    } catch {
      const start = stdout.indexOf("{");
      const end = stdout.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(stdout.slice(start, end + 1)) as LegendaryInfoEntry;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  /** Currently-installed titles, JSON. */
  async listInstalled(): Promise<LegendaryInstalledEntry[]> {
    const { stdout, stderr, exitCode } = await runFull(
      [this.binary, "list-installed", "--json"],
      { timeoutMs: 30_000 },
    );
    if (exitCode !== 0) {
      throw new Error(
        `legendary list-installed failed (exit ${exitCode}): ${stderr.trim() || "no output"}`,
      );
    }
    return safeJsonArray<LegendaryInstalledEntry>(stdout);
  }

  /**
   * Stream an install. Calls `emit` for each progress line. `onSpawn`
   * hands the live subprocess to the caller so cancel-by-SIGTERM is
   * possible from outside; the driver uses this to expose
   * `cancelInstall` upward.
   *
   * A SIGTERMed legendary exits non-zero (signal-killed), so this
   * function throws on cancel just like any other failure. The
   * caller distinguishes cancel from genuine failure by tracking
   * whether it asked for the kill itself.
   */
  async install(
    appName: string,
    basePath: string,
    emit: PipelineEmit,
    opts: {
      id?: string;
      onSpawn?: (proc: ReturnType<typeof Bun.spawn>) => void;
    } = {},
  ): Promise<void> {
    assertAppName(appName);
    const id = opts.id ?? `epic:install:${appName}`;
    emit({ kind: "progress", id, percent: 0, label: `Starting install` });
    const { exitCode } = await runStreaming(
      [this.binary, "install", appName, "--base-path", basePath, "--yes"],
      {
        timeoutMs: 0,
        onSpawn: opts.onSpawn,
        onLine: (line) => {
          const pct = parseProgressLine(line);
          if (pct !== null) emit({ kind: "progress", id, percent: pct });
        },
      },
    );
    if (exitCode !== 0) {
      throw new Error(`legendary install failed (exit ${exitCode}) for ${appName}`);
    }
    emit({ kind: "complete", id });
  }

  async uninstall(appName: string): Promise<void> {
    assertAppName(appName);
    const { exitCode, stderr } = await runFull(
      [this.binary, "uninstall", appName, "--yes"],
      { timeoutMs: 60_000 },
    );
    if (exitCode !== 0) {
      throw new Error(
        `legendary uninstall failed (exit ${exitCode}): ${stderr.trim() || "no output"}`,
      );
    }
  }

  /** Import an existing on-disk install into legendary's DB. */
  async importInstall(appName: string, dir: string): Promise<void> {
    assertAppName(appName);
    const { exitCode, stderr } = await runFull(
      [this.binary, "import", appName, dir],
      { timeoutMs: 60_000 },
    );
    if (exitCode !== 0) {
      throw new Error(
        `legendary import failed (exit ${exitCode}): ${stderr.trim() || "no output"}`,
      );
    }
  }
}

/** Exported for spec coverage of the validator itself. */
export const _appNameRegex = APP_NAME_RE;

function safeJsonArray<T>(stdout: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    // Some legendary versions intermix log lines and JSON. Grab the
    // first JSON array we can find as a defensive fallback.
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stdout.slice(start, end + 1)) as T[];
      } catch {
        // fall through
      }
    }
    return [];
  }
}
