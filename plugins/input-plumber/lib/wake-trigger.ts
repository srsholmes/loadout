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
  renderProfile,
  renderClearedProfile,
  PROFILE_PATH,
  DECK_OVERRIDE_PATH,
  DECK_OVERRIDE_YAML,
  UACCESS_RULE_PATH,
  UACCESS_RULE,
} from "./profile";
import type { WakeStatus, WakeStatusDevice, WakeOpResult } from "../shared";

export type { WakeStatus, WakeStatusDevice, WakeOpResult };

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
