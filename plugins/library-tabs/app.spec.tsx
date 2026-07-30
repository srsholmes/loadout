/**
 * library-tabs frontend spec.
 *
 * The behaviour worth pinning down here is the local-first arrangement:
 * evaluation happens in the webview, so switching tabs must NOT cause an RPC
 * call, and an empty tab must render a diagnosis rather than a bare grid.
 *
 * `@loadout/ui` is partially mocked — the real module is spread so Button,
 * GameCard and friends render for real, and only `useBackend`/`PluginProvider`
 * are controlled.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import * as actualUi from "@loadout/ui";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { GameInfo } from "@loadout/types";
import { adaptLibrary, phase1Providers } from "./lib/adapt";
import { defaultConfig } from "./lib/config";
import type { LibraryTabsConfig } from "./lib/config";
import type { Tab } from "./lib/types";

// ── Backend stub ───────────────────────────────────────────────────────

let config: LibraryTabsConfig = defaultConfig();
let games: GameInfo[] = [];
let providersAllOk = false;
const calls: Array<{ method: string; args: unknown[] }> = [];
const eventHandlers = new Map<string, (data: unknown) => void>();

function info(appId: string, name: string, extra: Partial<GameInfo> = {}): GameInfo {
  return {
    appId,
    name,
    sizeOnDisk: 1024 ** 3,
    headerUrl: `https://example.test/${appId}/h.jpg`,
    capsuleUrl: `https://example.test/${appId}/c.jpg`,
    localHeaderUrl: `https://example.test/${appId}/h.jpg`,
    localCapsuleUrl: `https://example.test/${appId}/c.jpg`,
    source: "steam",
    tags: [],
    ...extra,
  };
}

const callMock = mock((method: string, ...args: unknown[]) => {
  calls.push({ method, args });
  switch (method) {
    case "getConfig":
      return Promise.resolve({ config, warnings: [], readOnly: false });
    case "getSnapshot":
      return Promise.resolve({
        games: adaptLibrary(games),
        providers: providersAllOk
          ? {
              ...phase1Providers(true),
              appstore: { status: "ok", capturedAt: 1, ownsFields: [] },
              appinfo: { status: "ok", capturedAt: 1, ownsFields: [] },
            }
          : phase1Providers(false),
        generatedAt: 1,
      });
    case "setTabs":
      config = { ...config, tabs: args[0] as Tab[] };
      return Promise.resolve(config);
    case "createTabFromTemplate":
      return Promise.resolve(config);
    case "launchGame":
      return Promise.resolve();
    default:
      return Promise.resolve(null);
  }
});

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: { children: unknown }) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: { event: string; handler: (d: unknown) => void }) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

// Imported after the mock so the component picks it up.
const { mount } = await import("./app");

/** Mount into a detached container the way the overlay host does. */
function mountApp(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mount(container, {});
  return container;
}

beforeEach(() => {
  config = defaultConfig();
  games = [
    info("620", "Portal 2", { tags: ["favorite"] }),
    info("1091500", "Cyberpunk 2077"),
    info("3405691582", "Super Mario 64", { source: "shortcut", sizeOnDisk: 0 }),
  ];
  providersAllOk = false;
  calls.length = 0;
  eventHandlers.clear();
  callMock.mockClear();
  document.body.innerHTML = "";
});

describe("initial render", () => {
  it("renders the tab strip once loaded", async () => {
    mountApp();
    await waitFor(() => {
      expect(screen.getByRole("tablist", { name: "Library tabs" })).toBeTruthy();
    });
    expect(screen.getByRole("tab", { name: /All/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Installed/ })).toBeTruthy();
  });

  it("opens on the first visible tab by default", async () => {
    mountApp();
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /All/ }).getAttribute("aria-selected"),
      ).toBe("true");
    });
  });

  it("honours defaultTabId without hiding All Games", async () => {
    // TabMaster's #221 asks for exactly this and its only workaround is
    // hiding All Games entirely.
    config = { ...defaultConfig(), defaultTabId: "installed" };
    mountApp();
    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Installed/ }).getAttribute("aria-selected"),
      ).toBe("true");
    });
    expect(screen.getByRole("tab", { name: /^All/ })).toBeTruthy();
  });

  it("renders a tile per matching game", async () => {
    mountApp();
    await waitFor(() => {
      expect(screen.getByText("Portal 2")).toBeTruthy();
    });
    expect(screen.getByText("Cyberpunk 2077")).toBeTruthy();
    expect(screen.getByText("Super Mario 64")).toBeTruthy();
  });

  it("shows a plain-English summary of the active tab", async () => {
    mountApp();
    await waitFor(() => {
      expect(screen.getByText(/Show every game/)).toBeTruthy();
    });
  });
});

