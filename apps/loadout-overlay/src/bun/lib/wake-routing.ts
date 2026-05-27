// Wake-event → action routing. Extracted from index.ts::onWake so the
// pure decision logic — which wake events toggle the overlay, which
// are reserved by Steam, which look up a user-configurable shortcut —
// is testable without booting the full main process.
//
// Audit B-006: index.ts orchestrator had no unit tests for the
// onWake() branch table. The bug surface here is real: the original
// pre-fix version had Guide+X hardcoded to ToggleOverlay even when
// the user's shortcut config said something else.

import type { WakeEvent } from "../native/input-intercept";
import type {
  ControllerShortcuts,
  ShortcutAction,
} from "../../webview/lib/electrobun";

/**
 * Decision returned by `routeWake`. The caller (index.ts) translates
 * each variant into the appropriate side-effects:
 *   - `toggle`           → toggleOverlay(reason)
 *   - `open-plugin`      → toggleOverlay if closed, then sendToWebview(
 *                          "overlay-open-plugin", { pluginId })
 *   - `open-settings`    → toggleOverlay if closed, then sendToWebview(
 *                          "overlay-open-settings", {})
 *   - `open-home`        → toggleOverlay if closed, then sendToWebview(
 *                          "overlay-open-home", {})
 *   - `toggle-keyboard`  → toggleOverlay if closed, then sendToWebview(
 *                          "overlay-toggle-keyboard", {}) — webview flips
 *                          OSK visibility on receipt
 *   - `ignore`           → no-op (reserved key, unbound shortcut,
 *                          unknown action type)
 */
export type WakeAction =
  | { kind: "toggle"; reason: WakeEvent }
  | { kind: "open-plugin"; reason: WakeEvent; pluginId: string }
  | { kind: "open-settings"; reason: WakeEvent }
  | { kind: "open-home"; reason: WakeEvent }
  | { kind: "toggle-keyboard"; reason: WakeEvent }
  | { kind: "ignore"; reason: "hardcoded-toggle-skip" | "reserved" | "unbound" | "unknown-action" };

/**
 * Wake events whose action is hardcoded (not configurable). These are
 * keyboard-scoped triggers (F16 / Ctrl+3 / Ctrl+4) rather than
 * controller buttons.
 */
const HARDCODED_TOGGLE_EVENTS = new Set<WakeEvent>([
  "QamToggle",
  "CtrlThree",
  "CtrlFour",
]);

/**
 * Wake events reserved by Steam / InputPlumber on Bazzite. Even if a
 * saved user config has them bound, we ignore them to avoid the
 * focus-flicker bug where our overlay and Steam's QAM/guide menu
 * fight over focus.
 */
const RESERVED_EVENTS = new Set<WakeEvent>(["GuideA", "GuideY"]);

/**
 * Map a wake event to the configurable shortcut slot, if any. Returns
 * null for events that don't go through the user-configurable map
 * (hardcoded toggles + reserved keys are filtered out by their own
 * predicates before this is consulted).
 */
function shortcutForEvent(
  event: WakeEvent,
  shortcuts: ControllerShortcuts,
): ShortcutAction | null {
  if (event === "GuideB") return shortcuts.guide_b;
  if (event === "GuideX") return shortcuts.guide_x;
  return null;
}

/**
 * Decide what side-effect (if any) a wake event should produce.
 * Pure — same inputs produce the same outputs, no state mutation. The
 * caller is responsible for actually running the side-effect.
 *
 * Order matches the original onWake() in index.ts:
 *   1. Hardcoded keyboard wakes → toggle
 *   2. Steam-reserved Guide combos → ignore
 *   3. User-configurable Guide combos → look up `shortcuts`:
 *        - None / unknown   → ignore
 *        - ToggleOverlay    → toggle
 *        - OpenPlugin       → open-plugin (only if `value` is set)
 */
export function routeWake(
  event: WakeEvent,
  shortcuts: ControllerShortcuts,
): WakeAction {
  if (HARDCODED_TOGGLE_EVENTS.has(event)) {
    return { kind: "toggle", reason: event };
  }
  if (RESERVED_EVENTS.has(event)) {
    return { kind: "ignore", reason: "reserved" };
  }
  const action = shortcutForEvent(event, shortcuts);
  if (!action) return { kind: "ignore", reason: "unbound" };
  if (action.type === "ToggleOverlay") {
    return { kind: "toggle", reason: event };
  }
  if (action.type === "OpenPlugin" && action.value) {
    return { kind: "open-plugin", reason: event, pluginId: action.value };
  }
  if (action.type === "OpenSettings") {
    return { kind: "open-settings", reason: event };
  }
  if (action.type === "OpenHome") {
    return { kind: "open-home", reason: event };
  }
  if (action.type === "ToggleKeyboard") {
    return { kind: "toggle-keyboard", reason: event };
  }
  // "None", "OpenPlugin" with no value, or any future unknown type.
  return { kind: "ignore", reason: "unknown-action" };
}
