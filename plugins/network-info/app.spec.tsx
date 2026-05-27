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

const mockInterfaces = [
  {
    name: "wlan0",
    ip: "192.168.1.100",
    mac: "AA:BB:CC:DD:EE:FF",
    state: "up",
    type: "wifi",
  },
  {
    name: "eth0",
    ip: "192.168.1.50",
    mac: "11:22:33:44:55:66",
    state: "up",
    type: "ethernet",
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

  it("mounts and renders the heading", async () => {
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

  it("displays connection status and interface", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("CONNECTED");
      expect(container.textContent).toContain("wlan0");
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
});
