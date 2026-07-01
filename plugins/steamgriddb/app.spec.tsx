import { describe, it, expect, mock, beforeEach } from "bun:test";
import * as actualUi from "@loadout/ui";
import { fireEvent, waitFor } from "../../test/render";

const sgdbCallMock = mock((method: string, ..._args: unknown[]) => {
  void method;
  return Promise.resolve(null as unknown);
});
const gameLibraryCallMock = mock((method: string, ..._args: unknown[]) => {
  void method;
  return Promise.resolve(null as unknown);
});
const eventHandlers = new Map<string, (data: unknown) => void>();

const { PluginHeaderSlotProvider } = actualUi as unknown as {
  PluginHeaderSlotProvider: (props: {
    slot: HTMLElement | null;
    children: React.ReactNode;
  }) => React.ReactNode;
};

mock.module("@loadout/ui", () => ({
  ...actualUi,
  // Stripped-down PluginProvider that wires headerSlot through to
  // PluginHeaderSlotProvider so `<PluginHeader>` portals correctly.
  PluginProvider: ({
    children,
    headerSlot,
  }: {
    children: React.ReactNode;
    headerSlot?: HTMLElement | null;
  }) => (
    <PluginHeaderSlotProvider slot={headerSlot ?? null}>
      {children}
    </PluginHeaderSlotProvider>
  ),
  useBackend: (pluginId: string) => ({
    call:
      pluginId === "__core:game-library"
        ? gameLibraryCallMock
        : sgdbCallMock,
    useEvent: ({
      event,
      handler,
    }: {
      event: string;
      handler: (data: unknown) => void;
    }) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

beforeEach(() => {
  sgdbCallMock.mockReset();
  gameLibraryCallMock.mockReset();
  eventHandlers.clear();
  sgdbCallMock.mockImplementation((method: string) => {
    if (method === "hasApiKey") return Promise.resolve(true);
    return Promise.resolve(null);
  });
  gameLibraryCallMock.mockImplementation((method: string) => {
    if (method === "getFullLibrary")
      return Promise.resolve({ games: libraryFixture(), ownedAvailable: true });
    return Promise.resolve(null);
  });
});

/**
 * Shared library fixture. TF2 is installed (real `sizeOnDisk`);
 * Portal 2 is owned-but-not-installed (`sizeOnDisk: 0`, Steam source) so
 * it exercises the "Not installed" badge; Super Mario 64 is a non-Steam
 * shortcut (never badged as not-installed).
 */
function libraryFixture() {
  return [
    {
      appId: "440",
      name: "Team Fortress 2",
      sizeOnDisk: 15_000_000,
      headerUrl: "https://cdn/440/header.jpg",
      capsuleUrl: "https://cdn/440/capsule.jpg",
      localHeaderUrl: "/api/steam-grid/440/u/header",
      localCapsuleUrl: "/api/steam-grid/440/u/capsule",
      source: "steam",
      tags: [],
    },
    {
      appId: "620",
      name: "Portal 2",
      sizeOnDisk: 0,
      headerUrl: "https://cdn/620/header.jpg",
      capsuleUrl: "https://cdn/620/capsule.jpg",
      localHeaderUrl: "/api/steam-grid/620/u/header",
      localCapsuleUrl: "/api/steam-grid/620/u/capsule",
      source: "steam",
      tags: [],
    },
    {
      appId: "3735928559",
      name: "Super Mario 64",
      sizeOnDisk: 0,
      headerUrl: "/api/steam-grid/x/u/header",
      capsuleUrl: "/api/steam-grid/x/u/capsule",
      localHeaderUrl: "/api/steam-grid/x/u/header",
      localCapsuleUrl: "/api/steam-grid/x/u/capsule",
      source: "shortcut",
      tags: ["Emulation"],
    },
  ];
}

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

  it("badges an owned-but-not-installed Steam game as 'Not installed'", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    // STEAM_ONLY default: TF2 (installed) + Portal 2 (owned/not-installed).
    await waitFor(() => {
      expect(container.textContent).toContain("Portal 2");
    });
    // Exactly one badge — Portal 2 (sizeOnDisk 0). TF2 is installed
    // (non-zero size) so it must NOT be badged.
    const badges = container.textContent?.match(/Not installed/g) ?? [];
    expect(badges).toHaveLength(1);
  });

  it("shows the 'start Steam' hint when the owned library is unavailable", async () => {
    gameLibraryCallMock.mockImplementation((method: string) => {
      if (method === "getFullLibrary")
        return Promise.resolve({
          games: libraryFixture().filter((g) => g.sizeOnDisk > 0),
          ownedAvailable: false,
        });
      return Promise.resolve(null);
    });

    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() =>
      expect(container.textContent).toContain("Showing installed games only"),
    );
  });

  it("applies art to a not-installed game with source 'steam'", async () => {
    sgdbCallMock.mockImplementation((method: string) => {
      if (method === "hasApiKey") return Promise.resolve(true);
      if (method === "getGrids")
        return Promise.resolve([
          {
            id: 111,
            score: 4.2,
            style: "alternate",
            width: 600,
            height: 900,
            nsfw: false,
            humor: false,
            url: "https://sgdb/full/111.png",
            thumb: "https://sgdb/thumb/111.png",
            author: { name: "artist", steam64: "0", avatar: "" },
          },
        ]);
      if (method === "applyArt")
        return Promise.resolve({ success: true, instant: true, paths: [] });
      return Promise.resolve(null);
    });

    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    // Pick Portal 2 (owned, not installed).
    await waitFor(() => expect(container.textContent).toContain("Portal 2"));
    const portalCard = Array.from(
      container.querySelectorAll("[data-game-card]"),
    ).find((el) => el.textContent?.includes("Portal 2"));
    expect(portalCard).toBeTruthy();
    fireEvent.click(portalCard as HTMLElement);

    // Its grids load — click the first asset tile to apply.
    await waitFor(() => {
      expect(container.querySelector('img[alt^="Art by"]')).not.toBeNull();
    });
    const assetButton = (
      container.querySelector('img[alt^="Art by"]') as HTMLElement
    ).closest("button");
    fireEvent.click(assetButton as HTMLElement);

    await waitFor(() => {
      const applyCall = sgdbCallMock.mock.calls.find(
        (c) => c[0] === "applyArt",
      );
      expect(applyCall).toBeTruthy();
      // applyArt(appId, url, artType, source)
      expect(applyCall?.[1]).toBe("620");
      expect(applyCall?.[3]).toBe("grid_p");
      expect(applyCall?.[4]).toBe("steam");
    });
  });
});
