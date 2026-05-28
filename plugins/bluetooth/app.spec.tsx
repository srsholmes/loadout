import { describe, it, expect, mock, beforeEach } from "bun:test";
// Capture the real module BEFORE mock.module() — bun's mock.module is not
// hoisted, so static imports evaluate first. We spread actualUi below to
// keep all real exports and only override what we need.
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";

const callMock = mock((_method: string) => Promise.resolve(null));
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => {
  const { PluginHeaderSlotProvider } = actualUi as {
    PluginHeaderSlotProvider: (props: any) => any;
  };
  return {
    ...actualUi,
    // Stripped-down PluginProvider — keeps only the header-slot context
    // so `<PluginHeader>` portal-renders into the supplied slot. Backend
    // and focus context are mocked separately.
    PluginProvider: ({ children, headerSlot }: any) => (
      <PluginHeaderSlotProvider slot={headerSlot ?? null}>
        {children}
      </PluginHeaderSlotProvider>
    ),
    useBackend: () => ({
      call: callMock,
      useEvent: ({ event, handler }: any) => {
        eventHandlers.set(event, handler);
      },
      ready: true,
    }),
  };
});

const mockAdapter = {
  powered: true,
  discovering: false,
  name: "Test Adapter",
  address: "AA:BB:CC:DD:EE:FF",
};

const mockDevices = [
  {
    mac: "11:22:33:44:55:66",
    name: "Xbox Controller",
    connected: true,
    paired: true,
    type: "input" as const,
  },
  {
    mac: "77:88:99:AA:BB:CC",
    name: "AirPods",
    connected: false,
    paired: true,
    type: "audio" as const,
  },
];

describe("bluetooth plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((_method: string) => {
      if (_method === "getDevices") return Promise.resolve(mockDevices);
      if (_method === "getAdapterInfo") return Promise.resolve(mockAdapter);
      return Promise.resolve(null);
    });
  });

  it("portals the dynamic header into the supplied slot", async () => {
    const container = document.createElement("div");
    const headerSlot = document.createElement("div");
    document.body.appendChild(container);
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(headerSlot.querySelector("h1")?.textContent).toBe("Bluetooth");
    });
  });

  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("calls getDevices on mount", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getDevices");
    });
  });

  it("calls getAdapterInfo on mount", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getAdapterInfo");
    });
  });

  it("displays power state chip in the header", async () => {
    const container = document.createElement("div");
    const headerSlot = document.createElement("div");
    document.body.appendChild(container);
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(headerSlot.textContent).toContain("POWERED ON");
    });
  });

  it("displays device names", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Xbox Controller");
      expect(container.textContent).toContain("AirPods");
    });
  });

  it("shows Disconnect for connected devices", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      const buttons = container.querySelectorAll("button");
      const texts = Array.from(buttons).map((b) => b.textContent);
      expect(texts).toContain("Disconnect");
    });
  });

  it("shows Connect for disconnected devices", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      const buttons = container.querySelectorAll("button");
      const texts = Array.from(buttons).map((b) => b.textContent);
      expect(texts).toContain("Connect");
    });
  });

  it("registers deviceChanged event handler", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("deviceChanged")).toBe(true);
    });
  });
});
