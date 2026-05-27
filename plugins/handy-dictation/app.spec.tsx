/**
 * handy-dictation frontend spec.
 *
 * The page is a state machine driven by `getStatus` / `getConfig`:
 *
 *   - !installed              → "Install Handy" button (calls installHandy)
 *   - installed, !configured  → first-time setup card (Launch + I'm done)
 *   - installed,  configured  → dictation card + Start/Stop Handy controls
 *
 * Toggling Handy's process fires `startHandy` or `stopHandy`. We mock
 * `useBackend` so each test controls the RPC return values and asserts
 * which backend method the UI fanned out to.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as UiModule from "@loadout/ui";
import { waitFor, fireEvent } from "../../test/render";

const callMock = vi.fn((_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown));
const eventHandlers = new Map<string, (data: unknown) => void>();

vi.mock("@loadout/ui", async () => {
  const actual = await vi.importActual<typeof UiModule>("@loadout/ui");
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

const baseConfig = { startHidden: false, autostartOnLoad: true };

const notInstalledStatus = {
  installed: false,
  appImagePath: null,
  installedVersion: null,
  running: false,
  setupComplete: false,
  missingSystemDeps: [],
  settings: { microphone: null, model: null, configured: false },
};

const installedNotConfiguredStatus = {
  ...notInstalledStatus,
  installed: true,
  appImagePath: "/home/me/.local/share/loadout/handy-dictation/bin/handy.AppImage",
  installedVersion: "0.4.2",
  running: false,
  setupComplete: false,
  settings: { microphone: null, model: null, configured: false },
};

const installedRunningStatus = {
  ...installedNotConfiguredStatus,
  running: true,
  setupComplete: true,
  settings: { microphone: "Built-in Audio", model: "whisper-small.en", configured: true },
};

const installedIdleStatus = {
  ...installedRunningStatus,
  running: false,
};

function rpcFor(status: typeof notInstalledStatus) {
  callMock.mockImplementation((method: string) => {
    if (method === "getStatus") return Promise.resolve(status);
    if (method === "getConfig") return Promise.resolve(baseConfig);
    if (method === "installHandy") return Promise.resolve({ success: true });
    if (method === "uninstallHandy") return Promise.resolve({ success: true });
    if (method === "startHandy") return Promise.resolve({ success: true });
    if (method === "stopHandy") return Promise.resolve({ success: true });
    if (method === "toggleDictation") return Promise.resolve({ success: true });
    if (method === "launchHandyGui") return Promise.resolve({ success: true });
    return Promise.resolve(null);
  });
}

describe("handy-dictation plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
  });

  it("shows 'Install Handy' when the AppImage is missing", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Not installed");
      const installButton = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Install Handy"),
      );
      expect(installButton).toBeTruthy();
    });
  });

  it("clicking Install Handy calls installHandy", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Install Handy");
    });

    const installButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Install Handy"),
    );
    fireEvent.click(installButton!);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("installHandy");
    });
  });

  it("renders first-time setup card when installed but not configured", async () => {
    rpcFor(installedNotConfiguredStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("First-time setup");
      expect(container.textContent).toContain("Launch Handy for Setup");
    });
  });

  it("shows Running chip and Stop Handy button when status.running is true", async () => {
    rpcFor(installedRunningStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Running");
      const stopButton = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Stop Handy"),
      );
      expect(stopButton).toBeTruthy();
    });
  });

  it("clicking Stop Handy calls stopHandy", async () => {
    rpcFor(installedRunningStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Stop Handy");
    });

    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Stop Handy"),
    );
    fireEvent.click(stopButton!);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("stopHandy");
    });
  });

  it("clicking Start Handy (idle, configured) calls startHandy", async () => {
    rpcFor(installedIdleStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Start Handy");
    });

    const startButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim().startsWith("Start Handy"),
    );
    fireEvent.click(startButton!);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("startHandy");
    });
  });

  it("mountHeader renders the Dictation heading", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Dictation");
    });
  });
});
