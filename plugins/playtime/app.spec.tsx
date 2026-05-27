import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "../../test/render";

const callMock = vi.fn((method: string) => Promise.resolve(null));
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
    // Stripped-down PluginProvider that wires the headerSlot through to
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
    if (method === "getStats")
      return Promise.resolve({
        today: {
          totalMs: 3_600_000,
          gamesPlayed: 2,
          games: [
            { appId: "730", gameName: "Counter-Strike 2", totalMs: 2_400_000 },
            { appId: "570", gameName: "Dota 2", totalMs: 1_200_000 },
          ],
        },
        week: { totalMs: 18_000_000, gamesPlayed: 5, games: [] },
        month: { totalMs: 72_000_000, gamesPlayed: 12, games: [] },
        allTime: { totalMs: 360_000_000, gamesPlayed: 25, games: [] },
        weeklyBreakdown: [
          { day: "Mon", totalMs: 3_600_000 },
          { day: "Tue", totalMs: 0 },
          { day: "Wed", totalMs: 7_200_000 },
          { day: "Thu", totalMs: 1_800_000 },
          { day: "Fri", totalMs: 0 },
          { day: "Sat", totalMs: 3_600_000 },
          { day: "Sun", totalMs: 1_800_000 },
        ],
      });
    if (method === "getCurrentSession") return Promise.resolve(null);
    return Promise.resolve(null);
  });
});

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("playtime plugin", () => {
  it("portals the dynamic header into the supplied slot", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(headerSlot.querySelector("h1")?.textContent).toBe("PlayTime");
    });
  });

  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("displays period selector buttons in the header", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      // Day / Week / Month / All segmented now lives in the portaled
      // topbar header rather than the body.
      expect(headerSlot.textContent).toContain("Day");
      expect(headerSlot.textContent).toContain("Week");
      expect(headerSlot.textContent).toContain("Month");
      expect(headerSlot.textContent).toContain("All");
    });
  });

  it("shows today's stats summary", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      // Stats panel renders weekly hours (decimal) + per-day breakdown.
      expect(container.textContent).toContain("hours");
      expect(container.textContent).toContain("TOTAL");
    });
  });

  it("displays top games for the selected period", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      // The "Most Played" section is rendered (with empty-state when no
      // games match the active filter).
      expect(container.textContent).toContain("Most Played");
    });
  });

  it("shows weekly breakdown chart with day labels", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      // Chart uses single-letter day labels (M T W T F S S). The
      // headline now reads "This week" (the active range) on first
      // mount since the default range is `week`.
      expect(container.textContent).toContain("This week");
      expect(container.textContent).toMatch(/M.*T.*W.*T.*F.*S.*S/);
    });
  });

  it("shows current session in the header subtitle when a game is running", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStats")
        return Promise.resolve({
          today: { totalMs: 0, gamesPlayed: 0, games: [] },
          week: { totalMs: 0, gamesPlayed: 0, games: [] },
          month: { totalMs: 0, gamesPlayed: 0, games: [] },
          allTime: { totalMs: 0, gamesPlayed: 0, games: [] },
          weeklyBreakdown: [],
        });
      if (method === "getCurrentSession")
        return Promise.resolve({
          appId: "730",
          gameName: "Counter-Strike 2",
          startTime: Date.now() - 600_000,
          elapsedMs: 600_000,
        });
      return Promise.resolve(null);
    });

    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      // Header subtitle now reads "Now playing · <game>", and the body
      // still surfaces the live "NOW PLAYING" chip.
      expect(headerSlot.textContent).toContain("Now playing");
      expect(container.textContent).toContain("NOW PLAYING");
      expect(container.textContent).toContain("Counter-Strike 2");
    });
  });
});
