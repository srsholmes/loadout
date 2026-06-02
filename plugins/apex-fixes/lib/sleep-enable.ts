/**
 * sleep-enable — make suspend actually work on the APEX.
 *
 * Port of `sleep_enable.py`. Two independent sub-fixes applied
 * together:
 *
 *   1. Neutralize `/usr/lib/systemd/system-sleep/fw-fanctrl-suspend`
 *      — a Framework Laptop tool shipped by Bazzite. On non-Framework
 *      hardware it exits non-zero, which systemd treats as a failed
 *      pre-sleep hook and blocks suspend. We overwrite it with a
 *      no-op `exit 0` script. This lives in /usr/lib, which is part
 *      of the ostree-managed immutable filesystem, so the write
 *      requires `ostree admin unlock --hotfix` first.
 *
 *   2. Install `/etc/udev/rules.d/91-oxp-fingerprint-no-wakeup.rules`
 *      disabling USB wake on VID:PID 10a5:9800 (the fingerprint
 *      sensor). Without this, the sensor fires USB wake events the
 *      instant the device goes to sleep.
 *
 * Revert removes the udev rule and reloads. The fw-fanctrl-suspend
 * script cannot be fully restored from here — ostree's next
 * deployment replaces it with the original. Surface this caveat
 * in the UI.
 */

import { readFile, stat } from "node:fs/promises";
import {
  sudoSpawn,
  sudoTee,
  sudoMkdirP,
  sudoRmF,
  sudoChmod,
} from "./privileged";

const FW_SCRIPT = "/usr/lib/systemd/system-sleep/fw-fanctrl-suspend";
const FINGERPRINT_RULE = "/etc/udev/rules.d/91-oxp-fingerprint-no-wakeup.rules";

const NOOP_SCRIPT =
  "#!/bin/bash\n" +
  "# Neutralized by Apex Fixes (was fw-fanctrl-suspend for Framework Laptop)\n" +
  "exit 0\n";

const FINGERPRINT_RULE_CONTENT =
  '# Disable fingerprint reader as wake source (prevents immediate wake after sleep)\n' +
  'ACTION=="add", SUBSYSTEM=="usb", DRIVERS=="usb", ' +
  'ATTRS{idVendor}=="10a5", ATTRS{idProduct}=="9800", ' +
  'ATTR{power/wakeup}="disabled"\n';

export interface SleepEnableStatus {
  /** True when both sub-fixes are in place (or fw-fanctrl-suspend doesn't exist). */
  applied: boolean;
  /** Is the fw-fanctrl-suspend script a no-op (or absent)? */
  fwScriptNeutralized: boolean;
  /** Does the fw-fanctrl-suspend script exist on disk? */
  fwScriptExists: boolean;
  /** Is the fingerprint udev rule installed? */
  fingerprintRuleInstalled: boolean;
  summary: string;
}

