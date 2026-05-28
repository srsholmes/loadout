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
 *   logind SetBrightness D-Bus → sysfs direct write → sysfs via tee
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

/** Run xprop against gamescope display (:1 if DISPLAY not set). */
function xpropArgs(extra: string[]): string[] {
  const args = ["xprop", ...extra];
  if (!process.env.DISPLAY) {
    args.splice(1, 0, "-display", ":1");
  }
  return args;
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
    // 1. Try gamescope (gaming mode) — always check first
    const gRes = await exec(xpropArgs(["-root", SDR_GAMUT_PROP]));
    if (gRes.ok && gRes.stdout.includes("=")) {
      this.method = "gamescope";
      console.log("[display-settings] Using gamescope atoms");
    } else if (process.env.WAYLAND_DISPLAY) {
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
    } else {
      // 3. X11 session — xrandr actually works here
      const xRes = await exec(["xrandr", "--current"]);
      if (xRes.ok) {
        const match = xRes.stdout.match(/^(\S+)\s+connected/m);
        if (match) {
          this.xrandrOutput = match[1];
          this.method = "xrandr";
          console.log(`[display-settings] Using xrandr output: ${this.xrandrOutput}`);
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
    if (this.method === "gamescope") {
      const res = await exec(xpropArgs(["-root", SDR_GAMUT_PROP]));
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

    if (this.method === "gamescope") {
      const floatVal = value / 200;
      const res = await exec(
        xpropArgs([
          "-root", "-f", SDR_GAMUT_PROP, "32c",
          "-set", SDR_GAMUT_PROP, String(floatToLong(floatVal)),
        ]),
      );
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
        // 3. Try via tee (fallback for unusual setups)
        const res = await exec([
          "bash", "-c",
          `echo ${rawValue} | tee ${this.backlightPath}/brightness`,
        ]);
        this._emitState();
        return res.ok;
      }
    }

    // Last resort: xrandr software brightness (X11 only)
    if (this.method === "xrandr" && this.xrandrOutput) {
      const brightnessFloat = value / 100;
      const res = await exec([
        "xrandr", "--output", this.xrandrOutput,
        "--brightness", String(brightnessFloat),
      ]);
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

    if (this.method === "xrandr" && this.xrandrOutput) {
      const res = await exec([
        "xrandr", "--output", this.xrandrOutput,
        "--gamma", `${gamma.r}:${gamma.g}:${gamma.b}`,
      ]);
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

    if (this.method === "xrandr" && this.xrandrOutput) {
      const res = await exec([
        "xrandr", "--output", this.xrandrOutput,
        "--gamma", `${r.toFixed(3)}:${g.toFixed(3)}:${b.toFixed(3)}`,
      ]);
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
