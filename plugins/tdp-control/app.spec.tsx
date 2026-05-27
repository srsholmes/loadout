import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "../../test/render";

const callMock = vi.fn((method: string) => Promise.resolve(null));
const eventHandlers = new Map<string, (data: unknown) => void>();

vi.mock("@loadout/ui", async () => {
  const actual = await vi.importActual("@loadout/ui");
  return {
    ...actual,
    PluginProvider: ({ children }: any) => children,
    useBackend: () => ({
      call: callMock,
      useEvent: ({ event, handler }: any) => {
        eventHandlers.set(event, handler);
      },
      ready: true,
    }),
  };
});

const mockTdpInfo = {
  currentTdp: 15,
  tdpReadSource: "read" as const,
  minWatts: 5,
  maxWatts: 30,
  platform: "generic",
  deviceName: "Steam Deck",
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
};

describe("tdp-control plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getTdpInfo") return Promise.resolve(mockTdpInfo);
      return Promise.resolve(null);
    });
  });

  it("mounts and renders the heading", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("TDP Control");
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
});
