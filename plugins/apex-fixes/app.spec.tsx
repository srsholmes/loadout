/**
 * apex-fixes frontend spec.
 *
 * The plugin renders one card per fix (oxpec / lightSleep / sleepEnable /
 * xhciRecovery). Each card surfaces `Apply` / `Revert` / `Reapply`
 * buttons that fan out to the backend RPCs `applyFix(key)` /
 * `revertFix(key)`; the xHCI card has an extra `Rebind now` action that
 * calls `rebindXhciNow`. When the backend reports `success:false`, the
 * page shows a red error banner.
 *
 * We mock `useBackend` so the spec controls every RPC return value, then
 * drive the UI synchronously through the page's own click handlers.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ReactNode } from "react";
// Captured BEFORE mock.module() runs below, so this holds the real
// module for the partial-mock spread. (bun's mock.module is not hoisted,
// unlike vitest's vi.mock — static imports evaluate first.)
import * as actualUi from "@loadout/ui";
import { waitFor, fireEvent } from "../../test/render";

const callMock = mock((_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown));
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: { children?: ReactNode }) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: { event: string; handler: (data: unknown) => void }) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

const apexStatus = {
  deviceModel: "ONEXPLAYER ONEXPLAYER X1",
  isApex: true,
  fixes: {
    oxpec: { key: "oxpec", state: "not_applied", rebootRequired: false, details: "module not loaded" },
    lightSleep: { key: "lightSleep", state: "applied", rebootRequired: false, details: "s2idle present in /proc/cmdline" },
    sleepEnable: { key: "sleepEnable", state: "partial", rebootRequired: false, details: "udev rule present, fw-fanctrl-suspend still on disk" },
    xhciRecovery: { key: "xhciRecovery", state: "not_applied", rebootRequired: false, details: "service not installed" },
  },
};

const nonApexStatus = {
  deviceModel: "Generic PC",
  isApex: false,
  fixes: apexStatus.fixes,
};

function defaultRpc() {
  callMock.mockImplementation((method: string, ..._args: unknown[]) => {
    if (method === "getStatus") return Promise.resolve(apexStatus);
    if (method === "applyFix") return Promise.resolve({ success: true, steps: ["loaded module"] });
    if (method === "revertFix") return Promise.resolve({ success: true, steps: ["unloaded module"] });
    if (method === "rebindXhciNow") return Promise.resolve({ success: true, gamepadPresent: true, attempts: 1 });
    return Promise.resolve(null);
  });
}

describe("apex-fixes plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    defaultRpc();
  });

  it("renders one card per fix once getStatus resolves", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Fan EC Driver");
      expect(container.textContent).toContain("Light Sleep");
      expect(container.textContent).toContain("Sleep Enable");
      expect(container.textContent).toContain("xHCI Recovery");
    });
  });

  it("shows the not-on-APEX panel when isApex is false", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(nonApexStatus);
      return Promise.resolve(null);
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Not on APEX hardware");
      expect(container.textContent).toContain("Generic PC");
    });
  });

  it("clicking Apply on the oxpec card calls applyFix('oxpec')", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Fan EC Driver");
    });

    // First "Apply" button is on the first not-applied fix (oxpec).
    const applyButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Apply",
    );
    expect(applyButton).toBeTruthy();
    fireEvent.click(applyButton!);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("applyFix", "oxpec");
    });
  });

  it("clicking Revert on the lightSleep card calls revertFix('lightSleep')", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Light Sleep");
    });

    // lightSleep is the only applied fix → its card renders "Revert".
    const revertButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Revert",
    );
    expect(revertButton).toBeTruthy();
    fireEvent.click(revertButton!);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("revertFix", "lightSleep");
    });
  });

  it("surfaces the backend error when applyFix returns success:false", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(apexStatus);
      if (method === "applyFix")
        return Promise.resolve({ success: false, steps: [], error: "i2c bus stuck" });
      return Promise.resolve(null);
    });

    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Fan EC Driver");
    });

    const applyButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Apply",
    );
    fireEvent.click(applyButton!);

    await waitFor(() => {
      expect(container.textContent).toContain("apply failed: i2c bus stuck");
    });
  });

  it("Rebind now triggers rebindXhciNow and surfaces success", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("xHCI Recovery");
    });

    const rebindButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Rebind now"),
    );
    expect(rebindButton).toBeTruthy();
    fireEvent.click(rebindButton!);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("rebindXhciNow");
      expect(container.textContent).toContain("Gamepad recovered after 1 attempt");
    });
  });

  it("mountHeader renders the Apex Fixes heading and applied count", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Apex Fixes");
      // One of four fixes is applied in the fixture.
      expect(container.textContent).toContain("1 of 4 applied");
    });
  });
});
