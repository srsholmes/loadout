/**
 * Overlay-wake orchestration — the privileged, stateful half of the feature.
 *
 * The Loadout backend runs as root, so every step here is plain TypeScript:
 * fs writes for the profile / device override / udev rule, and @loadout/exec
 * for busctl / systemctl / udevadm. No shell scripts, no systemd one-shot —
 * boot persistence is handled by `reloadPersistedProfile()`, which the backend
 * calls on load (it comes up before the overlay user-service, so the IP
 * keyboard exists before the overlay enumerates devices).
 *
 * Pure templating + capability parsing lives in ./profile; the busctl client
 * lives in ./ipdbus. This module wires them to the system.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname } from "node:path";
import { runFull } from "@loadout/exec";
import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";
import {
  listCompositeDevices,
  getTargetKinds,
  loadProfilePath,
  inputPlumberAvailable,
  type CompositeDevice,
} from "./ipdbus";
import {
  parseCapability,
  buttonOptions,
  labelFor,
  renderProfile,
  renderCaptureProfile,
  renderClearedProfile,
  PROFILE_PATH,
  UACCESS_RULE_PATH,
  UACCESS_RULE,
} from "./profile";
import * as wakeDeck from "./wake-trigger-deck";
import type {
  WakeStatus,
  WakeStatusDevice,
  WakeOpResult,
  WakeCaptureResult,
} from "../shared";

export type { WakeStatus, WakeOpResult, WakeCaptureResult };

/** Re-exported so backend.ts can run it from onLoad without reaching into
 *  the Deck-specific submodule. No-ops cleanly on non-Deck because it just
 *  writes a udev rule scoped to Valve Deck VID/PIDs — harmless where no
 *  matching device exists, but you should still gate the call on
 *  isSteamDeck() to avoid pointless udev reloads on non-Deck hosts. */
export { ensureDeckHidrawUaccess } from "./wake-trigger-deck";

const PLUGIN_ID = "input-plumber";
const EXEC_TIMEOUT_MS = 10_000;

// ── persisted state ─────────────────────────────────────────────────────────

interface WakeState {
  wake?: {
    /** Raw capability string the user bound, e.g. "Gamepad:Button:RightPaddle1". */
    selectedRaw: string | null;
    /** CompositeDevice.Name the binding was made against (stability hint). */
    deviceName: string | null;
  };
}

async function readWake(): Promise<WakeState["wake"] | undefined> {
  const s = await readPluginStorage<WakeState>(PLUGIN_ID);
  return s.wake;
}

async function writeWake(wake: WakeState["wake"]): Promise<void> {
  // Merge into the plugin's existing storage object rather than clobbering it.
  const existing = await readPluginStorage<WakeState>(PLUGIN_ID);
  await writePluginStorage<WakeState>(PLUGIN_ID, { ...existing, wake });
}

// ── device detection ────────────────────────────────────────────────────────

/** Steam Deck DMI signatures (product_name). Same identifiers tdp-control
 *  uses. We also accept a Valve sys_vendor as a belt-and-braces fallback. */
const DECK_PRODUCTS = ["Jupiter", "Galileo"];

async function readSysAttr(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf-8")).trim();
  } catch {
    return "";
  }
}

export async function isSteamDeck(): Promise<boolean> {
  const product = await readSysAttr("/sys/class/dmi/id/product_name");
  if (DECK_PRODUCTS.some((p) => product.includes(p))) return true;
  const vendor = await readSysAttr("/sys/class/dmi/id/sys_vendor");
  return vendor.includes("Valve");
}

// ── status ──────────────────────────────────────────────────────────────────

/** Probe for a pre-existing IP profile that has user-relevant mappings.
 *  Used so the UI can warn before press-to-capture replaces them. Cheap
 *  probe: existence + at least one `mapping:` entry that isn't `[]`. */
const LEGACY_DEFAULT_PROFILE = "/var/lib/inputplumber/data/inputplumber/profiles/default.yaml";

export async function hasLegacyProfile(): Promise<boolean> {
  try {
    const content = await readFile(LEGACY_DEFAULT_PROFILE, "utf-8");
    // YAML `mapping: []` (empty) is fine; only flag when there's substantive
    // content. Look for at least one `- name:` entry under a mapping block.
    return /\bmapping:\s*\n\s*-\s+name:/.test(content);
  } catch {
    return false;
  }
}

