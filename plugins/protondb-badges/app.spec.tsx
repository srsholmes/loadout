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
}));

beforeEach(() => {
  callMock.mockReset();
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
});
