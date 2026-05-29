/**
 * network-info frontend spec.
 *
 * The plugin renders:
 *   1. CONNECTED/DISCONNECTED chip driven by the primary interface state.
 *   2. Connection Details panel (IPv4, interface, MAC, SSID, signal, …).
 *   3. Throughput section with Run Speed Test / Stop / Retest buttons.
 *
 * We mock `@loadout/ui` (useBackend + PluginProvider) so backend RPC is
 * fully controllable without a running loader.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";

const callMock = mock((method: string) => Promise.resolve(method === "getNetworkInfo" ? [] : null));
const eventHandlers = new Map<string, (data: unknown) => void>();

// Partial-mock @loadout/ui — spread the real module so other exports
// (Button, Text, etc.) are real. PluginProvider and useBackend are the
// only things we need to control.
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

const mockInterfaces = [
  {
    name: "wlan0",
    ip: "192.168.1.100",
    mac: "AA:BB:CC:DD:EE:FF",
    state: "up",
    type: "WiFi",
  },
  {
    name: "eth0",
    ip: "192.168.1.50",
    mac: "11:22:33:44:55:66",
    state: "up",
    type: "Ethernet",
  },
];

const mockConnectionInfo = {
  ssid: "MyNetwork",
  signal: 75,
  frequency: "5 GHz",
  bitRate: "866 Mbps",
};

describe("network-info plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getNetworkInfo") return Promise.resolve(mockInterfaces);
      if (method === "getConnectionInfo") return Promise.resolve(mockConnectionInfo);
      return Promise.resolve(null);
    });
  });

  it("mountHeader renders the plugin heading", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Network");
    });
  });

  it("calls getNetworkInfo on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getNetworkInfo");
    });
  });

  it("calls getConnectionInfo on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getConnectionInfo");
    });
  });

  it("displays network interface names", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("wlan0");
      expect(container.textContent).toContain("eth0");
    });
  });

  it("displays IP addresses", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("192.168.1.100");
      expect(container.textContent).toContain("192.168.1.50");
    });
  });

  it("displays WiFi SSID", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("MyNetwork");
    });
  });

  it("displays connection status chip", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("CONNECTED");
    });
  });

  it("shows Speed Test section with Run button", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Speed Test");
      expect(container.textContent).toContain("Run Speed Test");
    });
  });

  it("mountHeader and mount are functions (mountComponent factory)", async () => {
    // Guards the mountComponent factory — both exports must be callable.
    const mod = await import("./app");
    expect(typeof mod.mount).toBe("function");
    expect(typeof mod.mountHeader).toBe("function");
  });
});
