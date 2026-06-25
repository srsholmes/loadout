// Port of src-tauri/src/input_interceptor.rs.
//
// Single long-running read loop over all /dev/input/event* nodes.
// Two modes per device, toggled on overlay open/close:
//
//   - idle mode: EVIOCSMASK filters events down to just the wake
//     shortcuts (F16 for QAM, Guide+B / Ctrl+4 combos). Kernel drops
//     everything else before we see it, so we're not burning CPU on
//     every stick wiggle while the user is gaming.
//
//   - intercept mode: EVIOCGRAB takes exclusive access of physical
//     controllers. While the overlay is open the game + Steam BPM
//     see nothing — events flow only to us, and we hand them to the
//     NavController which emits NavActions the webview turns into
//     synthetic KeyboardEvents.
//
// Why this lives alongside the atom manipulation in gamescope-atoms.ts
// and not inside it: atoms tell Gamescope which window should get FOCUS
// (compositor-level). EVIOCGRAB operates at the KERNEL level and stops
// events reaching ANY userspace process. Belt-and-braces under
// Gamescope, where atom-only routing has been flaky.
//
// Steam Input's VIRTUAL Xbox 360 pad (vendor 28de / product 11ff) is a
// special "grab-only" case: while the overlay is open we EVIOCGRAB it but
// never read it for nav. A running GAME under the overlay reads its input
// from this virtual pad (Steam Input aggregates every physical pad into one
// virtual pad per controller), so grabbing it at the kernel input_dev level
// (blocks evdev AND joydev readers) stops the game receiving input — with NO
// resume-burst, unlike a process-freeze: grabbed events are never delivered,
// so nothing queues to replay on release. Overlay nav is unaffected (it comes
// from the PHYSICAL pads below, not this mirror). Steam BPM is unaffected too —
// it reads the physical pad via hidraw, not this virtual pad (verified
// on-device), so the menu keeps working and BPM yielding stays the focus
// atoms' job (gamescope-atoms.ts).
//
// What we intentionally do NOT grab:
//   - Physical keyboards. The user might want to type into the overlay
//     UI or use external shortcuts while it's open.
//   - The InputPlumber virtual keyboard for F16 — handled separately
//     so the QAM button can still toggle us off.

import { ptr } from "bun:ffi";
import {
  libc,
  EVIOCGRAB,
  EVIOCSMASK,
  INPUT_EVENT_SIZE,
} from "./ffi";
import {
  enumerateDevices,
  type InputDevice,
} from "./devices";
import {
  NavController,
  type InputEvent,
  type GamepadAxis,
} from "./nav-controller";
import { trace } from "./trace";
import {
  startDeviceHotplug,
  type DeviceHotplugHandle,
} from "./device-hotplug";

// ---- linux/input-event-codes.h (subset used by the wake + nav detection) ---

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_ABS = 0x03;

// Gamepad buttons
const BTN_A = 0x130;
const BTN_B = 0x131;
const BTN_X = 0x133;
const BTN_Y = 0x134;
const BTN_TL = 0x136;
const BTN_TR = 0x137;
const BTN_SELECT = 0x13a;
const BTN_MODE = 0x13c;

// Axes
const ABS_X = 0x00;
const ABS_Y = 0x01;
const ABS_RX = 0x03;
const ABS_RY = 0x04;
const ABS_HAT0X = 0x10;
const ABS_HAT0Y = 0x11;

// Keyboard keys
const KEY_LEFTCTRL = 29;
const KEY_3 = 4;
const KEY_4 = 5;
const KEY_F16 = 0xba;

// fcntl.h — same as f16-watcher.ts/input-grab.ts used.
const O_RDONLY = 0;
const O_NONBLOCK = 2048;

// ---- Hotplug warning -------------------------------------------------------

/**
 * Audit B-024: log a one-line warning when `startDeviceHotplug` returned
 * null (i.e. inotify is unavailable on this kernel/sandbox). The
 * device-hotplug module logs its own init-failure messages but the
 * operational consequence — "controllers added mid-session won't be
 * picked up until the next 2s reconcile poll" — lives here.
 *
 * Exported for tests.
 */
export function warnIfHotplugDisabled(
  hotplug: DeviceHotplugHandle | null,
  log: (msg: string) => void = console.warn,
): void {
  if (hotplug === null) {
    log(
      "[input-intercept] inotify unavailable — controllers added mid-session " +
        "will only be picked up by the 2s reconcile poll",
    );
  }
}

// ---- Wake events -----------------------------------------------------------

/** Wake shortcuts that should open/close the overlay. Subset of
 *  nav_controller.rs::WakeEvent. */
export type WakeEvent =
  | "QamToggle"
  | "GuideA"
  | "GuideB"
  | "GuideX"
  | "GuideY"
  | "CtrlThree"
  | "CtrlFour";

// ---- Tuning ---------------------------------------------------------------

/** Read-loop interval. Tauri's epoll has a 100ms timeout and bursts on
 *  demand; we approximate with fixed 25ms polling while intercepting and
 *  100ms while idle — both sides are cheap and within frame-time. */
