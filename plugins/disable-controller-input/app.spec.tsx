/**
 * disable-controller-input app spec.
 *
 * Tests the overlay UI: header, initial data fetch, the device-row
 * rendering, the lockout-recovery warning, and the unavailable banner
 * when InputPlumber is missing.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below — bun's mock.module is not
// hoisted like vitest's vi.mock, so we need the real module first.
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";

const callMock = mock((method: string, ..._args: unknown[]) => {
  void method;
  void _args;
  return Promise.resolve(null as unknown);
});
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: { children: React.ReactNode }) => children,
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
}));

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
