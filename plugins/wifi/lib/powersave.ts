/**
 * WiFi power-save control — disable the radio's power saving so the link
 * stops dropping out (and needing a reboot to recover). Cross-distro: the
 * exact same files and commands work on SteamOS, Bazzite and CachyOS.
 *
 * Three layers, applied together:
 *
 *   1. NetworkManager drop-in (/etc/NetworkManager/conf.d/…): `wifi.powersave
 *      = 2` is NM's "off" value and applies whatever the backend (iwd or
 *      wpa_supplicant). This is the universal, persistent fix.
 *
 *   2. iwd quirk (/etc/iwd/main.conf, only when iwd is installed): a
 *      `[DriverQuirks] PowerSaveDisable=*` entry, for iwd driving the radio
 *      directly. Merged into any existing config — never clobbered.
 *
 *   3. Runtime `iw dev <iface> set power_save off`: takes effect *instantly*
 *      without dropping the live connection, so we never need the disruptive
 *      `systemctl restart NetworkManager` from the manual fix. The config
 *      files cover the next reconnect / reboot; the wake hook (in backend.ts)
 *      re-asserts it after resume.
 *
 * All filesystem + subprocess access is injected (`PowerSaveDeps`) so the
 * orchestration is unit-testable without root, real sysfs, or a real radio.
 */

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Run = (
  cmd: string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<RunResult>;

export interface PowerSaveDeps {
  /** Run a subprocess (wired to `@loadout/exec`'s `runFull` in prod). */
  run: Run;
  /** Read a file as UTF-8. Rejects on a missing file. */
  readFile: (path: string) => Promise<string>;
  /** Write a file (UTF-8), creating it if absent. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Remove a file. Must swallow ENOENT (absent == success). */
  removeFile: (path: string) => Promise<void>;
  pathExists: (path: string) => Promise<boolean>;
  /** Interface names under /sys/class/net (basenames). */
  listNet: () => Promise<string[]>;
  /** Whether /sys/class/net/<iface>/wireless exists. */
  isWireless: (iface: string) => Promise<boolean>;
  log?: (message: string) => void;
}

export const NM_CONF = "/etc/NetworkManager/conf.d/wifi-powersave-off.conf";
export const IWD_DIR = "/etc/iwd";
export const IWD_CONF = "/etc/iwd/main.conf";

const QUIRK_SECTION = "DriverQuirks";
const QUIRK_KEY = "PowerSaveDisable";
const QUIRK_VAL = "*";

// --- pure config helpers -----------------------------------------------------

/** The NetworkManager drop-in body. `wifi.powersave = 2` == power-save off. */
export function buildNmDropIn(): string {
  return `# Managed by the loadout WiFi plugin — disables WiFi power saving so\n` +
    `# the link stops dropping out. Delete (or toggle off in Loadout) to revert.\n` +
    `[connection]\nwifi.powersave = 2\n`;
}

/** True if the NM drop-in is present and still sets powersave off. */
export function nmDropInActive(content: string): boolean {
  return /^\s*wifi\.powersave\s*=\s*2\s*$/m.test(content);
}

const isSectionHeader = (line: string) => /^\s*\[.+\]\s*$/.test(line);
const isQuirkSection = (line: string) =>
  new RegExp(`^\\s*\\[${QUIRK_SECTION}\\]\\s*$`).test(line);
const isQuirkKey = (line: string) =>
  new RegExp(`^\\s*${QUIRK_KEY}\\s*=`).test(line);

/** True if `[DriverQuirks] PowerSaveDisable=…` is present anywhere. */
export function iwdQuirkActive(content: string): boolean {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let inSection = false;
  for (const line of lines) {
    if (isSectionHeader(line)) inSection = isQuirkSection(line);
    else if (inSection && isQuirkKey(line)) return true;
  }
  return false;
}

/**
 * Add/ensure `PowerSaveDisable=*` under `[DriverQuirks]` in an iwd main.conf,
 * preserving every other section and key. Handles: empty file, existing
 * `[DriverQuirks]` without the key, an existing key with a different value,
 * and a config with other sections but no `[DriverQuirks]`.
 */
export function mergeIwdDriverQuirks(existing: string): string {
  const lines = existing.replace(/\r\n/g, "\n").split("\n");

  let secStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isQuirkSection(lines[i])) { secStart = i; break; }
  }

  if (secStart === -1) {
    const body = existing.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    const prefix = body.length ? `${body}\n\n` : "";
    return `${prefix}[${QUIRK_SECTION}]\n${QUIRK_KEY}=${QUIRK_VAL}\n`;
  }

  let secEnd = lines.length;
  for (let i = secStart + 1; i < lines.length; i++) {
    if (isSectionHeader(lines[i])) { secEnd = i; break; }
  }

  let keyIdx = -1;
  for (let i = secStart + 1; i < secEnd; i++) {
    if (isQuirkKey(lines[i])) { keyIdx = i; break; }
  }
  if (keyIdx !== -1) lines[keyIdx] = `${QUIRK_KEY}=${QUIRK_VAL}`;
  else lines.splice(secStart + 1, 0, `${QUIRK_KEY}=${QUIRK_VAL}`);

  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

/**
 * Remove `PowerSaveDisable=…` from an iwd main.conf, and drop the
 * `[DriverQuirks]` header too if that leaves the section empty. Other
 * sections/keys are untouched. Returns "" if nothing's left (caller can
 * then delete the file).
 */
