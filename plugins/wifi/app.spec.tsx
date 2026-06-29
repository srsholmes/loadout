/**
 * WiFi app spec.
 *
 * Tests the overlay UI: header, initial status fetch, the on/off alert,
 * and the power-save toggle wiring.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import * as actualUi from "@loadout/ui";
import { waitFor, fireEvent } from "../../test/render";

const callMock = mock((method: string, ..._args: unknown[]) => {
  void method;
  void _args;
  return Promise.resolve(null as unknown);
});
const eventHandlers = new Map<string, (data: unknown) => void>();
const notifyMock = mock((_msg: string, _opts?: unknown) => {
  void _msg;
  void _opts;
});

mock.module("@loadout/ui", () => ({
  ...actualUi,
  notify: notifyMock,
  PluginProvider: ({ children }: { children: React.ReactNode }) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: { event: string; handler: (data: unknown) => void }) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

const offStatus = {
  iface: "wlan0",
  nmConfigured: false,
  iwdPresent: false,
  iwdConfigured: false,
  runtime: "on",
  configured: false,
  powerSaveDisabled: false,
  listenerRunning: false,
};

const onStatus = {
  iface: "wlan0",
  nmConfigured: true,
  iwdPresent: true,
  iwdConfigured: true,
  runtime: "off",
  configured: true,
  powerSaveDisabled: true,
  listenerRunning: true,
};

describe("wifi plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    notifyMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(offStatus);
      return Promise.resolve({ success: true });
    });
  });

  it("renders the header", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("WiFi");
    });
  });

  it("fetches status on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getStatus");
    });
  });

  it("shows the default-on warning and the interface", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Power saving on (default)");
      expect(container.textContent).toContain("wlan0");
    });
  });

  it("toggles power saving off", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    let toggle: HTMLInputElement | undefined;
    await waitFor(() => {
      const t = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(t).toBeTruthy();
      toggle = t;
    });
    expect(toggle!.checked).toBe(false);

    fireEvent.click(toggle!);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("setPowerSaveDisabled", true);
    });
  });

  it("reflects the disabled state as checked with a success alert", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(onStatus);
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Power saving disabled");
      const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(toggle?.checked).toBe(true);
    });
  });
});
