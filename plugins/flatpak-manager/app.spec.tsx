import type { ReactNode } from "react";
import { describe, it, expect, mock, beforeEach } from "bun:test";
// Capture the real module BEFORE mock.module() — bun's mock.module is not
// hoisted, so static imports evaluate first. We spread actualUi below to
// keep all real exports and only override what we need.
import * as actualUi from "@loadout/ui";
import { fireEvent, waitFor } from "../../test/render";

const callMock = mock((_method: string, ..._args: unknown[]) =>
  Promise.resolve(null as unknown),
);
const eventHandlers = new Map<string, (data: unknown) => void>();

interface PluginProviderProps {
  children: ReactNode;
  headerSlot?: HTMLElement | null;
}
interface UseEventArgs {
  event: string;
  handler: (data: unknown) => void;
}

mock.module("@loadout/ui", () => {
  const { PluginHeaderSlotProvider } = actualUi as unknown as {
    PluginHeaderSlotProvider: (props: {
      slot: HTMLElement | null;
      children: ReactNode;
    }) => JSX.Element;
  };
  return {
    ...actualUi,
    // Stripped-down PluginProvider — keeps only the header-slot context
    // so `<PluginHeader>` portal-renders into the supplied slot. Backend
    // and focus context are mocked separately.
    PluginProvider: ({ children, headerSlot }: PluginProviderProps) => (
      <PluginHeaderSlotProvider slot={headerSlot ?? null}>
        {children}
      </PluginHeaderSlotProvider>
    ),
    useBackend: () => ({
      call: callMock,
      useEvent: ({ event, handler }: UseEventArgs) => {
        eventHandlers.set(event, handler);
      },
      ready: true,
    }),
  };
});

const mockApps = [
  {
    name: "Firefox",
    appId: "org.mozilla.firefox",
    version: "121.0",
    size: "350 MB",
    origin: "flathub",
  },
  {
    name: "Steam",
    appId: "com.valvesoftware.Steam",
    version: "1.0.0",
    size: "500 MB",
    origin: "flathub",
  },
];

const mockUpdates = [
  {
    name: "Firefox",
    appId: "org.mozilla.firefox",
    newVersion: "122.0",
  },
];

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("flatpak-manager plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getInstalled") return Promise.resolve(mockApps);
      if (method === "checkUpdates") return Promise.resolve(mockUpdates);
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
      expect(headerSlot.querySelector("h1")?.textContent).toBe("Flatpak");
    });
  });

  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("calls getInstalled on mount", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getInstalled");
    });
  });

  it("calls checkUpdates on mount", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("checkUpdates");
    });
  });

  it("displays installed app names in the body (Installed tab is default)", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(container.textContent).toContain("Firefox");
      expect(container.textContent).toContain("Steam");
    });
  });

  it("shows update count in the header (Updates segmented tab)", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      // Header renders "Updates (1)" inside the segmented item.
      expect(headerSlot.textContent).toContain("Updates (1)");
    });
  });

  it("shows installed app count in the header (Installed segmented tab)", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      // Header renders "Installed (2)" inside the segmented item, plus
      // the subtitle reads "2 apps · last sync …".
      expect(headerSlot.textContent).toContain("Installed (2)");
      expect(headerSlot.textContent).toContain("2 apps");
    });
  });

  it("registers updateComplete event handler", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("updateComplete")).toBe(true);
    });
  });

  it("shows the Refresh icon button in the header", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(
        headerSlot.querySelector('[aria-label="Refresh"]'),
      ).not.toBeNull();
    });
  });

  it("switches to the Updates tab when the segmented Updates item is clicked", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    // Wait for the segmented Updates item to portal into the header.
    await waitFor(() => {
      expect(headerSlot.textContent).toContain("Updates (1)");
    });

    // SegmentedItem renders as a clickable element containing the
    // "Updates (N)" text — find the closest button-like ancestor.
    const items = Array.from(
      headerSlot.querySelectorAll("button, [role='tab']"),
    );
    const updatesItem = items.find((el) =>
      (el.textContent ?? "").includes("Updates ("),
    ) as HTMLElement | undefined;
    expect(updatesItem).not.toBeUndefined();
    fireEvent.click(updatesItem!);

    // The body should now show the single update entry → v122.0.
    await waitFor(() => {
      expect(container.textContent).toContain("v122.0");
    });
  });
});
