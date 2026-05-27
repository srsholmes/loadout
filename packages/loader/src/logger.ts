/**
 * Loadout Logger
 *
 * Writes timestamped logs to both stdout and a log file.
 * Log file: ~/.config/loadout/logs/loadout.log
 *
 * Plugins get scoped loggers via createPluginLogger(pluginId).
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".config", "loadout", "logs");
const LOG_FILE = join(LOG_DIR, "loadout.log");

// Ensure log directory exists on import
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // best effort
}

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, tag: string, message: string): string {
  return `${timestamp()} [${level}] [${tag}] ${message}`;
}

function writeLog(line: string): void {
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // log file not writable — still output to console
  }
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

function createLogger(tag: string): Logger {
  return {
    info(message: string) {
      const line = formatMessage("INFO", tag, message);
      console.log(line);
      writeLog(line);
    },
    warn(message: string) {
      const line = formatMessage("WARN", tag, message);
      console.warn(line);
      writeLog(line);
    },
    error(message: string) {
      const line = formatMessage("ERROR", tag, message);
      console.error(line);
      writeLog(line);
    },
    debug(message: string) {
      const line = formatMessage("DEBUG", tag, message);
      console.log(line);
      writeLog(line);
    },
  };
}

/** Main server logger */
export const log = createLogger("server");

/** Create a scoped logger for a plugin */
export function createPluginLogger(pluginId: string): Logger {
  return createLogger(`plugin:${pluginId}`);
}

/** Log file path (for display to user) */
export const LOG_PATH = LOG_FILE;