const POLL_ACTIVE_MS = 25;
const POLL_IDLE_MS = 100;
// Safety cap for the deferred-grab path (see doGrab). If the toggle modifier
// (Guide) somehow never reports released — a flaky pad, EVIOCGKEY lying — we
// grab anyway after this long so the overlay can't be left ungrabbed (Steam
// navigating underneath) indefinitely. Well past a normal Guide tap+release.
const DEFER_GRAB_TIMEOUT_MS = 2000;

/** Buffer = 64 events per device per tick. Way bigger than any realistic
 *  25 ms burst; small enough that per-device allocation stays negligible. */
const READ_BATCH = 64;
const READ_BUF_SIZE = INPUT_EVENT_SIZE * READ_BATCH;

// Safety timeout removed 2026-05-11. The original Rust port had a 5s
// "if no events forwarded, auto-release" bail-out to handle a "stuck
// grab" pathology (overlay window vanished / hide() raced without
// doRelease() firing → user's whole machine sees dead controllers).
//
// The cure was worse than the disease:
//
//   - `lastForward` only ticks when NavController emits an action.
//     A user who reads the overlay UI for >5s without pressing a
//     controller button (very normal — overlay is meant to be read)
//     trips the bail-out, doRelease fires, controller appears dead.
//     Touch kept working (CEF, not evdev), so the user could hide+show
//     to re-grab. Reported by maintainer 2026-05-11.
//
//   - **Worse:** on a controller-only handheld with no touchscreen,
//     once the timeout fires the wake keys also route away from us
//     (they go to Steam now), so the user is permanently stranded
//     until they restart the service.
//
// What the timeout was protecting against is better handled by:
//   1. The kernel itself: on process death, all fds close and EVIOCGRAB
//      auto-releases. So a crashed overlay never leaves controllers stuck.
//   2. Making doGrab/doRelease strictly paired with overlay show/hide.
//      Any "stuck grab" is a bug in that pairing — fix it where it
//      actually leaks, not by papering over with a timer.
//
// If the pathological case re-surfaces, the right next step is a
// webview→bun heartbeat to detect a hung overlay window, not a
// blanket time-based bail-out.

// ---- Kernel event-mask helpers (EVIOCSMASK) --------------------------------
//
// EVIOCSMASK takes a `struct input_mask { __u32 type; __u32 codes_size;
// __u64 codes_ptr; }` (16 bytes). `codes_ptr` is a pointer to a bitmask
// indexed by event code. Kernel ignores events NOT in the mask before
// they reach read(2), so we save a read-side syscall per ignored event.

interface InputMask {
  type_: number;
  codesSize: number;
  codesPtr: bigint;
}

function encodeInputMask(m: InputMask): Uint8Array {
  // 16 bytes, little-endian on x86_64.
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  view.setUint32(0, m.type_, true);
  view.setUint32(4, m.codesSize, true);
  view.setBigUint64(8, m.codesPtr, true);
  return new Uint8Array(buf);
}

/** Build a bitmask (aligned to 8-byte boundary) from a list of event codes. */
function buildBitmask(codes: readonly number[]): Uint8Array {
  if (codes.length === 0) return new Uint8Array(0);
  const maxCode = codes.reduce((a, b) => (a > b ? a : b), 0);
  let byteLen = (maxCode >> 3) + 1;
  if (byteLen % 8 !== 0) byteLen += 8 - (byteLen % 8);
  if (byteLen < 8) byteLen = 8;
  const bits = new Uint8Array(byteLen);
  for (const code of codes) {
    bits[code >> 3] |= 1 << (code & 7);
  }
  return bits;
}

function setEventMask(
  fd: number,
  evType: number,
  codes: readonly number[],
): void {
  const bits = buildBitmask(codes);
  // `codesPtr` may legitimately be null when codes is empty (tells the
  // kernel "filter everything of this EV_TYPE"). Bun's ptr() needs a
  // non-empty buffer, so we pass a 1-byte dummy and codesSize=0 — the
  // kernel ignores the pointer when size is 0.
  const dummy = new Uint8Array(1);
  const mask: InputMask = {
    type_: evType,
    codesSize: bits.length,
    codesPtr: BigInt(bits.length === 0 ? ptr(dummy) : ptr(bits)),
  };
  const maskBuf = encodeInputMask(mask);
  libc.symbols.ioctl(fd, EVIOCSMASK, ptr(maskBuf));
  // Errors are expected on older kernels that don't support EVIOCSMASK —
  // we silently fall back to reading + discarding in userspace.
}

// ---- Wake-button codes for each mode --------------------------------------

/** Buttons monitored during idle mode — guide/select + the four face
 *  buttons for combo detection. */
const WAKE_BUTTON_CODES: readonly number[] = [
  BTN_MODE,
  BTN_SELECT,
  BTN_A,
  BTN_B,
  BTN_X,
  BTN_Y,
];

/** All buttons forwarded to the NavController during intercept. */
const NAV_BUTTON_CODES: readonly number[] = [
  BTN_A,
  BTN_B,
  BTN_X,
  BTN_Y,
  BTN_TL,
  BTN_TR,
  BTN_SELECT,
  BTN_MODE,
];

