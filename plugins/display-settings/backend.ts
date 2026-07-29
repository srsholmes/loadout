import type { PluginBackend, EmitPayload } from "@loadout/types";
import { runFull } from "@loadout/exec";
import { floatToLong, longToFloat, percentToRaw, rawToPercent } from "./lib/color";

/**
 * Display Settings backend — brightness + saturation only.
 *
 * Brightness path (method-independent): logind `SetBrightness` D-Bus →
 * direct sysfs write to /sys/class/backlight/<dev>/brightness as a
 * fallback. Works on every distro / DE that has a backlight device.
 *
 * Saturation path: gamescope's GAMESCOPE_COLOR_SDR_GAMUT_WIDENESS atom
 * (same one VibrantDeck uses). Documented range is 0.0..1.0 (0.5 =
 * sRGB, 1.0 = full panel-wide gamut). Hardware-clipped at 1.0 in
 * practice — pushing higher has no visible effect on the OXP Apex
 * panel, confirmed at write-time, so we stick to the documented range.
 *
 * Detection: enumerate /tmp/.X11-unix/ for active X servers, probe each
 * for the gamescope atom. First match wins; otherwise `method = "none"`
 * and the UI shows a warning banner for the saturation slider.
 *
 * The backend runs as root (systemd system service). X11 calls (xprop)
 * are wrapped in setpriv to drop to the user's uid so gamescope's
 * xhost accepts them — root isn't on its allow-list.
 */

// Gamescope atom — float packed as uint32, 0.0..1.0 (0.5 = sRGB, 1.0 = full wide)
const SDR_GAMUT_PROP = "GAMESCOPE_COLOR_SDR_GAMUT_WIDENESS";

type Method = "gamescope" | "none";

interface DisplayState {
  saturation: number; // 0-200  (100 = sRGB, 200 = max panel-wide)
  brightness: number; // 0-100
}

interface DisplayInfo extends DisplayState {
  method: Method;
  backlightPath: string | null;
  ranges: {
    saturation: [number, number];
    brightness: [number, number];
  };
}

// ---------- helpers ----------

async function exec(
  cmd: string[],
  env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr, exitCode } = await runFull(cmd, { env });
    return { ok: exitCode === 0, stdout, stderr };
  } catch {
    return { ok: false, stdout: "", stderr: "spawn failed" };
  }
}

/**
 * Resolve the target user's uid/gid for X11 calls.
 *
 * The loadout backend runs as a root systemd service but the X server
 * (gamescope) only authorises the *user* it was started for — root
 * isn't on xhost's allow-list. So we drop to the user for any X11
 * read/write via `setpriv --reuid --regid --clear-groups`.
 *
 * Derive uid/gid from `$HOME` (set in the unit file). `null` means
 * we're running unprivileged already (dev), so don't wrap.
 */
async function getUserCreds(): Promise<{ uid: number; gid: number } | null> {
  if (process.getuid?.() !== 0) return null;
  try {
    const home = process.env.HOME;
    if (!home) return null;
    const { stat } = await import("node:fs/promises");
    const s = await stat(home);
    return { uid: s.uid, gid: s.gid };
  } catch {
    return null;
  }
}

/**
 * Discover the X11 display sockets the user's session offers. Returns
 * e.g. `[":0", ":1"]`. Gamescope on the OXP Apex publishes its atoms
 * on `:0` and spawns a nested `:1` — we try both.
 */
async function discoverDisplays(): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir("/tmp/.X11-unix");
    return entries
      .filter((e) => /^X\d+$/.test(e))
      .map((e) => `:${e.slice(1)}`)
      .sort();
  } catch {
    return [":0"];
  }
}

/**
 * Wrap an X11 command (`xprop`) with `setpriv` so it runs as the user
 * gamescope authorised, and inject `DISPLAY` since the service unit
 * doesn't carry it. No-op (returns the command + env directly) when
 * running unprivileged.
 */
function wrapForUser(
  cmd: string[],
  display: string,
  creds: { uid: number; gid: number } | null,
): { cmd: string[]; env: Record<string, string> } {
  const env = {
    DISPLAY: display,
    HOME: process.env.HOME ?? "/",
  };
  if (creds === null) return { cmd, env };
  return {
    cmd: [
      "setpriv",
      "--reuid",
      String(creds.uid),
      "--regid",
      String(creds.gid),
      "--clear-groups",
      "--",
      ...cmd,
    ],
    env,
  };
}

