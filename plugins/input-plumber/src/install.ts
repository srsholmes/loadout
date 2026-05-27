/**
 * InputPlumber install driver.
 *
 * Thin wrapper around the bundled `scripts/install-inputplumber.sh`,
 * extracted from the apex-fixes migrate script's IP-specific steps.
 * The script does the actual work (pacman/dnf fast path, otherwise a
 * tarball install under /var/lib/inputplumber); this module adds:
 *
 *   - Status probe (no sudo) — is the binary on disk? Is the service
 *     active/enabled? Where did it come from (system package vs our
 *     /var install)?
 *   - A run helper that streams stdout/stderr to a callback so the UI
 *     can show a live log.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { sudoSpawn, sudoSpawnStreamed } from "./privileged";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const INSTALL_SCRIPT = join(PLUGIN_ROOT, "scripts", "install-inputplumber.sh");

const VAR_BIN = "/var/lib/inputplumber/bin/inputplumber";

export type ManagedBy = "us" | "distro" | "none";

export interface HhdStatus {
  /** Any hhd*.service unit file present on the system. */
  installed: boolean;
  /** Any hhd*.service unit currently active. */
  active: boolean;
  /** Unit names we detected (active or just installed). */
  units: string[];
}

export interface InstallStatus {
  /** Is the daemon binary present anywhere known? */
  installed: boolean;
  /** Where it lives, or null if not installed. */
  binaryPath: string | null;
  /**
   * "us"     — at /var/lib/inputplumber/bin/inputplumber (this script).
   * "distro" — anywhere else on PATH (system package).
   * "none"   — not present.
   */
  managedBy: ManagedBy;
  /** Reported by `inputplumber --version` if reachable. */
  version: string | null;
  /** Is inputplumber.service currently active? */
  serviceActive: boolean;
  /** Is inputplumber.service enabled (starts on boot)? */
  serviceEnabled: boolean;
  /** Does the bundled install script exist on disk? */
  scriptPresent: boolean;
  /** Handheld Daemon presence — IP can't coexist with it (the install
   *  script disables/masks any hhd*.service before bringing IP up). */
  hhd: HhdStatus;
  /** One-line human summary. */
  summary: string;
}

export interface InstallRunResult {
  success: boolean;
  exitCode: number;
  timedOut: boolean;
  durationSeconds: number;
  error?: string;
}

export interface RunnerOptions {
  onLog?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Populated with a cancel handle when the run starts. */
  cancellation?: { cancel: () => void };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function which(cmd: string): Promise<string | null> {
  const r = await sudoSpawn("which", [cmd], { timeoutMs: 3_000 });
  if (r.exitCode !== 0) return null;
  const path = r.stdout.trim().split("\n")[0];
  return path || null;
}

async function inputplumberVersion(binary: string): Promise<string | null> {
  const r = await sudoSpawn(binary, ["--version"], { timeoutMs: 5_000 });
  if (r.exitCode !== 0) return null;
  const m = r.stdout.trim().match(/(\d+\.\d+\.\d+(?:-\S+)?)/);
  return m ? m[1] : r.stdout.trim() || null;
}

async function isUnitActive(unit: string): Promise<boolean> {
  const { exitCode, stdout } = await sudoSpawn("systemctl", ["is-active", unit], {
    timeoutMs: 5_000,
  });
  return exitCode === 0 && stdout.trim() === "active";
}

async function isUnitEnabled(unit: string): Promise<boolean> {
  const { stdout } = await sudoSpawn("systemctl", ["is-enabled", unit], {
    timeoutMs: 5_000,
  });
  const s = stdout.trim();
  return s === "enabled" || s === "enabled-runtime" || s === "static";
}

async function probeHhd(): Promise<HhdStatus> {
  // List both active and installed (but inactive) hhd*.service units.
  // `list-unit-files` covers masked/disabled units; `list-units` would
  // miss them — we want to warn the user even if HHD is dormant.
  const { exitCode, stdout } = await sudoSpawn(
    "systemctl",
    ["list-unit-files", "--no-legend", "--type=service", "hhd*"],
    { timeoutMs: 5_000 },
  );
  if (exitCode !== 0) {
    return { installed: false, active: false, units: [] };
  }
  const units = stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((u): u is string => Boolean(u) && u.startsWith("hhd"));
  if (units.length === 0) {
    return { installed: false, active: false, units: [] };
  }
  // Check active status for each — IP only conflicts when HHD is
  // actually running, but we still want to surface installed-but-inactive
  // so the user knows it's lurking.
  const activeChecks = await Promise.all(units.map((u) => isUnitActive(u)));
  const active = activeChecks.some(Boolean);
  return { installed: true, active, units };
}

export async function getStatus(): Promise<InstallStatus> {
  const onPath = await which("inputplumber");
  let binaryPath: string | null = null;
  let managedBy: ManagedBy = "none";

  if (onPath) {
    binaryPath = onPath;
    managedBy = onPath === VAR_BIN ? "us" : "distro";
  } else if (await exists(VAR_BIN)) {
    binaryPath = VAR_BIN;
    managedBy = "us";
  }

  const installed = binaryPath !== null;
  const [version, serviceActive, serviceEnabled, scriptPresent, hhd] = await Promise.all([
    binaryPath ? inputplumberVersion(binaryPath) : Promise.resolve(null),
    isUnitActive("inputplumber.service"),
    isUnitEnabled("inputplumber.service"),
    exists(INSTALL_SCRIPT),
    probeHhd(),
  ]);

  let summary: string;
  if (!installed) {
    summary = "InputPlumber is not installed.";
  } else if (!serviceActive) {
    summary = `InputPlumber installed (${managedBy === "us" ? "/var" : "system"}) but the service isn't running.`;
  } else {
    summary = `InputPlumber active${version ? ` (v${version})` : ""}, managed by ${managedBy === "us" ? "this plugin" : "system package"}.`;
  }
  if (hhd.active) {
    summary += " Handheld Daemon (HHD) is running and will conflict — re-run to disable it.";
  }

  return {
    installed,
    binaryPath,
    managedBy,
    version,
    serviceActive,
    serviceEnabled,
    scriptPresent,
    hhd,
    summary,
  };
}

export async function install(opts: RunnerOptions = {}): Promise<InstallRunResult> {
  if (!(await exists(INSTALL_SCRIPT))) {
    return {
      success: false,
      exitCode: -1,
      timedOut: false,
      durationSeconds: 0,
      error: `script not found at ${INSTALL_SCRIPT}`,
    };
  }

  const started = Date.now();

  const res = await sudoSpawnStreamed("bash", [INSTALL_SCRIPT], {
    // 10 min cap. Tarball + libiio download is typically <1 min;
    // pacman/dnf can be a bit slower on first install. Plenty of margin.
    timeoutMs: 10 * 60_000,
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
      error: "install timed out after 10 minutes",
    };
  }
  if (res.exitCode !== 0) {
    return {
      success: false,
      exitCode: res.exitCode,
      timedOut: false,
      durationSeconds,
      error:
        res.stderr.trim().split("\n").slice(-5).join("\n") ||
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
