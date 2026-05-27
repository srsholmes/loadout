import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "../../test/render";

const callMock = vi.fn((method: string) => Promise.resolve(null));
const eventHandlers = new Map<string, (data: unknown) => void>();

vi.mock("@loadout/ui", async () => {
  const actual = await vi.importActual("@loadout/ui");
  return {
    ...actual,
    PluginProvider: ({ children }: any) => children,
    useBackend: () => ({
      call: callMock,
      useEvent: ({ event, handler }: any) => {
        eventHandlers.set(event, handler);
      },
      ready: true,
    }),
  };
});

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
      expect(container.textContent).toContain("72%");
    });
  });

  it("displays power draw", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("+12.5W");
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

  it("returns an unmount function", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    const unmount = mount(container);
    expect(typeof unmount).toBe("function");
  });
});
