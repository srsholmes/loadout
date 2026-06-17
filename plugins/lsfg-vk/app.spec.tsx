import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below — bun's mock.module is not
// hoisted like vitest's vi.mock, so we need the real module first.
import * as actualUi from "@loadout/ui";
import { fireEvent, waitFor } from "../../test/render";

const callMock = mock((method: string, ..._args: unknown[]) => {
  void method;
  return Promise.resolve(null as unknown);
});
const eventHandlers = new Map<string, (data: unknown) => void>();

const { PluginHeaderSlotProvider } = actualUi as unknown as {
  PluginHeaderSlotProvider: (props: {
    slot: HTMLElement | null;
    children: React.ReactNode;
  }) => React.ReactNode;
};

mock.module("@loadout/ui", () => ({
  ...actualUi,
  // Stripped-down PluginProvider that wires the headerSlot through to
  // PluginHeaderSlotProvider so `<PluginHeader>` portals correctly.
  PluginProvider: ({
    children,
    headerSlot,
  }: {
    children: React.ReactNode;
    headerSlot?: HTMLElement | null;
  }) => (
    <PluginHeaderSlotProvider slot={headerSlot ?? null}>
      {children}
    </PluginHeaderSlotProvider>
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
}));

const installedStatus = {
  install: {
    installed: true,
    layerSoExists: true,
    layerJsonExists: true,
    wrapperExists: true,
    wrapperPath: "/home/user/lsfg",
    wrapperToken: "~/lsfg",
    layerSoPath: "/home/user/.local/lib/liblsfg-vk.so",
    layerJsonPath:
      "/home/user/.local/share/vulkan/implicit_layer.d/VkLayer_LS_frame_generation.json",
    tomlPath: "/home/user/.config/lsfg-vk/conf.toml",
    layerVersion: "latest",
    installedVersion: "v1.0.0",
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
  launchOptions: "~/lsfg %command%",
};

const notInstalledStatus = {
  ...installedStatus,
  install: {
    ...installedStatus.install,
    installed: false,
    layerSoExists: false,
    layerJsonExists: false,
    wrapperExists: false,
    installedVersion: null,
  },
  dll: { found: false, path: null, isCustom: false },
};

beforeEach(() => {
  callMock.mockReset();
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
      expect(container.textContent).toContain("~/lsfg %command%"),
    );
  });

  it("settings view re-runs getStatus when the Re-check button is clicked", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);

    await waitFor(() => expect(container.textContent).toContain("Re-check"));
    const callsBefore = callMock.mock.calls.filter(
      (c) => c[0] === "getStatus",
    ).length;

    const recheckBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Re-check",
    ) as HTMLButtonElement;
    expect(recheckBtn).toBeDefined();
    fireEvent.click(recheckBtn);

    await waitFor(() => {
      const callsAfter = callMock.mock.calls.filter(
        (c) => c[0] === "getStatus",
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("not-installed picker view offers a Re-check that re-runs getStatus", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(notInstalledStatus);
      return Promise.resolve(null);
    });
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });

    await waitFor(() =>
      expect(container.textContent).toContain("Re-check installation"),
    );
    const callsBefore = callMock.mock.calls.filter(
      (c) => c[0] === "getStatus",
    ).length;

    const recheckBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Re-check installation",
    ) as HTMLButtonElement;
    fireEvent.click(recheckBtn);

    await waitFor(() => {
      const callsAfter = callMock.mock.calls.filter(
        (c) => c[0] === "getStatus",
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("settings view exposes the layer-version selector with the installed version", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);
    await waitFor(() => {
      expect(container.textContent).toContain("Layer version");
      expect(container.textContent).toContain("Installed: v1.0.0");
    });
  });

  it("selecting a layer version calls setLayerVersion on the backend", async () => {
    const container = createContainer();
    const headerSlot = document.createElement("div");
    document.body.appendChild(headerSlot);
    const { mount } = await import("./app");
    mount(container, { headerSlot });
    await enterSettingsView(headerSlot);

    // Open the custom Select (button trigger showing the current "Latest"
    // label), then click the "Compatibility" option row.
    await waitFor(() =>
      expect(container.textContent).toContain("Layer version"),
    );
    const trigger = Array.from(
      container.querySelectorAll('button[aria-haspopup="listbox"]'),
    )[0] as HTMLButtonElement;
    expect(trigger).toBeDefined();
    fireEvent.click(trigger);

    let compatRow: HTMLElement | undefined;
    await waitFor(() => {
      compatRow = Array.from(
        container.querySelectorAll('[role="option"]'),
      ).find((el) =>
        el.textContent?.includes("Compatibility"),
      ) as HTMLElement | undefined;
      expect(compatRow).toBeDefined();
    });
    fireEvent.click(compatRow!);

    await waitFor(() => {
      expect(
        callMock.mock.calls.some(
          (c) => c[0] === "setLayerVersion" && c[1] === "compat",
        ),
      ).toBe(true);
    });
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
