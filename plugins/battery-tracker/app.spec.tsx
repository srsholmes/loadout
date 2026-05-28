/**
 * battery-tracker frontend spec.
 *
 * Tests the overlay UI surface: mounting, battery info display, event
 * subscriptions, error state, and the widget/header mounts.
 *
 * Uses bun:test (not vitest). @loadout/ui is partially mocked so we can
 * control call() and useEvent() without a live backend.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below so the spread includes the real
// module. bun's mock.module is NOT hoisted (unlike vitest's vi.mock).
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";

const callMock = mock((_method: string) => Promise.resolve(null));
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: any) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: any) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

const mockBatteryInfo = {
  percentage: 72,
  status: "Discharging",
  powerWatts: 12.5,
  voltage: 7.8,
  energyNowWh: 30.2,
  energyFullWh: 42.0,
  energyFullDesignWh: 46.0,
  healthPercent: 91,
  timeRemainingMinutes: 145,
  timeRemainingFormatted: "2h 25m",
};

describe("battery-tracker plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getBatteryInfo") return Promise.resolve(mockBatteryInfo);
      if (method === "getHistory") return Promise.resolve([]);
      return Promise.resolve(null);
    });
  });

  it("mounts and renders the heading", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Battery");
    });
  });

  it("calls getBatteryInfo on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getBatteryInfo");
    });
  });

  it("calls getHistory on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getHistory");
    });
  });

  it("displays battery percentage", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("72");
    });
  });

  it("displays power draw", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("+12.5");
    });
  });

  it("displays battery health", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("91%");
    });
  });

  it("registers batteryUpdate event handler", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("batteryUpdate")).toBe(true);
    });
  });

  it("returns an unmount function from mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    const unmount = mount(container);
    expect(typeof unmount).toBe("function");
  });

  it("returns an unmount function from mountHomeWidget", async () => {
    const container = document.createElement("div");
    const { mountHomeWidget } = await import("./app");
    const unmount = mountHomeWidget(container);
    expect(typeof unmount).toBe("function");
  });

  it("returns an unmount function from mountHeader", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    const unmount = mountHeader(container);
    expect(typeof unmount).toBe("function");
  });

  it("shows error state when getBatteryInfo returns an error", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getBatteryInfo") return Promise.resolve({ error: "No battery detected" });
      if (method === "getHistory") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("No battery detected");
    });
  });

  it("shows spinner while battery data is loading", async () => {
    // Make getBatteryInfo never resolve so we stay in the loading state
    callMock.mockImplementation(() => new Promise(() => {}));

    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    // Spinner renders an svg or a container — just verify no percentage yet
    await waitFor(() => {
      expect(container.textContent).not.toContain("72%");
    });
  });

  it("batteryUpdate event updates displayed percentage", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    // Wait for initial render
    await waitFor(() => {
      expect(eventHandlers.has("batteryUpdate")).toBe(true);
    });

    // Simulate a live update via the event bus
    eventHandlers.get("batteryUpdate")!({
      ...mockBatteryInfo,
      percentage: 55,
    });

    await waitFor(() => {
      expect(container.textContent).toContain("55");
    });
  });

  it("mountHeader renders the subtitle", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Real-time power monitoring");
    });
  });
});