describe("local-first evaluation", () => {
  it("does NOT call the backend when switching tabs", async () => {
    // The whole library is fetched once and filtered in the webview; a tab
    // switch that hit RPC would make live counts unaffordable.
    mountApp();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Installed/ })).toBeTruthy();
    });

    calls.length = 0;
    screen.getByRole("tab", { name: /Installed/ }).click();

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: /Installed/ }).getAttribute("aria-selected"),
      ).toBe("true");
    });
    expect(calls.map((c) => c.method)).not.toContain("getSnapshot");
    expect(calls.map((c) => c.method)).not.toContain("getConfig");
  });

  it("fetches the config and snapshot exactly once on mount", async () => {
    mountApp();
    await waitFor(() => {
      expect(screen.getByText("Portal 2")).toBeTruthy();
    });
    expect(calls.filter((c) => c.method === "getSnapshot")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "getConfig")).toHaveLength(1);
  });

  it("renders live match counts in the strip", async () => {
    mountApp();
    await waitFor(() => {
      // All = 3 games.
      expect(screen.getByRole("tab", { name: /All.*3/ })).toBeTruthy();
    });
  });
});

describe("empty tabs explain themselves", () => {
  it("renders a diagnosis rather than a bare empty grid", async () => {
    // TabMaster's answer to an empty tab is an empty grid; its issue tracker
    // has users asking "why is my tab empty?" and going unanswered.
    games = [];
    mountApp();
    await waitFor(() => {
      expect(screen.getByText(/No games found/)).toBeTruthy();
    });
    expect(screen.getByText(/hasn't been scanned/)).toBeTruthy();
  });

  it("names the single culprit rule and offers to remove it", async () => {
    const impossible: Tab = {
      ...defaultConfig().tabs[0]!,
      id: "broken",
      label: "Broken",
      builtin: undefined,
      root: {
        id: "root",
        kind: "group",
        combinator: "all",
        children: [
          { id: "inst", kind: "installed" },
          { id: "nope", kind: "title", match: "contains", value: "zzzznope" },
        ],
      },
    };
    config = {
      ...defaultConfig(),
      tabs: [impossible],
      tabOrder: ["broken"],
      defaultTabId: "broken",
    };

    mountApp();
    await waitFor(() => {
      expect(screen.getByText(/One rule is excluding everything/)).toBeTruthy();
    });
    // And the fix names the rule in plain English.
    expect(screen.getByRole("button", { name: /Remove "title contains/ })).toBeTruthy();
  });

  it("applies a fix through the backend when its button is pressed", async () => {
    const impossible: Tab = {
      ...defaultConfig().tabs[0]!,
      id: "broken",
      label: "Broken",
      builtin: undefined,
      root: {
        id: "root",
        kind: "group",
        combinator: "all",
        children: [
          { id: "inst", kind: "installed" },
          { id: "nope", kind: "title", match: "contains", value: "zzzznope" },
        ],
      },
    };
    config = {
      ...defaultConfig(),
      tabs: [impossible],
      tabOrder: ["broken"],
      defaultTabId: "broken",
    };

    mountApp();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Remove "title contains/ })).toBeTruthy();
    });

    screen.getByRole("button", { name: /Remove "title contains/ }).click();
    await waitFor(() => {
      expect(calls.some((c) => c.method === "setTabs")).toBe(true);
    });
    const saved = calls.find((c) => c.method === "setTabs")!.args[0] as Tab[];
    expect(saved[0]!.root.children.map((c) => c.id)).toEqual(["inst"]);
  });
});

describe("template gallery", () => {
  it("opens on Add tab and lists templates", async () => {
    mountApp();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add tab" })).toBeTruthy();
    });
    screen.getByRole("button", { name: "Add tab" }).click();

    await waitFor(() => {
      expect(screen.getByText("Installed & unplayed")).toBeTruthy();
    });
    // Backlog suppression leads, per the ordering decision in templates.ts.
    expect(screen.getByText("Short games")).toBeTruthy();
  });

  it("disables a template whose data source is unavailable, and says why", async () => {
    // Offering a Deck Verified template that silently yields an empty tab is
    // the exact failure this design exists to prevent.
    mountApp();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add tab" })).toBeTruthy();
    });
    screen.getByRole("button", { name: "Add tab" }).click();

    await waitFor(() => {
      expect(screen.getByText("Deck Verified")).toBeTruthy();
    });
    const card = screen.getByText("Deck Verified").closest("button")!;
    expect(card.hasAttribute("disabled")).toBe(true);
    expect(card.textContent).toMatch(/aren't available yet/);
  });

  it("enables those templates once the providers are healthy", async () => {
    providersAllOk = true;
    mountApp();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add tab" })).toBeTruthy();
    });
    screen.getByRole("button", { name: "Add tab" }).click();

    await waitFor(() => {
      expect(screen.getByText("Deck Verified")).toBeTruthy();
    });
    expect(
      screen.getByText("Deck Verified").closest("button")!.hasAttribute("disabled"),
    ).toBe(false);
  });

  it("creates a tab from a template", async () => {
    mountApp();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add tab" })).toBeTruthy();
    });
    screen.getByRole("button", { name: "Add tab" }).click();
    await waitFor(() => {
      expect(screen.getByText("Installed & unplayed")).toBeTruthy();
    });

    screen.getByText("Installed & unplayed").closest("button")!.click();
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === "createTabFromTemplate" && c.args[0] === "backlog",
        ),
      ).toBe(true);
    });
  });
});