/** Keyboard wake keys. */
const SHORTCUT_KEY_CODES: readonly number[] = [
  KEY_LEFTCTRL,
  KEY_3,
  KEY_4,
];

/** QAM wake key. */
const QAM_KEY_CODES: readonly number[] = [KEY_F16];

/** Axes forwarded during intercept. Right stick (ABS_RX/RY) is included
 *  so the webview can drive analog scroll of the main content area. */
const NAV_AXIS_CODES: readonly number[] = [
  ABS_X,
  ABS_Y,
  ABS_RX,
  ABS_RY,
  ABS_HAT0X,
  ABS_HAT0Y,
];

function applyIdleMasks(fd: number, dev: InputDevice): void {
  // Controllers get wake buttons; keyboards get ctrl/3/4; qam gets F16.
  // A single device can be multiple (InputPlumber keyboard is both
  // keyboard + qam) — union all that apply.
  const codes: number[] = [];
  if (dev.flags.isController) codes.push(...WAKE_BUTTON_CODES);
  if (dev.flags.isKeyboard) codes.push(...SHORTCUT_KEY_CODES);
  if (dev.flags.isQam) codes.push(...QAM_KEY_CODES);
  setEventMask(fd, EV_KEY, codes);

  // Suppress axes + misc in idle — we only care about wake button
  // presses to bring the overlay up.
  setEventMask(fd, EV_ABS, []);
  setEventMask(fd, 0x02 /* EV_REL */, []);
  setEventMask(fd, 0x04 /* EV_MSC */, []);
}

function applyInterceptMasks(fd: number): void {
  // Broaden to everything nav needs: face buttons, shoulder bumpers,
  // modifiers, shortcut modifiers, and nav axes.
  const keys = [
    ...SHORTCUT_KEY_CODES,
    ...WAKE_BUTTON_CODES,
    ...NAV_BUTTON_CODES,
  ];
  setEventMask(fd, EV_KEY, keys);
  setEventMask(fd, EV_ABS, NAV_AXIS_CODES);
}

// ---- Raw event read --------------------------------------------------------

interface RawEvent {
  type: number;
  code: number;
  value: number;
}

function readRawEvents(fd: number, buf: Uint8Array, view: DataView): RawEvent[] {
  const n = Number(libc.symbols.read(fd, buf, BigInt(buf.byteLength)));
  if (n <= 0) return [];
  const count = Math.floor(n / INPUT_EVENT_SIZE);
  const out: RawEvent[] = new Array(count);
  for (let j = 0; j < count; j++) {
    const off = j * INPUT_EVENT_SIZE;
    out[j] = {
      type: view.getUint16(off + 16, true),
      code: view.getUint16(off + 18, true),
      value: view.getInt32(off + 20, true),
    };
  }
  return out;
}

// ---- Axis calibration (EVIOCGABS) -----------------------------------------
//
// Sticks + triggers report raw values in whatever range their kernel driver
// uses (e.g. -32768..32767 for a Sony pad, 0..255 for an Xbox trigger).
// NavController wants normalized -1..1 on the stick axes, so we query
// each device's min/max via EVIOCGABS once at open.

interface AxisCal {
  min: number;
  max: number;
}

/** EVIOCGABS(code) = _IOR('E', 0x40 + code, struct input_absinfo). */
function eviocgabs(code: number): bigint {
  return 0x80184540n + BigInt(code);
}

function readAxisCalibration(fd: number): Map<number, AxisCal> {
  const cal = new Map<number, AxisCal>();
  for (const code of NAV_AXIS_CODES) {
    // struct input_absinfo: __s32 value, min, max, fuzz, flat, resolution (24 bytes).
    const buf = new Uint8Array(24);
    const rc = libc.symbols.ioctl(fd, eviocgabs(code), ptr(buf));
    if (rc !== 0) continue;
    const view = new DataView(buf.buffer);
    const min = view.getInt32(4, true);
    const max = view.getInt32(8, true);
    cal.set(code, { min, max });
  }
  return cal;
}

function normalizeAxis(code: number, raw: number, cal: Map<number, AxisCal>): number {
  const c = cal.get(code);
  if (!c || c.max === c.min) return 0;
  const n = (raw - c.min) / (c.max - c.min);
  return Math.min(1, Math.max(0, n)) * 2 - 1;
}

/** Map an EV_ABS code to the NavController axis name, or null if it's an
 *  axis we don't forward. Shared by toInputEvents (live stream) and the
 *  grab-time re-sync below. */
function absCodeToAxis(code: number): GamepadAxis | null {
  switch (code) {
    case ABS_X: return "LeftStickX";
    case ABS_Y: return "LeftStickY";
    case ABS_RX: return "RightStickX";
    case ABS_RY: return "RightStickY";
    case ABS_HAT0X: return "HatX";
    case ABS_HAT0Y: return "HatY";
    default: return null;
  }
}

// ---- Hardware state re-sync (EVIOCGKEY + EVIOCGABS value) -------------------
//
// EVIOCGRAB/EVIOCSMASK only deliver *edge* events; if a button-up or
// axis-center is lost across a grab/ungrab or mask switch (or dropped over a
// flaky BT link), the edge-derived held-state desyncs and a control appears
// stuck "held". On every grab we read the device's ACTUAL current state
// straight from the kernel so a lost release can never survive the cycle.