export interface SleepEnableApplyResult {
  success: boolean;
  steps: string[];
  error?: string;
  /** One-way caveat: fw-fanctrl-suspend can only be restored by an ostree update. */
  oneWayWarning?: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isScriptNeutralized(): Promise<boolean> {
  if (!(await fileExists(FW_SCRIPT))) return true; // no file = not a problem
  try {
    const content = await readFile(FW_SCRIPT, "utf-8");
    const stripped = content.trim();
    if (stripped === "" || stripped.endsWith("exit 0")) return true;
    if (content === NOOP_SCRIPT) return true;
    // The real Framework script is ~1.5 KB. Anything under 100 bytes is
    // our no-op or similar.
    if (content.length < 100) return true;
    return false;
  } catch {
    return true;
  }
}

async function fingerprintRuleInstalled(): Promise<boolean> {
  return fileExists(FINGERPRINT_RULE);
}

export async function getStatus(): Promise<SleepEnableStatus> {
  const [fwScriptNeutralized, fwScriptExists, ruleInstalled] = await Promise.all([
    isScriptNeutralized(),
    fileExists(FW_SCRIPT),
    fingerprintRuleInstalled(),
  ]);
  const applied = fwScriptNeutralized && ruleInstalled;

  let summary: string;
  if (applied) summary = "Both sub-fixes in place.";
  else if (!fwScriptNeutralized && !ruleInstalled)
    summary = "fw-fanctrl-suspend still active and fingerprint wake-source still enabled.";
  else if (!fwScriptNeutralized) summary = "fw-fanctrl-suspend still blocks suspend.";
  else summary = "Fingerprint wake-source still enabled.";

  return {
    applied,
    fwScriptNeutralized,
    fwScriptExists,
    fingerprintRuleInstalled: ruleInstalled,
    summary,
  };
}

/**
 * Unlock the ostree-managed filesystem so /usr/lib becomes writable.
 * Retries a few times to let the unlock propagate before giving up.
 */
async function unlockOstree(steps: string[]): Promise<boolean> {
  // Quick probe — if already unlocked, skip.
  const probe = await sudoSpawn("test", ["-w", "/usr/lib/systemd/system-sleep"], {
    timeoutMs: 5_000,
  });
  if (probe.exitCode === 0) {
    steps.push("filesystem already writable");
    return true;
  }

  const unlock = await sudoSpawn("ostree", ["admin", "unlock", "--hotfix"], {
    timeoutMs: 120_000,
  });
  if (unlock.exitCode === 0) {
    steps.push("ostree unlock succeeded");
  } else {
    steps.push(
      `ostree unlock returned ${unlock.exitCode} (may already be unlocked): ${unlock.stderr.trim()}`,
    );
  }

  // Poll for writability — unlock is asynchronous on some releases.
  for (let attempt = 1; attempt <= 6; attempt++) {
    const check = await sudoSpawn("test", ["-w", "/usr/lib/systemd/system-sleep"], {
      timeoutMs: 5_000,
    });
    if (check.exitCode === 0) {
      steps.push("filesystem confirmed writable");
      return true;
    }
    const wait = Math.min(attempt * 500, 2_000);
    await new Promise((r) => setTimeout(r, wait));
  }

  steps.push("filesystem still read-only after retries");
  return false;
}

async function applyFwScriptFix(steps: string[]): Promise<string | null> {
  if (!(await fileExists(FW_SCRIPT))) {
    steps.push("fw-fanctrl-suspend not present (nothing to neutralize)");
    return null;
  }
  if (await isScriptNeutralized()) {
    steps.push("fw-fanctrl-suspend already neutralized");
    return null;
  }

  if (!(await unlockOstree(steps))) {
    return "ostree unlock failed — /usr/lib not writable";
  }

  try {
    await sudoTee(FW_SCRIPT, NOOP_SCRIPT);
    await sudoChmod(FW_SCRIPT, "755");
    steps.push("neutralized fw-fanctrl-suspend");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function applyFingerprintRule(steps: string[]): Promise<string | null> {
  if (await fingerprintRuleInstalled()) {
    steps.push("fingerprint wake-fix already installed");
    return null;
  }
  try {
    await sudoMkdirP("/etc/udev/rules.d");
    await sudoTee(FINGERPRINT_RULE, FINGERPRINT_RULE_CONTENT);
    steps.push(`installed ${FINGERPRINT_RULE}`);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  await sudoSpawn("udevadm", ["control", "--reload-rules"], { timeoutMs: 10_000 });
  await sudoSpawn("udevadm", ["trigger"], { timeoutMs: 10_000 });
  steps.push("reloaded udev rules");
  return null;
}

export async function apply(): Promise<SleepEnableApplyResult> {
  const steps: string[] = [];

  if ((await getStatus()).applied) {
    return { success: true, steps: ["already applied"] };
  }

  const fwErr = await applyFwScriptFix(steps);
  if (fwErr) {
    return {
      success: false,
      steps,
      error: `fw-fanctrl-suspend fix failed: ${fwErr}`,
      oneWayWarning: true,
    };
  }

  const ruleErr = await applyFingerprintRule(steps);
  if (ruleErr) {
    return {
      success: false,
      steps,
      error: `fingerprint rule install failed: ${ruleErr}`,
      oneWayWarning: true,
    };
  }

  return { success: true, steps, oneWayWarning: true };
}

export async function revert(): Promise<SleepEnableApplyResult> {
  const steps: string[] = [];

  // We can only remove the udev rule. fw-fanctrl-suspend stays
  // neutralized until the next ostree upgrade re-lays the image.
  if (await fileExists(FW_SCRIPT)) {
    if (await isScriptNeutralized()) {
      steps.push("fw-fanctrl-suspend will be restored on next Bazzite update");
    }
  }

  if (await fingerprintRuleInstalled()) {
    await sudoRmF(FINGERPRINT_RULE);
    await sudoSpawn("udevadm", ["control", "--reload-rules"], { timeoutMs: 10_000 });
    steps.push(`removed ${FINGERPRINT_RULE}`);
  } else {
    steps.push("fingerprint rule already absent");
  }

  return { success: true, steps, oneWayWarning: true };
}

export async function isApplied(): Promise<boolean> {
  return (await getStatus()).applied;
}
