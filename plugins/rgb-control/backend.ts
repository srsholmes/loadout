import type { PluginBackend, EmitPayload, RetryScanner } from "@loadout/types";
import { createRetryScanner } from "@loadout/types";
import { run, commandExists } from "@loadout/exec";
import { openSync, writeSync, closeSync, readdirSync, readFileSync } from "fs";
import {
  OXP_VID,
  OXP_PID,
  OXP_EFFECTS,
  OXP_MODES,
  ALL_MODES,
  COLOR_PRESETS,
  type Preset,
  oxpCmd,
  oxpBrightnessLevel,
  oxpBrightnessCode,
  clamp,
  toHex,
} from "./lib/oxp";
import { parseOpenRgbList } from "./lib/openrgb-parse";

/**
 * RGB backend interface — the detected hardware driver in use.
 */
interface RgbDriver {
  type: "oxp-hid" | "openrgb" | "sysfs" | "none";
  name: string;
  zones: RgbZone[];
}

interface RgbZone {
  id: string;
  name: string;
  color: { r: number; g: number; b: number };
  brightness: number;
  mode: string;
  supportedModes: string[];
}

interface RgbInfo {
  available: boolean;
  driver: string;
  zones: RgbZone[];
  supportedModes: string[];
}

/**
 * Minimum gap between consecutive writes to the OXP controller (ms).
 * The firmware silently drops back-to-back commands: a brightness
 * write followed immediately by a colour write left the colour write
 * partially applied (white came out cyan; primary colours vanished
 * entirely). HHD's reference uses `WRITE_DELAY = 0.05` after every
 * write — we mirror it. The gap is measured from the *completion* of
 * the previous write (after `closeSync`), not its start, so a slow
 * write doesn't shrink the effective gap.
 */
const OXP_WRITE_GAP_MS = 50;
let lastOxpWriteMs = 0;
/**
 * Single-lane queue so concurrent oxpWrite calls don't both see the
 * gap satisfied and race past it. Each call awaits the prior one's
 * completion before computing its own wait — guarantees serialised
 * writes with the 50 ms floor even under heavy contention (e.g. user
 * dragging a slider while a preset press is still in flight).
 */
let oxpWriteChain: Promise<unknown> = Promise.resolve();

/** Write a raw command to a hidraw device, serialised with a 50 ms
 *  inter-write floor to satisfy the OXP firmware. */