export async function getWakeStatus(): Promise<WakeStatus> {
  if (await isSteamDeck()) return wakeDeck.getWakeStatus();
  // Non-Deck only past this point — isDeck is always false here, drop the
  // redundant isSteamDeck() probe from the parallel fan-out.
  const [ipActive, wake, legacy] = await Promise.all([
    inputPlumberAvailable(),
    readWake(),
    hasLegacyProfile(),
  ]);
  let devices: WakeStatusDevice[] = [];
  if (ipActive) {
    const composites = await listCompositeDevices();
    devices = composites.map((d) => ({
      name: d.name,
      buttons: buttonOptions(d.capabilities),
    }));
  }
  return {
    ipActive,
    isDeck: false,
    devices,
    selectedRaw: wake?.selectedRaw ?? null,
    hasLegacyProfile: legacy,
  };
}

// ── privileged setup helpers ────────────────────────────────────────────────

async function writeFileMkdir(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

async function exec(cmd: string[]): Promise<{ ok: boolean; err: string }> {
  try {
    const { exitCode, stderr } = await runFull(cmd, { timeoutMs: EXEC_TIMEOUT_MS });
    return { ok: exitCode === 0, err: stderr.trim() };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

/** Install the uaccess udev rule (idempotent) and reload udev so it applies to
 *  the already-present IP keyboard without a replug. */
async function ensureUaccessRule(): Promise<void> {
  await writeFileMkdir(UACCESS_RULE_PATH, UACCESS_RULE);
  await exec(["udevadm", "control", "--reload"]);
  await exec(["udevadm", "trigger", "--subsystem-match=input"]);
}

async function waitForIp(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await inputPlumberAvailable()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Choose the composite device a binding applies to: the one whose
 *  capabilities include the chosen button, else the remembered device by name,
 *  else the first connected composite. */
function pickDevice(
  composites: CompositeDevice[],
  raw: string | null,
  rememberedName: string | null,
): CompositeDevice | null {
  if (composites.length === 0) return null;
  if (raw) {
    const byCap = composites.find((d) => d.capabilities.includes(raw));
    if (byCap) return byCap;
  }
  if (rememberedName) {
    const byName = composites.find((d) => d.name === rememberedName);
    if (byName) return byName;
  }
  // Guarded above: composites is non-empty, so composites[0] is present; the
  // ?? null only satisfies the checker (return type already allows null) and
  // never fires for real inputs.
  return composites[0] ?? null;
}

// ── public operations ───────────────────────────────────────────────────────

/**
 * Get InputPlumber ready to bind a wake button: on a Deck, enable + claim the
 * controller and write the auto_manage override; everywhere, install the
 * uaccess rule so the overlay can read IP's virtual keyboard. Idempotent, and
 * required before the picker can enumerate a Deck's buttons (IP ships disabled
 * there, so there's nothing to list until this runs).
 */
export async function prepareWake(): Promise<WakeOpResult> {
  if (await isSteamDeck()) return wakeDeck.prepareWake();
  // Non-Deck only past this point. The ensureDeckManaged / Deck-override
  // branches that used to live here are unreachable now — the Deck path
  // owns its own prepareWake in wake-trigger-deck.ts.
  if (!(await inputPlumberAvailable())) {
    return { ok: false, error: "InputPlumber is not running." };
  }
  await ensureUaccessRule();
  return { ok: true };
}

/**
 * Bind `raw` (a capability string from the picker) to the overlay wake key.
 * Does the full idempotent setup via `prepareWake`, renders the profile
 * preserving the device's targets, live-loads it, and persists the choice.
 * Re-callable to change the button (no reboot).
 */
export async function setWakeButton(raw: string): Promise<WakeOpResult> {
  if (await isSteamDeck()) return wakeDeck.setWakeButton(raw);
  const prepared = await prepareWake();
  if (!prepared.ok) return prepared;

  const composites = await listCompositeDevices();
  const wake = await readWake();
  const device = pickDevice(composites, raw, wake?.deviceName ?? null);
  if (!device) return { ok: false, error: "No InputPlumber device found." };

  const targets = await getTargetKinds(device.path);
  const yaml = renderProfile(parseCapability(raw), targets);
  await writeFileMkdir(PROFILE_PATH, yaml);

  const loaded = await loadProfilePath(device.path, PROFILE_PATH);
  if (!loaded.ok) {
    return {
      ok: false,
      error: `LoadProfilePath failed: ${loaded.stderr.trim() || `exit ${loaded.code}`}`,
    };
  }

  await writeWake({ selectedRaw: raw, deviceName: device.name });
  console.log(
    `[input-plumber] wake bound + persisted (setWakeButton): raw="${raw}" device="${device.name}"`,
  );
  return { ok: true };
}

// ── press-to-capture ────────────────────────────────────────────────────────

/** Where /proc/bus/input/devices is — overridable for tests. */
const PROC_INPUT_DEVICES = "/proc/bus/input/devices";

/** evdev input_event struct on x86_64: u64 sec + u64 usec + u16 type + u16 code + u32 value = 24 bytes. */
const EVENT_BYTES = 24;
const EV_KEY = 1;

/** Parse /proc/bus/input/devices to find the eventN node for a device by name.
 *  Returns the *highest-numbered* match — IP recreates its virtual keyboard
 *  on every LoadProfilePath, and `/proc/bus/input/devices` doesn't garbage-
 *  collect the dying entry immediately. The fresh node always has a higher
 *  eventN, so preferring max() avoids picking a node that's mid-tear-down. */
export function findEventNode(procContent: string, name: string): string | null {
  const blocks = procContent.split(/\n\n+/);
  let best: { num: number; path: string } | null = null;
  for (const block of blocks) {
    const nameMatch = block.match(/^N:\s+Name="([^"]+)"/m);
    if (!nameMatch || nameMatch[1] !== name) continue;
    const handlersMatch = block.match(/^H:\s+Handlers=(.*)$/m);
    if (!handlersMatch) continue;
    // Capture group 1 is mandatory, so on a match it is always present; ?? ""
    // only drops the `!` and is unreachable for a real match.
    const ev = (handlersMatch[1] ?? "").split(/\s+/).find((h) => /^event\d+$/.test(h));
    if (!ev) continue;
    const num = parseInt(ev.slice(5), 10);
    if (best === null || num > best.num) {
      best = { num, path: `/dev/input/${ev}` };
    }
  }
  return best?.path ?? null;
}

/** Read evdev events until we see a KEY_PRESS for a code in `accept`, or
 *  the deadline passes. Returns the accepted code, or null on timeout. */
async function readNextSentinelKey(
  path: string,
  accept: Set<number>,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(path);
    let buf: Buffer = Buffer.alloc(0);
    let done = false;
    const finish = (result: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stream.on("data", (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      while (buf.length >= EVENT_BYTES) {
        const type = buf.readUInt16LE(16);
        const code = buf.readUInt16LE(18);
        const value = buf.readInt32LE(20);
        buf = buf.subarray(EVENT_BYTES);
        if (type === EV_KEY && value === 1 && accept.has(code)) {
          finish(code);
          return;
        }
      }
    });
    stream.on("error", () => finish(null));
    stream.on("end", () => finish(null));
  });
}

/** Single-flight gate for `captureWakeButton`. A second concurrent call
 *  while the first is mid-listen would overwrite `PROFILE_PATH` and race
 *  on `LoadProfilePath`, leaving the catch-all profile loaded and a stale
 *  evdev listener on a dying virtual-keyboard node. */
let captureInflight: Promise<WakeCaptureResult> | null = null;

/**
 * Press-to-capture: write a transient profile mapping every recommended
 * button to a unique sentinel key, listen on the IP virtual keyboard for the
 * first sentinel press, then bind that button to F16 for real. On timeout or
 * error, restore the previous binding (or leave Off if there wasn't one).
 *
 * Concurrent calls are coalesced — the second caller awaits the first's
 * result rather than racing on `PROFILE_PATH`.
 *
 * Caller gets `{ ok, capturedRaw?, capturedLabel?, timedOut?, error? }`.
 */
export async function captureWakeButton(timeoutMs = 10_000): Promise<WakeCaptureResult> {
  if (await isSteamDeck()) return wakeDeck.captureWakeButton(timeoutMs);
  if (captureInflight) return captureInflight;
  // Clamp the timeout so a buggy caller can't wedge the inflight gate.
  const ms = Math.max(1000, Math.min(60_000, timeoutMs || 10_000));
  captureInflight = (async () => captureWakeButtonInner(ms))().finally(() => {
    captureInflight = null;
  });
  return captureInflight;
}

async function captureWakeButtonInner(timeoutMs: number): Promise<WakeCaptureResult> {
  const prepared = await prepareWake();
  if (!prepared.ok) return prepared;

  const composites = await listCompositeDevices();
  const wake = await readWake();
  const device = pickDevice(composites, null, wake?.deviceName ?? null);
  if (!device) return { ok: false, error: "No InputPlumber device found." };

  const opts = buttonOptions(device.capabilities);
  const recommended = opts.filter((o) => o.recommended);
  if (recommended.length === 0) {
    return { ok: false, error: "No recommendable buttons on this device." };
  }

  const targets = await getTargetKinds(device.path);
  const { yaml, sentinelToRaw } = renderCaptureProfile(opts, targets);
  await writeFileMkdir(PROFILE_PATH, yaml);
  // Surface the catch-all mapping so we can diagnose a timeout — if the
  // user's actual button isn't here, that's the bug, not the evdev read.
  console.log(
    `[input-plumber] capture catch-all: ${Array.from(sentinelToRaw.entries())
      .map(([code, raw]) => `${code}=${raw}`)
      .join(", ")}`,
  );

  const loaded = await loadProfilePath(device.path, PROFILE_PATH);
  if (!loaded.ok) {
    // Restore the previous binding so we don't leave the catch-all
    // sentinel profile loaded — without this the user's already-bound
    // button stops working in-session and self-heals only on the next
    // `reloadPersistedProfile`. The other two failure branches below
    // (timeout, final-load) already restore; this one was the outlier.
    await restorePreviousBinding(device, wake);
    return {
      ok: false,
      error: `LoadProfilePath (capture) failed: ${loaded.stderr.trim() || `exit ${loaded.code}`}`,
    };
  }

  // Find IP's virtual keyboard node; IP creates a fresh evdev on every
  // LoadProfilePath, so re-scan now rather than caching. Total budget ~6s
  // because on a Deck cold-boot IP can take 4-6s to publish the keyboard
  // after `prepareWake` enables the service.
  let kbPath: string | null = null;
  for (let i = 0; i < 30 && !kbPath; i++) {
    try {
      const proc = await readFile(PROC_INPUT_DEVICES, "utf-8");
      kbPath = findEventNode(proc, "InputPlumber Keyboard");
    } catch {
      kbPath = null;
    }
    if (!kbPath) await new Promise((r) => setTimeout(r, 200));
  }
  if (!kbPath) {
    await restorePreviousBinding(device, wake);
    return { ok: false, error: "Could not find InputPlumber virtual keyboard." };
  }
  console.log(`[input-plumber] capture listening on ${kbPath} for ${timeoutMs}ms`);

  const accept = new Set<number>(sentinelToRaw.keys());
  const code = await readNextSentinelKey(kbPath, accept, timeoutMs);
  if (code === null) {
    await restorePreviousBinding(device, wake);
    return { ok: false, timedOut: true, error: "No button pressed within the timeout." };
  }

  // `code` is one of sentinelToRaw's own keys (the `accept` set was built
  // from sentinelToRaw.keys()), so this lookup is always defined; the guard
  // drops the non-null `!` and restores like the other failure branches if
  // that invariant ever breaks (unreachable today).
  const raw = sentinelToRaw.get(code);
  if (raw === undefined) {
    await restorePreviousBinding(device, wake);
    return { ok: false, error: "Captured key was not in the sentinel map." };
  }
  // Render the real profile binding the captured button → F16.
  const realYaml = renderProfile(parseCapability(raw), targets);
  await writeFileMkdir(PROFILE_PATH, realYaml);
  const reload = await loadProfilePath(device.path, PROFILE_PATH);
  if (!reload.ok) {
    await restorePreviousBinding(device, wake);
    return {
      ok: false,
      error: `LoadProfilePath (final) failed: ${reload.stderr.trim() || `exit ${reload.code}`}`,
    };
  }

  await writeWake({ selectedRaw: raw, deviceName: device.name });
  console.log(
    `[input-plumber] wake bound + persisted (capture): raw="${raw}" device="${device.name}"`,
  );
  return {
    ok: true,
    capturedRaw: raw,
    capturedLabel: labelFor(parseCapability(raw)),
  };
}

/** Best-effort restore of a previous wake binding after a failed/cancelled
 *  capture. Falls back to a cleared profile if no previous binding existed. */
async function restorePreviousBinding(
  device: CompositeDevice,
  prev: WakeState["wake"] | undefined,
): Promise<void> {
  const targets = await getTargetKinds(device.path);
  const yaml = prev?.selectedRaw
    ? renderProfile(parseCapability(prev.selectedRaw), targets)
    : renderClearedProfile(targets);
  try {
    await writeFileMkdir(PROFILE_PATH, yaml);
    await loadProfilePath(device.path, PROFILE_PATH);
  } catch {
    // best-effort — surface nothing if restore itself errors.
  }
}

/** Disable the wake binding: load a no-mapping profile (controller keeps
 *  working) and forget the persisted selection. Persistence happens *after*
 *  a successful live load — if the load fails the persisted state stays
 *  authoritative so `reloadPersistedProfile` re-syncs on next boot. */
export async function clearWakeButton(): Promise<WakeOpResult> {
  if (await isSteamDeck()) return wakeDeck.clearWakeButton();
  if (!(await inputPlumberAvailable())) {
    await writeWake({ selectedRaw: null, deviceName: null });
    return { ok: true };
  }

  const composites = await listCompositeDevices();
  const device = pickDevice(composites, null, null);
  if (!device) {
    await writeWake({ selectedRaw: null, deviceName: null });
    return { ok: true };
  }

  const targets = await getTargetKinds(device.path);
  await writeFileMkdir(PROFILE_PATH, renderClearedProfile(targets));
  const loaded = await loadProfilePath(device.path, PROFILE_PATH);
  if (!loaded.ok) {
    return {
      ok: false,
      error: `LoadProfilePath failed: ${loaded.stderr.trim() || `exit ${loaded.code}`}`,
    };
  }
  await writeWake({ selectedRaw: null, deviceName: null });
  return { ok: true };
}

/**
 * Boot/onLoad reconciliation: if the user has a binding persisted, wait for IP
 * to come up and re-load the profile so the wake button works after a reboot.
 * Best-effort and non-throwing — logs via the returned result.
 */
export async function reloadPersistedProfile(): Promise<WakeOpResult> {
  if (await isSteamDeck()) return wakeDeck.reloadPersistedProfile();
  const wake = await readWake();
  if (!wake?.selectedRaw) {
    // Not an error, but log it: a lost/empty binding here is exactly how the
    // wake button silently reverts to its OS default after a reboot.
    console.log(
      `[input-plumber] wake reload: no persisted binding (${JSON.stringify(wake ?? null)}) — nothing to restore`,
    );
    return { ok: true };
  }
  console.log(
    `[input-plumber] wake reload: restoring binding raw="${wake.selectedRaw}" device="${wake.deviceName ?? "?"}"`,
  );

  // The IP service may have just started; give it a window to come up
  // before we conclude it's broken. 15s covers cold boot on slower handhelds.
  if (!(await waitForIp(15_000))) {
    console.warn(
      "[input-plumber] wake reload: InputPlumber did not come up within 15s — wake button NOT restored",
    );
    return { ok: false, error: "InputPlumber did not come up; wake button not reloaded." };
  }

  const composites = await listCompositeDevices();
  console.log(
    `[input-plumber] wake reload: IP up, ${composites.length} composite device(s): [${composites
      .map((d) => d.name)
      .join(", ")}]`,
  );
  const device = pickDevice(composites, wake.selectedRaw, wake.deviceName);
  if (!device) {
    console.warn(
      `[input-plumber] wake reload: bound device not found (wanted name="${wake.deviceName ?? "?"}" / cap="${wake.selectedRaw}") — wake button NOT restored`,
    );
    return { ok: false, error: "Bound device not connected; wake button not reloaded." };
  }
  // A capability-string mismatch (e.g. after an InputPlumber update renamed
  // the button) is a prime suspect for a reload that "succeeds" but doesn't
  // actually map anything — surface whether the saved cap is still present.
  const capPresent = device.capabilities.includes(wake.selectedRaw);
  console.log(
    `[input-plumber] wake reload: applying to device "${device.name}" (${device.path}); saved cap "${wake.selectedRaw}" ${
      capPresent ? "present" : "NOT PRESENT in device capabilities"
    }`,
  );

  // Re-render from the live targets in case the device's emulation changed,
  // then load. (The file may already exist from a prior boot, but re-rendering
  // keeps it correct if targets shifted.)
  const targets = await getTargetKinds(device.path);
  await writeFileMkdir(PROFILE_PATH, renderProfile(parseCapability(wake.selectedRaw), targets));
  const loaded = await loadProfilePath(device.path, PROFILE_PATH);
  if (loaded.ok) {
    console.log(
      `[input-plumber] wake reload: LoadProfilePath OK — wake button "${wake.selectedRaw}" restored on "${device.name}"`,
    );
    return { ok: true };
  }
  console.warn(
    `[input-plumber] wake reload: LoadProfilePath FAILED (exit ${loaded.code}${
      loaded.stderr ? `: ${loaded.stderr.trim()}` : ""
    })`,
  );
  return { ok: false, error: `LoadProfilePath failed: exit ${loaded.code}` };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Boot reconciliation with retry. `reloadPersistedProfile()` can transiently
 * fail on a cold boot when InputPlumber is up (so its internal `waitForIp`
 * passes) but the composite device hasn't been enumerated yet — it returns
 * "Bound device not connected", and a single-shot reload would drop the wake
 * binding for the whole session (the button silently reverts to its OS
 * default). Retrying a few times lets the pad finish enumerating.
 *
 * Cheap when nothing is bound: `reloadPersistedProfile()` returns `ok`
 * immediately, so the loop breaks on the first attempt with no delay.
 *
 * `reload` and `wait` are injectable so the retry logic is unit-testable
 * without real DBus or real multi-second sleeps.
 */
export async function reloadPersistedProfileWithRetry(
  opts: {
    attempts?: number;
    delayMs?: number;
    reload?: () => Promise<WakeOpResult>;
    wait?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, error: string) => void;
  } = {},
): Promise<WakeOpResult> {
  const attempts = Math.max(1, opts.attempts ?? 5);
  const delayMs = opts.delayMs ?? 2000;
  const reload = opts.reload ?? reloadPersistedProfile;
  const wait = opts.wait ?? delay;

  let last: WakeOpResult = { ok: true };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await reload();
    if (last.ok) break;
    opts.onRetry?.(attempt + 1, last.error ?? "unknown");
    // No sleep after the final attempt — nothing follows it.
    if (attempt < attempts - 1) await wait(delayMs);
  }
  return last;
}

/**
 * User-triggered recovery: restart the InputPlumber daemon, then re-load the
 * wake profile onto the freshly-recreated composite device.
 *
 * Rebuilding all composite devices + emulated targets from scratch is the
 * reliable fix for the class of stuck states we can't always recover from in
 * place — a controller stops presenting to Steam, the `deck-uhid` emulation
 * gets confused after heavy device churn, or the boot-time wake reload lost its
 * race. Exposed as a "Restart InputPlumber" button in the plugin UI.
 *
 * Best-effort and non-throwing. The retry loop covers the window where IP is
 * back up but hasn't finished re-enumerating the controller's capabilities yet
 * (the same race `reloadPersistedProfile` can hit at boot) — without it the
 * wake button would silently fail to reload right after the restart.
 */
export async function restartInputPlumber(): Promise<WakeOpResult> {
  // Clear systemd's restart bookkeeping before every restart. This is the one
  // change that makes the button safe AND able to recover. (a) It resets the
  // start-limit counter (StartLimitBurst=5 / 10s), so repeated presses — which
  // happen naturally when the controller is still dead and the user clicks
  // again — can never trip "start-limit-hit" and brick IP. (b) If IP is already
  // in a failed state (e.g. a prior burst already tripped the limit), a plain
  // `restart` keeps failing; reset-failed first lets the button dig IP back out.
  // Best-effort: a non-zero exit just means there was nothing to reset.
  await exec(["systemctl", "reset-failed", "inputplumber"]);
  const r = await exec(["systemctl", "restart", "inputplumber"]);
  if (!r.ok) {
    return { ok: false, error: `Failed to restart InputPlumber: ${r.err || "unknown error"}` };
  }
  // reloadPersistedProfile() already waits for IP to come up; retry it a few
  // times so a not-yet-enumerated composite (transient post-restart) resolves
  // rather than leaving the wake button unbound. No-op (ok) when no wake button
  // is bound, so this returns quickly on those setups.
  let last: WakeOpResult = { ok: true };
  for (let attempt = 0; attempt < 5; attempt++) {
    last = await reloadPersistedProfile();
    if (last.ok) break;
    await delay(1000);
  }
  return last;
}