/** EVIOCGKEY(len) = _IOC(_IOC_READ, 'E', 0x18, len) — returns a bitmap of the
 *  current pressed/released state of every key/button on the device. */
function eviocgkey(len: number): bigint {
  return (2n << 30n) | (BigInt(len) << 16n) | (0x45n << 8n) | 0x18n;
}

/** Current pressed-state of the combo modifier buttons, read from the kernel
 *  key bitmap. Buffer of 96 bytes covers codes 0..767 (well past BTN_MODE). */
function readModifierState(fd: number): { guide: boolean; select: boolean } {
  const buf = new Uint8Array(96);
  const rc = libc.symbols.ioctl(fd, eviocgkey(buf.length), ptr(buf));
  if (rc < 0) return { guide: false, select: false };
  const bit = (code: number) => (buf[code >> 3] & (1 << (code & 7))) !== 0;
  return { guide: bit(BTN_MODE), select: bit(BTN_SELECT) };
}

/** Current directional-axis positions as InputEvents, so NavController can be
 *  primed to physical reality on grab. Right-stick (continuous analog scroll)
 *  is skipped — only the dpad/stick *directions* matter for the stuck-held
 *  pathology. */
function readDirectionalAxisState(
  fd: number,
  cal: Map<number, AxisCal>,
): InputEvent[] {
  const out: InputEvent[] = [];
  for (const code of NAV_AXIS_CODES) {
    if (code === ABS_RX || code === ABS_RY) continue;
    const axis = absCodeToAxis(code);
    if (!axis) continue;
    const buf = new Uint8Array(24);
    const rc = libc.symbols.ioctl(fd, eviocgabs(code), ptr(buf));
    if (rc !== 0) continue;
    const raw = new DataView(buf.buffer).getInt32(0, true);
    out.push({
      kind: "axis",
      axis,
      value: cal.has(code) ? normalizeAxis(code, raw, cal) : raw,
    });
  }
  return out;
}

// ---- Combo detection (guide+button + ctrl+3/4) -----------------------------

/** How long the combo modifier + button must overlap. Matches
 *  nav_controller.rs's COMBO_MAX_DURATION. */
const COMBO_MAX_DURATION_MS = 300;

interface ComboState {
  guideHeld: boolean;
  selectHeld: boolean;
  pressedAt: Partial<Record<"a" | "b" | "x" | "y", number>>;
}

function newComboState(): ComboState {
  return { guideHeld: false, selectHeld: false, pressedAt: {} };
}

interface ShortcutState {
  ctrlHeld: boolean;
}

function newShortcutState(): ShortcutState {
  return { ctrlHeld: false };
}

function processCombo(
  state: ComboState,
  code: number,
  value: number,
  now: number,
): WakeEvent | null {
  if (code === BTN_MODE) {
    state.guideHeld = value !== 0;
    return null;
  }
  if (code === BTN_SELECT) {
    state.selectHeld = value !== 0;
    return null;
  }
  if (!state.guideHeld && !state.selectHeld) return null;

  const letter =
    code === BTN_A ? "a" :
    code === BTN_B ? "b" :
    code === BTN_X ? "x" :
    code === BTN_Y ? "y" : null;
  if (!letter) return null;

  if (value !== 0) {
    state.pressedAt[letter] = now;
    return null;
  }
  const pressedAt = state.pressedAt[letter];
  delete state.pressedAt[letter];
  if (pressedAt === undefined) return null;
  if (now - pressedAt >= COMBO_MAX_DURATION_MS) return null;
  switch (letter) {
    case "a": return "GuideA";
    case "b": return "GuideB";
    case "x": return "GuideX";
    case "y": return "GuideY";
  }
}

function processShortcut(
  state: ShortcutState,
  code: number,
  value: number,
): WakeEvent | null {
  if (code === KEY_LEFTCTRL) {
    state.ctrlHeld = value !== 0;
    return null;
  }
  if (value === 0) return null; // key release doesn't fire
  if (!state.ctrlHeld) return null;
  if (code === KEY_3) return "CtrlThree";
  if (code === KEY_4) return "CtrlFour";
  return null;
}

// ---- Raw → InputEvent ------------------------------------------------------

function toInputEvents(
  events: RawEvent[],
  cal: Map<number, AxisCal>,
): InputEvent[] {
  const out: InputEvent[] = [];
  for (const e of events) {
    if (e.type === EV_SYN) continue;
    if (e.type === EV_KEY) {
      const btn =
        e.code === BTN_A ? "A" :
        e.code === BTN_B ? "B" :
        e.code === BTN_X ? "X" :
        e.code === BTN_Y ? "Y" :
        e.code === BTN_TL ? "LB" :
        e.code === BTN_TR ? "RB" :
        e.code === BTN_MODE ? "Mode" :
        e.code === BTN_SELECT ? "Select" :
        null;
      if (btn) out.push({ kind: "button", button: btn, pressed: e.value !== 0 });
    } else if (e.type === EV_ABS) {
      const axis = absCodeToAxis(e.code);
      if (axis) {
        out.push({
          kind: "axis",
          axis,
          // Hat axes report raw -1/0/1 from the kernel already; passing
          // them through normalizeAxis would collapse them via the
          // deadzone if calibration didn't come back. Hats never have
          // EVIOCGABS calibration on most kernels anyway, so fall back
          // to raw when cal is missing.
          value: cal.has(e.code) ? normalizeAxis(e.code, e.value, cal) : e.value,
        });
      }
    }
  }
  return out;
}

