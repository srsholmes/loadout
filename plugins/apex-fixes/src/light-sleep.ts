/**
 * light-sleep — s2idle kargs via rpm-ostree.
 *
 * Port of the Decky plugin's `sleep_fix.py`. Adds two kargs to
 * `/proc/cmdline` and removes five legacy kargs that break s2idle
 * on this device. Persistent: `rpm-ostree kargs` creates a new
 * deployment, so changes take effect on next reboot.
 *
 * BIOS prerequisite — the APEX BIOS setting "ACPI Auto configuration"
 * must be **enabled** for s2idle to actually work. Driver-side fixes
 * can't override that; surface this in the UI note.
 */

import { readFile } from "node:fs/promises";
import { sudoSpawn } from "./privileged";

/** Kargs we want present. */
export const DESIRED_KARGS = [
  "mem_sleep_default=s2idle",
  "amd_iommu=off", // required — IOMMU must be off for Strix Halo sleep
] as const;

/** Legacy kargs that break s2idle or are counterproductive. */
export const PROBLEMATIC_KARGS = [
  "amd_iommu=on", // invalid AMD parameter, silently ignored
  "acpi.ec_no_wakeup=1", // prevents EC-based wakeup
  "amdgpu.cwsr_enable=0", // compute-specific, not needed
  "amdgpu.gttsize=126976", // not sleep-related
  "ttm.pages_limit=32505856", // not sleep-related
] as const;

export interface LightSleepStatus {
  applied: boolean;
  desiredPresent: string[];
  desiredMissing: string[];
  problematicFound: string[];
  summary: string;
}

export interface LightSleepApplyResult {
  success: boolean;
  rebootRequired: boolean;
  steps: string[];
  error?: string;
}

async function readCmdline(): Promise<string> {
  try {
    return await readFile("/proc/cmdline", "utf-8");
  } catch {
    return "";
  }
}

/**
 * Split /proc/cmdline into space-separated tokens. Matters because a
 * substring check on the raw cmdline would treat `amd_iommu=on` as
 * present whenever `amd_iommu=off` is present (both contain the
 * `amd_iommu=` prefix), which inverts the meaning of `is applied`.
 */
export function cmdlineContainsKarg(cmdline: string, karg: string): boolean {
  const tokens = cmdline.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  return tokens.includes(karg);
}

export async function getStatus(): Promise<LightSleepStatus> {
  const cmdline = await readCmdline();
  const desiredPresent = DESIRED_KARGS.filter((k) => cmdlineContainsKarg(cmdline, k));
  const desiredMissing = DESIRED_KARGS.filter((k) => !cmdlineContainsKarg(cmdline, k));
  const problematicFound = PROBLEMATIC_KARGS.filter((k) => cmdlineContainsKarg(cmdline, k));
  const applied = desiredMissing.length === 0 && problematicFound.length === 0;

  let summary: string;
  if (applied) summary = "Applied — reboot has taken effect.";
  else if (desiredMissing.length && problematicFound.length)
    summary = "Not applied and problematic legacy kargs present.";
  else if (desiredMissing.length)
    summary = `Missing kargs: ${desiredMissing.join(", ")}.`;
  else summary = `Problematic kargs present: ${problematicFound.join(", ")}.`;

  return { applied, desiredPresent, desiredMissing, problematicFound, summary };
}

export async function apply(): Promise<LightSleepApplyResult> {
  const cmdline = await readCmdline();
  const steps: string[] = [];
  const rpmArgs: string[] = ["kargs"];

  for (const karg of DESIRED_KARGS) {
    if (!cmdlineContainsKarg(cmdline, karg)) {
      rpmArgs.push(`--append=${karg}`);
      steps.push(`append ${karg}`);
    }
  }
  for (const karg of PROBLEMATIC_KARGS) {
    if (cmdlineContainsKarg(cmdline, karg)) {
      rpmArgs.push(`--delete=${karg}`);
      steps.push(`delete ${karg}`);
    }
  }

  if (rpmArgs.length === 1) {
    return {
      success: true,
      rebootRequired: false,
      steps: ["no changes — kargs already correct"],
    };
  }

  // rpm-ostree kargs rewrites the bootloader entry and stages a new
  // deployment. On Bazzite with a busy ostree cache or an in-progress
  // background refresh this can take 2–4 minutes — the original 60s
  // timeout was reliably tripping in the field. 300s gives the daemon
  // enough headroom without letting a truly hung call block forever.
  const { exitCode, stderr, timedOut } = await sudoSpawn("rpm-ostree", rpmArgs, {
    timeoutMs: 300_000,
  });
  if (timedOut) {
    return {
      success: false,
      rebootRequired: false,
      steps,
      error:
        "rpm-ostree kargs timed out (5 min). Another rpm-ostree " +
        "transaction may be in progress — check `rpm-ostree status` " +
        "and `systemctl status rpm-ostreed` then retry.",
    };
  }
  if (exitCode !== 0) {
    return {
      success: false,
      rebootRequired: false,
      steps,
      error: `rpm-ostree kargs failed: ${stderr.trim() || `exit ${exitCode}`}`,
    };
  }

  steps.push("rpm-ostree deployment updated");
  return { success: true, rebootRequired: true, steps };
}

export async function revert(): Promise<LightSleepApplyResult> {
  const cmdline = await readCmdline();
  const steps: string[] = [];
  const rpmArgs: string[] = ["kargs"];

  for (const karg of DESIRED_KARGS) {
    if (cmdlineContainsKarg(cmdline, karg)) {
      rpmArgs.push(`--delete=${karg}`);
      steps.push(`delete ${karg}`);
    }
  }

  if (rpmArgs.length === 1) {
    return {
      success: true,
      rebootRequired: false,
      steps: ["no kargs to remove"],
    };
  }

  const { exitCode, stderr } = await sudoSpawn("rpm-ostree", rpmArgs, {
    timeoutMs: 300_000,
  });
  if (exitCode !== 0) {
    return {
      success: false,
      rebootRequired: false,
      steps,
      error: `rpm-ostree kargs failed: ${stderr.trim() || `exit ${exitCode}`}`,
    };
  }

  steps.push("rpm-ostree deployment updated");
  return { success: true, rebootRequired: true, steps };
}

export async function isApplied(): Promise<boolean> {
  return (await getStatus()).applied;
}
