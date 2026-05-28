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
        position: "tl",
        showMainStory: true,
        showMainPlusExtras: true,
        showCompletionist: true,
        showAllStyles: true,
        enableLibraryBadge: true,
        enableStoreBadge: true,
      });
    if (method === "getStatus")
      return Promise.resolve({ connected: false, tabs: 0 });
    // Library now comes from game-browser::getGames (shared with
    // SGDB / LSFG-VK / ProtonDB). One mock handler covers both
    // plugin IDs because `useBackend` returns the same call mock here.
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
    // The grid card and home widget now use the name-aware RPC
    // (`getTimesForGame`) so non-Steam shortcuts can resolve too.
    // The legacy Steam-only path is still served for the BPM badge
    // pipeline; mock both so any caller in this suite gets a hit.
    if (
      method === "getTimesForSteamApp" ||
      method === "getTimesForGame"
    )
      return Promise.resolve({
        gameId: 1234,
        gameName: "Team Fortress 2",
        gameImage: "https://howlongtobeat.com/games/440_TF2.jpg",
        mainStory: "10.5h",
        mainPlusExtras: "25.0h",
        completionist: "100.0h",
        allStyles: "30.0h",
      });
    if (
      method === "getGameDetailForSteamApp" ||
      method === "getGameDetailForGame"
    )
      return Promise.resolve({
        gameId: 1234,
        gameName: "Team Fortress 2",
        gameImage: "https://howlongtobeat.com/games/440_TF2.jpg",
        mainStory: "10.5h",
        mainPlusExtras: "25.0h",
        completionist: "100.0h",
        allStyles: "30.0h",
        developer: "Valve",
        publisher: "Valve",
        platforms: "PC, Mac, Linux",
        genres: "FPS, Multiplayer",
        releaseWorld: "2007-10-10",
        reviewScore: 92,
        reviewCount: 5000,
        playingCount: 100,
        completedCount: 250,
        summary: "Team-based first-person shooter.",
        hltbUrl: "https://howlongtobeat.com/game/1234",
      });
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

