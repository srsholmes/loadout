/**
 * mangohud-tweaks app spec.
 *
 * Mocks `useBackend` so the component renders against canned RPC
 * responses (no real loader / no WebSocket). Then asserts the UI
 * surfaces preserved from the source plugin's spec:
 *   - "MangoHud Tweaks" header
 *   - installed/not-installed chip
 *   - preset segmented control
 *   - position picker
 *   - metric chip grid
 *   - reset button
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs — bun's mock.module is not hoisted
// like vitest's vi.mock, so we need the real module first.
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";

const callMock = mock((method: string) => {
  void method;
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

beforeEach(() => {
  callMock.mockReset();
  eventHandlers.clear();
  callMock.mockImplementation((method: string) => {
    if (method === "isInstalled") return Promise.resolve(true);
    if (method === "getConfig")
      return Promise.resolve({
        fps: "1",
        gpu_stats: "1",
        position: "top-left",
      });
    if (method === "getPresets")
      return Promise.resolve([
        { name: "minimal", label: "Minimal", config: { fps: "1" } },
        {
          name: "full",
          label: "Full",
          config: { fps: "1", gpu_stats: "1", cpu_stats: "1" },
        },
      ]);
    return Promise.resolve(null);
  });
});

describe("mangohud-tweaks plugin", () => {
  it("mounts and renders the header", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.textContent).toContain("MangoHud Tweaks");
    });
  });

  it("shows MangoHud as installed", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => expect(container.textContent).toContain("Installed"));
  });

  it("displays preset buttons", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Minimal");
      expect(container.textContent).toContain("Full");
    });
  });

  it("displays position selector buttons", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Top Left");
      expect(container.textContent).toContain("Bottom Right");
    });
  });

  it("displays toggle options for overlay metrics", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("FPS Counter");
      expect(container.textContent).toContain("GPU Stats");
      expect(container.textContent).toContain("CPU Stats");
      expect(container.textContent).toContain("RAM Usage");
    });
  });

  it("shows Reset to Defaults button", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() =>
      expect(container.textContent).toContain("Reset to Defaults"),
    );
  });

  it("registers configChanged event handler on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("configChanged")).toBe(true);
    });
  });
});
