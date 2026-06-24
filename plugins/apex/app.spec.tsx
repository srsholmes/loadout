/**
 * Apex app spec.
 *
 * Tests the overlay UI: header, initial status fetch, the healthy vs
 * missing-controller alert, the recover button wiring, and the
 * not-on-Apex banner.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import * as actualUi from "@loadout/ui";
import { waitFor, fireEvent } from "../../test/render";

const callMock = mock((method: string, ..._args: unknown[]) => {
  void method;
  void _args;
  return Promise.resolve(null as unknown);
});
const eventHandlers = new Map<string, (data: unknown) => void>();
const notifyMock = mock((_msg: string, _opts?: unknown) => {
  void _msg;
  void _opts;
});

mock.module("@loadout/ui", () => ({
  ...actualUi,
  notify: notifyMock,
  PluginProvider: ({ children }: { children: React.ReactNode }) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: { event: string; handler: (data: unknown) => void }) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

const healthyStatus = {
  unsupported: false,
  status: {
    pciDeviceExists: true,
    driverBound: true,
    gamepadPresent: true,
    controller: "0000:65:00.4",
    deadInLog: false,
    summary: "Controller healthy — nothing to do.",
  },
  hidOxp: { blacklisted: false, moduleLoaded: true, rebootRequired: false },
};

const missingStatus = {
  unsupported: false,
  status: {
    pciDeviceExists: true,
    driverBound: true,
    gamepadPresent: false,
    controller: "0000:65:00.4",
    deadInLog: true,
    summary: "Controller died on resume — rebind to recover the gamepad.",
  },
};

describe("apex plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    notifyMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(healthyStatus);
      return Promise.resolve({ success: true });
    });
  });

  it("renders the header", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Apex");
    });
  });

  it("fetches status on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getStatus");
    });
  });

  it("shows the healthy alert when the gamepad is present", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Controller healthy");
      expect(container.textContent).toContain("0000:65:00.4");
    });
  });

  it("shows the missing-controller warning and recover button", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(missingStatus);
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Controller missing");
      expect(container.textContent).toContain("died on resume");
    });
  });

  it("calls recover when the button is pressed", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(missingStatus);
      if (method === "recover")
        return Promise.resolve({
          success: true,
          controller: "0000:65:00.4",
          steps: ["bind"],
          gamepadPresent: true,
        });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    let button: HTMLButtonElement | undefined;
    await waitFor(() => {
      const btn = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Recover gamepad"),
      );
      expect(btn).toBeTruthy();
      button = btn as HTMLButtonElement;
    });

    fireEvent.click(button!);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("recover");
    });
  });

  it("shows the driver-blacklist control and toggles it", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Driver blacklist");
      expect(container.textContent).toContain("Blacklist the hid-oxp driver");
    });

    const toggles = [...container.querySelectorAll('input[type="checkbox"]')];
    const blacklistToggle = toggles[toggles.length - 1] as HTMLInputElement;
    expect(blacklistToggle.checked).toBe(false);

    fireEvent.click(blacklistToggle);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("setHidOxpBlacklist", true);
    });
  });

  it("warns when a reboot is required to apply the blacklist", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus")
        return Promise.resolve({
          ...healthyStatus,
          hidOxp: { blacklisted: true, moduleLoaded: true, rebootRequired: true },
        });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Reboot required");
    });
  });

  it("renders the not-on-Apex banner when unsupported", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve({ unsupported: true });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Not a OneXPlayer Apex");
    });
  });
});
