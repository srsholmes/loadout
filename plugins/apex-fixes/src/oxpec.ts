/**
 * oxpec — EC platform driver loader.
 *
 * Ports the Decky plugin's `oxpec_loader.py`. Three-stage load:
 *
 *   1. `modprobe oxpec` — works once the upstream kernel ships the
 *      APEX DMI alias. On this hardware today it fails with
 *      "No such device".
 *   2. `insmod plugins/apex-fixes/kernel-modules/<uname>/oxpec.ko` —
 *      the bundled build we vendored from Decky. This is the path
 *      that works right now.
 *   3. SELinux fallback: if insmod fails with "Permission denied" or
 *      "Operation not permitted", copy the .ko to /var/lib/oxpec/
 *      (directory that the OS-provided module policy already
 *      considers a module store), `chcon -t modules_object_t`, and
 *      retry the insmod.
 *
 * `ensure()` is the non-persistent onLoad path — load the module if
 * not already there, don't touch systemd. `apply()` installs the
 * systemd unit so the module comes up at boot without the plugin
 * needing to run. `revert()` undoes `apply()` cleanly.
 */

import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@loadout/exec";
import { sudoSpawn, sudoTee, sudoMkdirP, sudoRmF } from "./privileged";

const OXPEC_DIR = join(import.meta.dir, "..", "kernel-modules");
const INSTALL_DIR = "/var/lib/oxpec";
const INSTALL_KO = `${INSTALL_DIR}/oxpec.ko`;
const SERVICE_NAME = "oxpec-load.service";
const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}`;

export interface OxpecStatus {
  /** Module currently in the running kernel's module list. */
  moduleLoaded: boolean;
  /** systemd unit present AND enabled. */
  serviceEnabled: boolean;
  /** Whether the hwmon node exposed by the driver is visible. */
  hwmonPath: string | null;
  /** Running kernel (`uname -r`). */
  runningKernel: string;
  /** Kernel versions we have bundled .ko files for. */
  bundledKernels: string[];
  /** Whether the running kernel has a matching bundled .ko. */
  bundledKernelMatch: boolean;
  /** Human-readable one-line diagnostic for the UI. */
  summary: string;
}

export interface LoadResult {
  success: boolean;
  method?: "modprobe" | "insmod-bundled" | "insmod-installed";
  error?: string;
}

export interface ApplyResult {
  success: boolean;
  steps: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function getRunningKernel(): Promise<string> {
  try {
    const { stdout } = await run(["uname", "-r"]);
    return stdout;
  } catch {
    return "";
  }
}

async function listBundledKernels(): Promise<string[]> {
  try {
    const entries = await readdir(OXPEC_DIR, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (await fileExists(join(OXPEC_DIR, e.name, "oxpec.ko"))) out.push(e.name);
    }
    return out.sort();
  } catch {
    return [];
  }
}

async function findBundledKo(kernel: string): Promise<string | null> {
  if (!kernel) return null;
  const path = join(OXPEC_DIR, kernel, "oxpec.ko");
  return (await fileExists(path)) ? path : null;
}

async function isModuleLoaded(): Promise<boolean> {
  try {
    const content = await readFile("/proc/modules", "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("oxpec ")) return true;
    }
  } catch {
    /* not readable — treat as not loaded */
  }
  return false;
}

async function findHwmonPath(): Promise<string | null> {
  // Driver-reported name is `oxp_ec` on current APEX builds; upstream
  // oxpec.ko uses `oxpec`. Accept either so we don't go blind after a
  // version bump.
  const base = "/sys/class/hwmon";
  try {
    const entries = await readdir(base);
    for (const entry of entries) {
      try {
        const name = (await readFile(`${base}/${entry}/name`, "utf-8")).trim();
        if (name === "oxp_ec" || name === "oxpec") return `${base}/${entry}`;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* hwmon dir unreadable */
  }
  return null;
}

async function isServiceEnabled(): Promise<boolean> {
  if (!(await fileExists(SERVICE_PATH))) return false;
  try {
    const { exitCode, stdout } = await sudoSpawn("systemctl", [
      "is-enabled",
      SERVICE_NAME,
    ]);
    return exitCode === 0 && stdout.trim() === "enabled";
  } catch {
    return false;
  }
}

export async function getStatus(): Promise<OxpecStatus> {
  const [moduleLoaded, serviceEnabled, hwmonPath, runningKernel, bundledKernels] =
    await Promise.all([
      isModuleLoaded(),
      isServiceEnabled(),
      findHwmonPath(),
      getRunningKernel(),
      listBundledKernels(),
    ]);
  const bundledKernelMatch = bundledKernels.includes(runningKernel);

  let summary: string;
  if (moduleLoaded && serviceEnabled) {
    summary = `Driver loaded and persisted via ${SERVICE_NAME}.`;
  } else if (moduleLoaded) {
    summary = "Driver loaded transiently — will not survive reboot.";
  } else if (bundledKernelMatch) {
    summary = `Bundled .ko available for ${runningKernel} but not loaded.`;
  } else {
    summary = `No bundled .ko for running kernel (${runningKernel || "unknown"}).`;
  }

  return {
    moduleLoaded,
    serviceEnabled,
    hwmonPath,
    runningKernel,
    bundledKernels,
    bundledKernelMatch,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function tryModprobe(): Promise<LoadResult> {
  const { exitCode, stderr } = await sudoSpawn("modprobe", ["oxpec"], {
    timeoutMs: 10_000,
  });
  if (exitCode === 0 && (await isModuleLoaded())) {
    return { success: true, method: "modprobe" };
  }
  return { success: false, error: stderr.trim() || `modprobe exit ${exitCode}` };
}

async function tryInsmod(koPath: string, method: LoadResult["method"]): Promise<LoadResult> {
  const { exitCode, stderr } = await sudoSpawn("insmod", [koPath], {
    timeoutMs: 10_000,
  });
  if (exitCode === 0 && (await isModuleLoaded())) {
    return { success: true, method };
  }
  return { success: false, error: stderr.trim() || `insmod exit ${exitCode}` };
}

async function installBundledKo(bundledKo: string): Promise<{ success: boolean; error?: string }> {
  try {
    await sudoMkdirP(INSTALL_DIR);
    // Use sudo cp rather than node's copyFile — node can't write to /var/lib.
    const cp = await sudoSpawn("cp", [bundledKo, INSTALL_KO]);
    if (cp.exitCode !== 0) {
      return { success: false, error: `cp failed: ${cp.stderr.trim()}` };
    }
    // Best-effort SELinux context — don't fail if chcon isn't available
    // (non-enforcing systems).
    await sudoSpawn("chcon", ["-t", "modules_object_t", INSTALL_KO], {
      timeoutMs: 10_000,
    });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Non-persistent load — tries modprobe → bundled insmod → SELinux
 * fallback → /var/lib/oxpec copy. Returns early if the module is
 * already loaded.
 */
export async function ensure(): Promise<LoadResult & { alreadyLoaded?: boolean }> {
  if (await isModuleLoaded()) {
    return { success: true, alreadyLoaded: true, method: "modprobe" };
  }

  // 1. modprobe
  const mp = await tryModprobe();
  if (mp.success) return mp;
  const modprobeError = mp.error ?? "unknown";

  // 2. bundled insmod
  const kernel = await getRunningKernel();
  const bundled = await findBundledKo(kernel);
  if (bundled) {
    const im = await tryInsmod(bundled, "insmod-bundled");
    if (im.success) return im;

    // 3. SELinux fallback (copy to /var/lib/oxpec, chcon, retry)
    if (
      im.error?.includes("Permission denied") ||
      im.error?.includes("Operation not permitted")
    ) {
      const install = await installBundledKo(bundled);
      if (install.success) {
        const retry = await tryInsmod(INSTALL_KO, "insmod-installed");
        if (retry.success) return retry;
      }
    }
  }

  // 4. previously installed /var/lib/oxpec copy
  if (await fileExists(INSTALL_KO)) {
    const im = await tryInsmod(INSTALL_KO, "insmod-installed");
    if (im.success) return im;
  }

  const bundledKernels = await listBundledKernels();
  return {
    success: false,
    error:
      `Failed to load oxpec. modprobe: ${modprobeError}. ` +
      `Running kernel: ${kernel || "unknown"}. ` +
      `Bundled .ko available for: ${bundledKernels.join(", ") || "none"}.`,
  };
}

// ---------------------------------------------------------------------------
// Apply / Revert (persistent)
// ---------------------------------------------------------------------------

function makeServiceContent(koPath: string | null): string {
  // If we were able to load via modprobe, the service can too — use
  // modprobe-first with insmod fallback. Otherwise only the bundled
  // path works, so wire it directly.
  const execStart = koPath
    ? `/bin/sh -c 'modprobe oxpec 2>/dev/null || insmod ${koPath}'`
    : `/bin/sh -c 'modprobe oxpec'`;

  return `[Unit]
