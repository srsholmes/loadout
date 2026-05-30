/**
 * Pure helpers for the configurable overlay-wake button.
 *
 * No I/O, no subprocesses — just string/templating logic so it's trivially
 * unit-testable. The backend (lib/wake-trigger.ts) does the actual fs writes
 * and busctl calls; this module only produces the *content* it writes and
 * parses the *capability strings* InputPlumber reports.
 *
 * Mechanism: the overlay wakes in-game off KEY_F16. We make the
 * physical-button → F16 mapping a user-selectable InputPlumber profile. The
 * button choices come from the connected device's runtime
 * `CompositeDevice.Capabilities`, so there's no per-device code — any handheld
 * InputPlumber supports works the moment the user picks a button.
 *
 * NOTE (verify on hardware): the exact capability-string format and profile
 * schema below follow InputPlumber's documented conventions
 * (`docs/steamos-deck-controller-overlay-trigger.md`) but the `Capabilities`
 * property + `LoadProfilePath` method are not yet exercised elsewhere in this
 * repo. The parsing/rendering is centralised here precisely so it's a one-spot
 * adjustment if a live `busctl` dump shows a different shape.
 */

import type { WakeButtonOption } from "../shared";

export type { WakeButtonOption };

// ── Install destinations (all under /etc so they survive ostree switches) ──
export const ETC_DIR = "/etc/loadout/inputplumber";
export const PROFILE_PATH = `${ETC_DIR}/overlay-profile.yaml`;
export const DECK_OVERRIDE_PATH = "/etc/inputplumber/devices.d/50-steam_deck.yaml";
export const UACCESS_RULE_PATH = "/etc/udev/rules.d/71-loadout-inputplumber-uaccess.rules";

/** The keyboard key the overlay watches as its wake signal. Fixed internal
 *  contract — only the *physical button* bound to it is user-configurable. */
export const WAKE_KEY = "KeyF16";

const PROFILE_SCHEMA =
  "https://raw.githubusercontent.com/ShadowBlip/InputPlumber/main/rootfs/usr/share/inputplumber/schema/composite_device_profile_v1.json";

// ── Capability model ───────────────────────────────────────────────────────

/** A parsed InputPlumber source capability, e.g. "Gamepad:Button:RightPaddle1". */
export interface Capability {
  /** The raw capability string as reported by busctl. */
  raw: string;
  /** First segment, lowercased: "gamepad" | "keyboard" | "mouse" | … */
  category: string;
  /** Last segment — the button/key name, e.g. "RightPaddle1", "KeyRecord". */
  name: string;
}

/** Split a colon-delimited capability string into category + leaf name. */
export function parseCapability(raw: string): Capability {
  const parts = raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  const category = (parts[0] ?? "").toLowerCase();
  const name = parts.length > 0 ? parts[parts.length - 1] : raw.trim();
  return { raw: raw.trim(), category, name };
}

// Standard gameplay buttons/axes we should NOT recommend as a wake trigger
// (binding one would hijack normal play). Users can still pick them, but the
// UI nudges toward extras (paddles, the QAM/keyboard button, etc.).
const GAMEPLAY_BUTTONS = new Set([
  "south",
  "north",
  "east",
  "west",
  "leftbumper",
  "rightbumper",
  "lefttrigger",
  "righttrigger",
  "start",
  "select",
  "guide",
  "leftstick",
  "rightstick",
  "dpadup",
  "dpaddown",
  "dpadleft",
  "dpadright",
]);

// Things that can't sensibly be a discrete wake button: analog axes, sticks,
// touch, accelerometer, mouse motion. Filtered out of the picker entirely.
const NON_BUTTON_CATEGORIES = new Set([
  "mouse",
  "touchpad",
  "touchscreen",
  "imu",
  "gyro",
  "accelerometer",
]);

function isAxisLike(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("axis") ||
    n.includes("stick") ||
    n.includes("trigger") || // analog triggers — keep the digital bumpers
    n.startsWith("accel") ||
    n.startsWith("gyro")
  );
}

// Friendly labels for buttons we know by name. Steam Deck paddles map to the
// L4/L5/R4/R5 nomenclature users see on the hardware. Unknown names fall back
// to the raw capability name.
const KNOWN_LABELS: Record<string, string> = {
  leftpaddle1: "Left Back Paddle (L4)",
  leftpaddle2: "Left Back Paddle (L5)",
  rightpaddle1: "Right Back Paddle (R4)",
  rightpaddle2: "Right Back Paddle (R5)",
  lefttop: "Left Extra Button",
  righttop: "Right Extra Button",
  keyboard: "Keyboard Button",
  quickaccess: "Quick Access (QAM) Button",
  quickaccessmenu: "Quick Access (QAM) Button",
};

/** Humanise a button: known label, else a spaced-out version of the raw name. */
export function labelFor(cap: Capability): string {
  const known = KNOWN_LABELS[cap.name.toLowerCase()];
  if (known) return known;
  if (cap.category === "keyboard") {
    // "KeyRecord" → "Key Record"
    return cap.name.replace(/^Key/, "Key ").replace(/([a-z])([A-Z])/g, "$1 $2");
  }
  // "RightPaddle1" → "Right Paddle 1"
  return cap.name.replace(/([a-z])([A-Z0-9])/g, "$1 $2");
}

/**
 * Turn the device's raw capability list into picker options: drop axes/sticks
 * and non-button categories, label what's left, and flag the "extra" buttons
 * (paddles, keyboard/QAM button, anything non-standard) as recommended.
 */
