/**
 * display-settings app spec.
 *
 * Tests the overlay UI: header rendering, initial data fetch, preset
 * display, control method chip, stateChanged event registration, and
 * gamma value rendering.
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

const mockDisplayInfo = {
  saturation: 100,
  brightness: 80,
  colorTemp: 6500,
  gamma: { r: 1.0, g: 1.0, b: 1.0 },
  method: "gamescope",
  xrandrOutput: null,
  backlightPath: "/sys/class/backlight/intel_backlight",
  ranges: {
    saturation: [0, 200],
    brightness: [0, 100],
    colorTemp: [3000, 6500],
    gamma: [0, 2],
  },
};

const mockPresets = [
  {
    name: "default",
    label: "Default",
    saturation: 100,
    colorTemp: 6500,
    gamma: { r: 1, g: 1, b: 1 },
  },
  {
    name: "vivid",
    label: "Vivid",
    saturation: 150,
    colorTemp: 6500,
    gamma: { r: 1, g: 1, b: 1 },
  },
  {
    name: "warm",
    label: "Warm",
    saturation: 100,
    colorTemp: 4500,
    gamma: { r: 1, g: 1, b: 1 },
  },
];

describe("display-settings plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getDisplayInfo") return Promise.resolve(mockDisplayInfo);
      if (method === "getPresets") return Promise.resolve(mockPresets);
      return Promise.resolve(null);
    });
  });

  it("mountHeader renders the heading", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Display");
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

  it("calls getPresets on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getPresets");
    });
  });

  it("displays preset buttons", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Default");
      expect(container.textContent).toContain("Vivid");
      expect(container.textContent).toContain("Warm");
    });
  });

  it("displays control method", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Gamescope");
    });
  });

  it("shows Reset to Defaults button", async () => {
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

  it("displays gamma values", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("1.00");
    });
  });
});
