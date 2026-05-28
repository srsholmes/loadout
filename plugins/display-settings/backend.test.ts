import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { EmitPayload } from "@loadout/types";

/**
 * Display Settings backend tests.
 *
 * runFull (from @loadout/exec) internally calls Bun.spawn, so we spy on
 * Bun.spawn to intercept all external commands. Spec files are exempt
 * from the no-Bun.spawn eslint rule.
 *
 * backlight reads use Bun.file; backlight writes use Bun.write. Both are
 * tested via spies on the relevant Bun API.
 */

import DisplaySettingsBackend from "./backend";

describe("DisplaySettingsBackend", () => {
  let backend: DisplaySettingsBackend;
  let emittedEvents: EmitPayload[];
  let spawnSpy: ReturnType<typeof spyOn>;
  let savedWaylandDisplay: string | undefined;

  beforeEach(() => {
    // detectMethod() branches on process.env.WAYLAND_DISPLAY before falling
    // through to xrandr. CI and dev shells both leak this var, so tests that
    // assert the xrandr path see "wayland" unless we scrub the env here.
    savedWaylandDisplay = process.env.WAYLAND_DISPLAY;
    delete process.env.WAYLAND_DISPLAY;

    backend = new DisplaySettingsBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };

    // Default spawn mock: all commands fail (no gamescope, no xrandr)
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      () =>
        ({
          stdout: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(""));
              c.close();
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(""));
              c.close();
            },
          }),
          exited: Promise.resolve(1),
        }) as ReturnType<typeof Bun.spawn>,
    );
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    if (savedWaylandDisplay !== undefined) {
      process.env.WAYLAND_DISPLAY = savedWaylandDisplay;
    } else {
      delete process.env.WAYLAND_DISPLAY;
    }
  });

  // ---------------------------------------------------------------------------
  // setColorTemp — color temperature conversion
  // ---------------------------------------------------------------------------

  describe("setColorTemp()", () => {
    it("clamps kelvin to minimum 3000", async () => {
      await backend.setColorTemp(1000);
      const info = await backend.getDisplayInfo();
      expect(info.colorTemp).toBe(3000);
    });

    it("clamps kelvin to maximum 6500", async () => {
      await backend.setColorTemp(10000);
      const info = await backend.getDisplayInfo();
      expect(info.colorTemp).toBe(6500);
    });

    it("stores the clamped kelvin value", async () => {
      await backend.setColorTemp(4500);
      const info = await backend.getDisplayInfo();
      expect(info.colorTemp).toBe(4500);
    });

    it("updates gamma values based on temperature", async () => {
      await backend.setColorTemp(6500);
      const info = await backend.getDisplayInfo();
      // At 6500K (D65 white), gamma should be close to 1.0 for all channels
      expect(info.gamma.r).toBeCloseTo(1.0, 1);
      expect(info.gamma.g).toBeCloseTo(1.0, 1);
      expect(info.gamma.b).toBeCloseTo(1.0, 1);
    });

    it("produces a warmer (lower blue) gamma for 3000K", async () => {
      await backend.setColorTemp(3000);
      const info = await backend.getDisplayInfo();
      // Warm temperature: red should be higher than blue
      expect(info.gamma.r).toBeGreaterThan(info.gamma.b);
    });

    it("emits stateChanged event", async () => {
      await backend.setColorTemp(4500);
      expect(emittedEvents.length).toBeGreaterThan(0);
      const stateEvent = emittedEvents.find((e) => e.event === "stateChanged");
      expect(stateEvent).toBeDefined();
      expect((stateEvent!.data as { colorTemp: number }).colorTemp).toBe(4500);
    });
  });

  // ---------------------------------------------------------------------------
  // setSaturation
  // ---------------------------------------------------------------------------

  describe("setSaturation()", () => {
    it("clamps to 0-200 range", async () => {
      await backend.setSaturation(-50);
      let info = await backend.getDisplayInfo();
      expect(info.saturation).toBe(0);

      await backend.setSaturation(300);
      info = await backend.getDisplayInfo();
      expect(info.saturation).toBe(200);
    });

    it("rounds to integer", async () => {
      await backend.setSaturation(123.7);
      const info = await backend.getDisplayInfo();
      expect(info.saturation).toBe(124);
    });

    it("stores exact value within range", async () => {
      await backend.setSaturation(150);
      const info = await backend.getDisplayInfo();
      expect(info.saturation).toBe(150);
    });

    it("returns false when no method is detected", async () => {
      const result = await backend.setSaturation(100);
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // setBrightness
  // ---------------------------------------------------------------------------

  describe("setBrightness()", () => {
    it("clamps to 0-100 range", async () => {
      await backend.setBrightness(-10);
      let info = await backend.getDisplayInfo();
      expect(info.brightness).toBe(0);

      await backend.setBrightness(200);
      info = await backend.getDisplayInfo();
      expect(info.brightness).toBe(100);
    });

    it("returns false when no method and no backlight", async () => {
      const result = await backend.setBrightness(50);
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // setGamma
  // ---------------------------------------------------------------------------

  describe("setGamma()", () => {
    it("clamps gamma channels to 0.2-2.0 range", async () => {
      await backend.setGamma(0.0, 3.0, 1.0);
      const info = await backend.getDisplayInfo();
      expect(info.gamma.r).toBe(0.2);
      expect(info.gamma.g).toBe(2.0);
      expect(info.gamma.b).toBe(1.0);
    });

    it("stores valid gamma values", async () => {
      await backend.setGamma(1.5, 0.8, 1.2);
      const info = await backend.getDisplayInfo();
      expect(info.gamma.r).toBeCloseTo(1.5, 2);
      expect(info.gamma.g).toBeCloseTo(0.8, 2);
      expect(info.gamma.b).toBeCloseTo(1.2, 2);
    });

    it("returns false when no xrandr output configured", async () => {
      const result = await backend.setGamma(1.0, 1.0, 1.0);
      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getDisplayInfo — ranges and defaults
  // ---------------------------------------------------------------------------

  describe("getDisplayInfo()", () => {
    it("returns correct default state", async () => {
      const info = await backend.getDisplayInfo();
      expect(info.saturation).toBe(100);
      expect(info.brightness).toBe(100);
      expect(info.colorTemp).toBe(6500);
      expect(info.gamma).toEqual({ r: 1.0, g: 1.0, b: 1.0 });
      expect(info.method).toBe("none");
      expect(info.xrandrOutput).toBeNull();
      expect(info.backlightPath).toBeNull();
    });

    it("returns correct ranges", async () => {
      const info = await backend.getDisplayInfo();
      expect(info.ranges).toEqual({
        saturation: [0, 200],
        brightness: [0, 100],
        colorTemp: [3000, 6500],
        gamma: [0.2, 2.0],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getPresets
  // ---------------------------------------------------------------------------

  describe("getPresets()", () => {
    it("returns 5 built-in presets", async () => {
      const presets = await backend.getPresets();
      expect(presets).toHaveLength(5);

      const names = presets.map((p) => p.name);
      expect(names).toContain("default");
      expect(names).toContain("vivid");
      expect(names).toContain("warm");
      expect(names).toContain("cool");
      expect(names).toContain("movie");
    });

    it("default preset has neutral values", async () => {
      const presets = await backend.getPresets();
      const def = presets.find((p) => p.name === "default")!;
      expect(def.saturation).toBe(100);
      expect(def.colorTemp).toBe(6500);
      expect(def.gamma).toEqual({ r: 1.0, g: 1.0, b: 1.0 });
    });

    it("vivid preset has boosted saturation", async () => {
      const presets = await backend.getPresets();
      const vivid = presets.find((p) => p.name === "vivid")!;
      expect(vivid.saturation).toBeGreaterThan(100);
    });
  });

  // ---------------------------------------------------------------------------
  // applyPreset
  // ---------------------------------------------------------------------------

  describe("applyPreset()", () => {
    it("returns false for unknown preset name", async () => {
      const result = await backend.applyPreset("nonexistent");
      expect(result).toBe(false);
    });

    it("applies warm preset values to state", async () => {
      await backend.applyPreset("warm");
      const info = await backend.getDisplayInfo();
      expect(info.colorTemp).toBe(4500);
      expect(info.saturation).toBe(100);
    });

    it("applies vivid preset values to state", async () => {
      await backend.applyPreset("vivid");
      const info = await backend.getDisplayInfo();
      expect(info.saturation).toBe(130);
    });
  });

  // ---------------------------------------------------------------------------
  // resetDefaults
  // ---------------------------------------------------------------------------

  describe("resetDefaults()", () => {
    it("resets state to factory defaults", async () => {
      // Change some values first
      await backend.setSaturation(180);
      await backend.setBrightness(50);
      await backend.setColorTemp(3500);

      await backend.resetDefaults();

      const info = await backend.getDisplayInfo();
      expect(info.saturation).toBe(100);
      expect(info.brightness).toBe(100);
      expect(info.colorTemp).toBe(6500);
      expect(info.gamma).toEqual({ r: 1.0, g: 1.0, b: 1.0 });
    });
  });

  // ---------------------------------------------------------------------------
  // xrandr detection (method = "xrandr") — integration path
  // ---------------------------------------------------------------------------

  describe("_detectMethod() with xrandr", () => {
    it("sets method to xrandr when xrandr reports a connected output", async () => {
      spawnSpy.mockImplementation((cmd: string[]) => {
        const cmdName = cmd[0];

        // xprop fails (no gamescope)
        if (cmdName === "xprop") {
          return {
            stdout: new ReadableStream({
              start(c) {
                c.enqueue(
                  new TextEncoder().encode("no such atom on any window.\n"),
                );
                c.close();
              },
            }),
            stderr: new ReadableStream({
              start(c) {
                c.close();
              },
            }),
            exited: Promise.resolve(1),
          } as ReturnType<typeof Bun.spawn>;
        }

        // xrandr succeeds with a connected output
        if (cmdName === "xrandr") {
          return {
            stdout: new ReadableStream({
              start(c) {
                c.enqueue(
                  new TextEncoder().encode(
                    "eDP-1 connected primary 1920x1080+0+0\n   1920x1080     60.00*+\n",
                  ),
                );
                c.close();
              },
            }),
            stderr: new ReadableStream({
              start(c) {
                c.close();
              },
            }),
            exited: Promise.resolve(0),
          } as ReturnType<typeof Bun.spawn>;
        }

        return {
          stdout: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          stderr: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          exited: Promise.resolve(1),
        } as ReturnType<typeof Bun.spawn>;
      });

      await (backend as unknown as { _detectMethod(): Promise<void> })._detectMethod();
      expect((backend as unknown as { method: string }).method).toBe("xrandr");
      expect(
        (backend as unknown as { xrandrOutput: string }).xrandrOutput,
      ).toBe("eDP-1");
    });
  });
});