export function buttonOptions(capabilities: string[]): WakeButtonOption[] {
  const seen = new Set<string>();
  const out: WakeButtonOption[] = [];
  for (const raw of capabilities) {
    const cap = parseCapability(raw);
    if (seen.has(cap.raw)) continue;
    if (NON_BUTTON_CATEGORIES.has(cap.category)) continue;
    if (isAxisLike(cap.name)) continue;
    // Only gamepad buttons and keyboard keys make sense as a wake trigger.
    if (cap.category !== "gamepad" && cap.category !== "keyboard") continue;
    seen.add(cap.raw);
    const isGameplay = cap.category === "gamepad" && GAMEPLAY_BUTTONS.has(cap.name.toLowerCase());
    out.push({
      raw: cap.raw,
      name: cap.name,
      category: cap.category,
      label: labelFor(cap),
      recommended: !isGameplay,
    });
  }
  // Recommended first, then alphabetical by label for stable ordering.
  out.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

/**
 * Pick a sensible default trigger for first-run: prefer a right back paddle,
 * then any paddle, then a keyboard/QAM-style extra, else the first recommended
 * option, else null (let the user choose explicitly).
 */
export function pickDefaultButton(capabilities: string[]): WakeButtonOption | null {
  const opts = buttonOptions(capabilities);
  if (opts.length === 0) return null;
  const byName = (re: RegExp) =>
    opts.find((o) => re.test(o.name.toLowerCase()) && o.recommended) ?? null;
  return (
    byName(/^rightpaddle/) ??
    byName(/paddle/) ??
    opts.find((o) => o.category === "keyboard" && o.recommended) ??
    opts.find((o) => o.recommended) ??
    opts[0]
  );
}

// ── Rendered file content ────────────────────────────────────────────────

/**
 * Render the InputPlumber profile that binds `button` → F16. `targetDevices`
 * is the device's existing target list with `keyboard` ensured present — we
 * preserve whatever controller emulation the device already uses (xb360,
 * deck-uhid, …) and only add the keyboard so the overlay has an F16 source.
 */
export function renderProfile(button: Capability, targetDevices: string[]): string {
  const targets = ensureKeyboard(targetDevices);
  const sourceEvent =
    button.category === "keyboard"
      ? `      keyboard: ${button.name}`
      : `      gamepad:\n        button: ${button.name}`;
  return (
    `# yaml-language-server: $schema=${PROFILE_SCHEMA}\n` +
    `# Generated by Loadout — overlay wake button. Do not edit by hand;\n` +
    `# change the binding from the InputPlumber plugin panel instead.\n` +
    `version: 1\n` +
    `kind: DefaultProfile\n` +
    `name: Loadout Overlay Trigger\n` +
    `target_devices:\n` +
    targets.map((t) => `  - ${t}`).join("\n") +
    `\n` +
    `mapping:\n` +
    `  - name: Overlay wake (${button.name} -> F16)\n` +
    `    source_event:\n` +
    `${sourceEvent}\n` +
    `    target_events:\n` +
    `      - keyboard: ${WAKE_KEY}\n`
  );
}

/**
 * Render a profile with the same preserved targets but no mapping — used by
 * the "Off" option so the controller keeps working but nothing emits F16. We
 * load this rather than deleting the file so the change takes effect live,
 * without waiting for an IP restart.
 */
export function renderClearedProfile(targetDevices: string[]): string {
  const targets = ensureKeyboard(targetDevices);
  return (
    `# yaml-language-server: $schema=${PROFILE_SCHEMA}\n` +
    `# Generated by Loadout — overlay wake button disabled.\n` +
    `version: 1\n` +
    `kind: DefaultProfile\n` +
    `name: Loadout Overlay Trigger\n` +
    `target_devices:\n` +
    targets.map((t) => `  - ${t}`).join("\n") +
    `\n` +
    `mapping: []\n`
  );
}

/** Return targetDevices with `keyboard` guaranteed present (deduped, order
 *  preserved). If the device reported no targets we still emit a usable pair
 *  so the controller keeps working and a keyboard exists for F16. */
export function ensureKeyboard(targetDevices: string[]): string[] {
  const base = targetDevices.filter((t) => t && t !== "null");
  const seed = base.length > 0 ? base : ["gamepad"];
  const out: string[] = [];
  for (const t of [...seed, "keyboard"]) {
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Device override that makes InputPlumber claim the Steam Deck's built-in
 *  controller at boot. Deck-only: SteamOS ships IP disabled and unmanaging
 *  the Deck (hid-steam drives it), so we opt in. Other handhelds already have
 *  IP managing the pad, so this file is never written there. */
export const DECK_OVERRIDE_YAML =
  `# Generated by Loadout — enables InputPlumber management of the Steam Deck\n` +
  `# controller so a back-paddle can be mapped to the overlay wake key.\n` +
  `auto_manage: true\n`;

/** udev rule granting the active session user read access to InputPlumber's
 *  virtual keyboard. The overlay runs as a *user* service; physical keyboards
 *  get a logind uaccess ACL but IP's virtual one doesn't on the Deck, so the
 *  overlay's open() of it would EACCES without this. Universal — harmless
 *  where the device already grants access. */
export const UACCESS_RULE =
  `# Generated by Loadout — let the overlay (user service) open InputPlumber's\n` +
  `# virtual keyboard so it can read the wake key (F16).\n` +
  `SUBSYSTEM=="input", ATTRS{name}=="InputPlumber*", TAG+="uaccess"\n`;