// ---- Tracked device --------------------------------------------------------

interface TrackedDevice {
  fd: number;
  path: string;
  dev: InputDevice;
  grabbed: boolean;
  /** Steam Input virtual pad: EVIOCGRAB it while intercepting to silence the
   *  game underneath, but never read it for nav/wake (the physical pads drive
   *  nav; this mirrors them). See the file header. */
  grabOnly: boolean;
  combo: ComboState;
  shortcut: ShortcutState;
  cal: Map<number, AxisCal>;
}

// ---- Public API ------------------------------------------------------------

export interface InputInterceptOptions {
  /** Fires on wake shortcuts (F16, guide+B, ctrl+4 etc). The index.ts
   *  orchestrator decides whether to open or close the overlay. */
  onWake: (event: WakeEvent) => void;
  /** Fires for every NavAction while intercept is active. Wire this up
   *  to `overlay.rpc.send("overlay-action", {action})`. */
  onAction: (action: string) => void;
  /** Fires for continuous-analog axes (right stick) while intercept is
   *  active. Wire this up to `overlay.rpc.send("overlay-scroll", …)`. */
  onAxis?: (axis: "RightStickX" | "RightStickY", value: number) => void;
  /** Optional — number of controllers that were opened. For diagnostic logs. */
  onReady?: (counts: { controllers: number; keyboards: number; qam: number }) => void;
  /** When true (default), the Steam Input virtual pad (28de:11ff) is READ for
   *  nav — required on the Steam Deck, where a running game makes the built-in
   *  controller present only as this virtual pad. When false, it's grab-only:
   *  an external InputPlumber-managed pad drives nav over DBus and reading the
   *  mirror would double every input. index.ts sets this to "no IP composites".
   */
  readVirtualPadsForNav?: boolean;
}

export interface InputInterceptHandle {
  /** Start intercept — EVIOCGRAB physical controllers, broaden their
   *  event masks, reset NavController state. Safe to call multiple times. */
  grab(): void;
  /** Stop intercept — release grabs, narrow masks back to idle. */
  release(): void;
  /** Close all FDs, release any outstanding grabs. Call from shutdown. */
  shutdown(): void;
  /** For diagnostic logs. */
  readonly deviceCount: number;
}

