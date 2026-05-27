import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "../../test/render";

const callMock = vi.fn((method: string, ..._args: unknown[]) =>
  Promise.resolve(null as unknown),
);
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

const okList = {
  unavailable: false,
  controllers: [
    {
      hash: 100,
      name: "Steam Deck Controller",
      connected: true,
      disabled: false,
      savedKinds: [],
    },
    {
      hash: 200,
      name: "Xbox Wireless",
      connected: true,
      disabled: false,
      savedKinds: ["xb360"],
    },
  ],
};

describe("disable-controller-input plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "listControllers") return Promise.resolve(okList);
      if (method === "refreshControllers") return Promise.resolve(okList);
      return Promise.resolve({ ok: true });
    });
  });

  it("renders the header", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe(
        "Disable Controller Input",
      );
    });
  });

  it("calls listControllers on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("listControllers");
    });
  });

  it("renders each controller name", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Steam Deck Controller");
      expect(container.textContent).toContain("Xbox Wireless");
    });
  });

  it("shows the lockout-recovery warning", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain(
        "keyboard, mouse, or touchscreen",
      );
    });
  });

  it("renders the unavailable banner when InputPlumber is missing", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "listControllers") {
        return Promise.resolve({ unavailable: true, controllers: [] });
      }
      return Promise.resolve({ ok: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("InputPlumber not detected");
    });
  });
});
