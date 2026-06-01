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

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
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
  DECK_OVERRIDE_PATH,
  DECK_OVERRIDE_YAML,
  UACCESS_RULE_PATH,
  UACCESS_RULE,
} from "./profile";
import type {
  WakeStatus,
  WakeStatusDevice,
  WakeOpResult,
  WakeCaptureResult,
} from "../shared";

export type { WakeStatus, WakeStatusDevice, WakeOpResult, WakeCaptureResult };

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

export async function getWakeStatus(): Promise<WakeStatus> {
  const [ipActive, isDeck, wake] = await Promise.all([
    inputPlumberAvailable(),
    isSteamDeck(),
    readWake(),
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
    isDeck,
    devices,
    selectedRaw: wake?.selectedRaw ?? null,
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

/** Steam Deck only: write the auto_manage override and enable the IP service
 *  (SteamOS ships it disabled). No-op shape on other handhelds. */
async function ensureDeckManaged(): Promise<{ ok: boolean; err: string }> {
  await writeFileMkdir(DECK_OVERRIDE_PATH, DECK_OVERRIDE_YAML);
  const enable = await exec(["systemctl", "enable", "--now", "inputplumber.service"]);
  if (!enable.ok) return enable;
  // Give the daemon a moment to claim the controller before we look for it.
  await waitForIp(8000);
  return { ok: true, err: "" };
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
  return composites[0];
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
  if (!(await inputPlumberAvailable())) {
    if (await isSteamDeck()) {
      const managed = await ensureDeckManaged();
      if (!managed.ok) {
        return { ok: false, error: `Failed to enable InputPlumber: ${managed.err}` };
      }
    } else {
      return { ok: false, error: "InputPlumber is not running." };
    }
  } else if (await isSteamDeck()) {
    // IP already up, but keep the Deck override in place so the pad stays
    // managed across reboots.
    await writeFileMkdir(DECK_OVERRIDE_PATH, DECK_OVERRIDE_YAML);
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
  return { ok: true };
}

// ── press-to-capture ────────────────────────────────────────────────────────

/** Where /proc/bus/input/devices is — overridable for tests. */
const PROC_INPUT_DEVICES = "/proc/bus/input/devices";

/** evdev input_event struct on x86_64: u64 sec + u64 usec + u16 type + u16 code + u32 value = 24 bytes. */
const EVENT_BYTES = 24;
const EV_KEY = 1;

/** Parse /proc/bus/input/devices to find the eventN node for a device by name.
 *  Picks the first match — IP creates only one virtual keyboard per session. */
export function findEventNode(procContent: string, name: string): string | null {
  const blocks = procContent.split(/\n\n+/);
  for (const block of blocks) {
    const nameMatch = block.match(/^N:\s+Name="([^"]+)"/m);
    if (!nameMatch || nameMatch[1] !== name) continue;
    const handlersMatch = block.match(/^H:\s+Handlers=(.*)$/m);
    if (!handlersMatch) continue;
    const ev = handlersMatch[1].split(/\s+/).find((h) => /^event\d+$/.test(h));
    if (ev) return `/dev/input/${ev}`;
  }
  return null;
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

/**
 * Press-to-capture: write a transient profile mapping every recommended
 * button to a unique sentinel key, listen on the IP virtual keyboard for the
 * first sentinel press, then bind that button to F16 for real. On timeout or
 * error, restore the previous binding (or leave Off if there wasn't one).
 *
 * Caller gets `{ ok, capturedRaw?, capturedLabel?, timedOut?, error? }`.
 */
export async function captureWakeButton(timeoutMs = 10_000): Promise<WakeCaptureResult> {
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
    return {
      ok: false,
      error: `LoadProfilePath (capture) failed: ${loaded.stderr.trim() || `exit ${loaded.code}`}`,
    };
  }

  // Find IP's virtual keyboard node; IP creates a fresh evdev on every
  // LoadProfilePath, so re-scan now rather than caching.
  let kbPath: string | null = null;
  for (let i = 0; i < 10 && !kbPath; i++) {
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

  const raw = sentinelToRaw.get(code)!;
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
 *  working) and forget the persisted selection. */
export async function clearWakeButton(): Promise<WakeOpResult> {
  await writeWake({ selectedRaw: null, deviceName: null });
  if (!(await inputPlumberAvailable())) return { ok: true };

  const composites = await listCompositeDevices();
  const device = pickDevice(composites, null, null);
  if (!device) return { ok: true };

  const targets = await getTargetKinds(device.path);
  await writeFileMkdir(PROFILE_PATH, renderClearedProfile(targets));
  const loaded = await loadProfilePath(device.path, PROFILE_PATH);
  if (!loaded.ok) {
    return {
      ok: false,
      error: `LoadProfilePath failed: ${loaded.stderr.trim() || `exit ${loaded.code}`}`,
    };
  }
  return { ok: true };
}

/**
 * Boot/onLoad reconciliation: if the user has a binding persisted, wait for IP
 * to come up and re-load the profile so the wake button works after a reboot.
 * Best-effort and non-throwing — logs via the returned result.
 */
export async function reloadPersistedProfile(): Promise<WakeOpResult> {
  const wake = await readWake();
  if (!wake?.selectedRaw) return { ok: true };

  // On a Deck the service may be enabled but still starting; give it a window.
  if (!(await waitForIp(15_000))) {
    return { ok: false, error: "InputPlumber did not come up; wake button not reloaded." };
  }

  const composites = await listCompositeDevices();
  const device = pickDevice(composites, wake.selectedRaw, wake.deviceName);
  if (!device) {
    return { ok: false, error: "Bound device not connected; wake button not reloaded." };
  }

  // Re-render from the live targets in case the device's emulation changed,
  // then load. (The file may already exist from a prior boot, but re-rendering
  // keeps it correct if targets shifted.)
  const targets = await getTargetKinds(device.path);
  await writeFileMkdir(PROFILE_PATH, renderProfile(parseCapability(wake.selectedRaw), targets));
  const loaded = await loadProfilePath(device.path, PROFILE_PATH);
  return loaded.ok
    ? { ok: true }
    : { ok: false, error: `LoadProfilePath failed: exit ${loaded.code}` };
}

/** Remove all installed wake-trigger artifacts (used by uninstall paths/tests).
 *  Does not disable the IP service — that may be wanted independently. */
export async function removeWakeArtifacts(): Promise<void> {
  await rm(PROFILE_PATH, { force: true });
  await rm(UACCESS_RULE_PATH, { force: true });
  // Intentionally leave the Deck override in place; harmless and avoids churn
  // if the user re-enables.
}
