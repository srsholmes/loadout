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
  // so `<PluginHeader>` portal-renders into the supplied slot.
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

const mockFanInfo = {
  fans: [{ index: 0, rpm: 2400, pwm: 128, percent: 50 }],
  mode: "auto" as const,
  temps: [
    { label: "CPU", zone: "cpu", tempC: 55 },
    { label: "GPU", zone: "gpu", tempC: 48 },
  ],
  cpuTempC: 55,
  chipName: "it8613e",
  fanCount: 1,
  available: true,
  activePreset: null,
  usingEctool: false,
  warning: null,
};

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("fan-control plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getFanInfo") return Promise.resolve(mockFanInfo);
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
      expect(headerSlot.querySelector("h1")?.textContent).toBe("Fan Control");
    });
  });

  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("calls getFanInfo on mount", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getFanInfo");
    });
  });

  it("displays fan RPM", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("2,400");
    });
  });

  it("displays temperature readings", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("55");
      expect(container.textContent).toContain("48");
    });
  });

  it("shows Auto and Manual mode buttons in the header", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      // Auto/Manual segmented now lives in the portaled topbar header.
      const buttons = headerSlot.querySelectorAll("button");
      const texts = Array.from(buttons).map((b) => b.textContent);
      expect(texts).toContain("Auto");
      expect(texts).toContain("Manual");
    });
  });

  it("displays chip name in the header subtitle", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      // chipName is surfaced as "Detected: <chip>" in the header subtitle.
      expect(headerSlot.textContent).toContain("it8613e");
    });
  });

  it("registers fan-update event handler", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("fan-update")).toBe(true);
    });
  });

  it("shows unavailable message when no fan hardware", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getFanInfo")
        return Promise.resolve({ ...mockFanInfo, available: false });
      return Promise.resolve(null);
    });
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("No fan hardware detected");
    });
  });
});
