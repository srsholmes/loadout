import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "../../test/render";

const callMock = vi.fn((method: string) => Promise.resolve(null));
const eventHandlers = new Map<string, (data: unknown) => void>();

vi.mock("@loadout/ui", async () => {
  const actual = (await vi.importActual("@loadout/ui")) as Record<
    string,
    unknown
  >;
  const { PluginHeaderSlotProvider } = actual as {
    PluginHeaderSlotProvider: (props: any) => any;
  };
  return {
    ...actual,
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

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("bluetooth plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getDevices") return Promise.resolve(mockDevices);
      if (method === "getAdapterInfo") return Promise.resolve(mockAdapter);
      return Promise.resolve(null);
    });
  });

  it("portals the dynamic header into the supplied slot", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
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
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getDevices");
    });
  });

  it("calls getAdapterInfo on mount", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getAdapterInfo");
    });
  });

  it("displays power state chip in the header", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(headerSlot.textContent).toContain("POWERED ON");
    });
  });

  it("displays device names", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Xbox Controller");
      expect(container.textContent).toContain("AirPods");
    });
  });

  it("shows Disconnect for connected devices", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      const buttons = container.querySelectorAll("button");
      const texts = Array.from(buttons).map((b) => b.textContent);
      expect(texts).toContain("Disconnect");
    });
  });

  it("shows Connect for disconnected devices", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      const buttons = container.querySelectorAll("button");
      const texts = Array.from(buttons).map((b) => b.textContent);
      expect(texts).toContain("Connect");
    });
  });

  it("registers deviceChanged event handler", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("deviceChanged")).toBe(true);
    });
  });
});
