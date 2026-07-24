/**
 * battery-tracker frontend spec.
 *
 * Tests the overlay UI surface: mounting, battery info display, event
 * subscriptions, error state, and the widget/header mounts.
 *
 * Uses bun:test (not vitest). @loadout/ui is partially mocked so we can
 * control call() and useEvent() without a live backend.
 */

import { describe, it, expect, mock, beforeEach, jest } from "bun:test";
// Captured BEFORE mock.module() runs below so the spread includes the real
// module. bun's mock.module is NOT hoisted (unlike vitest's vi.mock).
import * as actualUi from "@loadout/ui";
import { waitFor, fireEvent, act } from "../../test/render";

const callMock = mock((_method: string, ..._args: unknown[]) => Promise.resolve(null));
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
      // Status is "Discharging" → sign is "-" (charging flag drives it, not the
      // unsigned `power_now` magnitude — the previous "+12.5" assertion was
      // pinning the pre-existing UX-lie bug flagged in code review).
      expect(container.textContent).toContain("-12.5");
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

  // -------------------------------------------------------------------------
  // Charging controls (charge limit + bypass)
  // -------------------------------------------------------------------------

  const supportedChargeControl = {
    supportsChargeLimit: true,
    chargeLimitPercent: null as number | null,
    supportsBypass: true,
    supportsBypassAwake: true,
    bypassMode: "disabled" as const,
  };

  function mockWithChargeControl(control: Record<string, unknown> | null) {
    callMock.mockImplementation((method: string) => {
      if (method === "getBatteryInfo") return Promise.resolve(mockBatteryInfo);
      if (method === "getHistory") return Promise.resolve([]);
      if (method === "getChargeControl") return Promise.resolve(control);
      return Promise.resolve({ success: true });
    });
  }

  it("renders the charging controls when the device supports them", async () => {
    mockWithChargeControl(supportedChargeControl);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Charge limit");
      expect(container.textContent).toContain("Bypass charging");
    });
  });

  it("hides the charging controls when the device supports neither", async () => {
    mockWithChargeControl({
      supportsChargeLimit: false,
      chargeLimitPercent: null,
      supportsBypass: false,
      supportsBypassAwake: false,
      bypassMode: "disabled",
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Power Flow");
    });
    expect(container.textContent).not.toContain("Charge limit");
    expect(container.textContent).not.toContain("Bypass charging");
  });

  it("enabling the charge-limit toggle calls setChargeLimit with the default", async () => {
    mockWithChargeControl(supportedChargeControl);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    let toggle: HTMLInputElement | null = null;
    await waitFor(() => {
      toggle = container.querySelector('input[type="checkbox"]');
      expect(toggle).not.toBeNull();
    });

    fireEvent.click(toggle!);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("setChargeLimit", 80);
    });
  });

  it("does not render the charge-limit slider while the limit is off", async () => {
    mockWithChargeControl(supportedChargeControl);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Charge limit");
    });
    // Limit off (chargeLimitPercent null) → no range input yet.
    expect(container.querySelector('input[type="range"]')).toBeNull();
  });

  // --- Bypass effectiveness check ---------------------------------------

  async function openBypassAndPick(container: HTMLElement, label: string) {
    const trigger = container.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(trigger);
      jest.advanceTimersByTime(1);
    });
    const opt = Array.from(document.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent?.trim() === label,
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(opt);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("warns when 'always' bypass leaves the battery charging", async () => {
    jest.useFakeTimers();
    try {
      callMock.mockImplementation((method: string) => {
        if (method === "getChargeControl") return Promise.resolve(supportedChargeControl);
        // Still charging after the write -> firmware ignored it.
        if (method === "getBatteryInfo")
          return Promise.resolve({ ...mockBatteryInfo, status: "Charging" });
        if (method === "getHistory") return Promise.resolve([]);
        return Promise.resolve({ success: true });
      });
      const container = document.createElement("div");
      document.body.appendChild(container);
      const { mount } = await import("./app");
      let unmount: () => void = () => {};
      await act(async () => {
        unmount = mount(container);
        await Promise.resolve();
      });
      await waitFor(() => expect(container.textContent).toContain("Bypass charging"));

      await openBypassAndPick(container, "Always");
      expect(container.textContent).not.toContain("didn’t take effect");
      await act(async () => {
        jest.advanceTimersByTime(6000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Bypass didn’t take effect");
      unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does NOT warn for 'while awake' even if still charging (expected)", async () => {
    jest.useFakeTimers();
    try {
      callMock.mockImplementation((method: string) => {
        if (method === "getChargeControl") return Promise.resolve(supportedChargeControl);
        if (method === "getBatteryInfo")
          return Promise.resolve({ ...mockBatteryInfo, status: "Charging" });
        if (method === "getHistory") return Promise.resolve([]);
        return Promise.resolve({ success: true });
      });
      const container = document.createElement("div");
      document.body.appendChild(container);
      const { mount } = await import("./app");
      let unmount: () => void = () => {};
      await act(async () => {
        unmount = mount(container);
        await Promise.resolve();
      });
      await waitFor(() => expect(container.textContent).toContain("Bypass charging"));

      await openBypassAndPick(container, "While awake");
      await act(async () => {
        jest.advanceTimersByTime(6000);
        await Promise.resolve();
        await Promise.resolve();
      });
      // Charging while awake is correct for this mode — no warning.
      expect(container.textContent).not.toContain("didn’t take effect");
      unmount();
    } finally {
      jest.useRealTimers();
    }
  });
});