export async function startInputIntercept(
  opts: InputInterceptOptions,
): Promise<InputInterceptHandle> {
  // The Steam Input virtual pad (28de:11ff) needs care. On the Steam Deck,
  // whenever a game/app is running Steam Input re-exposes the BUILT-IN
  // controller AS this virtual pad (the native "Steam Deck" gamepad node
  // disappears) — so it becomes the ONLY nav source for the Deck's controls
  // and MUST be read for nav. (Grabbing it while reading also silences the
  // game underneath, which is what #97 wanted; per this file's header that's
  // safe — Steam BPM reads the PHYSICAL pad via hidraw, not this mirror.)
  //
  // The exception is an EXTERNAL pad managed by InputPlumber: there the pad's
  // nav arrives over IP's DBus stream (ip-intercept.ts) and the virtual pad is
  // just a mirror — reading it too would double every input, so we only GRAB
  // it. index.ts sets readVirtualPadsForNav = "no IP composites present", i.e.
  // the Deck-alone case reads; the external-IP-pad case stays grab-only.
  const readVirtualPadsForNav = opts.readVirtualPadsForNav ?? true;

  // Track controllers including the virtual pad; isSteamVirtual only decides
  // read-for-nav vs grab-only below (via `grabOnly` in openAndTrack).
  const devices = (await enumerateDevices()).filter(
    (d) => d.flags.isController || d.flags.isKeyboard || d.flags.isQam,
  );

  const tracked: TrackedDevice[] = [];

  function openAndTrack(dev: InputDevice): TrackedDevice | null {
    const pathBuf = Buffer.from(dev.eventPath + "\0");
    const fd = libc.symbols.open(pathBuf, O_RDONLY | O_NONBLOCK);
    if (fd < 0) {
      console.warn(
        `[input-intercept] open failed for ${dev.eventPath} (${dev.name})`,
      );
      return null;
    }
    // A virtual pad is read for nav (grabOnly=false) on the Deck-alone case,
    // or grab-only when an external IP-managed pad drives nav over DBus.
    const grabOnly = dev.isSteamVirtual && !readVirtualPadsForNav;
    // Grab-only virtual pads are never read for nav, so masks + axis
    // calibration are irrelevant — skip them.
    if (!grabOnly) applyIdleMasks(fd, dev);
    const cal =
      dev.flags.isController && !grabOnly ? readAxisCalibration(fd) : new Map();
    const t: TrackedDevice = {
      fd,
      path: dev.eventPath,
      dev,
      grabbed: false,
      grabOnly,
      combo: newComboState(),
      shortcut: newShortcutState(),
      cal,
    };
    tracked.push(t);
    const kinds = [
      grabOnly
        ? "virtual(grab-only)"
        : dev.flags.isController
          ? "controller"
          : null,
      dev.flags.isKeyboard ? "keyboard" : null,
      dev.flags.isQam ? "qam" : null,
    ].filter(Boolean).join("+");
    console.log(
      `[input-intercept] opened ${dev.eventPath} '${dev.name}' (${kinds})`,
    );
    return t;
  }

  for (const dev of devices) {
    openAndTrack(dev);
  }

  opts.onReady?.({
    controllers: tracked.filter((t) => t.dev.flags.isController && !t.grabOnly)
      .length,
    keyboards: tracked.filter((t) => t.dev.flags.isKeyboard).length,
    qam: tracked.filter((t) => t.dev.flags.isQam).length,
  });

  let intercepting = false;
  let generation = 0;

  // Controllers whose EVIOCGRAB was deferred because the Guide modifier was
  // still held at grab time (see doGrab). Maps device -> deadline (perf.now
  // ms); pollOnce grabs each the instant Guide releases, or at the deadline.
  const pendingGrabs = new Map<TrackedDevice, number>();

  const nav = new NavController({
    emit: (a) => {
      opts.onAction(a);
    },
    emitAxis: (axis, value) => {
      opts.onAxis?.(axis, value);
    },
  });

  const buf = new Uint8Array(READ_BUF_SIZE);
  const view = new DataView(buf.buffer);

  function pollOnce(): void {
    // Drain any pending hot-plug events before reading from the
    // tracked devices — adds/removes mutate `tracked`, and we want
    // a fresh list when the read loop runs below.
    hotplug?.poll();

    const now = performance.now();

    // Engage any deferred grabs whose Guide modifier has now been released
    // (so Steam has observed the release), or that have waited past the
    // deadline. See doGrab for the stuck-Guide rationale.
    if (intercepting && pendingGrabs.size > 0) {
      for (const [t, deadline] of [...pendingGrabs]) {
        if (!readModifierState(t.fd).guide || now >= deadline) {
          pendingGrabs.delete(t);
          grabDevice(t);
        }
      }
    }

    for (const t of tracked) {
      const events = readRawEvents(t.fd, buf, view);

      // Steam Input virtual pads are grab-only: while intercepting we hold
      // EVIOCGRAB so the game underneath gets nothing. We never feed their
      // events to NavController (the physical pads already drive overlay nav;
      // this mirrors them, so processing both would double every input) and
      // never run wake detection on them. readRawEvents above already drained
      // the fd so its buffer can't back up — just skip the rest.
      if (t.grabOnly) continue;

      // Wake detection runs in every mode on every device.
      for (const e of events) {
        if (e.type !== EV_KEY) continue;
        if (t.dev.flags.isController) {
          const wake = processCombo(t.combo, e.code, e.value, now);
          if (wake) {
            trace(
              `[input-intercept] wake=${wake} from '${t.dev.name}' (${t.path})`,
            );
            opts.onWake(wake);
          }
        }
        if (t.dev.flags.isKeyboard) {
          const wake = processShortcut(t.shortcut, e.code, e.value);
          if (wake) {
            trace(
              `[input-intercept] wake=${wake} from '${t.dev.name}' (${t.path})`,
            );
            opts.onWake(wake);
          }
        }
        if (t.dev.flags.isQam && e.code === KEY_F16 && e.value === 1) {
          trace(
            `[input-intercept] wake=QamToggle from '${t.dev.name}' (${t.path})`,
          );
          opts.onWake("QamToggle");
        }
      }

      // During intercept, forward nav-relevant events to NavController.
      // Always call processEvents (even with []) so held buttons keep
      // key-repeating.
      if (intercepting && t.dev.flags.isController) {
        const cid = `${t.dev.hash}_${generation}`;
        const input = toInputEvents(events, t.cal);
        nav.processEvents(cid, input);
      }
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  function startTimer(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(pollOnce, intercepting ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }
  startTimer();

  // Re-sync a freshly-grabbed device's combo + NavController state to the
  // kernel's ACTUAL current button/axis state. EVIOCGRAB/EVIOCSMASK only
  // deliver edge events, so a button-up or axis-center lost across the
  // grab/mask transition would otherwise leave a control stuck "held".
  function resyncDeviceState(
    t: TrackedDevice,
    mods?: { guide: boolean; select: boolean },
  ): void {
    if (t.grabOnly) return;
    const m = mods ?? readModifierState(t.fd);
    t.combo.guideHeld = m.guide;
    t.combo.selectHeld = m.select;
    const axisEvents = readDirectionalAxisState(t.fd, t.cal);
    if (axisEvents.length > 0) {
      nav.processEvents(`${t.dev.hash}_${generation}`, axisEvents);
    }
  }

  /** EVIOCGRAB one tracked device + re-sync its state. Idempotent on
   *  already-grabbed devices. Shared by the immediate path and the
   *  deferred-grab path (pollOnce). */
  function grabDevice(
    t: TrackedDevice,
    mods?: { guide: boolean; select: boolean },
  ): void {
    if (!t.grabbed) {
      const intBuf = new Int32Array([1]);
      const rc = libc.symbols.ioctl(t.fd, EVIOCGRAB, ptr(intBuf));
      if (rc === 0) {
        t.grabbed = true;
        console.log(
          `[input-intercept] grabbed ${t.path} '${t.dev.name}'${t.grabOnly ? " (virtual, grab-only)" : ""}`,
        );
      } else {
        // EBUSY is normal if another app (old overlay instance,
        // steamcompmgr) has it — log and move on.
        console.warn(`[input-intercept] grab failed for ${t.path} (rc=${rc})`);
      }
    }
    resyncDeviceState(t, mods);
  }

  function doGrab(): void {
    if (intercepting) return;
    intercepting = true;
    generation += 1;
    nav.reset();
    pendingGrabs.clear();
    for (const t of tracked) {
      if (!t.dev.flags.isController) continue;
      // Fresh modifier state each cycle: a guide/select/ctrl release missed
      // last session must not leave guideHeld stuck (→ every B reads as
      // Guide+B → re-toggles the overlay). resyncDeviceState below then
      // re-seeds from real hardware.
      t.combo = newComboState();
      t.shortcut = newShortcutState();
      // grab-only virtual mirrors don't carry the user-held modifier and
      // resyncDeviceState no-ops on them, so just grab immediately.
      if (t.grabOnly) {
        grabDevice(t);
        continue;
      }
      applyInterceptMasks(t.fd);
      // Read the kernel button bitmap once: it both decides the deferral
      // below and seeds resyncDeviceState (passed into grabDevice), so we
      // never read EVIOCGKEY twice for the same grab.
      const mods = readModifierState(t.fd);
      // Defer the EVIOCGRAB while the toggle modifier (Guide/BTN_MODE) is
      // still physically held. The overlay opens on Guide+B; if we grab now,
      // the user's Guide-RELEASE lands on us (grabbed) and never reaches the
      // app underneath, leaving Steam stuck in "Guide held" after we close —
      // every button then reads as a Guide chord (X→keyboard, L2→zoom,
      // R2→screenshot, stick→volume), looking like a dead controller. While
      // we hold off, the app still reads the (ungrabbed) device, so it
      // observes the release; pollOnce grabs the instant Guide goes up.
      if (!t.grabbed && mods.guide) {
        pendingGrabs.set(t, performance.now() + DEFER_GRAB_TIMEOUT_MS);
        console.log(
          `[input-intercept] deferring grab of ${t.path} '${t.dev.name}' until Guide released`,
        );
        continue;
      }
      grabDevice(t, mods);
    }
    startTimer();
  }

  function doRelease(): void {
    if (!intercepting) return;
    intercepting = false;
    // Cancel any grab still deferred (overlay closed before Guide released).
    // Those devices were never grabbed, so the loop below leaves them be.
    pendingGrabs.clear();
    for (const t of tracked) {
      if (!t.dev.flags.isController) continue;
      if (t.grabbed) {
        // Kernel semantics (drivers/input/evdev.c): EVIOCGRAB treats the
        // ioctl arg as a pointer and only checks null-vs-non-null — any
        // non-null value GRABS, null RELEASES. Passing ptr() of a buffer
        // (even one containing zero) gives a valid heap address → kernel
        // would grab again. Pass literal null so bun:ffi marshals it as
        // NULL and the kernel ungrabs.
        libc.symbols.ioctl(t.fd, EVIOCGRAB, null);
        t.grabbed = false;
      }
      if (!t.grabOnly) applyIdleMasks(t.fd, t.dev);
      // Clear modifier state so it can't carry into the next idle cycle and
      // fire a phantom Guide+B / Ctrl+4 wake. Idle-mode combo detection
      // rebuilds guideHeld from fresh BTN_MODE presses.
      t.combo = newComboState();
      t.shortcut = newShortcutState();
    }
    nav.reset();
    console.log(
      `[input-intercept] released ${tracked.filter((t) => t.dev.flags.isController).length} controller(s)`,
    );
    startTimer();
  }

  // ---- Hot-plug -----------------------------------------------------------
  //
  // Bluetooth pads paired mid-session create a new /dev/input/eventN node
  // after startInputIntercept has already run, so the snapshot enumeration
  // above misses them. The inotify watcher fires onAdded for each new node;
  // we re-enumerate /proc to get the device's name + capability bitmask
  // and, if it qualifies, open + (if currently intercepting) grab it
  // exactly as the boot-time path does.

  async function handleDeviceAdded(eventPath: string): Promise<void> {
    if (tracked.some((t) => t.path === eventPath)) return;
    let fresh: InputDevice | undefined;
    try {
      const all = await enumerateDevices();
      fresh = all.find((d) => d.eventPath === eventPath);
    } catch (err) {
      console.warn(
        `[input-intercept] hotplug: enumerate failed for ${eventPath}:`,
        err,
      );
      return;
    }
    if (!fresh) return;
    const eligible =
      fresh.flags.isController ||
      fresh.flags.isKeyboard ||
      fresh.flags.isQam;
    if (!eligible) return;
    const t = openAndTrack(fresh);
    if (!t) return;
    // If the overlay is open, the new controller has to participate in
    // the intercept the same way the boot-time controllers do:
    // broaden masks + EVIOCGRAB (grab-only virtual pads just get the grab,
    // so a pad's Steam Input virtual node created on connect is silenced too).
    // Keyboards / qam don't get grabbed.
    if (intercepting && t.dev.flags.isController) {
      if (!t.grabOnly) applyInterceptMasks(t.fd);
      const intBuf = new Int32Array([1]);
      const rc = libc.symbols.ioctl(t.fd, EVIOCGRAB, ptr(intBuf));
      if (rc === 0) {
        t.grabbed = true;
        console.log(
          `[input-intercept] hotplug grabbed ${t.path} '${t.dev.name}'${t.grabOnly ? " (virtual, grab-only)" : ""}`,
        );
      } else {
        console.warn(
          `[input-intercept] hotplug grab failed for ${t.path} (rc=${rc})`,
        );
      }
      resyncDeviceState(t);
    }
  }

  function handleDeviceRemoved(eventPath: string): void {
    const idx = tracked.findIndex((t) => t.path === eventPath);
    if (idx < 0) return;
    const [t] = tracked.splice(idx, 1);
    if (t.grabbed) {
      libc.symbols.ioctl(t.fd, EVIOCGRAB, null);
      t.grabbed = false;
    }
    libc.symbols.close(t.fd);
    console.log(`[input-intercept] hotplug removed ${t.path} '${t.dev.name}'`);
  }

  const hotplug: DeviceHotplugHandle | null = startDeviceHotplug({
    onAdded: (path) => {
      handleDeviceAdded(path).catch((e) =>
        console.warn(`[input-intercept] hotplug add threw for ${path}:`, e),
      );
    },
    onRemoved: handleDeviceRemoved,
  });
  warnIfHotplugDisabled(hotplug);

  // Belt-and-braces reconciliation: poll /proc/bus/input/devices every
  // few seconds and diff against `tracked`. inotify is the fast path
  // (instant response) but on some kernels / sandbox configs the events
  // never reach our read() loop, so we cannot rely on it alone. The
  // proc-fs scan is cheap (~10 KB read, few regex matches per block) and
  // catches anything inotify missed.
  const RECONCILE_INTERVAL_MS = 2000;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  async function reconcileTracked(): Promise<void> {
    let all: InputDevice[];
    try {
      all = await enumerateDevices();
    } catch (err) {
      console.warn("[input-intercept] reconcile: enumerate failed:", err);
      return;
    }
    const seen = new Set(all.map((d) => d.eventPath));
    // Removals: tracked entries whose eventPath has vanished from /proc.
    for (const t of [...tracked]) {
      if (!seen.has(t.path)) {
        console.log(
          `[input-intercept] reconcile: ${t.path} '${t.dev.name}' gone — removing`,
        );
        handleDeviceRemoved(t.path);
      }
    }
    // Additions: eligible /proc entries we don't already track.
    const trackedPaths = new Set(tracked.map((t) => t.path));
    for (const dev of all) {
      if (trackedPaths.has(dev.eventPath)) continue;
      const eligible =
        dev.flags.isController ||
        dev.flags.isKeyboard ||
        dev.flags.isQam;
      if (!eligible) continue;
      console.log(
        `[input-intercept] reconcile: ${dev.eventPath} '${dev.name}' new — opening`,
      );
      const t = openAndTrack(dev);
      if (t && intercepting && t.dev.flags.isController) {
        if (!t.grabOnly) applyInterceptMasks(t.fd);
        const intBuf = new Int32Array([1]);
        const rc = libc.symbols.ioctl(t.fd, EVIOCGRAB, ptr(intBuf));
        if (rc === 0) {
          t.grabbed = true;
          console.log(
            `[input-intercept] reconcile grabbed ${t.path} '${t.dev.name}'${t.grabOnly ? " (virtual, grab-only)" : ""}`,
          );
        }
        resyncDeviceState(t);
      }
    }
  }
  reconcileTimer = setInterval(() => {
    reconcileTracked().catch((e) =>
      console.warn("[input-intercept] reconcile threw:", e),
    );
  }, RECONCILE_INTERVAL_MS);

  return {
    grab: doGrab,
    release: doRelease,
    shutdown: () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = null;
      hotplug?.shutdown();
      if (intercepting) doRelease();
      for (const t of tracked) libc.symbols.close(t.fd);
      tracked.length = 0;
    },
    get deviceCount() {
      return tracked.length;
    },
  };
}

// ---- Test helpers (exported for unit tests only) ---------------------------

export const __testing__ = {
  buildBitmask,
  encodeInputMask,
  processCombo,
  processShortcut,
  newComboState,
  newShortcutState,
  toInputEvents,
  normalizeAxis,
  eviocgabs,
  eviocgkey,
  absCodeToAxis,
};
