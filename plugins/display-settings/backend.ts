import type { PluginBackend, EmitPayload } from "@loadout/types";
import { runFull } from "@loadout/exec";
import { kelvinToGamma, floatToLong, longToFloat, percentToRaw, rawToPercent } from "./lib/color";

/**
 * Display Settings backend.
 *
 * Controls display brightness, color temperature, saturation, and gamma.
 *
 * Detection priority:
 *   1. Gamescope color atoms (gaming mode under gamescope compositor)
 *   2. Wayland D-Bus APIs (KDE NightLight + logind backlight)
 *   3. xrandr (X11 sessions only — NOT XWayland, which silently no-ops)
 *
 * Brightness chain (independent of method):
 *   logind SetBrightness D-Bus → sysfs direct write (root, authoritative)
 *
 * The backend runs as root (systemd system service) — no sudo needed.
 * Direct /sys writes via fs are NOT command-gated; declared in
 * plugin.permissions.filesystem for visibility.
 */

// Gamescope atom — float packed as uint32, 0.0..1.0 (0.5 = sRGB, 1.0 = full wide)
const SDR_GAMUT_PROP = "GAMESCOPE_COLOR_SDR_GAMUT_WIDENESS";

type Method = "gamescope" | "wayland" | "xrandr" | "none";

interface DisplayState {
  saturation: number; // 0-200  (100 = normal)
  brightness: number; // 0-100
  colorTemp: number; // 3000-6500 Kelvin
  gamma: { r: number; g: number; b: number };
}

interface DisplayInfo extends DisplayState {
  method: Method;
  xrandrOutput: string | null;
  backlightPath: string | null;
  ranges: {
    saturation: [number, number];
    brightness: [number, number];
    colorTemp: [number, number];
    gamma: [number, number];
  };
}

interface Preset {
  name: string;
  label: string;
  saturation: number;
  colorTemp: number;
  gamma: { r: number; g: number; b: number };
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
 * (gamescope or normal Xorg) only authorises the *user* it was started
 * for — root isn't on xhost's allow-list. So we drop to the user for
 * any X11 read/write via `setpriv --reuid --regid --clear-groups`.
 *
 * Derive uid/gid from `$HOME` (set in the unit file) so we don't have
 * to plumb `--user srsholmes` into every plugin. `null` means we're
 * running unprivileged already (dev), so don't wrap.
 */
async function getUserCreds(): Promise<{ uid: number; gid: number } | null> {
  if (process.getuid?.() !== 0) return null; // not running as root → no need
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
 * Discover the X11 display sockets the user's session is offering. Returns
 * e.g. `[":0", ":1"]`. Some sessions only have one; gamescope on the Apex
 * publishes its atoms on `:0` and exposes a nested `:1` (gamescope's own
 * inner Xwayland) — we try both.
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
    return [":0"]; // sensible default
  }
}

/**
 * Wrap an X11 command (`xprop`, `xrandr`, …) with `setpriv` so it runs
 * as the user gamescope authorised — and inject `DISPLAY` since the
 * service unit doesn't carry it. No-op (just returns the command + env)
 * when running unprivileged.
 */