function oxpWrite(devPath: string, cmd: Buffer): Promise<boolean> {
  const next = oxpWriteChain.then(async () => {
    const wait = OXP_WRITE_GAP_MS - (Date.now() - lastOxpWriteMs);
    if (wait > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    let ok = false;
    try {
      const hex = [...cmd.subarray(0, 8)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      console.log(`[rgb-control] hidraw write: ${devPath} → [${hex} ...]`);
      const fd = openSync(devPath, "w");
      writeSync(fd, cmd);
      closeSync(fd);
      ok = true;
    } catch (e) {
      console.log(`[rgb-control] hidraw write error: ${e}`);
      ok = false;
    } finally {
      // Stamp *after* the write completes (success or failure) so the
      // gap accounts for the actual time the kernel spent on the
      // hidraw syscall.
      lastOxpWriteMs = Date.now();
    }
    return ok;
  });
  // Detach from the rejection path on the chain itself — otherwise a
  // single throw would poison every subsequent write. The caller's
  // returned promise still surfaces its own outcome below.
  oxpWriteChain = next.catch(() => undefined);
  return next;
}

/**
 * Find the hidraw device node for the OXP V2 RGB controller (1A2C:B001).
 * Scans /sys/bus/hid/devices/ for the matching VID:PID and usage page 0xFF01.
 */
function findOxpHidraw(): string | null {
  try {
    const hid_devices = readdirSync("/sys/bus/hid/devices");
    for (const dev of hid_devices) {
      // Match devices like "0003:1A2C:B001.0002"
      if (!dev.toUpperCase().includes(`:${OXP_VID}:${OXP_PID}`)) continue;

      const devPath = `/sys/bus/hid/devices/${dev}`;
      // Check report descriptor for usage page 0xFF01
      try {
        const desc = readFileSync(`${devPath}/report_descriptor`);
        // Usage page 0xFF01 encoded as: 06 01 FF
        if (desc[0] === 0x06 && desc[1] === 0x01 && desc[2] === 0xFF) {
          // Found the right interface — get its hidraw node
          const hidrawDir = readdirSync(`${devPath}/hidraw`);
          if (hidrawDir.length > 0) {
            return `/dev/${hidrawDir[0]}`;
          }
        }
      } catch {
        continue;
      }
    }
  } catch (e) {
    console.log(`[rgb-control] HID scan error: ${e}`);
  }
  return null;
}

/**
 * Writes a string to a sysfs (or any) file without spawning a subprocess.
 *
 * Replaces the legacy `echo VALUE | tee PATH` pattern: same privilege model
 * (current uid — relies on udev rules granting write access on LED nodes),
 * but no shell, no subprocess, no shell-injection surface through `path`.
 * Returns true on success, false if the write failed (typically EACCES on
 * a root-owned sysfs node with no udev rule loosening it up).
 */
async function writeSysfs(path: string, value: string | number): Promise<boolean> {
  try {
    await Bun.write(path, String(value));
    return true;
  } catch (e) {
    console.log(`[rgb-control] writeSysfs ${path} failed: ${e}`);
    return false;
  }
}

/**
 * Runs a shell command and returns stdout, or null on failure.
 *
 * Wraps `@loadout/exec`'s `run()` in a `bash -c` shell — the
 * detection / control paths use a few legacy `cat ... 2>/dev/null`
 * and `ls ... 2>/dev/null` invocations whose stderr-silenced shape
 * the tests rely on. The capability gate matches on `basename(cmd[0])`
 * only, so `bash` is the binary that must appear in
 * `permissions.commands`.
 */
async function exec(cmd: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await run(["bash", "-c", cmd]);
    if (exitCode !== 0) return null;
    return stdout;
  } catch {
    return null;
  }
}

/**
 * RGB Control plugin backend.
 *
 * Detection priority:
 * 1. OXP HID V2 — direct hidraw to OneXPlayer Apex RGB controller (1A2C:B001)
 * 2. OpenRGB CLI — widest hardware support, user may have it installed
 * 3. sysfs LEDs — kernel-level LED class devices (multicolor and single-color)
 * 4. Platform-specific paths (OneXPlayer, ASUS, etc.)
 *
 * If no RGB hardware is found, the plugin gracefully reports that and still loads.
 */
export default class RgbControlBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private driver: RgbDriver = { type: "none", name: "None", zones: [] };
  private hardwareScanner?: RetryScanner;

  async onLoad(): Promise<void> {
    console.log("[rgb-control] Plugin loaded, detecting RGB hardware...");

    // Devices can be plugged in, OpenRGB started, etc. long after the plugin
    // loads — use the shared retry scanner to keep looking until one appears.
    this.hardwareScanner = createRetryScanner({
      label: "rgb-control",
      scan: async () => {
        await this.detectHardware();
        return this.driver.type !== "none";
      },
      intervalMs: 30_000,
      onFound: async () => {
        this.emit?.({ event: "hardwareChanged", data: await this.getRgbInfo() });
      },
    });
    await this.hardwareScanner.start();
  }

  async onUnload(): Promise<void> {
    this.hardwareScanner?.stop();
    console.log("[rgb-control] Plugin unloaded");
  }

  /** The hidraw device path when using OXP HID V2 driver */
  private oxpDevPath: string | null = null;

  /**
   * Per-zone last-non-zero brightness — preserves the user's
   * preference when we have to re-enable the LED block during a
   * setColor on a zone whose tracked brightness is 0. Without this
   * the always-re-enable path snapped users at 0% to 100% on the
   * next colour change, silently overriding their setting.
   */
  private lastNonZeroBrightness = new Map<string, number>();

  // ── Hardware Detection ──────────────────────────────────────────

  private async detectHardware(): Promise<void> {
    // 1. Try OXP HID V2 (OneXPlayer Apex direct hidraw — highest priority)
    if (this.detectOxpHid()) return;

    // 2. Try OpenRGB
    if (await this.detectOpenRgb()) return;

    // 3. Try sysfs LEDs
    if (await this.detectSysfsLeds()) return;

    // 4. Try platform-specific paths
    if (await this.detectPlatformSpecific()) return;

    console.log("[rgb-control] No RGB hardware detected");
    this.driver = { type: "none", name: "None", zones: [] };
  }

  private detectOxpHid(): boolean {
    const devPath = findOxpHidraw();
    if (!devPath) return false;

    this.oxpDevPath = devPath;
    this.driver = {
      type: "oxp-hid",
      name: "OneXPlayer HID V2",
      zones: [
        {
          id: "oxp:all",
          name: "All LEDs",
          color: { r: 0, g: 0, b: 0 },
          brightness: 100,
          mode: "cyberpunk",
          supportedModes: [...OXP_MODES],
        },
      ],
    };
    console.log(`[rgb-control] OXP HID V2 detected at ${devPath}`);
    return true;
  }

  private async detectOpenRgb(): Promise<boolean> {
    if (!(await commandExists("openrgb"))) return false;

    try {
      const listOutput = await exec("openrgb --noautoconnect -l 2>/dev/null");
      if (!listOutput) return false;

      const zones: RgbZone[] = parseOpenRgbList(listOutput);
      if (zones.length === 0) return false;

      this.driver = { type: "openrgb", name: "OpenRGB", zones };
      console.log(`[rgb-control] OpenRGB detected with ${zones.length} zone(s)`);
      return true;
    } catch (e) {
      console.log("[rgb-control] OpenRGB detection failed:", e);
      return false;
    }
  }

  private async detectSysfsLeds(): Promise<boolean> {
    try {
      const ledsOutput = await exec("ls /sys/class/leds/ 2>/dev/null");
      if (!ledsOutput) return false;

      const ledNames = ledsOutput.split("\n").filter((n) => n.length > 0);
      const zones: RgbZone[] = [];

      for (const ledName of ledNames) {
        const basePath = `/sys/class/leds/${ledName}`;

        // Check if this is an RGB-capable LED (multicolor or has color sub-LEDs)
        const isMulticolor = await exec(`cat ${basePath}/multi_index 2>/dev/null`);
        const hasBrightness = await exec(`cat ${basePath}/max_brightness 2>/dev/null`);

        if (!hasBrightness) continue;

        // Skip keyboard indicator LEDs (capslock, numlock, scrolllock, etc.)
        const isIndicator =
          ledName.includes("capslock") ||
          ledName.includes("numlock") ||
          ledName.includes("scrolllock") ||
          ledName.includes("compose") ||
          ledName.includes("kana");
        if (isIndicator) continue;

        // Determine what modes we support for this LED
        const supportedModes: string[] = ["static", "off"];
        // Check for trigger support (breathing via "timer" trigger)
        const triggers = await exec(`cat ${basePath}/trigger 2>/dev/null`);
        if (triggers?.includes("timer")) {
          supportedModes.push("breathing");
        }

        const currentBrightness = parseInt(
          (await exec(`cat ${basePath}/brightness 2>/dev/null`)) || "0",
          10
        );
        const maxBrightness = parseInt(hasBrightness, 10);
        const brightnessPct = maxBrightness > 0
          ? Math.round((currentBrightness / maxBrightness) * 100)
          : 100;

        // Try to read current color
        let color = { r: 0, g: 0, b: 0 };
        if (isMulticolor) {
          const intensity = await exec(
            `cat ${basePath}/multi_intensity 2>/dev/null`
          );
          if (intensity) {
            const parts = intensity.split(/\s+/).map(Number);
            if (parts.length >= 3) {
              color = { r: parts[0]!, g: parts[1]!, b: parts[2]! }; // length >= 3
            }
          }
        }

        zones.push({
          id: `sysfs:${ledName}`,
          name: ledName,
          color,
          brightness: brightnessPct,
          mode: currentBrightness === 0 ? "off" : "static",
          supportedModes,
        });
      }

      if (zones.length === 0) return false;

      this.driver = { type: "sysfs", name: "Sysfs LEDs", zones };
      console.log(`[rgb-control] sysfs LEDs detected: ${zones.length} zone(s)`);
      return true;
    } catch (e) {
      console.log("[rgb-control] sysfs detection failed:", e);
      return false;
    }
  }

  private async detectPlatformSpecific(): Promise<boolean> {
    // OneXPlayer LED path
    const oxpPath = "/sys/devices/platform/oxp-ec/leds";
    const oxpExists = await exec(`ls ${oxpPath} 2>/dev/null`);
    if (oxpExists) {
      this.driver = {
        type: "sysfs",
        name: "OneXPlayer LEDs",
        zones: [
          {
            id: `platform:oxp:main`,
            name: "OneXPlayer Main",
            color: { r: 0, g: 0, b: 0 },
            brightness: 100,
            mode: "static",
            supportedModes: [...ALL_MODES],
          },
        ],
      };
      console.log("[rgb-control] OneXPlayer platform LEDs detected");
      return true;
    }

    // ASUS ROG Ally aura path
    const asusPath = "/sys/devices/platform/asus-nb-wmi/leds";
    const asusExists = await exec(`ls ${asusPath} 2>/dev/null`);
    if (asusExists) {
      this.driver = {
        type: "sysfs",
        name: "ASUS ROG LEDs",
        zones: [
          {
            id: `platform:asus:main`,
            name: "ASUS ROG Main",
            color: { r: 0, g: 0, b: 0 },
            brightness: 100,
            mode: "static",
            supportedModes: [...ALL_MODES],
          },
        ],
      };
      console.log("[rgb-control] ASUS platform LEDs detected");
      return true;
    }

    // Ayaneo LED path
    const ayaneoPath = "/sys/devices/platform/ayaneo-ec/leds";
    const ayaneoExists = await exec(`ls ${ayaneoPath} 2>/dev/null`);
    if (ayaneoExists) {
      this.driver = {
        type: "sysfs",
        name: "Ayaneo LEDs",
        zones: [
          {
            id: `platform:ayaneo:main`,
            name: "Ayaneo Main",
            color: { r: 0, g: 0, b: 0 },
            brightness: 100,
            mode: "static",
            supportedModes: [...ALL_MODES],
          },
        ],
      };
      console.log("[rgb-control] Ayaneo platform LEDs detected");
      return true;
    }

    return false;
  }

  // ── Public RPC Methods ──────────────────────────────────────────

  /** Returns information about available RGB hardware. */
  async getRgbInfo(): Promise<RgbInfo> {
    const allModes = new Set<string>();
    for (const zone of this.driver.zones) {
      for (const m of zone.supportedModes) allModes.add(m);
    }

    return {
      available: this.driver.type !== "none",
      driver: this.driver.name,
      zones: this.driver.zones,
      supportedModes: [...allModes],
    };
  }

  /** Sets the color for a specific zone. */
  async setColor(zone: string, r: number, g: number, b: number): Promise<boolean> {
    console.log(`[rgb-control] setColor: zone=${zone} rgb=(${r},${g},${b})`);
    r = clamp(r, 0, 255);
    g = clamp(g, 0, 255);
    b = clamp(b, 0, 255);

    const z = this.driver.zones.find((z) => z.id === zone);
    if (!z) return false;

    let success = false;

    if (z.id.startsWith("oxp:")) {
      // Issue #93 / hardware repro on Apex: if LEDs are disabled on the
      // controller firmware (mode="off", brightness=0, fresh boot,
      // physical-button toggle — any cause we can't observe), a solid-
      // colour write lands silently with no visual effect. The previous
      // fix only re-enabled when our *cached* state said the zone was
      // off; in practice the cache drifts (we can't read back firmware
      // state), so the gate frequently misfired and the LEDs stayed
      // dark. Always re-enable before the colour write — the brightness
      // hidraw command is cheap and idempotent, and it's the only
      // signal we have that reliably wakes the LED block up.
      //
      // When the user is intentionally at 0%, re-enable to their last
      // non-zero preference (or 100% on first run) rather than snapping
      // to 100% — silently overriding a deliberate setting was a
      // regression in the original gate-removal patch.
      const targetPct =
        z.brightness > 0
          ? z.brightness
          : (this.lastNonZeroBrightness.get(z.id) ?? 100);
      const level = oxpBrightnessLevel(targetPct);
      await this.oxpSetBrightnessLevel(true, level);
      success = await this.oxpSetColor(r, g, b);
      if (success) {
        z.brightness = targetPct;
        z.mode = "static";
      }
    } else if (z.id.startsWith("openrgb:")) {
      const [, deviceIndex] = z.id.split(":");
      success = (await exec(
        `openrgb --noautoconnect -d ${deviceIndex} -c ${toHex(r, g, b)}`
      )) !== null;
    } else if (z.id.startsWith("sysfs:") || z.id.startsWith("platform:")) {
      success = await this.setSysfsColor(z.id, r, g, b);
    }

    if (success) {
      z.color = { r, g, b };
      if (r === 0 && g === 0 && b === 0) {
        z.mode = "off";
      } else if (z.mode === "off") {
        z.mode = "static";
      }
      this.emit?.({ event: "colorChanged", data: { zone: z.id, r, g, b } });
    }

    return success;
  }

  /** Sets the mode for a specific zone. */
  async setMode(zone: string, mode: string): Promise<boolean> {
    console.log(`[rgb-control] setMode: zone=${zone} mode=${mode}`);
    const z = this.driver.zones.find((z) => z.id === zone);
    if (!z) { console.log(`[rgb-control] setMode: zone not found`); return false; }
    if (!z.supportedModes.includes(mode)) { console.log(`[rgb-control] setMode: mode "${mode}" not supported`); return false; }

    let success = false;

    if (z.id.startsWith("oxp:")) {
      if (mode === "off") {
        success = await this.oxpSetBrightness(false);
      } else if (mode === "static") {
        // Re-apply current colour as solid. Sequential awaits so the
        // 50 ms inter-write gap that `oxpWrite` enforces survives —
        // `Promise && Promise` would evaluate both eagerly without
        // awaiting between them.
        const br = await this.oxpSetBrightness(true);
        if (!br) {
          console.warn(
            `[rgb-control] setMode: oxp brightness-enable failed, skipping colour write`,
          );
          success = false;
        } else {
          success = await this.oxpSetColor(z.color.r, z.color.g, z.color.b);
          if (!success) {
            console.warn(
              `[rgb-control] setMode: oxp brightness ON but colour write failed — device may be in partial-on state`,
            );
          }
        }
      } else if (mode in OXP_EFFECTS) {
        const br = await this.oxpSetBrightness(true);
        if (!br) {
          console.warn(
            `[rgb-control] setMode: oxp brightness-enable failed, skipping effect`,
          );
          success = false;
        } else {
          success = await this.oxpSetEffect(mode);
          if (!success) {
            console.warn(
              `[rgb-control] setMode: oxp brightness ON but effect write failed — device may be in partial-on state`,
            );
          }
        }
      }
    } else if (z.id.startsWith("openrgb:")) {
      const [, deviceIndex] = z.id.split(":");
      const modeMap: Record<string, string> = {
        static: "static",
        breathing: "breathing",
        rainbow: "rainbow",
        off: "off",
      };
      const openrgbMode = modeMap[mode] || "static";
      if (mode === "off") {
        success = (await exec(
          `openrgb --noautoconnect -d ${deviceIndex} -c 000000`
        )) !== null;
      } else {
        success = (await exec(
          `openrgb --noautoconnect -d ${deviceIndex} -m "${openrgbMode}"`
        )) !== null;
      }
    } else if (z.id.startsWith("sysfs:")) {
      const ledName = z.id.replace("sysfs:", "");
      const basePath = `/sys/class/leds/${ledName}`;

      if (mode === "off") {
        success = await writeSysfs(`${basePath}/brightness`, 0);
      } else if (mode === "breathing") {
        // Use "timer" trigger for breathing effect — three sequential sysfs writes
        const trigOk = await writeSysfs(`${basePath}/trigger`, "timer");
        // delay_on / delay_off attributes only appear after the timer trigger
        // is selected; doing this in-order matches the kernel led-class state
        // machine (same as the original chained `&&` pipeline).
        const onOk = await writeSysfs(`${basePath}/delay_on`, 500);
        const offOk = await writeSysfs(`${basePath}/delay_off`, 500);
        success = trigOk && onOk && offOk;
      } else {
        // Static — clear trigger, restore brightness
        await writeSysfs(`${basePath}/trigger`, "none");
        const maxBrightness = await exec(`cat ${basePath}/max_brightness 2>/dev/null`);
        if (maxBrightness) {
          const val = Math.round(
            (z.brightness / 100) * parseInt(maxBrightness, 10)
          );
          success = await writeSysfs(`${basePath}/brightness`, val);
        }
      }
    } else if (z.id.startsWith("platform:")) {
      // Platform-specific mode handling — fallback to color-based control
      if (mode === "off") {
        success = await this.setSysfsColor(z.id, 0, 0, 0);
      } else {
        success = true; // Mode change acknowledged, hardware may not support all modes
      }
    }

    console.log(`[rgb-control] setMode result: success=${success}`);
    if (success) {
      z.mode = mode;
      this.emit?.({ event: "modeChanged", data: { zone: z.id, mode } });
    }

    return success;
  }

  /** Sets the brightness for a specific zone (0-100%). */
  async setBrightness(zone: string, percent: number): Promise<boolean> {
    console.log(`[rgb-control] setBrightness: zone=${zone} percent=${percent}`);
    percent = clamp(percent, 0, 100);

    const z = this.driver.zones.find((z) => z.id === zone);
    if (!z) return false;

    let success = false;

    if (z.id.startsWith("oxp:")) {
      // OXP V2 has 3 brightness levels: low (1-33%), medium (34-66%), high (67-100%)
      const enabled = percent > 0;
      const level = oxpBrightnessLevel(percent);
      success = await this.oxpSetBrightnessLevel(enabled, level);
    } else if (z.id.startsWith("openrgb:")) {
      const [, deviceIndex] = z.id.split(":");
      // OpenRGB brightness: scale current color
      const factor = percent / 100;
      const r = Math.round(z.color.r * factor);
      const g = Math.round(z.color.g * factor);
      const b = Math.round(z.color.b * factor);
      success = (await exec(
        `openrgb --noautoconnect -d ${deviceIndex} -c ${toHex(r, g, b)}`
      )) !== null;
    } else if (z.id.startsWith("sysfs:")) {
      const ledName = z.id.replace("sysfs:", "");
      const basePath = `/sys/class/leds/${ledName}`;
      const maxBrightness = await exec(`cat ${basePath}/max_brightness 2>/dev/null`);
      if (maxBrightness) {
        const val = Math.round((percent / 100) * parseInt(maxBrightness, 10));
        success = await writeSysfs(`${basePath}/brightness`, val);
      }
    } else if (z.id.startsWith("platform:")) {
      success = true; // Brightness acknowledged
    }

    if (success) {
      z.brightness = percent;
      // Remember the user's preference so a setColor on a zone at 0%
      // can restore it rather than snapping to full.
      if (percent > 0) this.lastNonZeroBrightness.set(z.id, percent);
      this.emit?.({ event: "brightnessChanged", data: { zone: z.id, percent } });
    }

    return success;
  }

  /** Returns available color presets. */
  async getPresets(): Promise<Preset[]> {
    return COLOR_PRESETS;
  }

  /** Applies a color preset to all zones. */
  async applyPreset(name: string): Promise<boolean> {
    const preset = COLOR_PRESETS.find(
      (p) => p.name.toLowerCase() === name.toLowerCase()
    );
    if (!preset) return false;

    let allOk = true;
    for (const zone of this.driver.zones) {
      const ok = await this.setColor(zone.id, preset.r, preset.g, preset.b);
      if (!ok) allOk = false;
    }

    this.emit?.({
      event: "presetApplied",
      data: { name: preset.name, r: preset.r, g: preset.g, b: preset.b },
    });

    return allOk;
  }

  /** Re-runs hardware detection and returns the new info. */
  async rescan(): Promise<RgbInfo> {
    await this.detectHardware();
    return this.getRgbInfo();
  }

  // ── OXP HID V2 helpers ──────────────────────────────────────────

  private async oxpSetColor(r: number, g: number, b: number): Promise<boolean> {
    if (!this.oxpDevPath) return false;
    // Solid color: cmd 0x07, payload [0xFE, R,G,B x20, 0x00]
    const payload: number[] = [0xFE];
    for (let i = 0; i < 20; i++) payload.push(r, g, b);
    payload.push(0x00);
    return oxpWrite(this.oxpDevPath, oxpCmd(0x07, payload));
  }

  private async oxpSetEffect(effect: string): Promise<boolean> {
    if (!this.oxpDevPath) return false;
    const code = OXP_EFFECTS[effect];
    if (code === undefined) return false;
    console.log(`[rgb-control] Setting OXP effect: ${effect} (0x${code.toString(16)})`);
    return oxpWrite(this.oxpDevPath, oxpCmd(0x07, [code]));
  }

  private oxpSetBrightness(enabled: boolean): Promise<boolean> {
    return this.oxpSetBrightnessLevel(enabled, "high");
  }

  private async oxpSetBrightnessLevel(
    enabled: boolean,
    level: "low" | "medium" | "high",
  ): Promise<boolean> {
    if (!this.oxpDevPath) return false;
    // Brightness: cmd 0x07, payload [0xFD, enabled, 0x05, brightness_code]
    const bc = oxpBrightnessCode(level);
    return oxpWrite(this.oxpDevPath, oxpCmd(0x07, [0xFD, enabled ? 1 : 0, 0x05, bc]));
  }

  // ── Internal helpers ────────────────────────────────────────────

  private async setSysfsColor(
    zoneId: string,
    r: number,
    g: number,
    b: number
  ): Promise<boolean> {
    if (zoneId.startsWith("sysfs:")) {
      const ledName = zoneId.replace("sysfs:", "");
      const basePath = `/sys/class/leds/${ledName}`;

      // Check for multicolor support
      const multiIndex = await exec(`cat ${basePath}/multi_index 2>/dev/null`);
      if (multiIndex) {
        return await writeSysfs(
          `${basePath}/multi_intensity`,
          `${r} ${g} ${b}`,
        );
      }

      // Fallback: single-color LED — set brightness proportional to color intensity
      const maxBrightness = await exec(`cat ${basePath}/max_brightness 2>/dev/null`);
      if (maxBrightness) {
        const intensity = Math.max(r, g, b);
        const val = Math.round(
          (intensity / 255) * parseInt(maxBrightness, 10)
        );
        return await writeSysfs(`${basePath}/brightness`, val);
      }
    }

    return false;
  }
}
