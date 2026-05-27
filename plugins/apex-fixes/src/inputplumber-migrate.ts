/**
 * inputplumber-migrate — HHD → InputPlumber migration driver.
 *
 * Thin wrapper around the bundled `scripts/migrate-to-inputplumber.sh`
 * (ported from the `onexplayer-apex-bazzite-fixes` Decky plugin). The
 * script does the actual work — build hid-oxp.ko against the running
 * kernel, stage the .ko under /var/lib/hid-oxp, install a systemd unit,
 * mask HHD, build + install InputPlumber from upstream main (the OXP
 * HID driver work originally tracked in PR #567 has since been merged),
 * lay down the Apex-specific overrides in /usr/share/inputplumber, and
 * restart.
 *
 * No rollback path — going back to HHD is out of scope. The script is
 * idempotent, so "Reinstall" is just re-running it: already-loaded
 * modules, masked services, and staged binaries are detected and
 * skipped.
 *
 * Why vendor the script instead of rewriting in TS:
 *   - The script is already battle-tested in the sibling repo and
 *     includes subtle ordering fixes (stop inputplumber before
 *     overwriting the ELF, reload dbus-broker so a new policy file
 *     takes effect, handle missing libiio).
 *   - Several steps (`cargo build --release`, `dnf download`) are
 *     multi-minute and best expressed as shell.
 *   - Rewriting would double the surface area for divergence from
 *     upstream.
 *
 * What this module adds on top:
 *   - Status probe (no sudo) — is hid-oxp loaded? Is
 *     hid-oxp-load.service enabled? Is inputplumber.service active?
 *     Is HHD running?
 *   - A `migrate()` runner that streams stdout/stderr back to the
 *     caller via callbacks, so the UI can show a live log.
 *   - A 30-minute cap on the migration (`cargo build` of InputPlumber
 *     is the slow path; 10 min is enough on a warm cache but not on
 *     a cold one).
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@loadout/exec";
import { sudoSpawn, sudoSpawnStreamed } from "./privileged";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const MIGRATE_SCRIPT = join(PLUGIN_ROOT, "scripts", "migrate-to-inputplumber.sh");

export type Stack = "inputplumber" | "hhd" | "mixed" | "none";

export interface MigrationStatus {
  /** Is the out-of-tree hid-oxp driver loaded into the kernel? */
  hidOxpLoaded: boolean;
  /** Is our hid-oxp-load.service enabled (will load on next boot)? */
  hidOxpServiceEnabled: boolean;
  /**
   * Is our InputPlumber binary installed at
   * /var/lib/inputplumber/bin/inputplumber (persistent, ostree-safe)?
   * Pre-migration installs that landed in /usr/bin/inputplumber are
   * deliberately not counted — they don't survive a deployment switch.
   */
  inputplumberInstalled: boolean;
  /** Is inputplumber.service currently active? */
  inputplumberActive: boolean;
  /** Is inputplumber.service enabled (starts on boot)? */
  inputplumberEnabled: boolean;
  /** Is hhd.service currently active? */
  hhdActive: boolean;
  /** Has hhd.service been masked? */
  hhdMasked: boolean;
  /** Does the vendored migrate script exist on disk? */
  scriptsPresent: boolean;
  /** Does this repo ship a prebuilt hid-oxp.ko for the running kernel? */
  prebuiltKoAvailable: boolean;
  /** Running kernel (uname -r) — filled in best-effort. */
  runningKernel: string;
  /** Overall stack selection — "inputplumber" once both pieces are live. */
  stack: Stack;
  /** One-line human summary. */
  summary: string;
}

