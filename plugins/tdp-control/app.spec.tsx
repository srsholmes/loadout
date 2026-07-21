import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below, so this holds the real
// module for the partial-mock spread. (bun's mock.module is not hoisted,
// unlike vitest's vi.mock — static imports evaluate first.)
import * as actualUi from "@loadout/ui";
import { waitFor, fireEvent } from "../../test/render";

const callMock = mock((_method: string) => Promise.resolve(null) as Promise<unknown>);
const eventHandlers = new Map<string, (data: unknown) => void>();

let currentGameValue: { appId: number; gameName: string } | null = null;

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: any) => children,
  // PluginHeader normally portals into the loader-allocated topbar slot,
  // which doesn't exist in tests — render its children inline instead.
  PluginHeader: ({ children }: any) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: any) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
  useCurrentGame: () => currentGameValue,
}));

const mockTdpInfo = {
  currentTdp: 15,
  tdpReadSource: "read" as const,
  minWatts: 5,
  maxWatts: 30,
  pluggedMaxWatts: 30,
  batteryMaxWatts: 25,
  platform: "generic",
  deviceName: "Steam Deck",
  usingCustomDevice: false,
  method: "ryzenadj",
  profiles: { silent: 8, balanced: 15, performance: 25 },
  activeProfile: "balanced",
  cpuVendor: "AMD",
  cpuModel: "AMD Custom APU 0405",
  scalingDriver: "amd-pstate-epp",
  platformProfile: null,
  platformProfileChoices: [],
  eppOptions: ["performance", "balance_performance", "balance_power", "power"],
  currentEpp: "balance_performance",
  governorOptions: ["performance", "powersave"],
  currentGovernor: "powersave",
  supportsSmt: true,
  supportsCpuBoost: true,
  cpuBoostEnabled: false,
  cpuBoostSetting: false,
};

describe("tdp-control plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    currentGameValue = null;
    callMock.mockImplementation((method: string) => {
      if (method === "getTdpInfo") return Promise.resolve(mockTdpInfo);
      return Promise.resolve(null);
    });
  });

  it("mounts and renders the heading", async () => {
    // The header is now portaled from the main mount() via <PluginHeader>
    // (mounted inline by the mock above); mountHeader is a stub.
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("TDP Control");
    });
  });

  it("CPU Boost toggle reflects the enforced setting and calls setCpuBoost flipped", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getTdpInfo") return Promise.resolve(mockTdpInfo);
      if (method === "setCpuBoost") return Promise.resolve({ success: true });
      return Promise.resolve(null);
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("CPU Boost");
    });
    const section = Array.from(container.querySelectorAll(".subsection")).find(
      (s) =>
        s.querySelector(".subsection-label")?.textContent?.includes("CPU Boost"),
    );
    expect(section).toBeDefined();
    const toggle = section!.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(toggle).toBeDefined();
    // mock cpuBoostSetting is false (the enforced default)
    expect(toggle.checked).toBe(false);
    toggle.click();
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("setCpuBoost", true);
    });
  });

  it("opens the custom-device form from the header gear and returns via Back", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    // Landing view: TDP controls are shown, the custom-device form is not.
    await waitFor(() => {
      expect(container.textContent).toContain("15W");
    });
    expect(container.textContent).not.toContain("CUSTOM DEVICE");

    // The header gear opens the settings sub-view holding the form.
    const gear = container.querySelector(
      '[aria-label="Custom device settings"]',
    ) as HTMLButtonElement;
    expect(gear).toBeTruthy();
    fireEvent.click(gear);

    await waitFor(() => {
      expect(container.textContent).toContain("CUSTOM DEVICE");
      expect(container.textContent).toContain("Device name");
    });

    // The back button returns to the landing (TDP controls) view.
    const back = container.querySelector(
      '[aria-label="Back to TDP Control"]',
    ) as HTMLButtonElement;
    expect(back).toBeTruthy();
    fireEvent.click(back);

    await waitFor(() => {
      expect(container.textContent).not.toContain("CUSTOM DEVICE");
      expect(container.textContent).toContain("15W");
    });
  });

  it("calls getTdpInfo on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getTdpInfo");
    });
  });

  it("displays current TDP value", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("15W");
    });
  });

  it("displays device name", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Steam Deck");
    });
  });

  it("displays preset profile buttons", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("silent");
      expect(container.textContent).toContain("balanced");
      expect(container.textContent).toContain("performance");
    });
  });

  it("displays TDP method", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("RyzenAdj");
    });
  });

  it("registers tdpChanged event handler", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("tdpChanged")).toBe(true);
    });
  });

  it("displays CPU model info", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("AMD Custom APU 0405");
    });
  });

  describe("per-game profile grid (#105)", () => {
    const profiles = [
      { appId: 1145360, gameName: "Hades", tdpWatts: 12 },
      { appId: 391540, gameName: "Undertale", tdpWatts: 8 },
    ];

    beforeEach(() => {
      callMock.mockImplementation((method: string) => {
        if (method === "getTdpInfo") return Promise.resolve(mockTdpInfo);
        if (method === "getPerGameEnabled") return Promise.resolve(true);
        if (method === "getGameProfiles") return Promise.resolve(profiles);
        if (method === "getGameDefaultTdp") return Promise.resolve(15);
        return Promise.resolve(null);
      });
    });

    it("renders a cover card per saved profile with its TDP badge", async () => {
      const container = document.createElement("div");
      const { mount } = await import("./app");
      mount(container);
      await waitFor(() => {
        expect(container.textContent).toContain("Hades");
        expect(container.textContent).toContain("Undertale");
        // each saved TDP shows as a badge
        expect(container.textContent).toContain("12W");
        expect(container.textContent).toContain("8W");
      });
      // cover art is rendered via the capsule artwork URL
      const imgs = Array.from(container.querySelectorAll("img"));
      expect(
        imgs.some((i) => i.getAttribute("src")?.includes("/steam-grid/1145360")),
      ).toBe(true);
    });

    it("calls removeGameProfile(appId) when a card's Remove is clicked", async () => {
      const container = document.createElement("div");
      const { mount } = await import("./app");
      mount(container);
      await waitFor(() => {
        expect(container.textContent).toContain("Hades");
      });
      const removeBtn = Array.from(
        container.querySelectorAll("button"),
      ).find((b) => b.textContent?.trim() === "Remove");
      expect(removeBtn).toBeDefined();
      removeBtn!.click();
      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("removeGameProfile", 1145360);
      });
    });

    it("is controller-activatable: the card tile carries the remove handler (onPick)", async () => {
      // GameCard registers the whole tile as the spatial-nav focusable and
      // fires onPick on controller A / Enter. We wire onPick to the same
      // remove handler, so the card must be an interactive role=button and
      // activating it removes the profile (what A does on-device).
      const container = document.createElement("div");
      const { mount } = await import("./app");
      mount(container);
      await waitFor(() => {
        expect(container.textContent).toContain("Hades");
      });
      const card = Array.from(
        container.querySelectorAll('[role="button"]'),
      ).find((el) => el.textContent?.includes("Hades"));
      expect(card).toBeDefined();
      (card as HTMLElement).click();
      await waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("removeGameProfile", 1145360);
      });
    });
  });
});
