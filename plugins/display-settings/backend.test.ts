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

  beforeEach(() => {
    backend = new DisplaySettingsBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };

    // Default spawn mock: all commands fail (no gamescope detected,
    // no backlight write succeeds via D-Bus).
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
  });

  // ---------------------------------------------------------------------------
  // setSaturation
  // ---------------------------------------------------------------------------

  describe("setSaturation()", () => {
    it("clamps to 0-200 range", async () => {
      await backend.setSaturation(-50);
      let info = await backend.getDisplayInfo();
      expect(info.saturation).toBe(0);

      await backend.setSaturation(800);
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

    it("returns false when no gamescope is detected", async () => {
      const result = await backend.setSaturation(100);
      expect(result).toBe(false);
    });

    it("emits stateChanged on every call", async () => {
      await backend.setSaturation(150);
      const sat = emittedEvents.filter((e) => e.event === "stateChanged");
      expect(sat.length).toBeGreaterThan(0);
      expect((sat[sat.length - 1].data as { saturation: number }).saturation).toBe(150);
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

    it("returns false when no backlight detected", async () => {
      const result = await backend.setBrightness(50);
      expect(result).toBe(false);
    });

    it("emits stateChanged on every call", async () => {
      await backend.setBrightness(70);
      const ev = emittedEvents.filter((e) => e.event === "stateChanged");
      expect(ev.length).toBeGreaterThan(0);
      expect((ev[ev.length - 1].data as { brightness: number }).brightness).toBe(70);
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
    });

    it("reports method=none when nothing is detected", async () => {
      const info = await backend.getDisplayInfo();
      expect(info.method).toBe("none");
    });

    it("reports backlightPath=null when no backlight detected", async () => {
      const info = await backend.getDisplayInfo();
      expect(info.backlightPath).toBeNull();
    });

    it("returns correct ranges", async () => {
      const info = await backend.getDisplayInfo();
      expect(info.ranges).toEqual({
        saturation: [0, 200],
        brightness: [0, 100],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // resetDefaults
  // ---------------------------------------------------------------------------

  describe("resetDefaults()", () => {
    it("resets state to factory defaults", async () => {
      await backend.setSaturation(40);
      await backend.setBrightness(60);
      await backend.resetDefaults();
      const info = await backend.getDisplayInfo();
      expect(info.saturation).toBe(100);
      expect(info.brightness).toBe(100);
    });
  });
});
