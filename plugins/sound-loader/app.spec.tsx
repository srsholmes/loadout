import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below, so this holds the real
// module for the partial-mock spread. (bun's mock.module is not hoisted,
// unlike vitest's vi.mock — static imports evaluate first.)
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";

const callMock = mock((_method: string) => Promise.resolve(null));
const eventHandlers = new Map<string, (data: unknown) => void>();

const { PluginHeaderSlotProvider } = actualUi as unknown as {
  PluginHeaderSlotProvider: (props: {
    slot: HTMLElement | null;
    children: React.ReactNode;
  }) => React.ReactElement;
};

mock.module("@loadout/ui", () => ({
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
}));

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

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("sound-loader plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "listPacks") return Promise.resolve(mockPacks);
      if (method === "getActivePack") return Promise.resolve(null);
      if (method === "getUseInOverlay") return Promise.resolve(false);
      if (method === "getUseInSteam") return Promise.resolve(false);
      if (method === "getActivePackMappings")
        return Promise.resolve({ packId: null, mappings: {}, ignore: [] });
      return Promise.resolve(null);
    });
  });

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
    const container = createContainer();
    const unmount = mountHeader(container);
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
      if (method === "getUseInOverlay") return Promise.resolve(false);
      if (method === "getUseInSteam") return Promise.resolve(false);
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

  describe("Community tab", () => {
    const communityPacks = [
      {
        id: "psp-uuid",
        name: "PSP Sounds",
        author: "SGL-Galaxy",
        description: "PlayStation Portable menu sounds",
        version: "1.0.0",
        downloadUrl: "https://api.deckthemes.com/blobs/psp",
        previewImageUrl: null,
        githubUrl: "https://github.com/example/psp",
        lastChanged: "01/01/2024",
        manifestVersion: 2,
        music: false,
        installed: false,
      },
      {
        id: "lofi-uuid",
        name: "Lo-Fi Beats",
        author: "DJ Test",
        description: "music pack",
        version: "0.5.0",
        downloadUrl: "https://api.deckthemes.com/blobs/lofi",
        previewImageUrl: null,
        githubUrl: null,
        lastChanged: "01/01/2024",
        manifestVersion: 2,
        music: true,
        installed: false,
      },
    ];

    beforeEach(() => {
      callMock.mockImplementation((method: string) => {
        if (method === "listPacks") return Promise.resolve(mockPacks);
        if (method === "getActivePack") return Promise.resolve(null);
        if (method === "getUseInOverlay") return Promise.resolve(false);
        if (method === "getUseInSteam") return Promise.resolve(false);
        if (method === "getActivePackMappings")
          return Promise.resolve({ packId: null, mappings: {}, ignore: [] });
        if (method === "listCommunityPacks")
          return Promise.resolve(communityPacks);
        if (method === "getCommunityPacksStatus")
          return Promise.resolve({
            state: "ready",
            syncedAt: Date.now(),
            entryCount: communityPacks.length,
            lastError: null,
          });
        return Promise.resolve(null);
      });
    });

    it("renders the community pack list when the Community tab is selected", async () => {
      const container = createContainer();
      const headerSlot = document.createElement("div");
      document.body.appendChild(headerSlot);
      const { mount } = await import("./app");
      mount(container, { headerSlot });

      // Wait for the body to mount.
      await waitFor(() => {
        expect(container.textContent).toContain("Default (Steam Sounds)");
      });

      // Click the "Community" segmented tab in the header.
      const communityBtn = Array.from(
        headerSlot.querySelectorAll("button, [role=button]"),
      ).find((el) => el.textContent?.trim() === "Community") as
        | HTMLElement
        | undefined;
      expect(communityBtn).toBeDefined();
      communityBtn!.click();

      await waitFor(() => {
        expect(container.textContent).toContain("PSP Sounds");
      });
    });

    it("filters out music packs by default and reveals them on toggle", async () => {
      const container = createContainer();
      const headerSlot = document.createElement("div");
      document.body.appendChild(headerSlot);
      const { mount } = await import("./app");
      mount(container, { headerSlot });

      await waitFor(() => {
        expect(container.textContent).toContain("Default (Steam Sounds)");
      });

      const communityBtn = Array.from(
        headerSlot.querySelectorAll("button, [role=button]"),
      ).find((el) => el.textContent?.trim() === "Community") as
        | HTMLElement
        | undefined;
      communityBtn!.click();

      await waitFor(() => {
        expect(container.textContent).toContain("PSP Sounds");
      });
      // Music pack should be hidden by default.
      expect(container.textContent).not.toContain("Lo-Fi Beats");
    });

    it("renders a retry surface when the community-packs status is error and no packs are cached", async () => {
      callMock.mockImplementation((method: string) => {
        if (method === "listPacks") return Promise.resolve(mockPacks);
        if (method === "getActivePack") return Promise.resolve(null);
        if (method === "getUseInOverlay") return Promise.resolve(false);
        if (method === "getUseInSteam") return Promise.resolve(false);
        if (method === "getActivePackMappings")
          return Promise.resolve({ packId: null, mappings: {}, ignore: [] });
        if (method === "listCommunityPacks") return Promise.resolve([]);
        if (method === "getCommunityPacksStatus")
          return Promise.resolve({
            state: "error",
            syncedAt: null,
            entryCount: 0,
            lastError: "DNS failure",
          });
        return Promise.resolve(null);
      });

      const container = createContainer();
      const headerSlot = document.createElement("div");
      document.body.appendChild(headerSlot);
      const { mount } = await import("./app");
      mount(container, { headerSlot });

      await waitFor(() => {
        expect(container.textContent).toContain("Default (Steam Sounds)");
      });

      const communityBtn = Array.from(
        headerSlot.querySelectorAll("button, [role=button]"),
      ).find((el) => el.textContent?.trim() === "Community") as
        | HTMLElement
        | undefined;
      communityBtn!.click();

      await waitFor(() => {
        expect(container.textContent).toContain("Could not reach deckthemes.com");
        expect(container.textContent).toContain("DNS failure");
      });
    });
  });
});