describe("hltb plugin", () => {
  it("portals the dynamic header (How Long to Beat title) into the supplied slot", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() =>
      expect(headerSlot.querySelector("h1")?.textContent).toBe(
        "How Long to Beat",
      ),
    );
  });

  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("settings view shows the Steam Integration panel with the Inject time-to-beat copy and Steam CEF status", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() => {
      expect(container.textContent).toContain("Steam Integration");
      expect(container.textContent).toContain("Inject time-to-beat");
      expect(container.textContent).toContain("Steam CEF");
    });
  });

  it("settings view shows the Metrics Shown checklist", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() => {
      expect(container.textContent).toContain("Metrics Shown");
      expect(container.textContent).toContain("Main Story");
      expect(container.textContent).toContain("Completionist");
    });
  });

  it("returns an unmount function and clears the body on unmount", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    const unmount = mount(container);
    expect(typeof unmount).toBe("function");
    unmount();
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  // ── #86: card → detail view ────────────────────────────────────

  it("clicking a card opens the detail view with the full breakdown and the dynamic header subtitle", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    // Wait for the grid to render at least one card.
    await waitFor(() => {
      expect(container.querySelector("button")).not.toBeNull();
    });

    // Click the first card. The GameCard renders as a <button> when
    // `onPick` is wired — click it to drill into the detail route.
    const cards = container.querySelectorAll("button");
    expect(cards.length).toBeGreaterThan(0);
    fireEvent.click(cards[0]);

    await waitFor(() => {
      // Header retitled with lowercase "How long to beat" per #86.
      expect(headerSlot.querySelector("h1")?.textContent).toBe(
        "How long to beat",
      );
      // Subtitle is now the game name.
      expect(headerSlot.textContent).toMatch(/Team Fortress 2|Counter-Strike 2/);
    });

    await waitFor(() => {
      // Detail hero renders the four time-badges as overlay pills on
      // the artwork (short labels: "Main", "+Sides", "100%", "Avg"
      // — full labels live in the badge `title` tooltip).
      expect(container.textContent).toContain("Main");
      expect(container.textContent).toContain("+Sides");
      expect(container.textContent).toContain("100%");
      expect(container.textContent).toContain("Avg");
    });
  });

  it("detail view surfaces the rich HLTB metadata when present", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    await waitFor(() => {
      expect(container.querySelector("button")).not.toBeNull();
    });

    fireEvent.click(container.querySelectorAll("button")[0]);

    await waitFor(() => {
      expect(container.textContent).toContain("Developer");
      expect(container.textContent).toContain("Valve");
      expect(container.textContent).toContain("Publisher");
      expect(container.textContent).toContain("Released");
      expect(container.textContent).toContain("2007-10-10");
      // Stats panel includes the review score badge.
      expect(container.textContent).toContain("92/100");
    });
  });

  // ── Non-Steam shortcut support (emulated games) ───────────────

  it("shows non-Steam shortcuts in the grid and looks them up via getTimesForGame(appId, name)", async () => {
    // Override the getGames mock to include a shortcut entry (e.g. an
    // emulator-launched ROM like SSX3). The original Steam-only
    // filter would have dropped this row; the new picker should
    // render it and pass the shortcut's name into the lookup so HLTB
    // can resolve it via search.
    callMock.mockImplementation((method: string) => {
      if (method === "getSettings")
        return Promise.resolve({
          position: "tl",
          showMainStory: true,
          showMainPlusExtras: true,
          showCompletionist: true,
          showAllStyles: true,
          enableLibraryBadge: true,
          enableStoreBadge: true,
        });
      if (method === "getStatus")
        return Promise.resolve({ connected: false, tabs: 0 });
      if (method === "getGames")
        return Promise.resolve([
          {
            appId: "1234567890",
            name: "SSX 3",
            source: "shortcut",
            headerUrl: "",
            capsuleUrl: "",
            tags: [],
          },
        ]);
      if (method === "getCollections") return Promise.resolve([]);
      if (method === "getTimesForGame")
        return Promise.resolve({
          gameId: 9018,
          gameName: "SSX 3",
          gameImage: "",
          mainStory: "8.0h",
          mainPlusExtras: "12.0h",
          completionist: "20.0h",
          allStyles: "10.0h",
        });
      return Promise.resolve(null);
    });

    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    // Picker defaults to STEAM_ONLY now; the SSX 3 shortcut only
    // surfaces under "All games". Open the dropdown and pick it
    // before asserting the shortcut row renders.
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
      expect(container.textContent).toContain("SSX 3");
    });

    // Drill into the detail view — that handler isn't intersection-
    // gated like the grid card, so it actually fires the RPC in
    // JSDOM. Asserting the `getGameDetailForGame` call with the
    // shortcut's *name* is what proves the new name-aware pipeline
    // is wired up — a regression to the Steam-only RPC would have
    // dropped this game entirely from the picker before it ever
    // reached this point.
    const cards = container.querySelectorAll("button");
    expect(cards.length).toBeGreaterThan(0);
    fireEvent.click(cards[0]);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "getGameDetailForGame",
        "1234567890",
        "SSX 3",
      );
    });
  });

  it("library filter dropdown is present in the header (opens to listbox with Steam-only / Non-Steam-only options)", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    // The shared `Select` component renders a custom trigger button
    // with `aria-haspopup="listbox"` (the CEF webview can't be
    // trusted to render a native <select> consistently — see the
    // Select source). Find the trigger, click it, and assert the
    // listbox surfaces the Steam-only + Non-Steam-only options.
    await waitFor(() => {
      const trigger = headerSlot.querySelector(
        '[aria-haspopup="listbox"]',
      ) as HTMLButtonElement | null;
      expect(trigger).not.toBeNull();
    });
    const trigger = headerSlot.querySelector(
      '[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;

    // Trigger label includes the current value ("Steam only (N)") —
    // proves the picker defaults to STEAM_ONLY on first render
    // (most users want Steam-library completion times, not Heroic /
    // Lutris / emulator shortcuts which rarely have HLTB matches).
    expect(trigger.textContent).toMatch(/Steam only/);

    fireEvent.click(trigger);

    await waitFor(() => {
      const listbox = headerSlot.querySelector(
        '[role="listbox"]',
      ) as HTMLElement | null;
      expect(listbox).not.toBeNull();
      expect(listbox!.textContent).toContain("Steam only");
    });
  });

  it("detail view back button (HeaderBackButton) returns to the library grid", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    await waitFor(() => {
      expect(container.querySelector("button")).not.toBeNull();
    });
    fireEvent.click(container.querySelectorAll("button")[0]);

    await waitFor(() => {
      // Detail view marker: short-label badges only exist on the hero.
      expect(container.textContent).toContain("+Sides");
    });

    // Tap the back button rendered in the portaled header slot.
    const back = headerSlot.querySelector(
      '[aria-label="Back to library"]',
    ) as HTMLButtonElement | null;
    expect(back).not.toBeNull();
    fireEvent.click(back!);

    await waitFor(() => {
      // Grid is back: header re-takes the original title.
      expect(headerSlot.querySelector("h1")?.textContent).toBe(
        "How Long to Beat",
      );
      // "+Sides" is the hero-only short label; cards use full labels.
      expect(container.textContent).not.toContain("+Sides");
    });
  });
});
