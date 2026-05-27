/**
 * Error reporting utility for the overlay app.
 *
 * Captures plugin errors with full context (stack trace, plugin info,
 * timestamps, system info) and provides helpers to copy to clipboard
 * or save to ~/Downloads as a text file for Discord posting.
 */

import { authHeaders } from "../lib/backend";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ErrorReport {
  /** Plugin that triggered the error */
  pluginName: string;
  pluginId: string;
  /** Error details */
  errorMessage: string;
  stackTrace: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** System / build info */
  steamLoaderVersion: string;
  userAgent: string;
  platform: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = "0.1.0-alpha";

// ---------------------------------------------------------------------------
// Report creation
// ---------------------------------------------------------------------------

/**
 * Build a structured error report from an Error and plugin metadata.
 */
export function createErrorReport(
  pluginId: string,
  pluginName: string,
  error: Error,
): ErrorReport {
  return {
    pluginName,
    pluginId,
    errorMessage: error.message,
    stackTrace: error.stack ?? "No stack trace available",
    timestamp: new Date().toISOString(),
    steamLoaderVersion: VERSION,
    userAgent: navigator.userAgent,
    platform: navigator.platform ?? "unknown",
  };
}

/**
 * Serialize an ErrorReport into a human-readable text block
 * suitable for pasting into Discord or saving as a file.
 */
export function formatErrorReport(report: ErrorReport): string {
  const divider = "=".repeat(60);
  return [
    divider,
    "  Loadout - Error Report",
    divider,
    "",
    `Plugin:    ${report.pluginName} (${report.pluginId})`,
    `Timestamp: ${report.timestamp}`,
    `Version:   ${report.steamLoaderVersion}`,
    `Platform:  ${report.platform}`,
    `UA:        ${report.userAgent}`,
    "",
    "--- Error Message ---",
    report.errorMessage,
    "",
    "--- Stack Trace ---",
    report.stackTrace,
    "",
    divider,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Copy the formatted error report to the system clipboard.
 * Returns true on success, false on failure.
 */
export async function copyErrorToClipboard(report: ErrorReport): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(formatErrorReport(report));
    return true;
  } catch {
    // Clipboard API may be unavailable in WebKitGTK — try fallback
    try {
      const textarea = document.createElement("textarea");
      textarea.value = formatErrorReport(report);
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Save the error report to ~/Downloads via the server API.
 * The server writes the file to the user's Downloads directory.
 * Returns the filename on success, or null on failure.
 */
export async function saveErrorToDownloads(report: ErrorReport): Promise<string | null> {
  const timestamp = report.timestamp.replace(/[:.]/g, "-");
  const filename = `loadout-error-${report.pluginId}-${timestamp}.txt`;

  try {
    const res = await fetch("/api/save-error", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({
        filename,
        content: formatErrorReport(report),
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return filename;
  } catch (err) {
    console.error("[loadout] Failed to save error report:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Global error capture
// ---------------------------------------------------------------------------

/** Registered listeners for global errors */
type ErrorListener = (report: ErrorReport) => void;
const listeners: Set<ErrorListener> = new Set();

/**
 * Subscribe to global (uncaught) errors. Returns an unsubscribe function.
 */
export function onGlobalError(listener: ErrorListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(report: ErrorReport) {
  for (const listener of listeners) {
    try {
      listener(report);
    } catch {
      // Don't let a listener error crash the error reporter
    }
  }
}

/**
 * Install global error handlers (window.onerror, unhandledrejection).
 * Call once at app startup. Returns a cleanup function.
 */
export function installGlobalErrorHandlers(): () => void {
  function handleError(event: ErrorEvent) {
    const report = createErrorReport(
      "global",
      "Uncaught Error",
      event.error instanceof Error
        ? event.error
        : new Error(event.message || "Unknown error"),
    );
    notifyListeners(report);
  }

  function handleRejection(event: PromiseRejectionEvent) {
    const reason = event.reason;
    const report = createErrorReport(
      "global",
      "Unhandled Promise Rejection",
      reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : "Unknown rejection"),
    );
    notifyListeners(report);
  }

  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleRejection);

  return () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleRejection);
  };
}