function wrapForUser(
  cmd: string[],
  display: string,
  creds: { uid: number; gid: number } | null,
): { cmd: string[]; env: Record<string, string> } {
  const env = {
    DISPLAY: display,
    // Some xhost-only sessions need the user's HOME for cookie discovery,
    // and `setpriv --clear-groups` strips it — set it explicitly.
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
    colorTemp: 6500,
    gamma: { r: 1.0, g: 1.0, b: 1.0 },
  };

  private method: Method = "none";
  private xrandrOutput: string | null = null;
  private backlightPath: string | null = null;
  private backlightName: string | null = null;
  private maxBrightness: number = 0;
  private hasNightLight: boolean = false;
  /** X11 display where we found the gamescope atom (or the X server we
   *  drive via xrandr). Populated by _detectMethod. */
  private activeDisplay: string | null = null;
  /** Cached uid/gid of the user we drop to for X11 calls. Null when the
   *  backend is running unprivileged already (dev). */
  private userCreds: { uid: number; gid: number } | null = null;

  async onLoad(): Promise<void> {
    console.log("[display-settings] Plugin loaded");
    await this._detectMethod();
    await this._readCurrentState();
  }

  async onUnload(): Promise<void> {
    // Stop NightLight preview on unload so we don't leave the screen tinted
    if (this.hasNightLight && this.state.colorTemp !== 6500) {
      await exec([
        "busctl", "--user", "call",
        "org.kde.KWin", "/org/kde/KWin/NightLight",
        "org.kde.KWin.NightLight", "stopPreview",
      ]);
    }
    console.log("[display-settings] Plugin unloaded");
  }

  // ---------- detection ----------

  private async _detectMethod(): Promise<void> {
    // Resolve the user we'll drop to for X11 calls. The root systemd
    // service is NOT on the X server's xhost allow-list — only the
    // user gamescope was started for is. setpriv --reuid lets root
    // exec child commands as that user without losing the sysfs
    // permissions root has elsewhere in the plugin.
    this.userCreds = await getUserCreds();
    const displays = await discoverDisplays();

    // 1. Try gamescope on every display socket the session offers.
    //    Gamescope on the OXP Apex publishes the GAMUT atom on :0 and
    //    spawns a nested :1, so we can't hardcode either — enumerate.
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

    if (this.method === "none" && process.env.WAYLAND_DISPLAY) {
      // 2. Wayland session — use D-Bus APIs, NOT xrandr (which only affects XWayland)
      this.method = "wayland";
      console.log("[display-settings] Using Wayland D-Bus APIs");

      // Check for KDE NightLight availability
      const nlRes = await exec([
        "busctl", "--user", "get-property",
        "org.kde.KWin", "/org/kde/KWin/NightLight",
        "org.kde.KWin.NightLight", "available",
      ]);
      if (nlRes.ok && nlRes.stdout.includes("true")) {
        this.hasNightLight = true;
        console.log("[display-settings] KDE NightLight available for color temperature");
      }
    } else if (this.method === "none") {
      // 3. X11 session — xrandr (also user-wrapped). Try every discovered
      //    display, the first one that returns a connected output wins.
      for (const display of displays) {
        const { cmd, env } = wrapForUser(["xrandr", "--current"], display, this.userCreds);
        const xRes = await exec(cmd, env);
        if (!xRes.ok) continue;
        const match = xRes.stdout.match(/^(\S+)\s+connected/m);
        if (match) {
          this.xrandrOutput = match[1];
          this.activeDisplay = display;
          this.method = "xrandr";
          console.log(`[display-settings] Using xrandr output: ${this.xrandrOutput} on ${display}`);
          break;
        }
      }
    }

    // Backlight detection (works for all methods)
    // Uses fs readdir directly — not command-gated, declared in permissions.filesystem
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir("/sys/class/backlight");
      if (entries.length > 0) {
        this.backlightName = entries[0];
        this.backlightPath = `/sys/class/backlight/${this.backlightName}`;
        const maxStr = await Bun.file(`${this.backlightPath}/max_brightness`).text();
        this.maxBrightness = parseInt(maxStr.trim(), 10);
        console.log(`[display-settings] Backlight: ${this.backlightPath} (max ${this.maxBrightness})`);
      }
    } catch {
      // No backlight available
    }
  }

  private async _readCurrentState(): Promise<void> {
    // Read gamescope saturation
    if (this.method === "gamescope" && this.activeDisplay) {
      const { cmd, env } = wrapForUser(
        ["xprop", "-root", SDR_GAMUT_PROP],
        this.activeDisplay,
        this.userCreds,
      );
      const res = await exec(cmd, env);
      if (res.ok && res.stdout.includes("=")) {
        const rawVal = parseInt(res.stdout.split("=")[1].trim(), 10);
        const floatVal = longToFloat(rawVal);
        this.state.saturation = Math.round(floatVal * 200);
      }
    }

    // Read backlight brightness (sysfs direct read — declared in permissions.filesystem)
    if (this.backlightPath && this.maxBrightness > 0) {
      try {
        const currentStr = await Bun.file(`${this.backlightPath}/brightness`).text();
        const current = parseInt(currentStr.trim(), 10);
        this.state.brightness = rawToPercent(current, this.maxBrightness);
      } catch {
        // ignore
      }
    }

    // Read KDE NightLight current temperature
    if (this.hasNightLight) {
      const res = await exec([
        "busctl", "--user", "get-property",
        "org.kde.KWin", "/org/kde/KWin/NightLight",
        "org.kde.KWin.NightLight", "currentTemperature",
      ]);
      if (res.ok) {
        // Output format: "u 6500"
        const match = res.stdout.match(/u\s+(\d+)/);
        if (match) {
          this.state.colorTemp = parseInt(match[1], 10);
          this.state.gamma = kelvinToGamma(this.state.colorTemp);
        }
      }
    }
  }

  // ---------- public RPC methods ----------

  async getDisplayInfo(): Promise<DisplayInfo> {
    await this._readCurrentState();
    return {
      ...this.state,
      method: this.method,
      xrandrOutput: this.xrandrOutput,
      backlightPath: this.backlightPath,
      ranges: {
        saturation: [0, 200],
        brightness: [0, 100],
        colorTemp: [3000, 6500],
        gamma: [0.2, 2.0],
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

    // Saturation is not available on Wayland (KDE) or most xrandr drivers
    this._emitState();
    return false;
  }

  async setBrightness(value: number): Promise<boolean> {
    value = Math.max(0, Math.min(100, Math.round(value)));
    this.state.brightness = value;

    if (this.backlightPath && this.backlightName && this.maxBrightness > 0) {
      const rawValue = percentToRaw(value, this.maxBrightness);

      // 1. Try logind D-Bus (works without root on Wayland & X11)
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

      // 2. Try sysfs direct write (backend runs as root — declared in permissions.filesystem)
      try {
        await Bun.write(`${this.backlightPath}/brightness`, String(rawValue));
        this._emitState();
        return true;
      } catch {
        // Direct sysfs write failed as root — no further fallback needed
        this._emitState();
        return false;
      }
    }

    // Last resort: xrandr software brightness (X11 only)
    if (this.method === "xrandr" && this.xrandrOutput && this.activeDisplay) {
      const brightnessFloat = value / 100;
      const { cmd, env } = wrapForUser(
        [
          "xrandr", "--output", this.xrandrOutput,
          "--brightness", String(brightnessFloat),
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

  async setColorTemp(kelvin: number): Promise<boolean> {
    kelvin = Math.max(3000, Math.min(6500, Math.round(kelvin)));
    this.state.colorTemp = kelvin;

    const gamma = kelvinToGamma(kelvin);

    if (this.method === "wayland" && this.hasNightLight) {
      // KDE NightLight preview — applies the temperature immediately at compositor level
      const res = await exec([
        "busctl", "--user", "call",
        "org.kde.KWin", "/org/kde/KWin/NightLight",
        "org.kde.KWin.NightLight", "preview", "u", String(kelvin),
      ]);
      if (res.ok) {
        this.state.gamma = gamma;
      }
      this._emitState();
      return res.ok;
    }

    if (this.method === "xrandr" && this.xrandrOutput && this.activeDisplay) {
      const { cmd, env } = wrapForUser(
        [
          "xrandr", "--output", this.xrandrOutput,
          "--gamma", `${gamma.r}:${gamma.g}:${gamma.b}`,
        ],
        this.activeDisplay,
        this.userCreds,
      );
      const res = await exec(cmd, env);
      if (res.ok) {
        this.state.gamma = gamma;
      }
      this._emitState();
      return res.ok;
    }

    // Gamescope: store the gamma, gamescope handles night mode at compositor level
    this.state.gamma = gamma;
    this._emitState();
    return this.method === "gamescope";
  }

  async setGamma(r: number, g: number, b: number): Promise<boolean> {
    r = Math.max(0.2, Math.min(2.0, r));
    g = Math.max(0.2, Math.min(2.0, g));
    b = Math.max(0.2, Math.min(2.0, b));
    this.state.gamma = {
      r: +r.toFixed(3),
      g: +g.toFixed(3),
      b: +b.toFixed(3),
    };

    if (this.method === "xrandr" && this.xrandrOutput && this.activeDisplay) {
      const { cmd, env } = wrapForUser(
        [
          "xrandr", "--output", this.xrandrOutput,
          "--gamma", `${r.toFixed(3)}:${g.toFixed(3)}:${b.toFixed(3)}`,
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

  async resetDefaults(): Promise<void> {
    await this.setSaturation(100);
    await this.setBrightness(100);
    await this.setColorTemp(6500);
    await this.setGamma(1.0, 1.0, 1.0);
  }

  async getPresets(): Promise<Preset[]> {
    return [
      {
        name: "default",
        label: "Default",
        saturation: 100,
        colorTemp: 6500,
        gamma: { r: 1.0, g: 1.0, b: 1.0 },
      },
      {
        name: "vivid",
        label: "Vivid",
        saturation: 130,
        colorTemp: 6500,
        gamma: { r: 1.0, g: 1.0, b: 1.0 },
      },
      {
        name: "warm",
        label: "Warm",
        saturation: 100,
        colorTemp: 4500,
        gamma: { r: 1.0, g: 1.0, b: 1.0 },
      },
      {
        name: "cool",
        label: "Cool",
        saturation: 100,
        colorTemp: 6500,
        gamma: { r: 0.95, g: 0.95, b: 1.0 },
      },
      {
        name: "movie",
        label: "Movie",
        saturation: 90,
        colorTemp: 4500,
        gamma: { r: 1.0, g: 1.0, b: 1.0 },
      },
    ];
  }

  async applyPreset(name: string): Promise<boolean> {
    const presets = await this.getPresets();
    const preset = presets.find((p) => p.name === name);
    if (!preset) return false;

    await this.setSaturation(preset.saturation);
    await this.setColorTemp(preset.colorTemp);
    await this.setGamma(preset.gamma.r, preset.gamma.g, preset.gamma.b);
    return true;
  }

  // ---------- internals ----------

  private _emitState(): void {
    this.emit?.({
      event: "stateChanged",
      data: { ...this.state },
    });
  }
}
