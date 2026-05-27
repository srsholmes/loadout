import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as UiModule from "@loadout/ui";
import { fireEvent, waitFor } from "../../test/render";

// All useBackend("quick-links") calls go through this mock. Previous
// versions of this spec had a second mock for "gaming-mode-browser";
// after #121 those calls all route through quick-links itself, so we
// only need the single backend.
const callMock = vi.fn(
  (_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown),
);
const eventHandlers = new Map<string, (data: unknown) => void>();
const currentGameRef: { value: { appId: number; gameName: string; startTime: number } | null } = {
  value: null,
};

vi.mock("@loadout/ui", async () => {
  const actual = await vi.importActual<typeof UiModule>("@loadout/ui");
  return {
    ...actual,
    PluginProvider: ({ children }: any) => children,
    // PluginHeader normally portals into the loader-allocated topbar
    // slot, which doesn't exist in jsdom. Render its children inline
    // so test assertions can find header-rendered controls (cog,
    // back button) by traversing the test container.
    PluginHeader: ({ children }: any) => children,
    HeaderBackButton: ({ onBack, title }: any) => (
      <button type="button" aria-label={title ?? "Back"} onClick={onBack}>
        Back
      </button>
    ),
    IconButton: ({ children, onClick, ariaLabel }: any) => (
      <button type="button" aria-label={ariaLabel} onClick={onClick}>
        {children}
      </button>
    ),
    useBackend: () => ({
      call: callMock,
      useEvent: ({ event, handler }: any) => {
        eventHandlers.set(event, handler);
      },
      ready: true,
    }),
    useCurrentGame: () => currentGameRef.value,
    useFocusable: () => ({ ref: () => {}, focused: false }),
    notify: () => {},
  };
});

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

  it("renders one card per visible template (suffix-expanded) with the URL host visible, when a game is running", async () => {
    currentGameRef.value = {
      appId: 620,
      gameName: "Portal 2",
      startTime: Date.now(),
    };
    rpcFor(baseState);
    const container = document.createElement("div");
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
    await mountAndOpenSettings(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Browser shortcut");
    });
  });

  it("Reset button dispatches resetToDefaults", async () => {
    rpcFor(baseState);
    const container = document.createElement("div");
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
    const { mountHomeWidget } = await import("./app");
    mountHomeWidget(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Yuzu");
      expect(container.textContent).toContain("Google");
    });
    expect(container.textContent).not.toContain("ProtonDB");
  });
});
