// InputPlumber "intercept mode" input path — an alternative to the
// EVIOCGRAB grab in input-intercept.ts for hosts where InputPlumber (IP)
// manages the controller.
//
// WHY THIS EXISTS
// ----------------
// On IP-managed handhelds running SteamOS (OneXPlayer APEX, ROG Ally, …)
// the wake-button profile routes the pad through a `deck-uhid` target —
// a HID device behind hid-steam → Steam Input, with NO grabbable evdev.
// So the evdev path's EVIOCGRAB grabs 0 controllers and Steam BPM keeps
// driving nav *behind* the open overlay. (See input-intercept.ts and the
// fix/overlay-input-focus-grab branch for the full diagnosis.)
//
// IP's own mechanism solves this cleanly. Every IP composite device has:
//   - a writable `InterceptMode` property (0=None, 1=Pass, 2=Always,
//     3=GamepadOnly), and
//   - a permanently-attached DBus *target* (`…/devices/target/dbusN`) that
//     emits an `InputEvent(String capability, double value)` signal.
//
// We use mode 3 = GamepadOnly. In this mode IP routes only GAMEPAD events
// to the DBus target (so Steam BPM is starved of d-pad/stick/face-button
// nav → it stops) while KEYBOARD events still pass through to the normal
// keyboard target. That keyboard pass-through is deliberate and load-
// bearing: the overlay's wake button is rendered (by the input-plumber
// plugin) as `gamepad button → KeyF16`, so under GamepadOnly the F16 still
// reaches the IP keyboard evdev and the EXISTING evdev wake path
// (input-intercept.ts) catches it to CLOSE the overlay. (Mode 2 = Always
// swallows the keyboard event too, which is why the wake button couldn't
// close the overlay — see git history of this module.)
//
// We subscribe to the DBus InputEvent signals, translate the `ui_*`
// capabilities to the SAME NavController InputEvents the evdev path uses,
// so the webview side is unchanged.
//
// Verified on-device (OXP APEX, SteamOS): GamepadOnly freezes Steam BPM
// nav and the DBus target emits ui_up / ui_down / ui_left / ui_right /
// ui_accept / ui_back / ui_guide / ui_quick as press(1.0)/release(0.0)
// pairs, while the F16 wake button still closes via the evdev path.
//
// WHY ALONGSIDE, NOT INSTEAD OF, THE EVDEV PATH
// ----------------------------------------------
// This only works when IP is in the loop. On Bazzite/CachyOS/desktop where
// IP isn't managing the pad there's no composite device to intercept, so
// the evdev grab in input-intercept.ts stays as the universal fallback.
// `available` is false there and grab()/release() are no-ops.
//
// Permissions: setting InterceptMode and receiving the DBus signals both
// work for non-root clients — the IP D-Bus policy
// (org.shadowblip.InputPlumber.conf) currently allows `context="default"`
// to receive signals (there's an upstream TODO to gate this behind an
// alternative API; if that lands, this path needs the backend to relay).
//
// We shell out to `busctl` (set InterceptMode, discover composites) and
// `gdbus monitor` (receive InputEvent signals) rather than pulling in a
// D-Bus library — both are present on every IP host and keep this module
// dependency-free, matching the rest of native/.

import { runFull, runStreaming } from "@loadout/exec";
import { NavController, type InputEvent } from "./nav-controller";
import { trace } from "./trace";

const SERVICE = "org.shadowblip.InputPlumber";
const COMPOSITE_IFACE = "org.shadowblip.Input.CompositeDevice";

// busctl can block on the system-bus default timeout (~25s) while IP is
// mid-restart; cap discovery/set calls so a stuck bus can't wedge a toggle.
// Matches the backend ipdbus.ts client.
const BUSCTL_TIMEOUT_MS = 5000;

const COMPOSITE_PATH_RE = /^\/org\/shadowblip\/InputPlumber\/CompositeDevice\d+$/;

/** Pump cadence while intercepting — services NavController key-repeat for
 *  held d-pad directions between signal arrivals. Mirrors the evdev path's
 *  POLL_ACTIVE_MS. */
const PUMP_MS = 25;

/** NavController keys per-controller state by id; the DBus stream is a
 *  single logical controller, so a constant id is fine. */
const NAV_CONTROLLER_ID = "ip-dbus";

