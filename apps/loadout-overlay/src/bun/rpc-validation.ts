// RPC payload validators. Extracted to a sibling module so the index.ts
// handlers stay readable and the validation logic can be unit-tested
// without booting the full overlay (window, atoms, evdev loop).
//
// Kept deliberately minimal — no zod, no schema framework. Just enough
// structural checks to reject malformed CEF payloads with a logged
// warning instead of an opaque TypeError or process crash.

import type { ControllerShortcuts, ShortcutAction } from "../webview/lib/electrobun";

const SHORTCUT_ACTION_TYPES = new Set([
  "None",
  "ToggleOverlay",
  "OpenPlugin",
  "OpenSettings",
  "OpenHome",
  "ToggleKeyboard",
]);
const SHORTCUT_KEYS = ["guide_a", "guide_b", "guide_x", "guide_y"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidShortcutAction(value: unknown): value is ShortcutAction {
  if (!isPlainObject(value)) return false;
  if (typeof value.type !== "string") return false;
  if (!SHORTCUT_ACTION_TYPES.has(value.type)) return false;
  if (value.value !== undefined && typeof value.value !== "string") return false;
  return true;
}

function isValidControllerShortcuts(value: unknown): value is ControllerShortcuts {
  if (!isPlainObject(value)) return false;
  for (const key of SHORTCUT_KEYS) {
    if (!isValidShortcutAction(value[key])) return false;
  }
  return true;
}

/**
 * Validate the params passed to the `setControllerShortcuts` RPC handler.
 * Returns the typed shortcuts on success, or null if the payload is
 * malformed (caller logs + ignores). Fixes audit B-001 — previously the
 * handler cast `params` directly to the expected shape, so a malformed
 * payload either crashed (TypeError across IPC) or silently corrupted the
 * module-global shortcuts state.
 */
export function validateSetControllerShortcutsParams(
  params: unknown,
): ControllerShortcuts | null {
  if (!isPlainObject(params)) return null;
  const next = params.shortcuts;
  if (!isValidControllerShortcuts(next)) return null;
  return next;
}

/**
 * Validate the params passed to the `readSoundFile` RPC handler. Returns
 * the filename string on success, or null if the payload is malformed.
 * Fixes audit B-002 — `filename.includes("/")` threw a TypeError when
 * `filename` was not a string. The path-traversal / extension checks in
 * the handler still run after this returns; this only enforces the
 * `typeof === "string"` precondition.
 */
export function validateReadSoundFileFilename(params: unknown): string | null {
  if (!isPlainObject(params)) return null;
  if (typeof params.filename !== "string") return null;
  return params.filename;
}