export default class DisplaySettingsBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private state: DisplayState = {
    saturation: 100,
    brightness: 100,
  };

  private method: Method = "none";
  private backlightPath: string | null = null;
  private backlightName: string | null = null;
  private maxBrightness: number = 0;
  /** X11 display where we found the gamescope atom. Null when no
   *  gamescope was detected. */
  private activeDisplay: string | null = null;
  /** Cached uid/gid of the user we drop to for X11 calls. Null when
   *  the backend is running unprivileged already (dev). */
  private userCreds: { uid: number; gid: number } | null = null;

  async onLoad(): Promise<void> {
    console.log("[display-settings] Plugin loaded");
    await this._detectMethod();
    await this._readCurrentState();
  }

  async onUnload(): Promise<void> {
    console.log("[display-settings] Plugin unloaded");
  }

  // ---------- detection ----------

  private async _detectMethod(): Promise<void> {
    this.userCreds = await getUserCreds();
    const displays = await discoverDisplays();

    // Probe each X server for the gamescope SDR-gamut atom.
    for (const display of displays) {
      const { cmd, env } = wrapForUser(
        ["xprop", "-root", SDR_GAMUT_PROP],
        display,
        this.userCreds,
      );
      const gRes = await exec(cmd, env);
      if (gRes.ok && gRes.stdout.includes("=")) {
        this.method = "gamescope";
        this.activeDisplay = display;
        console.log(`[display-settings] Using gamescope atoms on ${display}`);
        break;
      }
    }

    // Backlight detection (independent of method).
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir("/sys/class/backlight");
      const firstBacklight = entries[0];
      if (firstBacklight !== undefined) {
        this.backlightName = firstBacklight;
        this.backlightPath = `/sys/class/backlight/${this.backlightName}`;
        const maxStr = await Bun.file(`${this.backlightPath}/max_brightness`).text();
        this.maxBrightness = parseInt(maxStr.trim(), 10);
        console.log(`[display-settings] Backlight: ${this.backlightPath} (max ${this.maxBrightness})`);
      }
    } catch {
      // No backlight available — slider still renders, writes will no-op.
    }
  }

  private async _readCurrentState(): Promise<void> {
    if (this.method === "gamescope" && this.activeDisplay) {
      const { cmd, env } = wrapForUser(
        ["xprop", "-root", SDR_GAMUT_PROP],
        this.activeDisplay,
        this.userCreds,
      );
      const res = await exec(cmd, env);
      // stdout contains "=", so split yields at least two parts.
      const rawStr = res.ok ? res.stdout.split("=")[1] : undefined;
      if (rawStr !== undefined) {
        const rawVal = parseInt(rawStr.trim(), 10);
        const floatVal = longToFloat(rawVal);
        this.state.saturation = Math.round(floatVal * 200);
      }
    }

    if (this.backlightPath && this.maxBrightness > 0) {
      try {
        const currentStr = await Bun.file(`${this.backlightPath}/brightness`).text();
        const current = parseInt(currentStr.trim(), 10);
        this.state.brightness = rawToPercent(current, this.maxBrightness);
      } catch {
        // ignore
      }
    }
  }

  // ---------- public RPC methods ----------

  async getDisplayInfo(): Promise<DisplayInfo> {
    await this._readCurrentState();
    return {
      ...this.state,
      method: this.method,
      backlightPath: this.backlightPath,
      ranges: {
        saturation: [0, 200],
        brightness: [0, 100],
      },
    };
  }

  async setSaturation(value: number): Promise<boolean> {
    value = Math.max(0, Math.min(200, Math.round(value)));
    this.state.saturation = value;

    if (this.method === "gamescope" && this.activeDisplay) {
      const floatVal = value / 200;
      const { cmd, env } = wrapForUser(
        [
          "xprop", "-root", "-f", SDR_GAMUT_PROP, "32c",
          "-set", SDR_GAMUT_PROP, String(floatToLong(floatVal)),
        ],
        this.activeDisplay,
        this.userCreds,
      );
      const res = await exec(cmd, env);
      this._emitState();
      return res.ok;
    }

    this._emitState();
    return false;
  }

  async setBrightness(value: number): Promise<boolean> {
    value = Math.max(0, Math.min(100, Math.round(value)));
    this.state.brightness = value;

    if (this.backlightPath && this.backlightName && this.maxBrightness > 0) {
      const rawValue = percentToRaw(value, this.maxBrightness);

      // 1. logind D-Bus — works as root, polkit not needed.
      const dbusRes = await exec([
        "busctl", "call",
        "org.freedesktop.login1",
        "/org/freedesktop/login1/session/auto",
        "org.freedesktop.login1.Session",
        "SetBrightness", "ssu",
        "backlight", this.backlightName, String(rawValue),
      ]);
      if (dbusRes.ok) {
        this._emitState();
        return true;
      }

      // 2. sysfs direct write — backend runs as root, declared in
      //    permissions.filesystem for visibility.
      try {
        await Bun.write(`${this.backlightPath}/brightness`, String(rawValue));
        this._emitState();
        return true;
      } catch {
        this._emitState();
        return false;
      }
    }

    this._emitState();
    return false;
  }

  async resetDefaults(): Promise<void> {
    await this.setSaturation(100);
    await this.setBrightness(100);
  }

  // ---------- internals ----------

  private _emitState(): void {
    this.emit?.({
      event: "stateChanged",
      data: { ...this.state },
    });
  }
}
