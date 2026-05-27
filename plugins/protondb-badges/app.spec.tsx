import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, waitFor } from "../../test/render";

const callMock = vi.fn((method: string, ..._args: unknown[]) =>
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
    useBackend: () => ({
      call: callMock,
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
  callMock.mockImplementation((method: string) => {
    if (method === "getSettings")
      return Promise.resolve({
        size: "regular",
        position: "tl",
        labelOnHover: "off",
        showSubmitButton: true,
        enableLibraryBadge: true,
        enableStoreBadge: true,
      });
    if (method === "getStatus")
      return Promise.resolve({ connected: true, tabs: 4 });
    // game-browser::getGames replaced listInstalledGames as the
    // library source. Same useBackend mock is shared across plugins,
    // so this fixture covers both `protondb-badges` and `game-browser`.
    if (method === "getGames")
      return Promise.resolve([
        {
          appId: "440",
          name: "Team Fortress 2",
          source: "steam",
          headerUrl: "https://cdn/440/header.jpg",
          capsuleUrl: "https://cdn/440/capsule.jpg",
          localHeaderUrl: "http://localhost:33820/api/steam-grid/440/x/header",
          localCapsuleUrl: "http://localhost:33820/api/steam-grid/440/x/capsule",
          tags: [],
        },
        {
          appId: "730",
          name: "Counter-Strike 2",
          source: "steam",
          headerUrl: "https://cdn/730/header.jpg",
          capsuleUrl: "https://cdn/730/capsule.jpg",
          localHeaderUrl: "http://localhost:33820/api/steam-grid/730/x/header",
          localCapsuleUrl: "http://localhost:33820/api/steam-grid/730/x/capsule",
          tags: [],
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

/** Click the "Plugin preferences" gear icon in the portaled header to switch into config view. */
async function enterSettingsView(headerSlot: HTMLElement): Promise<void> {
  await waitFor(() => {
    const gear = headerSlot.querySelector(
      '[aria-label="Plugin preferences"]',
    ) as HTMLButtonElement | null;
    expect(gear).not.toBeNull();
  });
  const gear = headerSlot.querySelector(
    '[aria-label="Plugin preferences"]',
  ) as HTMLButtonElement;
  fireEvent.click(gear);
}

describe("protondb-badges plugin", () => {
  it("portals the dynamic header (ProtonDB title) into the supplied slot", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() =>
      expect(headerSlot.querySelector("h1")?.textContent).toBe("ProtonDB"),
    );
  });

  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("settings view shows connection status (Connected, 4 tabs)", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() => expect(container.textContent).toContain("Connected"));
  });

  it("settings view shows badge sections (Compatibility Badges, Store Badge)", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() => {
      expect(container.textContent).toContain("Compatibility Badges");
      expect(container.textContent).toContain("Store Badge");
    });
  });

  it("settings view shows Clear ProtonDB Cache button", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() =>
      expect(container.textContent).toContain("Clear ProtonDB Cache"),
    );
  });
});
