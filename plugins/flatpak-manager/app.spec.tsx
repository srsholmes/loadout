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
    // Stripped-down PluginProvider — wires the supplied headerSlot
    // through PluginHeaderSlotProvider so `<PluginHeader>` portals
    // into the slot the test owns. Backend + focus context are mocked
    // separately.
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

/** Click a header control by selector, waiting until it lands in the portal. */
async function clickHeaderControl(
  headerSlot: HTMLElement,
  selector: string,
): Promise<HTMLElement> {
  await waitFor(() => {
    const el = headerSlot.querySelector(selector) as HTMLElement | null;
    expect(el).not.toBeNull();
  });
  const el = headerSlot.querySelector(selector) as HTMLElement;
  fireEvent.click(el);
  return el;
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
    const items = Array.from(headerSlot.querySelectorAll("button, [role='tab']"));
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
