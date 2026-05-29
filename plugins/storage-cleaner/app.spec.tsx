/**
 * storage-cleaner app spec.
 *
 * Tests the overlay UI: header, initial data fetch, disk summary,
 * cleanable rows, and the Clear button.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below — bun's mock.module is not
// hoisted like vitest's vi.mock, so we need the real module first.
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";

const callMock = mock((method: string, ..._args: unknown[]) => {
  void method;
  void _args;
  return Promise.resolve(null);
});
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: { children: React.ReactNode }) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: { event: string; handler: (data: unknown) => void }) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

const mockDiskUsage = [
  {
    filesystem: "/dev/sda1",
    size: "500G",
    used: "200G",
    available: "300G",
    usePercent: "40%",
    mountpoint: "/",
  },
];

const mockShaderCache = {
  total: 1073741824,
  totalFormatted: "1.0 GB",
  games: [
    { appId: "730", name: "Counter-Strike 2", sizeBytes: 536870912, sizeFormatted: "512 MB" },
    { appId: "570", name: "Dota 2", sizeBytes: 536870912, sizeFormatted: "512 MB" },
  ],
};

const mockCompatData = {
  total: 2147483648,
  totalFormatted: "2.0 GB",
  games: [
    { appId: "730", name: "Counter-Strike 2", sizeBytes: 1073741824, sizeFormatted: "1.0 GB" },
  ],
};

const mockOrphanedData = {
  total: 0,
  totalFormatted: "0 B",
  entries: [],
};

describe("storage-cleaner plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getDiskUsage") return Promise.resolve(mockDiskUsage);
      if (method === "getShaderCacheSize") return Promise.resolve(mockShaderCache);
      if (method === "getCompatDataSize") return Promise.resolve(mockCompatData);
      if (method === "getOrphanedData") return Promise.resolve(mockOrphanedData);
      return Promise.resolve(null);
    });
  });

  it("mounts and renders the heading", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Storage");
    });
  });

  it("calls getDiskUsage on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getDiskUsage");
    });
  });

  it("calls getShaderCacheSize on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getShaderCacheSize");
    });
  });

  it("displays disk mountpoint", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("/");
    });
  });

  it("displays disk usage percentage", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("40%");
    });
  });

  it("groups shader caches into a single all-games row", async () => {
    // The UI shows "Shader precache (all)" with a game count rather
    // than per-game rows.
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Shader precache");
      expect(container.textContent).toContain("2 games");
    });
  });

  it("displays shader cache total size", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("1.00 GB");
    });
  });

  it("shows Clear button(s)", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      const buttons = container.querySelectorAll("button");
      const texts = Array.from(buttons).map((b) => b.textContent?.trim());
      expect(texts.some((t) => t === "Clear")).toBe(true);
    });
  });
});
