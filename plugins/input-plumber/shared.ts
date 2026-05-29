/**
 * Shared types between the InputPlumber plugin backend (Bun) and
 * frontend (browser) bundles. Lives here — not in `lib/install.ts` —
 * because the frontend can't import `lib/` (which pulls in node:fs and
 * @loadout/exec). Backend re-exports `InstallStatus` / `InstallRunResult`
 * from this module so both sides share a single source of truth and
 * the types can't drift the moment the backend changes.
 *
 * No `node:*`, FFI, fs, or DOM APIs allowed in this module — it has to
 * load cleanly in both runtimes.
 */

export type ManagedBy = "us" | "distro" | "none";

export interface InstallStatus {
  /** Is the daemon binary present anywhere known? */
  installed: boolean;
  /** Where it lives, or null if not installed. */
  binaryPath: string | null;
  /**
   * "us"     — at /var/lib/inputplumber/bin/inputplumber (this script).
   * "distro" — anywhere else on PATH (system package).
   * "none"   — not present.
   */
  managedBy: ManagedBy;
  /** Reported by `inputplumber --version` if reachable. */
  version: string | null;
  /** Is inputplumber.service currently active? */
  serviceActive: boolean;
  /** Is inputplumber.service enabled (starts on boot)? */
  serviceEnabled: boolean;
  /** Does the bundled install script exist on disk? */
  scriptPresent: boolean;
  /** One-line human summary. */
  summary: string;
}

export interface InstallRunResult {
  success: boolean;
  exitCode: number;
  timedOut: boolean;
  durationSeconds: number;
  error?: string;
}

export interface InstallStartResult {
  started: boolean;
  error?: string;
}

export interface InstallLogEvent {
  kind: "stdout" | "stderr" | "status";
  text: string;
}

export interface InstallStateEvent {
  running: boolean;
  result?: InstallRunResult;
}