describe("search", () => {
  it("narrows the current tab", async () => {
    mountApp();
    await waitFor(() => {
      expect(screen.getByText("Portal 2")).toBeTruthy();
    });

    // fireEvent.change, not a raw DOM event: React tracks input values via
    // its own value setter and ignores an untracked native `input` event.
    fireEvent.change(document.querySelector("input")!, {
      target: { value: "portal" },
    });

    await waitFor(() => {
      expect(screen.queryByText("Cyberpunk 2077")).toBeNull();
    });
    expect(screen.getByText("Portal 2")).toBeTruthy();
  });
});

describe("launching", () => {
  it("passes the game's source, so shortcuts get their 64-bit gameid", async () => {
    mountApp();
    await waitFor(() => {
      expect(screen.getByText("Super Mario 64")).toBeTruthy();
    });

    screen.getByText("Super Mario 64").closest("button")!.click();
    await waitFor(() => {
      expect(calls.some((c) => c.method === "launchGame")).toBe(true);
    });
    const launch = calls.find((c) => c.method === "launchGame")!;
    expect(launch.args).toEqual(["3405691582", "shortcut"]);
  });
});

describe("read-only mode", () => {
  it("hides Add tab and explains why", async () => {
    callMock.mockImplementation((method: string, ...args: unknown[]) => {
      calls.push({ method, args });
      if (method === "getConfig") {
        return Promise.resolve({ config, warnings: [], readOnly: true });
      }
      if (method === "getSnapshot") {
        return Promise.resolve({
          games: adaptLibrary(games),
          providers: phase1Providers(false),
          generatedAt: 1,
        });
      }
      return Promise.resolve(null);
    });

    mountApp();
    await waitFor(() => {
      expect(screen.getByText(/newer version of Loadout/)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Add tab" })).toBeNull();
  });
});
