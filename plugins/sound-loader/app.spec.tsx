import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "../../test/render";

const callMock = vi.fn((method: string) => Promise.resolve(null));
const eventHandlers = new Map<string, (data: unknown) => void>();

vi.mock("@loadout/ui", async () => {
  const actual = (await vi.importActual("@loadout/ui")) as Record<string, unknown>;
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

const mockPacks = [
  {
    id: "retro-pack",
    name: "Retro 8-bit",
    author: "PixelAudio",
    description: "Chiptune-style UI sounds",
    version: "1.0.0",
    mappedEvents: ["nav", "select", "back", "error"],
    ignoredEvents: [],
  },
];

describe("sound-loader plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "listPacks") return Promise.resolve(mockPacks);
      if (method === "getActivePack") return Promise.resolve(null);
      if (method === "getActivePackMappings")
        return Promise.resolve({ packId: null, mappings: {}, ignore: [] });
      return Promise.resolve(null);
    });
  });

  function createContainer(): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    return container;
  }

  it("portals the dynamic header into the supplied headerSlot", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(headerSlot.querySelector("h1")?.textContent).toBe("Sound Loader");
    });
  });

  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("calls listPacks on mount", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("listPacks");
    });
  });

  it("calls getActivePack on mount", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getActivePack");
    });
  });

  it("displays built-in sound modes", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Default (Steam Sounds)");
      expect(container.textContent).toContain("Synthesized");
    });
  });

  it("displays custom sound pack name", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Retro 8-bit");
    });
  });

  it("displays pack author", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("PixelAudio");
    });
  });

  it("displays pack description", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Chiptune-style UI sounds");
    });
  });

  it("registers activePackChanged event handler", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("activePackChanged")).toBe(true);
    });
  });

  it("returns an unmount function", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    const unmount = mount(container);
    expect(typeof unmount).toBe("function");
  });

  it("shows empty state when no packs installed", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "listPacks") return Promise.resolve([]);
      if (method === "getActivePack") return Promise.resolve(null);
      if (method === "getActivePackMappings")
        return Promise.resolve({ packId: null, mappings: {}, ignore: [] });
      return Promise.resolve(null);
    });

    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("No custom sound packs installed");
    });
  });
});
