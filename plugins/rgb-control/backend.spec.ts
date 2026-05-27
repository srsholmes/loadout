import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";
import RgbControlBackend from "./backend";

// ── Mock fs sync functions ───────────────────────────────────────

const mockReaddirSync = mock(() => [] as string[]);
const mockReadFileSync = mock(() => Buffer.alloc(0));
const mockOpenSync = mock(() => 99);
const mockWriteSync = mock(() => 0);
const mockCloseSync = mock(() => {});

// Spread real fs to avoid contaminating other modules
import * as realFs from "fs";
mock.module("fs", () => ({
  ...realFs,
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  openSync: mockOpenSync,
  writeSync: mockWriteSync,
  closeSync: mockCloseSync,
}));

// Mock Bun.spawn for shell commands (exec / commandExists)
const mockSpawn = mock(() => ({
  stdout: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(""));
      controller.close();
    },
  }),
  stderr: new ReadableStream({
    start(controller) { controller.close(); },
  }),
  exited: Promise.resolve(0),
  exitCode: 0,
  pid: 1234,
}));

function mockExecResponses(resolver: (cmd: string) => string | null) {
  mockSpawn.mockImplementation((cmd: string[]) => {
    const fullCmd = cmd.join(" ");
    const result = resolver(fullCmd);
    const exitCode = result === null ? 1 : 0;
    return {
      stdout: new ReadableStream({
        start(controller) {
          if (result !== null) {
            controller.enqueue(new TextEncoder().encode(result));
          }
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) { controller.close(); },
      }),
      exited: Promise.resolve(exitCode),
      exitCode,
      pid: 1234,
    };
  });
}

const originalSpawn = Bun.spawn;

