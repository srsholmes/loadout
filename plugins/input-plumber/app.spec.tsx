/**
 * input-plumber frontend spec.
 *
 * The page renders a single install card whose state derives from the
 * `getStatus` RPC (`installed` / `serviceActive` / `scriptPresent`). The
 * primary button toggles between "Install InputPlumber" / "Reinstall"
 * and dispatches `startInstall`. The backend streams progress through
 * the `install-log` and `install-state` events; the latter flips the
 * button back to "Install" + records the run result.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below, so this holds the real
// module for the partial-mock spread. (bun's mock.module is not hoisted,
// unlike vitest's vi.mock — static imports evaluate first.)
import * as actualUi from "@loadout/ui";
import { waitFor, fireEvent } from "../../test/render";

const callMock = mock((_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown));
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

const notInstalledStatus = {
  installed: false,
  binaryPath: null,
  managedBy: "none",
  version: null,
  serviceActive: false,
  serviceEnabled: false,
  scriptPresent: true,
  summary: "InputPlumber is not installed.",
};

const installedActiveStatus = {
  installed: true,
  binaryPath: "/usr/bin/inputplumber",
  managedBy: "distro",
  version: "0.46.0",
  serviceActive: true,
  serviceEnabled: true,
  scriptPresent: true,
  summary: "InputPlumber is active.",
};

const scriptMissingStatus = {
  ...notInstalledStatus,
  scriptPresent: false,
  summary: "Install script missing from plugin directory.",
};

function rpcFor(status: typeof notInstalledStatus, running = false) {
  callMock.mockImplementation((method: string) => {
    if (method === "getStatus") return Promise.resolve(status);
    if (method === "isInstallRunning") return Promise.resolve({ running });
    if (method === "startInstall") return Promise.resolve({ started: true });
    return Promise.resolve(null);
  });
}

describe("input-plumber plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
  });

  it("renders the 'Not installed' chip when the binary is absent", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Not installed");
      expect(container.textContent).toContain("Install InputPlumber");
    });
  });

  it("renders the 'Active' chip when the service is running", async () => {
    rpcFor(installedActiveStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Active");
      // Already installed → primary button label flips to Reinstall.
      expect(container.textContent).toContain("Reinstall");
      expect(container.textContent).toContain("v0.46.0");
    });
  });

  it("clicking the install button calls startInstall", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Install InputPlumber");
    });

    const installButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Install InputPlumber"),
    );
    expect(installButton).toBeTruthy();
    fireEvent.click(installButton!);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("startInstall");
    });
  });

  it("install-log events stream into the on-screen log pane", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(eventHandlers.has("install-log")).toBe(true);
    });

    eventHandlers.get("install-log")!({ kind: "stdout", text: "==> building hid-oxp\n" });

    await waitFor(() => {
      expect(container.querySelector("pre")?.textContent).toContain("building hid-oxp");
    });
  });

  it("install-state event with success surfaces the duration", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(eventHandlers.has("install-state")).toBe(true);
    });

    eventHandlers.get("install-state")!({
      running: false,
      result: { success: true, exitCode: 0, timedOut: false, durationSeconds: 42 },
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Last run succeeded in 42s");
    });
  });

  it("disables the install button when the install script is missing", async () => {
    rpcFor(scriptMissingStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Install script missing");
    });

    const installButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Install InputPlumber"),
    ) as HTMLButtonElement;
    expect(installButton).toBeTruthy();
    expect(installButton.disabled).toBe(true);
  });
});
