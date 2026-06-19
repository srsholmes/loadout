import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() so this holds the real module for spread.
// (bun's mock.module is not hoisted, unlike vitest's vi.mock — static
// imports evaluate first.)
import * as actualUi from "@loadout/ui";
import { fireEvent, waitFor } from "../../test/render";

const callMock = mock((_method: string, ..._args: unknown[]) =>
  Promise.resolve(null as unknown),
);
const eventHandlers = new Map<string, (data: unknown) => void>();
// Spy for the host shim the tile-click handler invokes to close the
// overlay before driving Steam. Wired into the @loadout/ui mock below.
const hideOverlayMock = mock(() => Promise.resolve());

const { PluginHeaderSlotProvider } = actualUi as unknown as {
  PluginHeaderSlotProvider: (props: {
    slot: HTMLElement | null;
    children: unknown;
  }) => unknown;
};

mock.module("@loadout/ui", () => ({
  ...actualUi,
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
  useCurrentGame: () => null,
  hideOverlay: hideOverlayMock,
}));

beforeEach(() => {
  callMock.mockReset();
  hideOverlayMock.mockClear();
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
      return Promise.resolve({ connected: false, tabs: 0 });
    if (method === "listInstalledGames")
      return Promise.resolve([
        { appId: "440", name: "Team Fortress 2" },
        { appId: "730", name: "Counter-Strike 2" },
      ]);
    if (method === "listAllGames")
      return Promise.resolve([
        { appId: "440", name: "Team Fortress 2" },
        { appId: "730", name: "Counter-Strike 2" },
        { appId: "570", name: "Dota 2" },
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

  it("settings view shows connection status section", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() => expect(container.textContent).toContain("Disconnected"));
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

  it("defaults the library-source dropdown to Installed games", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() =>
      expect(headerSlot.textContent).toContain("Installed games"),
    );
    // The installed list is the source by default; the all-library RPC
    // must not be hit until the user switches.
    const calledMethods = callMock.mock.calls.map((c) => c[0]);
    expect(calledMethods).toContain("listInstalledGames");
    expect(calledMethods).not.toContain("listAllGames");
  });

  it("switching the dropdown to All games fetches the full library", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    // Open the dropdown (trigger button lives in the portaled header).
    const trigger = await waitFor(() => {
      const btn = headerSlot.querySelector(
        'button[aria-haspopup="listbox"]',
      ) as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(trigger);

    // Click the "All games" option.
    const allOption = await waitFor(() => {
      const opt = Array.from(
        headerSlot.querySelectorAll('[role="option"]'),
      ).find((el) => el.textContent?.includes("All games")) as
        | HTMLElement
        | undefined;
      expect(opt).toBeDefined();
      return opt!;
    });
    fireEvent.click(allOption);

    await waitFor(() => {
      const calledMethods = callMock.mock.calls.map((c) => c[0]);
      expect(calledMethods).toContain("listAllGames");
    });
  });

  it("clicking a game hides the overlay and opens it in Steam → ProtonDB", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    const tile = await waitFor(() => {
      const btn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Team Fortress 2"),
      ) as HTMLButtonElement | undefined;
      expect(btn).toBeDefined();
      return btn!;
    });
    fireEvent.click(tile);

    await waitFor(() => {
      expect(hideOverlayMock).toHaveBeenCalled();
      const openCall = callMock.mock.calls.find((c) => c[0] === "openProtonDb");
      expect(openCall).toBeDefined();
      expect(openCall?.[1]).toEqual({ appId: "440" });
    });
  });
});