// ---- busctl helpers --------------------------------------------------------

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function exec(cmd: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr, exitCode } = await runFull(cmd, {
      timeoutMs: BUSCTL_TIMEOUT_MS,
    });
    return { ok: exitCode === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

function busctl(args: string[]): Promise<ExecResult> {
  return exec(["busctl", "--system", "--no-pager", ...args]);
}

/** Pluck top-level CompositeDevice paths from `busctl tree --list` output. */
export function pickCompositePaths(treeStdout: string): string[] {
  const out: string[] = [];
  for (const line of treeStdout.split("\n")) {
    const t = line.trim();
    if (COMPOSITE_PATH_RE.test(t)) out.push(t);
  }
  return out;
}

async function listCompositePaths(): Promise<string[]> {
  const r = await busctl(["tree", "--list", SERVICE]);
  if (!r.ok) return [];
  return pickCompositePaths(r.stdout);
}

/** InterceptMode values (org.shadowblip.Input.CompositeDevice):
 *  0=None, 1=Pass, 2=Always, 3=GamepadOnly. We toggle between 0 (off) and
 *  3 (gamepad-only intercept) — see the file header for why GamepadOnly. */
const INTERCEPT_OFF = 0;
const INTERCEPT_GAMEPAD_ONLY = 3;

async function setInterceptMode(
  path: string,
  mode: typeof INTERCEPT_OFF | typeof INTERCEPT_GAMEPAD_ONLY,
): Promise<void> {
  const r = await busctl([
    "set-property",
    SERVICE,
    path,
    COMPOSITE_IFACE,
    "InterceptMode",
    "u",
    String(mode),
  ]);
  if (!r.ok) {
    console.warn(
      `[ip-intercept] set InterceptMode=${mode} failed for ${path}: ${r.stderr.trim()}`,
    );
  }
}

// ---- ui_* capability → NavController InputEvent ----------------------------
//
// IP intercept translates physical input into the `ui_*` capability set
// (the DBus:ui_* TargetCapabilities). We re-express them as the same
// button/axis InputEvents the evdev reader produces, so NavController's
// key-repeat + deadzone logic is reused verbatim. Directions map onto the
// hat axes (value ±1 on press, 0 on release); accept/back/bumpers onto the
// face/shoulder buttons.

interface NavMap {
  kind: "axis";
  axis: "HatX" | "HatY";
  sign: 1 | -1;
}
interface BtnMap {
  kind: "button";
  button: "A" | "B" | "LB" | "RB";
}

const UI_NAV: Record<string, NavMap | BtnMap> = {
  ui_up: { kind: "axis", axis: "HatY", sign: -1 },
  ui_down: { kind: "axis", axis: "HatY", sign: 1 },
  ui_left: { kind: "axis", axis: "HatX", sign: -1 },
  ui_right: { kind: "axis", axis: "HatX", sign: 1 },
  ui_accept: { kind: "button", button: "A" },
  ui_back: { kind: "button", button: "B" },
  ui_l1: { kind: "button", button: "LB" },
  ui_r1: { kind: "button", button: "RB" },
};

/** ui_* capabilities that ALSO toggle the overlay closed while it's open.
 *  Under GamepadOnly the bound wake button (KeyF16) already closes via the
 *  evdev path, so these are a redundant convenience: the Guide/QAM-class
 *  buttons are gamepad buttons, so in GamepadOnly they arrive over DBus and
 *  give a "get me out" control even if the user never bound a wake button.
 *  Every received ui_* is trace-logged so unmapped controls are easy to
 *  spot on-device. */
const UI_WAKE = new Set(["ui_guide", "ui_quick", "ui_quick2", "ui_osk"]);

/** Map a (capability, value) pair to a NavController InputEvent, or null if
 *  it isn't a nav capability. `pressed` = value past the half threshold. */
export function uiToInputEvent(cap: string, value: number): InputEvent | null {
  const m = UI_NAV[cap];
  if (!m) return null;
  const pressed = value >= 0.5;
  if (m.kind === "axis") {
    return { kind: "axis", axis: m.axis, value: pressed ? m.sign : 0 };
  }
  return { kind: "button", button: m.button, pressed };
}

/** Parse one `gdbus monitor` line into a (capability, value) pair, or null.
 *  Line shape:
 *    /org/.../target/dbus0: org.shadowblip.Input.DBusDevice.InputEvent ('ui_up', 1.0)
 */
export function parseInputEventLine(
  line: string,
): { cap: string; value: number } | null {
  const m = line.match(/\.InputEvent\s+\('([^']+)',\s*([-0-9.eE]+)\)/);
  if (!m) return null;
  // Both capture groups are mandatory in the regex, so on a match m[1]
  // and m[2] are always present.
  const value = Number.parseFloat(m[2]!);
  if (Number.isNaN(value)) return null;
  return { cap: m[1]!, value };
}

// ---- Public API ------------------------------------------------------------

export interface IpInterceptOptions {
  /** Nav actions for the webview — wire to sendToWebview("overlay-action"). */
  onAction: (action: string) => void;
  /** Continuous right-stick analog scroll — wire to "overlay-scroll".
   *  (IP doesn't currently surface analog over the ui_* set, but the hook
   *  matches the evdev path's shape for symmetry.) */
  onAxis?: (axis: "RightStickX" | "RightStickY", value: number) => void;
  /** A wake/close trigger seen on the DBus stream while intercepting — wire
   *  to the same onWake() that evdev wake events use. */
  onWake: (event: "QamToggle") => void;
  /** Diagnostics: number of IP composite devices discovered. */
  onReady?: (info: { composites: number }) => void;
}

export interface IpInterceptHandle {
  /** True when ≥1 IP composite device exists — i.e. this path is usable on
   *  this host. When false, grab()/release() are no-ops and the evdev path
   *  in input-intercept.ts is the one doing the work. */
  readonly available: boolean;
  /** Begin intercept — InterceptMode=2 on every composite device. Steam is
   *  starved; nav arrives over DBus. Safe to call when unavailable. */
  grab(): void;
  /** End intercept — InterceptMode=0; input flows back to Steam. */
  release(): void;
  /** Stop the signal monitor and ensure InterceptMode is back to 0. */
  shutdown(): void;
}

export async function startIpIntercept(
  opts: IpInterceptOptions,
): Promise<IpInterceptHandle> {
  const composites = await listCompositePaths();
  const available = composites.length > 0;

  opts.onReady?.({ composites: composites.length });

  if (!available) {
    // No IP in the loop — the evdev path handles this host. Return an inert
    // handle so the orchestrator can call grab/release unconditionally.
    return {
      available: false,
      grab() {},
      release() {},
      shutdown() {},
    };
  }

  console.log(
    `[ip-intercept] ${composites.length} IP composite device(s): ${composites.join(", ")}`,
  );

  // Belt-and-braces: clear any stale intercept on startup. Unlike EVIOCGRAB
  // (auto-released by the kernel when the holding fd closes), InterceptMode
  // is daemon-side state in InputPlumber that OUTLIVES this process — a
  // crash, SIGKILL, or a service restart while the overlay was open leaves
  // the composite stuck in GamepadOnly, deadening the pad in Steam. Forcing
  // it back to 0 here means a fresh overlay always starts from a known-good
  // state regardless of how the previous instance died.
  for (const p of composites) {
    await setInterceptMode(p, INTERCEPT_OFF);
  }

  let intercepting = false;
  let pumpTimer: ReturnType<typeof setInterval> | null = null;

  const nav = new NavController({
    emit: (a) => opts.onAction(a),
    emitAxis: (axis, value) => opts.onAxis?.(axis, value),
  });

  function feed(cap: string, value: number): void {
    if (!intercepting) return;
    const ev = uiToInputEvent(cap, value);
    if (ev) {
      nav.processEvents(NAV_CONTROLLER_ID, [ev]);
      return;
    }
    if (UI_WAKE.has(cap) && value >= 0.5) {
      trace(`[ip-intercept] wake=QamToggle from ${cap}`);
      opts.onWake("QamToggle");
      return;
    }
    // Unmapped capability — trace it so an unrecognised wake button or a
    // nav cap we haven't mapped yet is easy to spot on-device.
    if (value >= 0.5) trace(`[ip-intercept] unmapped ui event: ${cap}=${value}`);
  }

  // ---- gdbus signal monitor ----------------------------------------------
  //
  // One long-lived `gdbus monitor` over the whole IP service. It only ever
  // emits InputEvent signals while some composite is intercepting, so
  // leaving it running when idle is free. runStreaming drains stdout
  // line-by-line; `feed` gates on `intercepting` so any stray late signal
  // after release() is ignored. The promise stays pending until shutdown
  // kills the captured subprocess.
  let monitorProc: { kill: () => void } | null = null;
  runStreaming(["gdbus", "monitor", "--system", "--dest", SERVICE], {
    onSpawn: (proc) => {
      monitorProc = proc;
    },
    onLine: (line) => {
      const parsed = parseInputEventLine(line);
      if (parsed) feed(parsed.cap, parsed.value);
    },
  }).catch((e) => console.warn("[ip-intercept] monitor reader threw:", e));

  function startPump(): void {
    if (pumpTimer) clearInterval(pumpTimer);
    // Empty-batch pumps service held-direction key repeat between arrivals.
    pumpTimer = setInterval(() => {
      if (intercepting) nav.processEvents(NAV_CONTROLLER_ID, []);
    }, PUMP_MS);
  }

  function stopPump(): void {
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = null;
  }

  function doGrab(): void {
    if (intercepting) return;
    intercepting = true;
    nav.reset();
    for (const p of composites) {
      setInterceptMode(p, INTERCEPT_GAMEPAD_ONLY).catch(() => {});
    }
    startPump();
    console.log(
      `[ip-intercept] intercept ON — InterceptMode=GamepadOnly(3) on ${composites.length} device(s)`,
    );
  }

  function doRelease(): void {
    if (!intercepting) return;
    intercepting = false;
    for (const p of composites) {
      setInterceptMode(p, INTERCEPT_OFF).catch(() => {});
    }
    stopPump();
    nav.reset();
    console.log("[ip-intercept] intercept OFF — InterceptMode=None(0)");
  }

  return {
    available: true,
    grab: doGrab,
    release: doRelease,
    shutdown() {
      stopPump();
      if (intercepting) {
        // Best-effort synchronous-ish reset so we don't strand the pad.
        for (const p of composites) setInterceptMode(p, INTERCEPT_OFF).catch(() => {});
        intercepting = false;
      }
      try {
        monitorProc?.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
