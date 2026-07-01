import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below, so this holds the real
// module for the partial-mock spread. (bun's mock.module is not hoisted,
// unlike vitest's vi.mock — static imports evaluate first.)
import * as actualUi from "@loadout/ui";
import { waitFor, fireEvent } from "../../test/render";

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
  customCurveActive: false,
  usingEctool: false,
  warning: null,
};

const mockCustomCurve = [
  { tempC: 40, percent: 20 },
  { tempC: 55, percent: 45 },
  { tempC: 70, percent: 70 },
  { tempC: 85, percent: 100 },
];

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

  it("displays temperature readings (sensors behind the collapsible box)", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    // Edge/primary temp (55°) is in the always-visible Live Status card.
    await waitFor(() => {
      expect(container.textContent).toContain("55");
    });
    // Per-sensor rows (incl. GPU 48°) live in the Temperature Sensors box,
    // which is collapsed by default — expand it, then they appear.
    const toggle = await waitFor(() => {
      const el = Array.from(container.querySelectorAll('[role="button"]')).find(
        (b) => b.textContent?.includes("Temperature Sensors"),
      );
      if (!el) throw new Error("Temperature Sensors toggle not rendered");
      return el as HTMLElement;
    });
    expect(container.textContent).not.toContain("48"); // hidden while closed
    fireEvent.click(toggle);
    await waitFor(() => {
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

  // ---------------------------------------------------------------------------
  // Custom fan curve editor
  // ---------------------------------------------------------------------------

  it("fetches the saved custom curve on mount", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getCustomCurve");
    });
  });

  it("offers a Custom preset option in manual mode", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getFanInfo")
        return Promise.resolve({ ...mockFanInfo, mode: "manual" });
      if (method === "getCustomCurve") return Promise.resolve(mockCustomCurve);
      return Promise.resolve(null);
    });
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      const texts = Array.from(container.querySelectorAll("button")).map(
        (b) => b.textContent,
      );
      expect(texts.some((t) => t?.includes("Custom"))).toBe(true);
    });
  });

  it("applies the custom curve and reveals the graph editor when Custom is selected", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getFanInfo")
        return Promise.resolve({ ...mockFanInfo, mode: "manual" });
      if (method === "getCustomCurve") return Promise.resolve(mockCustomCurve);
      return Promise.resolve(null);
    });
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    const customButton = await waitFor(() => {
      const btn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Custom"),
      );
      if (!btn) throw new Error("Custom button not yet rendered");
      return btn;
    });

    fireEvent.click(customButton);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("applyCustomCurve");
      // The graph editor (an SVG) appears once Custom is active.
      expect(container.querySelector("svg[aria-label='Fan curve graph']")).not.toBeNull();
      expect(container.textContent).toContain("Point 1 / 4");
    });
  });

  it("visualises the selected preset as a read-only curve graph (no editor controls)", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getFanInfo")
        return Promise.resolve({
          ...mockFanInfo,
          mode: "manual",
          activePreset: "balanced",
        });
      if (method === "getCustomCurve") return Promise.resolve(mockCustomCurve);
      return Promise.resolve(null);
    });
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      // The curve graph renders for the active preset...
      expect(
        container.querySelector("svg[aria-label='Fan curve graph']"),
      ).not.toBeNull();
      expect(container.textContent).toContain("Balanced Curve");
      // ...but it's read-only: no add/remove-point controls, no point selector.
      expect(container.querySelector("[aria-label='Add point']")).toBeNull();
      expect(container.textContent).not.toContain("Point 1 / 4");
    });
  });

  it("renders a saved per-game profile as a card with its setting and a Remove action", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getFanInfo") return Promise.resolve(mockFanInfo);
      if (method === "getPerGameEnabled") return Promise.resolve(true);
      if (method === "getGameProfiles")
        return Promise.resolve([
          { appId: 220, gameName: "Half-Life 2", mode: "manual", speed: 65 },
        ]);
      return Promise.resolve(null);
    });
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Saved profiles (1)");
      expect(container.textContent).toContain("Half-Life 2");
      expect(container.textContent).toContain("65%"); // fanProfileBadge label
      const removeBtn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Remove",
      );
      expect(removeBtn).toBeTruthy();
    });
  });

  it("clicking Remove fires removeGameProfile exactly once (no card-onPick double-fire)", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getFanInfo") return Promise.resolve(mockFanInfo);
      if (method === "getPerGameEnabled") return Promise.resolve(true);
      if (method === "getGameProfiles")
        return Promise.resolve([
          { appId: 220, gameName: "Half-Life 2", mode: "manual", speed: 65 },
        ]);
      return Promise.resolve(null);
    });
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    const removeBtn = await waitFor(() => {
      const btn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Remove",
      );
      if (!btn) throw new Error("Remove button not yet rendered");
      return btn;
    });

    fireEvent.click(removeBtn);

    await waitFor(() => {
      // The card's own onPick is ALSO removeProfile; without the GameCard
      // action-slot stopPropagation the click would bubble and fire it
      // twice. Assert exactly one removeGameProfile call.
      const removeCalls = callMock.mock.calls.filter(
        (c) => c[0] === "removeGameProfile",
      );
      expect(removeCalls).toHaveLength(1);
      expect(removeCalls[0][1]).toBe(220);
    });
  });
});

describe("fan-control pure helpers", () => {
  it("editCurvePoint clamps temp between neighbours (1°C gap) and percent to [0,100]", async () => {
    const { editCurvePoint } = await import("./app");
    const pts = [
      { tempC: 30, percent: 10 },
      { tempC: 50, percent: 50 },
      { tempC: 80, percent: 90 },
    ];
    // Middle point can't pass its upper neighbour (80) minus 1.
    expect(editCurvePoint(pts, 1, { tempC: 999 })[1].tempC).toBe(79);
    // ...nor its lower neighbour (30) plus 1.
    expect(editCurvePoint(pts, 1, { tempC: 0 })[1].tempC).toBe(31);
    expect(editCurvePoint(pts, 1, { percent: 200 })[1].percent).toBe(100);
    // Out-of-range index is a no-op (same reference back).
    expect(editCurvePoint(pts, 9, { percent: 5 })).toBe(pts);
  });

  it("insertCurvePoint adds a midpoint node in the widest temperature gap", async () => {
    const { insertCurvePoint } = await import("./app");
    const pts = [
      { tempC: 30, percent: 10 },
      { tempC: 40, percent: 20 },
      { tempC: 80, percent: 90 }, // widest gap is 40→80
    ];
    const { points, index } = insertCurvePoint(pts);
    expect(points).toHaveLength(4);
    expect(index).toBe(2);
    expect(points[2]).toEqual({ tempC: 60, percent: 55 });
  });

  it("fanProfileBadge formats a manual speed vs auto mode", async () => {
    const { fanProfileBadge } = await import("./app");
    expect(
      fanProfileBadge({ appId: 1, gameName: "x", mode: "manual", speed: 55 }),
    ).toBe("55%");
    expect(fanProfileBadge({ appId: 1, gameName: "x", mode: "auto" })).toBe(
      "AUTO",
    );
  });
});
