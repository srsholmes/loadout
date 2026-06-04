/**
 * quick-links app spec — covers landing/settings/home-widget UI.
 *
 * Mocks @loadout/ui to swap PluginProvider/PluginHeader/IconButton/
 * HeaderBackButton/useBackend/useCurrentGame/useFocusable so the React
 * tree renders inline (no portal, no shell context) and we can drive
 * RPC + current-game from the test.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below — bun's mock.module is not
// hoisted like vitest's vi.mock, so we need the real module first.
import * as actualUi from "@loadout/ui";
import { fireEvent, waitFor } from "../../test/render";

// All useBackend("quick-links") calls go through this mock.
const callMock = mock(
  (_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown),
);
const eventHandlers = new Map<string, (data: unknown) => void>();
const currentGameRef: {
  value: { appId: number; gameName: string; startTime: number } | null;
} = { value: null };

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: { children: React.ReactNode }) => children,
  // PluginHeader normally portals into the loader-allocated topbar
  // slot, which doesn't exist in happy-dom. Render its children
  // inline so test assertions can find header-rendered controls
  // (cog, back button) by traversing the test container.
  PluginHeader: ({ children }: { children: React.ReactNode }) => children,
  HeaderBackButton: ({
    onBack,
    title,
  }: {
    onBack: () => void;
    title?: string;
  }) => (
    <button type="button" aria-label={title ?? "Back"} onClick={onBack}>
      Back
    </button>
  ),
  IconButton: ({
    children,
    onClick,
    ariaLabel,
  }: {
    children: React.ReactNode;
    onClick: () => void;
    ariaLabel?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
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
  useCurrentGame: () => currentGameRef.value,
  useFocusable: () => ({ ref: () => {}, focused: false }),
  notify: () => {},
}));

const baseState = {
  version: 1,
  templates: [
    {
      id: "youtube",
      name: "YouTube",
      urlTemplate: "https://yt/?q={name}+{suffix}",
      suffixGroup: "youtube",
      builtin: true,
      enabled: true,
    },
    {
      id: "google",
      name: "Google",
      urlTemplate: "https://g/?q={name}",
      builtin: true,
      enabled: true,
    },
    {
      id: "protondb",
      name: "ProtonDB",
      urlTemplate: "https://protondb/app/{appId}",
      steamOnly: true,
      builtin: true,
      enabled: true,
    },
  ],
  suffixes: { youtube: ["tips"] },
  perGame: {},
  hidden: [],
  installedBrowsers: [],
};

function rpcFor(state: unknown, opts?: { isGamingMode?: boolean }) {
  callMock.mockImplementation((method: string) => {
    if (method === "getState") return Promise.resolve(state);
    if (method === "launchUrl") return Promise.resolve({ launched: true });
    if (method === "isGamingMode")
      return Promise.resolve(opts?.isGamingMode ?? false);
    // Browser-installer flow: settings view detects + queries Steam
    // reachability. Tests don't exercise the install flow here —
    // return empty so the card renders the "no browsers detected"
    // state instead of throwing while reading the array.
    if (method === "detectBrowsers") return Promise.resolve([]);
    if (method === "isSteamReachable") return Promise.resolve(true);
    return Promise.resolve(state);
  });
}

describe("quick-links landing page (default mount)", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    currentGameRef.value = null;
  });

  it("renders the empty state with an Open Settings button when no game is running", async () => {
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("No game running");
    });
    const openSettings = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Open Settings"),
    ) as HTMLButtonElement | undefined;
    expect(openSettings).toBeTruthy();
  });

  it("a getState rejection on mount does not surface as an unhandled rejection", async () => {
    currentGameRef.value = {
      appId: 620,
      gameName: "Portal 2",
      startTime: Date.now(),
    };
    const rejections: unknown[] = [];
    const handler = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", handler);
    try {
      callMock.mockImplementation((method: string) =>
        method === "getState"
          ? Promise.reject(new Error("rpc down"))
          : Promise.resolve(method === "isGamingMode" ? false : baseState),
      );
      const container = document.createElement("div");
      document.body.appendChild(container);
      const { mount } = await import("./app");
      mount(container);
      // Let the rejected getState microtask settle and the
      // unhandledRejection event (fires a tick later) flush.
      await new Promise((r) => setTimeout(r, 50));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("renders one card per visible template (suffix-expanded) with the URL host visible, when a game is running", async () => {
    currentGameRef.value = {
      appId: 620,
      gameName: "Portal 2",
      startTime: Date.now(),
    };
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      // Template names render as card titles.
      expect(container.textContent).toContain("YouTube · tips");
      expect(container.textContent).toContain("Google");
      expect(container.textContent).toContain("ProtonDB");
      // URL host is shown as a small mono line under each title.
      expect(container.textContent).toContain("yt");
      expect(container.textContent).toContain("g");
    });
  });

  it("clicking a card's Open button routes through quick-links::launchUrl with the resolved URL", async () => {
    currentGameRef.value = {
      appId: 620,
      gameName: "Portal 2",
      startTime: Date.now(),
    };
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Google");
    });

    // Find the Open button inside the Google card.
    const openButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) =>
        b.textContent?.trim().startsWith("Open") &&
        !b.textContent?.includes("Settings"),
    );
    const googleOpen = openButtons.find((b) =>
      b.closest(".card")?.textContent?.includes("Google"),
    ) as HTMLButtonElement | undefined;
    expect(googleOpen).toBeTruthy();
    fireEvent.click(googleOpen!);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "launchUrl",
        "https://g/?q=Portal%202",
      );
    });
  });
});

describe("quick-links gaming-mode banner", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    currentGameRef.value = null;
  });

  it("does NOT show the banner outside gaming mode, even with no browser installed", async () => {
    rpcFor(baseState, { isGamingMode: false });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("No game running");
    });
    expect(container.textContent).not.toContain(
      "No browser shortcut registered",
    );
  });

  it("shows the banner in gaming mode when no Chrome/Firefox shortcut is installed", async () => {
    rpcFor(baseState, { isGamingMode: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain(
        "No browser shortcut registered",
      );
    });
  });

  it("hides the banner when Chrome/Firefox is installed (even in gaming mode)", async () => {
    const stateWithFirefox = {
      ...baseState,
      installedBrowsers: [
        {
          browserId: "firefox-native",
          name: "Firefox",
          kind: "native",
          appId: 1,
          gameId64: "1",
          exe: "/usr/bin/firefox",
          launchOptionsBase: "--new-tab {url}",
        },
      ],
    };
    rpcFor(stateWithFirefox, { isGamingMode: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      // Make sure the state has loaded.
      expect(container.textContent).toContain("No game running");
    });
    expect(container.textContent).not.toContain(
      "No browser shortcut registered",
    );
  });

  it("still shows the banner when Brave (not Chrome/Firefox) is installed in gaming mode", async () => {
    const stateWithBrave = {
      ...baseState,
      installedBrowsers: [
        {
          browserId: "brave-native",
          name: "Brave",
          kind: "native",
          appId: 1,
          gameId64: "1",
          exe: "/usr/bin/brave",
          launchOptionsBase: "{url}",
        },
      ],
    };
    rpcFor(stateWithBrave, { isGamingMode: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain(
        "No browser shortcut registered",
      );
    });
  });

  it("banner's 'Open settings' CTA navigates to the settings view", async () => {
    rpcFor(baseState, { isGamingMode: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain(
        "No browser shortcut registered",
      );
    });

    const cta = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Open settings",
    ) as HTMLButtonElement | undefined;
    expect(cta).toBeTruthy();
    fireEvent.click(cta!);

    await waitFor(() => {
      // Settings view shows the Templates section heading.
      expect(container.textContent).toContain("Templates");
    });
  });
});

describe("quick-links settings sub-page (cog flips to it)", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    currentGameRef.value = null;
  });

  async function mountAndOpenSettings(container: HTMLElement) {
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Quick Links");
    });
    const cog = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Quick Links settings",
    ) as HTMLButtonElement | undefined;
    expect(cog).toBeTruthy();
    fireEvent.click(cog!);
  }

  it("renders every template's name in the Templates section after clicking the cog", async () => {
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    await mountAndOpenSettings(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Suffix groups");
      expect(container.textContent).toContain("YouTube");
      expect(container.textContent).toContain("Google");
      expect(container.textContent).toContain("ProtonDB");
    });
  });

  it("renders the browser-shortcut card", async () => {
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    await mountAndOpenSettings(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Browser shortcut");
    });
  });

  it("Reset button dispatches resetToDefaults", async () => {
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    await mountAndOpenSettings(container);

    const reset = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Reset",
    ) as HTMLButtonElement;
    expect(reset).toBeTruthy();
    fireEvent.click(reset);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("resetToDefaults");
    });
  });

  it("HeaderBackButton returns from settings to landing", async () => {
    currentGameRef.value = {
      appId: 620,
      gameName: "Portal 2",
      startTime: Date.now(),
    };
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    await mountAndOpenSettings(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Templates");
    });

    const back = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Back",
    ) as HTMLButtonElement;
    expect(back).toBeTruthy();
    fireEvent.click(back);

    await waitFor(() => {
      expect(container.textContent).not.toContain("Suffix groups");
      expect(container.textContent).toContain("Google");
    });
  });

  it("'Install a browser' button shows the installer when no shortcut is registered", async () => {
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    await mountAndOpenSettings(container);

    // installer auto-opens because installedBrowsers is empty
    await waitFor(() => {
      expect(container.textContent).toContain(
        "Register a desktop browser as a non-Steam game",
      );
    });
  });

  it("clicking Install in the installer dispatches installBrowserShortcut", async () => {
    const firefoxCandidate = {
      id: "firefox-native",
      name: "Firefox",
      kind: "native",
      exe: "/usr/bin/firefox",
      launchOptionsBase: "--new-tab {url}",
    };
    callMock.mockImplementation((method: string) => {
      if (method === "getState") return Promise.resolve(baseState);
      if (method === "isGamingMode") return Promise.resolve(false);
      if (method === "detectBrowsers")
        return Promise.resolve([firefoxCandidate]);
      if (method === "isSteamReachable") return Promise.resolve(true);
      if (method === "installBrowserShortcut")
        return Promise.resolve(firefoxCandidate);
      return Promise.resolve(baseState);
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await mountAndOpenSettings(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Firefox");
      expect(container.textContent).toContain("Install as non-Steam game");
    });

    const installBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Install as non-Steam game"),
    ) as HTMLButtonElement;
    expect(installBtn).toBeTruthy();
    fireEvent.click(installBtn);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "installBrowserShortcut",
        "firefox-native",
      );
    });
  });
});

describe("quick-links home widget", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    currentGameRef.value = null;
  });

  it("renders the empty state when no game is running", async () => {
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mountHomeWidget } = await import("./app");
    mountHomeWidget(container);

    await waitFor(() => {
      expect(container.textContent).toContain("No game running");
    });
  });

  it("renders one chip per enabled template (+ suffix expansion) when a game is running", async () => {
    currentGameRef.value = {
      appId: 620,
      gameName: "Portal 2",
      startTime: Date.now(),
    };
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mountHomeWidget } = await import("./app");
    mountHomeWidget(container);

    await waitFor(() => {
      expect(container.textContent).toContain("YouTube · tips");
      expect(container.textContent).toContain("Google");
      expect(container.textContent).toContain("ProtonDB");
      expect(container.textContent).toContain("Portal 2");
    });
  });

  it("clicking a chip routes through quick-links::launchUrl", async () => {
    currentGameRef.value = {
      appId: 620,
      gameName: "Portal 2",
      startTime: Date.now(),
    };
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mountHomeWidget } = await import("./app");
    mountHomeWidget(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Google");
    });

    const chip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Google",
    ) as HTMLButtonElement;
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "launchUrl",
        "https://g/?q=Portal%202",
      );
    });
  });

  it("hides steamOnly templates for shortcut appids (top bit set)", async () => {
    currentGameRef.value = {
      appId: 3000000001,
      gameName: "Yuzu",
      startTime: Date.now(),
    };
    rpcFor(baseState);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mountHomeWidget } = await import("./app");
    mountHomeWidget(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Yuzu");
      expect(container.textContent).toContain("Google");
    });
    expect(container.textContent).not.toContain("ProtonDB");
  });
});

describe("BrowserPicker (settings)", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    currentGameRef.value = null;
  });

  const TWO_CANDIDATES = [
    { id: "firefox-native", name: "Firefox", kind: "native", exe: "/usr/bin/firefox", launchOptionsBase: "--new-tab {url}" },
    { id: "chrome-native", name: "Chrome", kind: "native", exe: "/usr/bin/chrome", launchOptionsBase: "{url}" },
  ];

  function rpcWith(state: unknown) {
    callMock.mockImplementation((method: string) => {
      if (method === "getState") return Promise.resolve(state);
      if (method === "isGamingMode") return Promise.resolve(false);
      if (method === "detectBrowsers") return Promise.resolve(TWO_CANDIDATES);
      if (method === "isSteamReachable") return Promise.resolve(true);
      return Promise.resolve(state);
    });
  }

  async function gotoSettings(container: HTMLElement) {
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      const cog = Array.from(container.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === "Quick Links settings",
      );
      expect(cog).toBeTruthy();
    });
    const cog = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Quick Links settings",
    ) as HTMLButtonElement;
    fireEvent.click(cog);
  }

  it("renders one radio per detected browser and no <select> dropdown", async () => {
    rpcWith({ ...baseState, installedBrowsers: [] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await gotoSettings(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Firefox");
      expect(container.textContent).toContain("Chrome");
    });
    expect(container.querySelector("select")).toBeNull();
  });

  it("selecting a browser radio calls setSelectedBrowserId with its id", async () => {
    rpcWith({ ...baseState, installedBrowsers: [] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await gotoSettings(container);
    await waitFor(() => expect(container.textContent).toContain("Chrome"));
    const chromeRadio = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Chrome"),
    ) as HTMLButtonElement;
    fireEvent.click(chromeRadio);
    expect(callMock).toHaveBeenCalledWith("setSelectedBrowserId", "chrome-native");
  });

  it("shows Install button when the selected browser has no shortcut", async () => {
    rpcWith({ ...baseState, installedBrowsers: [], selectedBrowserId: "firefox-native" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await gotoSettings(container);
    await waitFor(() => {
      const btn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Install as non-Steam game"),
      );
      expect(btn).toBeTruthy();
    });
  });

  it("hides Install button when the selected browser is already installed", async () => {
    rpcWith({
      ...baseState,
      selectedBrowserId: "firefox-native",
      installedBrowsers: [
        { browserId: "firefox-native", name: "Firefox", kind: "native", appId: 1, gameId64: "1", exe: "/usr/bin/firefox", launchOptionsBase: "--new-tab {url}" },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await gotoSettings(container);
    await waitFor(() => expect(container.textContent).toContain("Firefox"));
    const installBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Install as non-Steam game"),
    );
    expect(installBtn).toBeUndefined();
  });
});

describe("BrowserPicker on the landing page", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    currentGameRef.value = null;
  });

  function rpcWith(state: unknown) {
    callMock.mockImplementation((method: string) => {
      if (method === "getState") return Promise.resolve(state);
      if (method === "isGamingMode") return Promise.resolve(false);
      if (method === "detectBrowsers")
        return Promise.resolve([
          { id: "firefox-native", name: "Firefox", kind: "native", exe: "/usr/bin/firefox", launchOptionsBase: "--new-tab {url}" },
        ]);
      if (method === "isSteamReachable") return Promise.resolve(true);
      return Promise.resolve(state);
    });
  }

  it("shows the picker on the landing page when no browser is installed", async () => {
    currentGameRef.value = { appId: 620, gameName: "Portal 2", startTime: Date.now() };
    rpcWith({ ...baseState, installedBrowsers: [] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Open links in");
      expect(container.textContent).toContain("Firefox");
    });
  });

  it("hides the picker on the landing page once a browser is installed", async () => {
    currentGameRef.value = { appId: 620, gameName: "Portal 2", startTime: Date.now() };
    rpcWith({
      ...baseState,
      installedBrowsers: [
        { browserId: "firefox-native", name: "Firefox", kind: "native", appId: 1, gameId64: "1", exe: "/usr/bin/firefox", launchOptionsBase: "--new-tab {url}" },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);
    // Landing chips render (templates from baseState), but the picker does not.
    await waitFor(() => expect(container.textContent).toContain("ProtonDB"));
    expect(container.textContent).not.toContain("Open links in");
  });
});