Description=Load oxpec EC platform driver for OneXPlayer
DefaultDependencies=no
After=systemd-modules-load.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${execStart}
ExecStop=/sbin/rmmod oxpec

[Install]
WantedBy=multi-user.target
`;
}

export async function apply(): Promise<ApplyResult> {
  const steps: string[] = [];
  const kernel = await getRunningKernel();

  // If the service is already installed+enabled and module is loaded,
  // short-circuit.
  if ((await isServiceEnabled()) && (await isModuleLoaded())) {
    return { success: true, steps: ["Already applied"] };
  }

  // Decide which path the systemd unit should use.
  // First: does `modprobe oxpec` actually work right now?
  let koForService: string | null = null;
  const mp = await tryModprobe();
  if (mp.success) {
    steps.push("Loaded via modprobe");
  } else {
    const bundled = await findBundledKo(kernel);
    if (!bundled) {
      const bundledKernels = await listBundledKernels();
      return {
        success: false,
        error:
          `No oxpec.ko for kernel ${kernel || "unknown"}. ` +
          `Bundled: ${bundledKernels.join(", ") || "none"}. ` +
          "Rebuild the .ko or add support for this kernel version.",
        steps,
      };
    }
    steps.push(`Using bundled .ko for ${kernel}`);

    const install = await installBundledKo(bundled);
    if (!install.success) {
      return { success: false, error: install.error, steps };
    }
    steps.push(`Staged oxpec.ko at ${INSTALL_DIR}`);
    koForService = INSTALL_KO;

    const im = await tryInsmod(INSTALL_KO, "insmod-installed");
    if (!im.success) {
      return {
        success: false,
        error: `insmod after stage failed: ${im.error}`,
        steps,
      };
    }
    steps.push("Loaded via insmod");
  }

  // Write the systemd unit.
  try {
    await sudoTee(SERVICE_PATH, makeServiceContent(koForService));
    steps.push(`Wrote ${SERVICE_PATH}`);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      steps,
    };
  }

  // Reload systemd + enable+start the unit.
  const reload = await sudoSpawn("systemctl", ["daemon-reload"]);
  if (reload.exitCode !== 0) {
    return {
      success: false,
      error: `daemon-reload failed: ${reload.stderr.trim()}`,
      steps,
    };
  }

  const en = await sudoSpawn("systemctl", ["enable", "--now", SERVICE_NAME]);
  if (en.exitCode !== 0) {
    return {
      success: false,
      error: `enable --now ${SERVICE_NAME} failed: ${en.stderr.trim()}`,
      steps,
    };
  }
  steps.push(`Enabled ${SERVICE_NAME}`);

  if (!(await isModuleLoaded())) {
    return {
      success: false,
      error: "Module did not appear in /proc/modules after install",
      steps,
    };
  }
  steps.push("Module loaded");

  const hwmon = await findHwmonPath();
  if (hwmon) steps.push(`hwmon registered at ${hwmon}`);

  return { success: true, steps };
}

export async function revert(): Promise<ApplyResult> {
  const steps: string[] = [];

  if (await fileExists(SERVICE_PATH)) {
    const dis = await sudoSpawn("systemctl", ["disable", "--now", SERVICE_NAME]);
    if (dis.exitCode === 0) steps.push(`Disabled ${SERVICE_NAME}`);
    else steps.push(`disable failed (continuing): ${dis.stderr.trim()}`);
  }

  if (await isModuleLoaded()) {
    const rm = await sudoSpawn("rmmod", ["oxpec"], { timeoutMs: 10_000 });
    if (rm.exitCode === 0) steps.push("Unloaded oxpec module");
    else steps.push(`rmmod failed (continuing): ${rm.stderr.trim()}`);
  }

  await sudoRmF(SERVICE_PATH);
  steps.push(`Removed ${SERVICE_PATH}`);

  await sudoSpawn("rm", ["-rf", INSTALL_DIR]);
  steps.push(`Removed ${INSTALL_DIR}`);

  await sudoSpawn("systemctl", ["daemon-reload"]);

  return { success: true, steps };
}

/**
 * Marker that the API expects — matches the Python `is_applied()` shape.
 * Backend uses `getStatus()` for richer data; this is here in case a
 * caller only wants the boolean.
 */
export async function isApplied(): Promise<boolean> {
  const s = await getStatus();
  return s.moduleLoaded && s.serviceEnabled;
}
