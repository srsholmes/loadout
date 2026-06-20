// "Export logs" RPC (issue #130). Collects the overlay UI's captured
// console output (sent over from the webview) and the backend server's
// on-disk log file, formats them into one human-readable report, and
// writes it to the user's Downloads folder with a timestamped filename
// so they can attach it to a bug report.
//
// Extracted from rpc-handlers.ts so the formatting + path logic is
// unit-testable without booting the overlay or its RPC transport.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Matches @loadout/loadout-server's logger LOG_PATH. The overlay doesn't
// depend on that package, so we recompute the path rather than import it
// across the app boundary — both derive it from the same convention.
const SERVER_LOG_PATH = join(
  homedir(),
  ".config",
  "loadout",
  "logs",
  "loadout.log",
);

const HR =
  "--------------------------------------------------------------------------------";

export interface ExportLogsResult {
  success: boolean;
  error?: string;
  /** Absolute path of the written file, on success. */
  path?: string;
}

/** Filesystem-safe local timestamp: `2026-06-20_14-32-07`. Colons and
 *  dots aren't portable in filenames, so we avoid ISO's separators. */
export function timestampForFilename(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

/** Pull the `uiLogs` string out of an untrusted CEF RPC payload. Returns
 *  "" for any malformed shape so a bad payload still produces a (server-
 *  only) export rather than throwing across IPC. */
export function extractUiLogs(params: unknown): string {
  if (typeof params !== "object" || params === null) return "";
  const value = (params as { uiLogs?: unknown }).uiLogs;
  return typeof value === "string" ? value : "";
}

async function readServerLog(): Promise<string> {
  try {
    return await readFile(SERVER_LOG_PATH, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `(could not read server log at ${SERVER_LOG_PATH}: ${msg})`;
  }
}

/** Assemble the final report. Sectioned with clear headers so a user (or
 *  whoever they send it to) can read it top to bottom. */
export function buildReport(opts: {
  uiLogs: string;
  serverLogs: string;
  generatedAt: Date;
}): string {
  const { uiLogs, serverLogs, generatedAt } = opts;
  const ui = uiLogs.trim() || "(no UI logs captured this session)";
  const server = serverLogs.trim() || "(server log was empty)";

  return [
    HR,
    " Loadout diagnostic log export",
    ` Generated:  ${generatedAt.toISOString()}`,
    ` Platform:   ${process.platform} ${process.arch}`,
    HR,
    "",
    "Logs from the Loadout overlay UI and the backend server, collected to",
    "help diagnose issues. UI logs come first, then the server log file.",
    "",
    HR,
    " UI LOGS  (overlay webview console)",
    HR,
    "",
    ui,
    "",
    HR,
    ` SERVER LOGS  (${SERVER_LOG_PATH})`,
    HR,
    "",
    server,
    "",
  ].join("\n");
}

/**
 * Write the combined UI + server log report to ~/Downloads with a
 * timestamped filename. Returns the path on success, or a structured
 * error. Never throws — the RPC layer turns the envelope into a button
 * state in Settings.
 */
export async function exportLogs(params?: unknown): Promise<ExportLogsResult> {
  try {
    const now = new Date();
    const report = buildReport({
      uiLogs: extractUiLogs(params),
      serverLogs: await readServerLog(),
      generatedAt: now,
    });

    const downloadsDir = join(homedir(), "Downloads");
    if (!existsSync(downloadsDir)) {
      await mkdir(downloadsDir, { recursive: true });
    }

    const path = join(downloadsDir, `loadout-logs-${timestampForFilename(now)}.txt`);
    await writeFile(path, report, "utf8");
    console.log(`[overlay] exported logs to ${path}`);
    return { success: true, path };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[overlay] exportLogs threw:", err);
    return { success: false, error: msg };
  }
}
