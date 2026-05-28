/**
 * launch-options app spec — bun:test + happy-dom.
 *
 * Tests cover: dynamic PluginHeader portal, library card grid render,
 * Configured / Options pill affordance, click-to-detail navigation,
 * back button, and the presets view entry.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below — bun's mock.module is not
// hoisted like vitest's vi.mock, so we need the real module first.
import * as actualUi from "@loadout/ui";
import { fireEvent, waitFor } from "../../test/render";

const callMock = mock((method: string) => {
  void method;
  return Promise.resolve(null as unknown);
});
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => {
  const { PluginHeaderSlotProvider } = actualUi as unknown as {
    PluginHeaderSlotProvider: (props: {
      slot: HTMLElement | null;
      children: React.ReactNode;
    }) => React.ReactElement;
  };
  return {
    ...actualUi,
    // Stripped-down PluginProvider that wires headerSlot through to
    // PluginHeaderSlotProvider so `<PluginHeader>` portals correctly.
    PluginProvider: ({
      children,
      headerSlot,
    }: {
      children: React.ReactNode;
      headerSlot?: HTMLElement | null;
    }) => (
      <PluginHeaderSlotProvider slot={headerSlot ?? null}>
        {children}
      </PluginHeaderSlotProvider>
    ),
    useBackend: () => ({
      call: callMock,
      useEvent: ({
        event,
        handler,
      }: {
        event: string;
        handler: (data: unknown) => void;
      }) => {
        eventHandlers.set(event, handler);
      },
      ready: true,
    }),
    // Force useCurrentGame to null so the running-game float-to-top
    // branch is exercised on the empty path (no current game pinned).
    useCurrentGame: () => null,
  };
});

beforeEach(() => {
  callMock.mockClear();
  eventHandlers.clear();
  callMock.mockImplementation((method: string) => {
    // Both `launch-options` and `__core:game-library` backends share
    // this mock. `launch-options::getGames` returns the per-appId
    // launch-options strings; `__core:game-library::getGames` returns
    // the library entries (name + artwork URLs) the card grid renders.
    // The picker merges by appId at the call site.
    if (method === "getGames") {
      // Test mock can't distinguish which backend is calling — we
      // return a shape that satisfies both. The launch-options call
      // ignores fields it doesn't know; the __core:game-library call
      // ignores `launchOptions`. (See the dual-shape mock in the app
      // code.)
      return Promise.resolve([
        {
          appId: "730",
          name: "Counter-Strike 2",
          launchOptions: "mangohud %command%",
          source: "steam",
          headerUrl: "https://example.invalid/730/header.jpg",
          capsuleUrl: "https://example.invalid/730/capsule.jpg",
          tags: [],
        },
        {
          appId: "570",
          name: "Dota 2",
          launchOptions: "gamemoderun %command%",
          source: "steam",
          headerUrl: "https://example.invalid/570/header.jpg",
          capsuleUrl: "https://example.invalid/570/capsule.jpg",
          tags: [],
        },
      ]);
    }
    if (method === "getCollections") return Promise.resolve([]);
    if (method === "getPresets")
      return Promise.resolve([
        { name: "MangoHud", options: "mangohud %command%" },
        { name: "GameMode", options: "gamemoderun %command%" },
      ]);
    return Promise.resolve(null);
  });
});

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

/** Click the "Manage presets" gear icon to enter the presets view. */
async function enterPresetsView(headerSlot: HTMLElement): Promise<void> {
  await waitFor(() => {
    const gear = headerSlot.querySelector(
      '[aria-label="Manage presets"]',
    ) as HTMLButtonElement | null;
    expect(gear).not.toBeNull();
  });
  const gear = headerSlot.querySelector(
    '[aria-label="Manage presets"]',
  ) as HTMLButtonElement;
  fireEvent.click(gear);
}

/**
 * Click the game card in the grid that displays the given title.
 * `GameCard` renders as a `<button>` whose inner title `<div>` carries
 * `title={title}` — we locate that div, walk up to the enclosing
 * button, and click it.
 */
async function clickGameCard(
  container: HTMLElement,
  name: string,
): Promise<void> {
  await waitFor(() => {
    expect(container.textContent).toContain(name);
  });
  const titleEl = Array.from(
    container.querySelectorAll<HTMLElement>("[title]"),
  ).find((el) => el.getAttribute("title") === name);
  expect(titleEl).toBeDefined();
  const card = titleEl!.closest("button") as HTMLButtonElement | null;
  expect(card).not.toBeNull();
  fireEvent.click(card!);
}

describe("launch-options plugin", () => {
  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("portals the dynamic header (Launch Options title) into the supplied slot", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(headerSlot.querySelector("h1")?.textContent).toBe(
        "Launch Options",
      );
    });
  });

  it("calls getGames on mount", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getGames");
    });
  });

  it("default view renders each game as a card tile by name", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      // Cards render the friendly game name as the tile title.
      expect(container.textContent).toContain("Counter-Strike 2");
      expect(container.textContent).toContain("Dota 2");
    });
  });

  it("renders an Options affordance on every card tile", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      // Per issue #85: each card has an "Options" button-style affordance.
      // We render two cards in the mock library, so we expect two pills.
      const matches = container.textContent?.match(/Options/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("marks cards that already have launch options as Configured", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      // Both mocked games have launch options set, so the "Configured"
      // overlay badge should render twice.
      const matches = container.textContent?.match(/Configured/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("clicking a card opens the detail view with the game name as header subtitle", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    await clickGameCard(container, "Counter-Strike 2");

    // Header subtitle in detail view = game name.
    await waitFor(() => {
      // The PluginHeader title is always "Launch Options" — the
      // subtitle below it changes per view. We assert the game
      // name now appears inside the header slot specifically.
      expect(headerSlot.textContent).toContain("Counter-Strike 2");
    });
    // Detail view body contains the AppID + the saved launch command
    // for that specific game, not the other one.
    expect(container.textContent).toContain("AppID 730");
    expect(container.textContent).toContain("mangohud %command%");
    expect(container.textContent).not.toContain("Dota 2");
  });

  it("back button on detail view returns to the library list", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    await clickGameCard(container, "Counter-Strike 2");

    // Detail rendered.
    await waitFor(() => {
      expect(container.textContent).toContain("AppID 730");
    });

    // HeaderBackButton renders an IconButton with the left-arrow
    // glyph; we locate it by its accessible label.
    const back = headerSlot.querySelector(
      '[aria-label="Back to library"]',
    ) as HTMLButtonElement | null;
    expect(back).not.toBeNull();
    fireEvent.click(back!);

    // List view restored — both games visible again.
    await waitFor(() => {
      expect(container.textContent).toContain("Counter-Strike 2");
      expect(container.textContent).toContain("Dota 2");
    });
    // And the detail-specific AppID line is gone.
    expect(container.textContent).not.toContain("AppID 730");
  });

  it("presets view shows presets from backend", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterPresetsView(headerSlot);
    await waitFor(() => {
      expect(container.textContent).toContain("MangoHud");
      expect(container.textContent).toContain("GameMode");
    });
  });
});
