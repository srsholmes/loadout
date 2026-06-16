/**
 * theme-loader app spec.
 *
 * Tests the overlay UI: portaled dynamic header, segmented [Themes |
 * Community] toggle, reapply icon button enable/disable wiring, body
 * theme listing, empty state, and options-count badge for themes
 * with patches.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below — bun's mock.module is not
// hoisted like vitest's vi.mock, so we need the real module first.
import * as actualUi from "@loadout/ui";
import { fireEvent, waitFor } from "../../test/render";

const callMock = mock((method: string, ..._args: unknown[]) => {
  void method;
  void _args;
  return Promise.resolve(null as unknown);
});
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => ({
  ...actualUi,
  // Stripped-down PluginProvider — wires the supplied headerSlot
  // through PluginHeaderSlotProvider so `<PluginHeader>` portals
  // into the slot the test owns. Backend + focus context are mocked
  // separately.
  PluginProvider: ({
    children,
    headerSlot,
  }: {
    children: React.ReactNode;
    headerSlot?: HTMLElement | null;
  }) =>
    actualUi.PluginHeaderSlotProvider({
      slot: headerSlot ?? null,
      children,
    }) as React.ReactElement,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: { event: string; handler: (data: unknown) => void }) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("theme-loader plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getThemes")
        return Promise.resolve([
          { id: "dark", name: "Dark Mode", kind: "pack", active: true },
          { id: "retro", name: "Retro", kind: "pack", active: false },
        ]);
      if (method === "getStatus")
        return Promise.resolve({
          connected: true,
          tabCount: 3,
          activeThemeCount: 1,
        });
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
      expect(headerSlot.querySelector("h1")?.textContent).toBe("Theme Loader");
    });
  });

  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("renders the segmented [Themes | Community] toggle and Reapply icon in the header", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(headerSlot.textContent).toContain("Themes");
      expect(headerSlot.textContent).toContain("Community");
      expect(
        headerSlot.querySelector('[aria-label="Reapply themes"]'),
      ).not.toBeNull();
    });
  });

  it("lists themes from backend in the body", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(container.textContent).toContain("Dark Mode");
      expect(container.textContent).toContain("Retro");
    });
  });

  it("renders the empty-themes state when nothing is installed", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getThemes") return Promise.resolve([]);
      if (method === "getStatus")
        return Promise.resolve({
          connected: false,
          tabCount: 0,
          activeThemeCount: 0,
        });
      return Promise.resolve(null);
    });

    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() =>
      expect(container.textContent).toContain("No themes installed"),
    );
  });

  it("renders an options-count badge when a theme has configurable patches", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getThemes")
        return Promise.resolve([
          {
            id: "obsidian",
            name: "Obsidian",
            kind: "pack",
            active: true,
            patches: {
              "Main Color": { default: "Black", values: ["Black", "White"] },
            },
            variants: {},
          },
          { id: "plain", name: "Plain", kind: "pack", active: false },
        ]);
      if (method === "getStatus")
        return Promise.resolve({
          connected: true,
          tabCount: 1,
          activeThemeCount: 1,
        });
      return Promise.resolve(null);
    });

    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    await waitFor(() => {
      // The "N options" badge is rendered inline on the theme row.
      // The variant select itself only appears once the row is expanded.
      expect(container.textContent).toContain("Obsidian");
      expect(container.textContent).toContain("1 options");
    });
  });

  it("calls reconnect when the Reapply icon button (header) is clicked", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getThemes")
        return Promise.resolve([
          { id: "active-pack", name: "Active", kind: "pack", active: true },
        ]);
      if (method === "getStatus")
        return Promise.resolve({
          connected: true,
          tabCount: 1,
          activeThemeCount: 1,
        });
      if (method === "reconnect")
        return Promise.resolve({ success: true });
      return Promise.resolve(null);
    });

    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    // Wait for the Reapply button to be ENABLED (gated on `themes.some(active)`
    // — initially false until getThemes resolves).
    await waitFor(() => {
      const btn = headerSlot.querySelector(
        '[aria-label="Reapply themes"]',
      ) as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      expect(btn?.disabled).toBe(false);
    });
    const btn = headerSlot.querySelector(
      '[aria-label="Reapply themes"]',
    ) as HTMLButtonElement;
    fireEvent.click(btn);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("reconnect"));
  });

  it("disables the Reapply icon button (header) when no themes are active", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getThemes")
        return Promise.resolve([
          {
            id: "inactive-pack",
            name: "Inactive",
            kind: "pack",
            active: false,
          },
        ]);
      if (method === "getStatus")
        return Promise.resolve({
          connected: true,
          tabCount: 1,
          activeThemeCount: 0,
        });
      return Promise.resolve(null);
    });

    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    await waitFor(() => {
      const btn = headerSlot.querySelector(
        '[aria-label="Reapply themes"]',
      ) as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
    });
    const reapplyBtn = headerSlot.querySelector(
      '[aria-label="Reapply themes"]',
    ) as HTMLButtonElement;
    expect(reapplyBtn.disabled).toBe(true);
  });
});
