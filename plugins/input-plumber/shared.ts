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

// ── Overlay wake button ─────────────────────────────────────────────────────
// Shared between the backend (renders/loads the IP profile) and the picker UI.

/** A pickable physical button, derived from a device's IP capabilities. */
export interface WakeButtonOption {
  /** Raw capability string, e.g. "Gamepad:Button:RightPaddle1". The opaque id
   *  the backend round-trips back to bind the button. */
  raw: string;
  /** Leaf capability name, e.g. "RightPaddle1". */
  name: string;
  /** Capability category, "gamepad" | "keyboard". */
  category: string;
  /** Human label for the UI. */
  label: string;
  /** True for "extra" buttons (paddles, QAM/keyboard button); false for core
   *  gameplay buttons we'd rather the user didn't hijack. */
  recommended: boolean;
}

export interface WakeStatusDevice {
  /** InputPlumber composite-device name. */
  name: string;
  /** Buttons the user can bind on this device. */
  buttons: WakeButtonOption[];
}

export interface WakeStatus {
  /** Is the IP service answering on the bus right now? */
  ipActive: boolean;
  /** Is this a Steam Deck (needs the enable + auto_manage step)? */
  isDeck: boolean;
  /** Connected composite devices with their pickable buttons. */
  devices: WakeStatusDevice[];
  /** Raw capability currently bound, or null for none/Off. */
  selectedRaw: string | null;
}

export interface WakeOpResult {
  ok: boolean;
  error?: string;
}

/** Result of a press-to-capture flow: ok plus the captured button's
 *  identity if one was detected before the timeout. */
export interface WakeCaptureResult extends WakeOpResult {
  /** Raw capability string of the button the user pressed. */
  capturedRaw?: string;
  /** Human label for that button (UI confirmation). */
  capturedLabel?: string;
  /** True when the capture window expired without a press. */
  timedOut?: boolean;
}
