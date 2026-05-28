/**
 * display-settings app spec.
 *
 * Tests the slim overlay UI: header, initial data fetch, brightness +
 * saturation sliders, method chip, stateChanged event registration, and
 * the gamescope-not-detected warning.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below — bun's mock.module is not
// hoisted like vitest's vi.mock, so we need the real module first.
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";

const callMock = mock((method: string) => {
  void method;
  return Promise.resolve(null);
});
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: { children: React.ReactNode }) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: { event: string; handler: (data: unknown) => void }) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

const mockGamescopeInfo = {
  saturation: 100,
  brightness: 80,
  method: "gamescope",
  backlightPath: "/sys/class/backlight/intel_backlight",
  ranges: { saturation: [0, 200], brightness: [0, 100] },
};

const mockNoneInfo = {
  saturation: 100,
  brightness: 80,
  method: "none",
  backlightPath: null,
  ranges: { saturation: [0, 200], brightness: [0, 100] },
};

describe("display-settings plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getDisplayInfo") return Promise.resolve(mockGamescopeInfo);
      return Promise.resolve(null);
    });
  });

  it("mountHeader renders the heading", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Display Settings");
    });
  });

  it("calls getDisplayInfo on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getDisplayInfo");
    });
  });

  it("displays the Gamescope control method chip when detected", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Gamescope");
    });
  });

  it("shows Reset to defaults button", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Reset to defaults");
    });
  });

  it("registers stateChanged event handler", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("stateChanged")).toBe(true);
    });
  });

  it("does NOT show the gamescope warning when method=gamescope", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      // wait for the brightness slider to render
      expect(container.textContent).toContain("Brightness");
    });
    expect(container.textContent).not.toContain("Saturation requires gamescope");
  });

  it("shows the gamescope warning when method=none", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getDisplayInfo") return Promise.resolve(mockNoneInfo);
      return Promise.resolve(null);
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Saturation requires gamescope");
    });
  });
});