export interface MigrationRunResult {
  success: boolean;
  exitCode: number;
  timedOut: boolean;
  error?: string;
  /** Seconds the run took end-to-end. */
  durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Status probe
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isModuleLoaded(): Promise<boolean> {
  try {
    const content = await readFile("/proc/modules", "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("hid_oxp ")) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function runningKernel(): Promise<string> {
  try {
    const { stdout } = await run(["uname", "-r"]);
    return stdout;
  } catch {
    return "";
  }
}

/** `systemctl is-active <unit>` → true only for "active". */
async function isUnitActive(unit: string): Promise<boolean> {
  const { exitCode, stdout } = await sudoSpawn("systemctl", ["is-active", unit], {
    timeoutMs: 5_000,
  });
  // is-active is documented to return non-zero for everything except active/activating.
  return exitCode === 0 && stdout.trim() === "active";
}

/** `systemctl is-enabled <unit>` → true only for "enabled"/"static". */
async function isUnitEnabled(unit: string): Promise<boolean> {
  const { stdout } = await sudoSpawn("systemctl", ["is-enabled", unit], {
    timeoutMs: 5_000,
  });
  const s = stdout.trim();
  return s === "enabled" || s === "enabled-runtime" || s === "static";
}

/** `systemctl is-enabled <unit>` → true when the returned state is "masked". */
async function isUnitMasked(unit: string): Promise<boolean> {
  const { stdout } = await sudoSpawn("systemctl", ["is-enabled", unit], {
    timeoutMs: 5_000,
  });
  return stdout.trim() === "masked";
}

export async function getStatus(): Promise<MigrationStatus> {
  const kernel = await runningKernel();
  const [
    hidOxpLoaded,
    hidOxpServiceEnabled,
    inputplumberInstalled,
    inputplumberActive,
    inputplumberEnabled,
    hhdActive,
    hhdMasked,
    migrateExists,
    prebuiltKoAvailable,
  ] = await Promise.all([
    isModuleLoaded(),
    isUnitEnabled("hid-oxp-load.service"),
    exists("/var/lib/inputplumber/bin/inputplumber"),
    isUnitActive("inputplumber.service"),
    isUnitEnabled("inputplumber.service"),
    isUnitActive("hhd.service"),
    isUnitMasked("hhd.service"),
    exists(MIGRATE_SCRIPT),
    kernel
      ? exists(join(PLUGIN_ROOT, "kernel-patches", "hid-oxp", kernel, "hid-oxp.ko"))
      : Promise.resolve(false),
  ]);

  let stack: Stack;
  if (inputplumberActive && !hhdActive) stack = "inputplumber";
  else if (hhdActive && !inputplumberActive) stack = "hhd";
  else if (inputplumberActive && hhdActive) stack = "mixed";
  else stack = "none";

  let summary: string;
  if (stack === "inputplumber") {
    summary = hidOxpLoaded
      ? "Running on InputPlumber with hid-oxp loaded."
      : "InputPlumber active, but hid-oxp is NOT loaded — back paddles/RGB will not work until next reboot.";
  } else if (stack === "hhd") {
    summary = "Still running HHD. Install to switch to InputPlumber + hid-oxp.";
  } else if (stack === "mixed") {
    summary = "Both HHD and InputPlumber are active — controllers will conflict. Re-run install to converge.";
  } else {
    summary = "Neither HHD nor InputPlumber is running. Install to bring up InputPlumber + hid-oxp.";
  }

  return {
    hidOxpLoaded,
    hidOxpServiceEnabled,
    inputplumberInstalled,
    inputplumberActive,
    inputplumberEnabled,
    hhdActive,
    hhdMasked,
    scriptsPresent: migrateExists,
    prebuiltKoAvailable,
    runningKernel: kernel,
    stack,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

export interface RunnerOptions {
  onLog?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Populated with a cancel handle when the run starts. */
  cancellation?: { cancel: () => void };
}

async function runScript(
  scriptPath: string,
  opts: RunnerOptions,
): Promise<MigrationRunResult> {
  if (!(await exists(scriptPath))) {
    return {
      success: false,
      exitCode: -1,
      timedOut: false,
      durationSeconds: 0,
      error: `script not found at ${scriptPath}`,
    };
  }

  const started = Date.now();

  // `bash` explicitly so the shebang's `set -euo pipefail` runs under
  // bash even if /bin/sh is dash. The migration script uses bash-only
  // syntax (HHD_UNITS+=(...) arrays).
  const res = await sudoSpawnStreamed("bash", [scriptPath], {
    timeoutMs: 30 * 60_000,
    onStdout: (c) => opts.onLog?.(c, "stdout"),
    onStderr: (c) => opts.onLog?.(c, "stderr"),
    signal: opts.cancellation,
  });

  const durationSeconds = Math.round((Date.now() - started) / 1000);

  if (res.timedOut) {
    return {
      success: false,
      exitCode: -1,
      timedOut: true,
      durationSeconds,
      error: "script timed out after 30 minutes",
    };
  }
  if (res.exitCode !== 0) {
    return {
      success: false,
      exitCode: res.exitCode,
      timedOut: false,
      durationSeconds,
      error: res.stderr.trim().split("\n").slice(-5).join("\n") ||
        `script exited ${res.exitCode}`,
    };
  }

  return {
    success: true,
    exitCode: 0,
    timedOut: false,
    durationSeconds,
  };
}

export async function migrate(opts: RunnerOptions = {}): Promise<MigrationRunResult> {
  return runScript(MIGRATE_SCRIPT, opts);
}
