import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below — bun's mock.module is not
// hoisted like vitest's vi.mock, so we need the real module first.
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";

const callMock = mock(
  (_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown),
);
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: { children: React.ReactNode }) => children,
  // PluginHeader portals into a loader-allocated topbar slot that
  // doesn't exist in happy-dom. Render children inline so header
  // controls (cog, back button) are reachable in assertions.
  PluginHeader: ({ children }: { children: React.ReactNode }) => children,
  HeaderBackButton: ({
    onBack,
    title,
  }: {
    onBack?: () => void;
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
    onClick?: () => void;
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
  useFocusable: () => ({ ref: () => {}, focused: false }),
  notify: () => {},
}));

const mockGames = [
  {
    id: "sm64-decomp",
    name: "Super Mario 64 (PC)",
    project: "sm64-port",
    platform: "n64",
    description: "Native PC build of SM64.",
    installType: "build_from_source",
    tags: ["decomp"],
    hasUpdate: false,
    gameStatus: "available",
    hasNativeBuild: true,
    addedToSteam: false,
  },
  {
    id: "oot-decomp",
    name: "Zelda: Ocarina of Time (PC)",
    project: "Ship of Harkinian",
    platform: "n64",
    description: "Native PC port.",
    installType: "build_from_source",
    tags: ["decomp"],
    hasUpdate: false,
    gameStatus: "available",
    hasNativeBuild: true,
    addedToSteam: false,
  },
];

const mockSettings = {
  autoAddToSteam: false,
  updateCheckInterval: 86400,
};

beforeEach(() => {
  callMock.mockReset();
  eventHandlers.clear();
  callMock.mockImplementation((method: string) => {
    if (method === "getGames") return Promise.resolve(mockGames);
    if (method === "getSettings") return Promise.resolve(mockSettings);
    if (method === "getCatalogArt") return Promise.resolve(null);
    if (method === "checkBuildEnv")
      return Promise.resolve({
        ok: true,
        label: "host",
        missing: [],
        hasRecipe: true,
      });
    return Promise.resolve(null);
  });
});

describe("recomp plugin app", () => {
  it("exports mount and mountHeader", async () => {
    const mod = await import("./app");
    expect(typeof mod.mount).toBe("function");
    expect(typeof mod.mountHeader).toBe("function");
  });

  it("mountHeader returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const container = document.createElement("div");
    const unmount = mountHeader(container);
    expect(typeof unmount).toBe("function");
    unmount();
  });

  it("mounts the catalog and calls getGames", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    const unmount = mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getGames");
    });
    unmount();
  });

  it("renders the RecompHub heading after games load", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    const unmount = mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("RecompHub");
    });
    unmount();
  });

  it("displays game names from the catalog", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    const unmount = mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Super Mario 64");
      expect(container.textContent).toContain("Ocarina of Time");
    });
    unmount();
  });

  it("subscribes to pipelineEvent for install progress", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    const unmount = mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("pipelineEvent")).toBe(true);
    });
    unmount();
  });
});
