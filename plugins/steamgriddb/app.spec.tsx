import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, waitFor } from "../../test/render";

const sgdbCallMock = vi.fn((method: string, ..._args: unknown[]) =>
  Promise.resolve(null as unknown),
);
const gameBrowserCallMock = vi.fn((method: string, ..._args: unknown[]) =>
  Promise.resolve(null as unknown),
);
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
    // Stripped-down PluginProvider that wires headerSlot through to
    // PluginHeaderSlotProvider so `<PluginHeader>` portals correctly.
    PluginProvider: ({ children, headerSlot }: any) => (
      <PluginHeaderSlotProvider slot={headerSlot ?? null}>
        {children}
      </PluginHeaderSlotProvider>
    ),
    useBackend: (pluginId: string) => ({
      call:
        pluginId === "game-browser" ? gameBrowserCallMock : sgdbCallMock,
      useEvent: ({ event, handler }: any) => {
        eventHandlers.set(event, handler);
      },
      ready: true,
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  eventHandlers.clear();
  sgdbCallMock.mockImplementation((method: string) => {
    if (method === "hasApiKey") return Promise.resolve(true);
    return Promise.resolve(null);
  });
  gameBrowserCallMock.mockImplementation((method: string) => {
    if (method === "getGames")
      return Promise.resolve([
        {
          appId: "440",
          name: "Team Fortress 2",
          sizeOnDisk: 0,
          headerUrl: "https://cdn/440/header.jpg",
          capsuleUrl: "https://cdn/440/capsule.jpg",
          source: "steam",
          tags: [],
        },
        {
          appId: "730",
          name: "Counter-Strike 2",
          sizeOnDisk: 0,
          headerUrl: "https://cdn/730/header.jpg",
          capsuleUrl: "https://cdn/730/capsule.jpg",
          source: "steam",
          tags: [],
        },
        {
          appId: "3735928559",
          name: "Super Mario 64",
          sizeOnDisk: 0,
          headerUrl: "/api/steam-grid/x/u/header",
          capsuleUrl: "/api/steam-grid/x/u/capsule",
          source: "shortcut",
          tags: ["Emulation"],
        },
      ]);
    return Promise.resolve(null);
  });
});

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("steamgriddb plugin", () => {
  it("portals the dynamic header (SteamGridDB title) into the supplied slot", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() =>
      expect(headerSlot.querySelector("h1")?.textContent).toBe("SteamGridDB"),
    );
  });

  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("renders the library search input in the header when an API key is set", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      const input = headerSlot.querySelector(
        'input[placeholder="Search games…"]',
      );
      expect(input).not.toBeNull();
    });
  });

  it("shows the connect/API-key onboarding screen when no key is stored", async () => {
    sgdbCallMock.mockImplementation((method: string) => {
      if (method === "hasApiKey") return Promise.resolve(false);
      return Promise.resolve(null);
    });

    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() =>
      expect(container.textContent).toContain("Connect to SteamGridDB"),
    );
  });

  it("includes both Steam games and non-Steam shortcuts in the picker", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    // STEAM_ONLY default: Steam games are visible immediately.
    await waitFor(() => {
      expect(container.textContent).toContain("Team Fortress 2");
    });
    // Non-Steam shortcuts surface only when the user picks "All games"
    // from the filter dropdown.
    await waitFor(() => {
      const trigger = headerSlot.querySelector('[aria-haspopup="listbox"]');
      expect(trigger).not.toBeNull();
    });
    fireEvent.click(
      headerSlot.querySelector('[aria-haspopup="listbox"]') as HTMLButtonElement,
    );
    await waitFor(() => {
      const opt = Array.from(
        headerSlot.querySelectorAll('[role="option"]'),
      ).find((o) => o.textContent?.includes("All games"));
      expect(opt).toBeTruthy();
      fireEvent.click(opt as HTMLElement);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Super Mario 64");
    });
  });

  it("renders the header subtitle describing plugin functionality", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() =>
      expect(headerSlot.textContent).toContain(
        "Custom artwork for your library",
      ),
    );
  });
});
