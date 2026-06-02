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

/** Sentinel keys the press-to-capture profile uses: each recommended button
 *  is temporarily mapped to one of these so we can identify *which* physical
 *  button the user pressed by reading the IP virtual keyboard. F16 is skipped
 *  (that's the real wake key); rare F13–F24 keys are unlikely to be bound to
 *  anything else, so a stray press during capture won't collide. The keycodes
 *  are the Linux input-event codes for those keys (KEY_F13 = 183, …). */
export const SENTINEL_KEYS: readonly { name: string; code: number }[] = [
  { name: "KeyF13", code: 183 },
  { name: "KeyF14", code: 184 },
  { name: "KeyF15", code: 185 },
  // F16 reserved (it's the wake key itself).
  { name: "KeyF17", code: 187 },
  { name: "KeyF18", code: 188 },
  { name: "KeyF19", code: 189 },
  { name: "KeyF20", code: 190 },
  { name: "KeyF21", code: 191 },
  { name: "KeyF22", code: 192 },
  { name: "KeyF23", code: 193 },
  { name: "KeyF24", code: 194 },
];

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

// Allowlist of *extra* buttons we recommend as wake triggers — paddles,
// QAM-area, keyboard-style extras, multimedia. Everything outside this set
// (standard gameplay buttons, normal alphanumeric keys) is demoted to "other"
// and excluded from the press-to-capture catch-all. Without the allowlist,
// 150+ standard keyboard keys swamp the recommended pool and the user's
// actual handheld button gets pushed past the sentinel limit.
const EXTRA_GAMEPAD_BUTTONS = new Set([
  "leftpaddle1",
  "leftpaddle2",
  "rightpaddle1",
  "rightpaddle2",
  "lefttop",
  "righttop",
  "keyboard",
  "quickaccess",
  "quickaccess2",
  "quickaccessmenu",
  "mute",
  "screenshot",
  "share",
]);

const EXTRA_KEYBOARD_KEYS = new Set([
  // Rare function keys that handhelds repurpose for their hardware buttons.
  "keyf13",
  "keyf14",
  "keyf15",
  "keyf16",
  "keyf17",
  "keyf18",
  "keyf19",
  "keyf20",
  "keyf21",
  "keyf22",
  "keyf23",
  "keyf24",
  // CJK conversion keys handhelds frequently emit for extra buttons.
  "keyhenkan",
  "keymuhenkan",
  "keykatakana",
  "keyhiragana",
  "keykatakanahiragana",
  "keyhanja",
  "keyhangeul",
  "keyyen",
  "keyro",
  // Multimedia / system keys handhelds map their hardware buttons to.
  // `KeyRecord` in particular — used by several handhelds for the
  // QAM-adjacent hardware button (the Apex's `Gamepad:Button:Keyboard`
  // composite uses Keyboard:KeyRecord on the underlying USB keyboard);
  // dropping it would push real wake-target buttons off the catch-all.
  "keyrecord",
  "keymute",
  "keyvolumeup",
  "keyvolumedown",
  "keypause",
  "keyscrolllock",
  "keysysrq",
  "keymenu",
  "keyhomepage",
  "keymail",
  "keycalculator",
  "keyplaypause",
  "keystop",
  "keynext",
  "keyprevious",
  "keypower",
  "keysleep",
  "keywakeup",
  "keyback",
  "keyforward",
  "keyrefresh",
  "keymicmute",
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
    const lower = cap.name.toLowerCase();
    const isExtra =
      (cap.category === "gamepad" && EXTRA_GAMEPAD_BUTTONS.has(lower)) ||
      (cap.category === "keyboard" && EXTRA_KEYBOARD_KEYS.has(lower));
    out.push({
      raw: cap.raw,
      name: cap.name,
      category: cap.category,
      label: labelFor(cap),
      recommended: isExtra,
    });
  }
  // Recommended first; within recommended, gamepad buttons before keyboard
  // sentinels (the handheld's physical extras are the real targets — keyboard
  // F13-F24 are only useful when a handheld emits them, which is rarer).
  // Then alphabetical for stable ordering.
  out.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (a.recommended && a.category !== b.category) {
      if (a.category === "gamepad") return -1;
      if (b.category === "gamepad") return 1;
    }
    return a.label.localeCompare(b.label);
  });
  return out;
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
 * Render a "press-to-capture" profile that maps each recommended button to a
 * unique sentinel key. The backend loads this transiently, reads the IP
 * virtual keyboard for the next sentinel keypress, then uses the returned
 * `sentinelToRaw` lookup to identify which physical button the user pressed.
 *
 * Buttons beyond `SENTINEL_KEYS.length` are silently dropped — the
 * recommended set on any handheld is well under 11 buttons, so this is
 * always a no-op in practice. Non-recommended (gameplay) buttons are
 * intentionally excluded so the user can keep playing during the capture
 * window.
 */
export function renderCaptureProfile(
  buttons: WakeButtonOption[],
  targetDevices: string[],
): { yaml: string; sentinelToRaw: Map<number, string> } {
  const targets = ensureKeyboard(targetDevices);
  const sentinelToRaw = new Map<number, string>();
  const mappings: string[] = [];
  const recommended = buttons.filter((b) => b.recommended);
  const limit = Math.min(recommended.length, SENTINEL_KEYS.length);
  for (let i = 0; i < limit; i++) {
    const b = recommended[i];
    const sentinel = SENTINEL_KEYS[i];
    sentinelToRaw.set(sentinel.code, b.raw);
    const cap = parseCapability(b.raw);
    const sourceEvent =
      cap.category === "keyboard"
        ? `      keyboard: ${cap.name}`
        : `      gamepad:\n        button: ${cap.name}`;
    mappings.push(
      `  - name: Capture (${cap.name} -> ${sentinel.name})\n` +
        `    source_event:\n` +
        `${sourceEvent}\n` +
        `    target_events:\n` +
        `      - keyboard: ${sentinel.name}`,
    );
  }
  const yaml =
    `# yaml-language-server: $schema=${PROFILE_SCHEMA}\n` +
    `# Generated by Loadout — press-to-capture (transient).\n` +
    `version: 1\n` +
    `kind: DefaultProfile\n` +
    `name: Loadout Capture\n` +
    `target_devices:\n` +
    targets.map((t) => `  - ${t}`).join("\n") +
    `\n` +
    `mapping:\n` +
    mappings.join("\n") +
    `\n`;
  return { yaml, sentinelToRaw };
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
