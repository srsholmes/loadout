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

beforeEach(() => {
  vi.clearAllMocks();
  eventHandlers.clear();
  callMock.mockImplementation((method: string) => {
    if (method === "isInstalled") return Promise.resolve(true);
    if (method === "getConfig")
      return Promise.resolve({ fps: "1", gpu_stats: "1", position: "top-left" });
    if (method === "getPresets")
      return Promise.resolve([
        { name: "minimal", label: "Minimal", config: { fps: "1" } },
        { name: "full", label: "Full", config: { fps: "1", gpu_stats: "1", cpu_stats: "1" } },
      ]);
    return Promise.resolve(null);
  });
});

describe("mangohud-tweaks plugin", () => {
  it("mounts and renders the header", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() =>
      expect(container.textContent).toContain("MangoHud Tweaks"),
    );
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
});
