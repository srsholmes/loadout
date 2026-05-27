import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, waitFor } from "../../test/render";

const callMock = vi.fn((method: string, ..._args: unknown[]) =>
  Promise.resolve(null as unknown),
);
const eventHandlers = new Map<string, (data: unknown) => void>();

vi.mock("@loadout/ui", async () => {
  const actual = (await vi.importActual("@loadout/ui")) as Record<
    string,
    unknown
  >;
  const { PluginHeaderSlotProvider } = actual as {
    PluginHeaderSlotProvider: (props: any) => any;
  };
  return {
    ...actual,
    // Stripped-down PluginProvider that wires the headerSlot through to
    // PluginHeaderSlotProvider so `<PluginHeader>` portals correctly.
    PluginProvider: ({ children, headerSlot }: any) => (
      <PluginHeaderSlotProvider slot={headerSlot ?? null}>
        {children}
      </PluginHeaderSlotProvider>
    ),
    useBackend: () => ({
      call: callMock,
      useEvent: ({ event, handler }: any) => {
        eventHandlers.set(event, handler);
      },
      ready: true,
    }),
  };
});

const installedStatus = {
  install: {
    installed: true,
    layerSoExists: true,
    layerJsonExists: true,
    wrapperExists: true,
    wrapperPath: "/home/user/lsfg",
    wrapperToken: "lsfg",
    layerSoPath: "/home/user/.local/lib/liblsfg-vk.so",
    layerJsonPath:
      "/home/user/.local/share/vulkan/implicit_layer.d/VkLayer_LS_frame_generation.json",
    tomlPath: "/home/user/.config/lsfg-vk/conf.toml",
  },
  dll: {
    found: true,
    path: "/home/user/.local/share/Steam/steamapps/common/Lossless Scaling/Lossless.dll",
    isCustom: false,
  },
  settings: {
    multiplier: 2,
    flow_scale: 0.8,
    performance_mode: false,
    hdr_mode: false,
    experimental_present_mode: "fifo",
    verbose_logging: false,
  },
  customDllPath: null,
  launchOptions: "/home/user/lsfg %command%",
};

const notInstalledStatus = {
  ...installedStatus,
  install: {
    ...installedStatus.install,
    installed: false,
    layerSoExists: false,
    layerJsonExists: false,
    wrapperExists: false,
  },
  dll: { found: false, path: null, isCustom: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  eventHandlers.clear();
  callMock.mockImplementation((method: string) => {
    if (method === "getStatus") return Promise.resolve(installedStatus);
    return Promise.resolve(null);
  });
});

function createContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

/** Click the "Plugin preferences" gear icon to switch into settings view. */
async function enterSettingsView(headerSlot: HTMLElement): Promise<void> {
  await waitFor(() => {
    const gear = headerSlot.querySelector(
      '[aria-label="Plugin preferences"]',
    ) as HTMLButtonElement | null;
    expect(gear).not.toBeNull();
  });
  const gear = headerSlot.querySelector(
    '[aria-label="Plugin preferences"]',
  ) as HTMLButtonElement;
  fireEvent.click(gear);
}

describe("lsfg-vk plugin UI", () => {
  it("mountHeader is a stub that returns an unmount function", async () => {
    const { mountHeader } = await import("./app");
    const unmount = mountHeader();
    expect(typeof unmount).toBe("function");
  });

  it("portals the dynamic header (LSFG-VK title) into the supplied slot", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(headerSlot.querySelector("h1")?.textContent).toBe("LSFG-VK");
    });
  });

  it("settings view shows the Installed chip when the layer is on disk", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() => expect(container.textContent).toContain("Installed"));
  });

  it("settings view shows the multiplier segment buttons including Off", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() => {
      expect(container.textContent).toContain("Off");
      expect(container.textContent).toContain("2×");
      expect(container.textContent).toContain("3×");
      expect(container.textContent).toContain("4×");
    });
  });

  it("settings view shows the present-mode select with FIFO labelled as default", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() => {
      expect(container.textContent).toContain("Present Mode");
      expect(container.textContent).toContain("FIFO");
    });
  });

  it("settings view renders the ~/lsfg %command% launch string", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() =>
      expect(container.textContent).toContain("/home/user/lsfg %command%"),
    );
  });

  it("default view shows the install prompt when the layer is missing", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(notInstalledStatus);
      return Promise.resolve(null);
    });
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await waitFor(() => {
      expect(container.textContent).toContain("LSFG-VK is not installed");
    });
  });
});
