/**
 * InputPlumber D-Bus client for the overlay-wake feature.
 *
 * Thin busctl wrappers, modelled on the proven client in
 * `plugins/disable-controller-input/backend.ts` (same service/iface names,
 * same 5s timeout so a stuck call during an IP restart can't wedge the
 * backend). The backend runs as root, so these go straight through
 * @loadout/exec with no pkexec wrapper.
 *
 * Surface used here that the disable-controller-input client doesn't touch:
 *   - CompositeDevice.Capabilities  (property `as`) — the button list the
 *     picker is built from.
 *   - CompositeDevice.LoadProfilePath(s) (method) — live profile reload.
 *
 * NOTE (verify on hardware): `Capabilities` + `LoadProfilePath` are documented
 * but not yet exercised elsewhere in this repo. Parsing is isolated in
 * `parseStringArrayProp` so it's a one-spot fix if a live dump differs.
 */

import { runFull } from "@loadout/exec";

const SERVICE = "org.shadowblip.InputPlumber";
const COMPOSITE_IFACE = "org.shadowblip.Input.CompositeDevice";
const TARGET_IFACE = "org.shadowblip.Input.Target";
const MANAGER_PATH = "/org/shadowblip/InputPlumber/Manager";
const MANAGER_IFACE = "org.shadowblip.InputManager";

// Match disable-controller-input's ceiling: busctl can block on the system
// bus default timeout (~25s) while IP is mid-restart; 5s fails fast.
const BUSCTL_TIMEOUT_MS = 5000;

const COMPOSITE_PATH_RE = /^\/org\/shadowblip\/InputPlumber\/CompositeDevice\d+$/;

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

async function exec(cmd: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr, exitCode } = await runFull(cmd, {
      timeoutMs: BUSCTL_TIMEOUT_MS,
    });
    return { ok: exitCode === 0, stdout, stderr, code: exitCode };
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      code: -1,
    };
  }
}

function busctl(args: string[]): Promise<ExecResult> {
  return exec(["busctl", "--system", "--no-pager", ...args]);
}

// ── parsers ──────────────────────────────────────────────────────────────

/** Parse a `s "value"` busctl property line. */
export function parseStringProp(stdout: string): string | null {
  const m = stdout.trim().match(/^s\s+"((?:\\.|[^"\\])*)"$/);
  if (!m) return null;
  // Capture group 1 is mandatory, so on a match it is always present.
  return m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Parse a `as N "a" "b" …` busctl string-array property line. Returns `[]`
 *  for `as 0`, null if the shape isn't a string array. */
export function parseStringArrayProp(stdout: string): string[] | null {
  const trimmed = stdout.trim();
  const m = trimmed.match(/^as\s+(\d+)((?:\s+"(?:\\.|[^"\\])*")*)$/);
  if (!m) return null;
  // Both capture groups are mandatory, so on a match m[1] and m[2] are
  // always present; each exec match's group 1 likewise.
  if (parseInt(m[1]!, 10) === 0) return [];
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[2]!)) !== null) {
    out.push(p[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  return out;
}

/** Parse an `ao N "/p1" …` (or `as N …`) array-of-paths property line.
 *  InputPlumber switched `CompositeDevice.TargetDevices` from `ao` (object-path
 *  array) to `as` (string array) around v0.77 — accept both signatures so the
 *  plugin keeps reading targets correctly across versions. The path values
 *  are identical, only the D-Bus type marker differs. */
export function parseObjectPathArrayProp(stdout: string): string[] | null {
  const m = stdout.trim().match(/^a[os]\s+(\d+)((?:\s+"[^"]*")*)$/);
  if (!m) return null;
  // Both capture groups are mandatory, so on a match m[1] and m[2] are
  // always present; each exec match's group 1 likewise.
  if (parseInt(m[1]!, 10) === 0) return [];
  const out: string[] = [];
  const re = /"([^"]*)"/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[2]!)) !== null) out.push(p[1]!);
  return out;
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

// ── D-Bus wrappers ─────────────────────────────────────────────────────────

export async function inputPlumberAvailable(): Promise<boolean> {
  const r = await busctl(["tree", "--list", SERVICE]);
  return r.ok;
}

export async function listCompositeDevicePaths(): Promise<string[]> {
  const r = await busctl(["tree", "--list", SERVICE]);
  if (!r.ok) return [];
  return pickCompositePaths(r.stdout);
}

export async function getCompositeName(path: string): Promise<string | null> {
  const r = await busctl(["get-property", SERVICE, path, COMPOSITE_IFACE, "Name"]);
  return r.ok ? parseStringProp(r.stdout) : null;
}

export async function getCapabilities(path: string): Promise<string[]> {
  const r = await busctl(["get-property", SERVICE, path, COMPOSITE_IFACE, "Capabilities"]);
  if (!r.ok) return [];
  return parseStringArrayProp(r.stdout) ?? [];
}

async function getTargetPaths(path: string): Promise<string[]> {
  const r = await busctl(["get-property", SERVICE, path, COMPOSITE_IFACE, "TargetDevices"]);
  if (!r.ok) return [];
  return parseObjectPathArrayProp(r.stdout) ?? [];
}

async function getTargetKind(path: string): Promise<string | null> {
  const r = await busctl(["get-property", SERVICE, path, TARGET_IFACE, "DeviceType"]);
  return r.ok ? parseStringProp(r.stdout) : null;
}

/** Current non-null target kinds for a composite device — used to preserve the
 *  device's controller emulation when we render the wake profile. */
export async function getTargetKinds(compositePath: string): Promise<string[]> {
  const kinds: string[] = [];
  for (const tp of await getTargetPaths(compositePath)) {
    const kind = await getTargetKind(tp);
    if (kind && kind !== "null") kinds.push(kind);
  }
  return kinds;
}

/** Live-load a profile YAML onto a composite device. No reboot needed. */
export async function loadProfilePath(
  compositePath: string,
  profilePath: string,
): Promise<ExecResult> {
  return busctl([
    "call",
    SERVICE,
    compositePath,
    COMPOSITE_IFACE,
    "LoadProfilePath",
    "s",
    profilePath,
  ]);
}

export interface CompositeDevice {
  path: string;
  name: string;
  capabilities: string[];
}

/** Enable/disable IP management of ALL supported devices (not just configs with
 *  `auto_manage`). Enabling lets IP manage EXTERNAL controllers (Xbox/PS pads)
 *  so the overlay can intercept their input instead of Steam reading them via
 *  hidraw. Onboard-safe: the handheld config is `auto_manage`, so disabling only
 *  releases the external pads. Enable EARLY (backend onLoad — before Steam grabs
 *  external pads at boot) so IP wins the race and Steam never sees the physical
 *  pad (a late enable causes a physical+emulated duplicate). */
export async function setManageAllDevices(enable: boolean): Promise<ExecResult> {
  return busctl([
    "set-property",
    SERVICE,
    MANAGER_PATH,
    MANAGER_IFACE,
    "ManageAllDevices",
    "b",
    enable ? "true" : "false",
  ]);
}

/** Enumerate the connected composite devices with their names + capabilities. */
export async function listCompositeDevices(): Promise<CompositeDevice[]> {
  const out: CompositeDevice[] = [];
  for (const path of await listCompositeDevicePaths()) {
    const name = await getCompositeName(path);
    if (!name) continue;
    out.push({ path, name, capabilities: await getCapabilities(path) });
  }
  return out;
}