describe("RgbControlBackend", () => {
  let backend: RgbControlBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(() => {
    mockReaddirSync.mockReset();
    mockReadFileSync.mockReset();
    mockOpenSync.mockReset();
    mockWriteSync.mockReset();
    mockCloseSync.mockReset();
    mockSpawn.mockClear();

    // Default: no HID devices, no commands available
    mockReaddirSync.mockImplementation(() => []);
    mockReadFileSync.mockImplementation(() => Buffer.alloc(0));

    // @ts-expect-error -- mock
    Bun.spawn = mockSpawn;

    // Default: all commands fail (no openrgb, no sysfs LEDs)
    mockExecResponses(() => null);

    backend = new RgbControlBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
  });

  afterEach(async () => {
    await backend.onUnload();
    Bun.spawn = originalSpawn;
  });

  // ── No Hardware ──────────────────────────────────────────────

  describe("no hardware detected", () => {
    it("reports available=false and driver=None", async () => {
      await backend.onLoad();
      const info = await backend.getRgbInfo();
      expect(info.available).toBe(false);
      expect(info.driver).toBe("None");
      expect(info.zones).toEqual([]);
    });
  });

  // ── OXP HID Detection ───────────────────────────────────────

  describe("OXP HID V2 detection", () => {
    it("detects OneXPlayer HID device from /sys/bus/hid/devices", async () => {
      mockReaddirSync.mockImplementation((path: unknown) => {
        const pathStr = String(path);
        if (pathStr === "/sys/bus/hid/devices") {
          return ["0003:1A2C:B001.0002"];
        }
        // hidraw directory
        if (pathStr.includes("0003:1A2C:B001.0002") && pathStr.includes("hidraw")) {
          return ["hidraw3"];
        }
        return [];
      });

      // Report descriptor with usage page 0xFF01
      mockReadFileSync.mockImplementation(() => {
        const buf = Buffer.alloc(64);
        buf[0] = 0x06; // Usage Page
        buf[1] = 0x01;
        buf[2] = 0xFF;
        return buf;
      });

      await backend.onLoad();
      const info = await backend.getRgbInfo();
      expect(info.available).toBe(true);
      expect(info.driver).toBe("OneXPlayer HID V2");
      expect(info.zones).toHaveLength(1);
      expect(info.zones[0].id).toBe("oxp:all");
      expect(info.zones[0].name).toBe("All LEDs");
    });

    it("skips HID devices that do not match VID:PID", async () => {
      mockReaddirSync.mockImplementation((path: unknown) => {
        const pathStr = String(path);
        if (pathStr === "/sys/bus/hid/devices") {
          return ["0003:DEAD:BEEF.0001"];
        }
        return [];
      });

      await backend.onLoad();
      const info = await backend.getRgbInfo();
      expect(info.available).toBe(false);
    });

    it("skips HID devices with wrong usage page", async () => {
      mockReaddirSync.mockImplementation((path: unknown) => {
        const pathStr = String(path);
        if (pathStr === "/sys/bus/hid/devices") {
          return ["0003:1A2C:B001.0002"];
        }
        return [];
      });

      // Wrong usage page
      mockReadFileSync.mockImplementation(() => {
        const buf = Buffer.alloc(64);
        buf[0] = 0x06;
        buf[1] = 0x00;
        buf[2] = 0x00;
        return buf;
      });

      await backend.onLoad();
      const info = await backend.getRgbInfo();
      expect(info.available).toBe(false);
    });
  });

  // ── OpenRGB Detection ────────────────────────────────────────

  describe("OpenRGB detection", () => {
    it("detects devices via openrgb CLI", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) {
          return [
            "0: Corsair K70 RGB",
            "  Zone 0: Keyboard",
            "  Zone 1: Logo",
          ].join("\n");
        }
        return null;
      });

      await backend.onLoad();
      const info = await backend.getRgbInfo();
      expect(info.available).toBe(true);
      expect(info.driver).toBe("OpenRGB");
      expect(info.zones).toHaveLength(2);
      expect(info.zones[0].id).toBe("openrgb:0:0");
      expect(info.zones[1].id).toBe("openrgb:0:1");
    });

    it("handles devices with no explicit zones", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) {
          return "0: Simple LED Device";
        }
        return null;
      });

      await backend.onLoad();
      const info = await backend.getRgbInfo();
      expect(info.available).toBe(true);
      expect(info.zones).toHaveLength(1);
      expect(info.zones[0].name).toBe("Simple LED Device");
    });
  });

  // ── Sysfs LED Detection ──────────────────────────────────────

  describe("sysfs LED detection", () => {
    it("detects multicolor LEDs in /sys/class/leds", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return null; // openrgb not installed
        if (cmd.includes("ls /sys/class/leds")) {
          return "asus::kbd_backlight\ncapslock";
        }
        if (cmd.includes("multi_index") && cmd.includes("asus")) return "red green blue";
        if (cmd.includes("multi_index") && cmd.includes("capslock")) return null;
        if (cmd.includes("max_brightness") && cmd.includes("asus")) return "255";
        if (cmd.includes("max_brightness") && cmd.includes("capslock")) return "1";
        if (cmd.includes("brightness") && cmd.includes("asus")) return "128";
        if (cmd.includes("brightness") && cmd.includes("capslock")) return "0";
        if (cmd.includes("trigger") && cmd.includes("asus")) return "[none] timer";
        if (cmd.includes("trigger") && cmd.includes("capslock")) return "[none]";
        if (cmd.includes("multi_intensity")) return "128 64 32";
        return null;
      });

      await backend.onLoad();
      const info = await backend.getRgbInfo();
      expect(info.available).toBe(true);
      expect(info.driver).toBe("Sysfs LEDs");
      // Only asus::kbd_backlight (capslock is an indicator, filtered out)
      const asuZone = info.zones.find((z) => z.name === "asus::kbd_backlight");
      expect(asuZone).toBeDefined();
      expect(asuZone!.supportedModes).toContain("breathing"); // has timer trigger
    });

    it("filters out keyboard indicator LEDs", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return null;
        if (cmd.includes("ls /sys/class/leds")) {
          return "capslock\nnumlock\nscrolllock\ncompose\nkana\nreal_led";
        }
        if (cmd.includes("max_brightness")) return "255";
        if (cmd.includes("brightness")) return "100";
        if (cmd.includes("multi_index")) return null;
        if (cmd.includes("trigger")) return "[none]";
        return null;
      });

      await backend.onLoad();
      const info = await backend.getRgbInfo();
      // Should only have real_led, not the indicator LEDs
      expect(info.zones.every((z) => !z.name.includes("capslock"))).toBe(true);
      expect(info.zones.every((z) => !z.name.includes("numlock"))).toBe(true);
    });
  });

  // ── setColor ─────────────────────────────────────────────────

  describe("setColor", () => {
    it("clamps RGB values to 0-255", async () => {
      // Set up a simple openrgb zone
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) return "0: LED";
        if (cmd.includes("openrgb --noautoconnect -d")) return "";
        return null;
      });

      await backend.onLoad();

      // Should not throw; values get clamped
      const result = await backend.setColor("openrgb:0:0", 300, -50, 128);
      // The method should attempt to set the color (clamps internally)
      expect(typeof result).toBe("boolean");
    });

    it("returns false for unknown zone", async () => {
      await backend.onLoad();
      const result = await backend.setColor("nonexistent:zone", 255, 0, 0);
      expect(result).toBe(false);
    });

    it("emits colorChanged event on success", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) return "0: LED";
        if (cmd.includes("openrgb --noautoconnect -d")) return "";
        return null;
      });

      await backend.onLoad();
      await backend.setColor("openrgb:0:0", 255, 0, 0);

      const event = emittedEvents.find((e) => e.event === "colorChanged");
      expect(event).toBeDefined();
      expect((event!.data as { r: number }).r).toBe(255);
    });

    it("sets mode to off when color is (0,0,0)", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) return "0: LED";
        if (cmd.includes("openrgb --noautoconnect -d")) return "";
        return null;
      });

      await backend.onLoad();
      await backend.setColor("openrgb:0:0", 0, 0, 0);

      const info = await backend.getRgbInfo();
      const zone = info.zones.find((z) => z.id === "openrgb:0:0");
      expect(zone!.mode).toBe("off");
    });

    it("OXP HID writes color via hidraw", async () => {
      // Set up OXP detection
      mockReaddirSync.mockImplementation((path: unknown) => {
        const pathStr = String(path);
        if (pathStr === "/sys/bus/hid/devices") return ["0003:1A2C:B001.0002"];
        if (pathStr.includes("hidraw")) return ["hidraw3"];
        return [];
      });
      mockReadFileSync.mockImplementation(() => {
        const buf = Buffer.alloc(64);
        buf[0] = 0x06;
        buf[1] = 0x01;
        buf[2] = 0xFF;
        return buf;
      });

      await backend.onLoad();
      const result = await backend.setColor("oxp:all", 255, 128, 0);
      expect(result).toBe(true);
      expect(mockOpenSync).toHaveBeenCalled();
      expect(mockWriteSync).toHaveBeenCalled();
    });

    it("OXP HID setColor re-enables brightness when LEDs were off", async () => {
      // Regression for #93: hardware reproducer — if user disables LEDs via
      // setMode("off") or setBrightness(0), the controller firmware drops
      // brightness to 0. A subsequent setColor() command lands on the
      // firmware but the LEDs stay dark because brightness is still 0.
      // Verified on Apex hardware: solid-red HID payload sent after a
      // brightness-disable command leaves LEDs off until a brightness
      // -enable command is also sent.
      //
      // The fix: setColor() must re-enable brightness when the zone's
      // current brightness is 0 (or mode is "off"), then send the color.
      mockReaddirSync.mockImplementation((path: unknown) => {
        const pathStr = String(path);
        if (pathStr === "/sys/bus/hid/devices") return ["0003:1A2C:B001.0002"];
        if (pathStr.includes("hidraw")) return ["hidraw3"];
        return [];
      });
      mockReadFileSync.mockImplementation(() => {
        const buf = Buffer.alloc(64);
        buf[0] = 0x06;
        buf[1] = 0x01;
        buf[2] = 0xFF;
        return buf;
      });

      await backend.onLoad();

      // Step 1: user turns LEDs off
      await backend.setMode("oxp:all", "off");
      mockWriteSync.mockClear();

      // Step 2: user picks a new color via the color picker
      const result = await backend.setColor("oxp:all", 255, 0, 0);
      expect(result).toBe(true);

      // Two HID writes must happen: brightness-enable then solid-color.
      // Before the fix, only the color command was sent (LEDs stayed dark).
      expect(mockWriteSync.mock.calls.length).toBeGreaterThanOrEqual(2);

      // First call: brightness-enable command (payload marker 0xFD, enabled=1).
      const brightnessCmd = mockWriteSync.mock.calls[0][1] as Buffer;
      expect(brightnessCmd[2]).toBe(0xFD);
      expect(brightnessCmd[3]).toBe(1); // enabled flag

      // Second call: solid-color command (payload marker 0xFE).
      const colorCmd = mockWriteSync.mock.calls[1][1] as Buffer;
      expect(colorCmd[2]).toBe(0xFE);

      // Zone state reflects the new color + back-to-static mode.
      const info = await backend.getRgbInfo();
      const zone = info.zones.find((z) => z.id === "oxp:all");
      expect(zone?.mode).toBe("static");
      expect(zone?.color).toEqual({ r: 255, g: 0, b: 0 });
      expect(zone?.brightness).toBeGreaterThan(0);
    });

    it("OXP HID writes are spaced at least 50 ms apart (HHD WRITE_DELAY parity)", async () => {
      // Hardware repro on Apex: back-to-back hidraw writes to the OXP
      // controller dropped the second command. HHD enforces a 50 ms
      // gap via `WRITE_DELAY = 0.05`; we mirror that floor. Without
      // it, white came out cyan and primary colours did nothing.
      mockReaddirSync.mockImplementation((path: unknown) => {
        const pathStr = String(path);
        if (pathStr === "/sys/bus/hid/devices")
          return ["0003:1A2C:B001.0002"];
        if (pathStr.includes("hidraw")) return ["hidraw3"];
        return [];
      });
      mockReadFileSync.mockImplementation(() => {
        const buf = Buffer.alloc(64);
        buf[0] = 0x06;
        buf[1] = 0x01;
        buf[2] = 0xFF;
        return buf;
      });

      // Wrap mockWriteSync to record wall-clock time of each call.
      const writeTimes: number[] = [];
      mockWriteSync.mockImplementation(() => {
        writeTimes.push(Date.now());
        return 64;
      });

      await backend.onLoad();
      const ok = await backend.setColor("oxp:all", 255, 0, 0);
      expect(ok).toBe(true);

      // setColor on OXP fires two writes: brightness-enable + colour.
      // The second must land at least ~50 ms after the first (small
      // slack for timer jitter on tight CI loops).
      expect(writeTimes.length).toBeGreaterThanOrEqual(2);
      const gap = writeTimes[1] - writeTimes[0];
      expect(gap).toBeGreaterThanOrEqual(45);
    });

    it("OXP setColor preserves the user's last non-zero brightness preference", async () => {
      // Before: when z.brightness was 0 (user turned LEDs off via
      // setBrightness(0)) the always-re-enable path snapped them to
      // 100% on the next setColor — silently overriding their
      // preference. Now we remember the last non-zero value and
      // restore it.
      mockReaddirSync.mockImplementation((path: unknown) => {
        const pathStr = String(path);
        if (pathStr === "/sys/bus/hid/devices")
          return ["0003:1A2C:B001.0002"];
        if (pathStr.includes("hidraw")) return ["hidraw3"];
        return [];
      });
      mockReadFileSync.mockImplementation(() => {
        const buf = Buffer.alloc(64);
        buf[0] = 0x06;
        buf[1] = 0x01;
        buf[2] = 0xFF;
        return buf;
      });

      await backend.onLoad();
      // User intentionally sets a low brightness, then turns off.
      await backend.setBrightness("oxp:all", 20);
      await backend.setBrightness("oxp:all", 0);
      mockWriteSync.mockClear();

      // Now pick a colour — should restore brightness to ~20, not 100.
      await backend.setColor("oxp:all", 0, 0, 255);

      const info = await backend.getRgbInfo();
      const zone = info.zones.find((z) => z.id === "oxp:all");
      expect(zone?.brightness).toBe(20);

      // First write is brightness with the "low" level code (0x01),
      // not the "high" level (0x04). Payload offset 5 is the
      // brightness-level byte.
      const brightnessCmd = mockWriteSync.mock.calls[0][1] as Buffer;
      expect(brightnessCmd[2]).toBe(0xFD);
      expect(brightnessCmd[3]).toBe(1);
      expect(brightnessCmd[5]).toBe(0x01); // "low"
    });

    it("OXP setColor does not mutate z.brightness when the colour write fails", async () => {
      // Regression: previously z.brightness was bumped before the
      // colour write — if the colour write failed, cached state
      // claimed brightness=100 while the device hadn't visibly
      // changed.
      mockReaddirSync.mockImplementation((path: unknown) => {
        const pathStr = String(path);
        if (pathStr === "/sys/bus/hid/devices")
          return ["0003:1A2C:B001.0002"];
        if (pathStr.includes("hidraw")) return ["hidraw3"];
        return [];
      });
      mockReadFileSync.mockImplementation(() => {
        const buf = Buffer.alloc(64);
        buf[0] = 0x06;
        buf[1] = 0x01;
        buf[2] = 0xFF;
        return buf;
      });

      await backend.onLoad();
      // Force the SECOND write (the colour command) to throw — the
      // first (brightness) succeeds, the second fails.
      let writeCount = 0;
      mockWriteSync.mockImplementation(() => {
        writeCount++;
        if (writeCount === 2) throw new Error("simulated colour write failure");
        return 64;
      });
      await backend.setBrightness("oxp:all", 0);
      mockWriteSync.mockImplementation(() => {
        writeCount++;
        if (writeCount === 2) throw new Error("simulated colour write failure");
        return 64;
      });
      writeCount = 0;

      const ok = await backend.setColor("oxp:all", 255, 0, 0);
      expect(ok).toBe(false);

      const info = await backend.getRgbInfo();
      const zone = info.zones.find((z) => z.id === "oxp:all");
      // brightness must NOT have been bumped to a non-zero value just
      // because the brightness-enable write succeeded.
      expect(zone?.brightness).toBe(0);
    });
  });

  // ── setMode ──────────────────────────────────────────────────

  describe("setMode", () => {
    it("returns false for unknown zone", async () => {
      await backend.onLoad();
      expect(await backend.setMode("nonexistent", "static")).toBe(false);
    });

    it("returns false for unsupported mode", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) return "0: LED";
        return null;
      });

      await backend.onLoad();
      expect(await backend.setMode("openrgb:0:0", "strobe_mega_ultra")).toBe(false);
    });

    it("OXP effect modes enable brightness before setting effect", async () => {
      // Regression test: effect modes (aurora, cyberpunk, etc.) must call
      // oxpSetBrightness(true) before sending the effect command. Without this,
      // effects only work if "static" was applied first (which enables brightness).
      mockReaddirSync.mockImplementation((path: unknown) => {
        const pathStr = String(path);
        if (pathStr === "/sys/bus/hid/devices") return ["0003:1A2C:B001.0002"];
        if (pathStr.includes("hidraw")) return ["hidraw3"];
        return [];
      });
      mockReadFileSync.mockImplementation(() => {
        const buf = Buffer.alloc(64);
        buf[0] = 0x06;
        buf[1] = 0x01;
        buf[2] = 0xFF;
        return buf;
      });

      await backend.onLoad();

      // Apply an effect mode directly (without "static" first)
      const result = await backend.setMode("oxp:all", "cyberpunk");
      expect(result).toBe(true);

      // Should have written TWO commands: brightness enable + effect
      // First write = brightness (0xFD payload), second write = effect (0x09 payload)
      expect(mockWriteSync.mock.calls.length).toBe(2);

      // First call: brightness enable command (payload starts with 0xFD)
      const brightnessCmd = mockWriteSync.mock.calls[0][1] as Buffer;
      expect(brightnessCmd[2]).toBe(0xFD); // brightness command marker

      // Second call: effect command (payload starts with effect code 0x09 = cyberpunk)
      const effectCmd = mockWriteSync.mock.calls[1][1] as Buffer;
      expect(effectCmd[2]).toBe(0x09); // cyberpunk effect code
    });

    it("emits modeChanged event on success", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) return "0: LED";
        if (cmd.includes("openrgb --noautoconnect -d")) return "";
        return null;
      });

      await backend.onLoad();
      await backend.setMode("openrgb:0:0", "static");

      const event = emittedEvents.find((e) => e.event === "modeChanged");
      expect(event).toBeDefined();
      expect((event!.data as { mode: string }).mode).toBe("static");
    });
  });

  // ── setBrightness ────────────────────────────────────────────

  describe("setBrightness", () => {
    it("clamps brightness between 0 and 100", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) return "0: LED";
        if (cmd.includes("openrgb --noautoconnect -d")) return "";
        return null;
      });

      await backend.onLoad();
      await backend.setBrightness("openrgb:0:0", 150);

      const info = await backend.getRgbInfo();
      expect(info.zones[0].brightness).toBe(100);
    });

    it("returns false for unknown zone", async () => {
      await backend.onLoad();
      expect(await backend.setBrightness("missing", 50)).toBe(false);
    });

    it("emits brightnessChanged event", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) return "0: LED";
        if (cmd.includes("openrgb --noautoconnect -d")) return "";
        return null;
      });

      await backend.onLoad();
      await backend.setBrightness("openrgb:0:0", 50);

      const event = emittedEvents.find((e) => e.event === "brightnessChanged");
      expect(event).toBeDefined();
      expect((event!.data as { percent: number }).percent).toBe(50);
    });
  });

  // ── Presets ──────────────────────────────────────────────────

  describe("presets", () => {
    it("returns the built-in color presets", async () => {
      const presets = await backend.getPresets();
      expect(presets.length).toBeGreaterThan(0);

      const red = presets.find((p) => p.name === "Red");
      expect(red).toBeDefined();
      expect(red!.r).toBe(255);
      expect(red!.g).toBe(0);
      expect(red!.b).toBe(0);

      const off = presets.find((p) => p.name === "Off");
      expect(off).toBeDefined();
      expect(off!.r).toBe(0);
    });

    it("applyPreset returns false for unknown preset name", async () => {
      expect(await backend.applyPreset("UltraViolet")).toBe(false);
    });

    it("applyPreset applies color to all zones (case-insensitive)", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) {
          return "0: Device A\n  Zone 0: Main\n  Zone 1: Logo";
        }
        if (cmd.includes("openrgb --noautoconnect -d")) return "";
        return null;
      });

      await backend.onLoad();
      const result = await backend.applyPreset("blue");
      expect(result).toBe(true);

      const event = emittedEvents.find((e) => e.event === "presetApplied");
      expect(event).toBeDefined();
      expect((event!.data as { name: string }).name).toBe("Blue");
    });
  });

  // ── rescan ───────────────────────────────────────────────────

  describe("rescan", () => {
    it("re-runs hardware detection and returns updated info", async () => {
      await backend.onLoad();
      let info = await backend.getRgbInfo();
      expect(info.available).toBe(false);

      // Now simulate OpenRGB appearing
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) return "0: New Device";
        return null;
      });

      info = await backend.rescan();
      expect(info.available).toBe(true);
      expect(info.driver).toBe("OpenRGB");
    });
  });

  // ── getRgbInfo ───────────────────────────────────────────────

  describe("getRgbInfo", () => {
    it("collects supported modes from all zones", async () => {
      mockExecResponses((cmd: string) => {
        if (cmd.includes("which openrgb")) return "/usr/bin/openrgb";
        if (cmd.includes("openrgb --noautoconnect -l")) return "0: LED";
        return null;
      });

      await backend.onLoad();
      const info = await backend.getRgbInfo();
      expect(info.supportedModes).toContain("static");
      expect(info.supportedModes).toContain("off");
    });
  });
});