export function stripIwdDriverQuirks(existing: string): string {
  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isQuirkSection(line)) {
      // Collect this section's body (until the next header), dropping our key.
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !isSectionHeader(lines[j]); j++) {
        if (!isQuirkKey(lines[j])) body.push(lines[j]);
      }
      // Keep the section only if it still has a non-blank line.
      if (body.some((l) => l.trim() !== "")) {
        out.push(line, ...body);
      }
      i = j - 1; // resume at the next header
      continue;
    }
    out.push(line);
  }

  const joined = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  return joined.trim() === "" ? "" : (joined.endsWith("\n") ? joined : `${joined}\n`);
}

/** Parse `iw dev <iface> get power_save` → "on" | "off" | null. */
export function parsePowerSave(out: string): "on" | "off" | null {
  const m = /power\s*save:\s*(on|off)/i.exec(out);
  return m ? (m[1].toLowerCase() as "on" | "off") : null;
}

// --- impure orchestration ----------------------------------------------------

/** First wireless interface under /sys/class/net, or null. */
export async function detectWirelessIface(deps: PowerSaveDeps): Promise<string | null> {
  const names = await deps.listNet();
  for (const name of names.sort()) {
    if (await deps.isWireless(name)) return name;
  }
  return null;
}

export interface PowerSaveStatus {
  /** Detected wireless interface, or null if none. */
  iface: string | null;
  /** NM drop-in present + setting powersave off. */
  nmConfigured: boolean;
  /** iwd is installed on this system. */
  iwdPresent: boolean;
  /** iwd DriverQuirks PowerSaveDisable present. */
  iwdConfigured: boolean;
  /** Live runtime state, or null when it can't be read. */
  runtime: "on" | "off" | null;
  /** Persistent config fully in place (NM + iwd-where-present). */
  configured: boolean;
}

export async function getStatus(deps: PowerSaveDeps): Promise<PowerSaveStatus> {
  const iface = await detectWirelessIface(deps);

  const nmContent = await deps.readFile(NM_CONF).catch(() => "");
  const nmConfigured = nmDropInActive(nmContent);

  const iwdPresent = await deps.pathExists(IWD_DIR);
  const iwdContent = iwdPresent ? await deps.readFile(IWD_CONF).catch(() => "") : "";
  const iwdConfigured = iwdPresent ? iwdQuirkActive(iwdContent) : false;

  let runtime: "on" | "off" | null = null;
  if (iface) {
    const r = await deps.run(["iw", "dev", iface, "get", "power_save"], { timeoutMs: 5_000 });
    if (r.exitCode === 0) runtime = parsePowerSave(r.stdout);
  }

  const configured = nmConfigured && (!iwdPresent || iwdConfigured);
  return { iface, nmConfigured, iwdPresent, iwdConfigured, runtime, configured };
}

export interface PowerSaveResult {
  success: boolean;
  iface: string | null;
  steps: string[];
  error?: string;
}

/** Disable WiFi power saving: write configs + apply at runtime. */
export async function enable(deps: PowerSaveDeps): Promise<PowerSaveResult> {
  const steps: string[] = [];
  try {
    await deps.writeFile(NM_CONF, buildNmDropIn());
    steps.push("nm-config-written");

    if (await deps.pathExists(IWD_DIR)) {
      const current = await deps.readFile(IWD_CONF).catch(() => "");
      await deps.writeFile(IWD_CONF, mergeIwdDriverQuirks(current));
      steps.push("iwd-config-written");
    }

    const iface = await detectWirelessIface(deps);
    if (iface) {
      const r = await deps.run(["iw", "dev", iface, "set", "power_save", "off"], { timeoutMs: 5_000 });
      if (r.exitCode === 0) steps.push("runtime-off");
      else deps.log?.(`iw set power_save off failed (${r.exitCode}): ${r.stderr.trim()}`);
    }
    deps.log?.(`power-save disabled (${steps.join(", ")})`);
    return { success: true, iface, steps };
  } catch (e) {
    return { success: false, iface: null, steps, error: String(e) };
  }
}

/** Re-enable WiFi power saving (revert): remove configs + apply at runtime. */
export async function disable(deps: PowerSaveDeps): Promise<PowerSaveResult> {
  const steps: string[] = [];
  try {
    await deps.removeFile(NM_CONF);
    steps.push("nm-config-removed");

    if (await deps.pathExists(IWD_CONF)) {
      const current = await deps.readFile(IWD_CONF).catch(() => "");
      const next = stripIwdDriverQuirks(current);
      if (next === "") await deps.removeFile(IWD_CONF);
      else await deps.writeFile(IWD_CONF, next);
      steps.push("iwd-config-removed");
    }

    const iface = await detectWirelessIface(deps);
    if (iface) {
      const r = await deps.run(["iw", "dev", iface, "set", "power_save", "on"], { timeoutMs: 5_000 });
      if (r.exitCode === 0) steps.push("runtime-on");
    }
    deps.log?.(`power-save restored (${steps.join(", ")})`);
    return { success: true, iface, steps };
  } catch (e) {
    return { success: false, iface: null, steps, error: String(e) };
  }
}

/** Re-assert runtime power-save-off (used on resume from sleep). */
export async function reassertRuntime(deps: PowerSaveDeps): Promise<void> {
  const iface = await detectWirelessIface(deps);
  if (!iface) return;
  await deps.run(["iw", "dev", iface, "set", "power_save", "off"], { timeoutMs: 5_000 });
  deps.log?.(`wake: re-asserted power_save off on ${iface}`);
}
