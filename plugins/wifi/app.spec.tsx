/**
 * WiFi app spec.
 *
 * Tests the overlay UI: header, initial status fetch, the on/off alert,
 * and the power-save toggle wiring.
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

const recoveryDefaults = {
  autoRecover: false,
  recovering: false,
  lastRecovery: null,
  watchdogSuspended: false,
  lastKnownDriver: { driver: "iwlwifi", iface: "wlan0" },
};

const offStatus = {
  iface: "wlan0",
  nmConfigured: false,
  iwdPresent: false,
  iwdConfigured: false,
  runtime: "on",
  configured: false,
  powerSaveDisabled: false,
  listenerRunning: false,
  ...recoveryDefaults,
};

const onStatus = {
  iface: "wlan0",
  nmConfigured: true,
  iwdPresent: true,
  iwdConfigured: true,
  runtime: "off",
  configured: true,
  powerSaveDisabled: true,
  listenerRunning: true,
  ...recoveryDefaults,
};

describe("wifi plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    notifyMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(offStatus);
      if (method === "recoverRadio") {
        return Promise.resolve({
          ok: true,
          stage: "done",
          tier: "modprobe",
          driver: "iwlwifi",
          iface: "wlan1",
          detail: "Driver reloaded — radio back as wlan1.",
          at: 1,
          source: "manual",
        });
      }
      return Promise.resolve({ success: true });
    });
  });

  it("renders the header", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("WiFi");
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

  it("shows the default-on warning and the interface", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Power saving on (default)");
      expect(container.textContent).toContain("wlan0");
    });
  });

  it("toggles power saving off", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    let toggle: HTMLInputElement | undefined;
    await waitFor(() => {
      const t = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(t).toBeTruthy();
      toggle = t;
    });
    expect(toggle!.checked).toBe(false);

    fireEvent.click(toggle!);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("setPowerSaveDisabled", true);
    });
  });

  it("reflects the disabled state as checked with a success alert", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(onStatus);
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Power saving disabled");
      const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(toggle?.checked).toBe(true);
    });
  });

  it("renders the radio recovery card", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Radio recovery");
      expect(container.textContent).toContain("Recover WiFi radio");
      expect(container.textContent).toContain("Auto-recover radio");
    });
  });

  it("the recover button dispatches recoverRadio and shows the busy label", async () => {
    // Hold the recovery unresolved so the busy label is observable.
    let release!: (value: unknown) => void;
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(offStatus);
      if (method === "recoverRadio") return new Promise((resolve) => (release = resolve));
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    let button: HTMLButtonElement | undefined;
    await waitFor(() => {
      const b = container.querySelector("button") as HTMLButtonElement;
      expect(b?.textContent).toContain("Recover WiFi radio");
      button = b;
    });

    fireEvent.click(button!);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("recoverRadio");
      expect(container.querySelector("button")?.textContent).toContain("Recovering…");
    });

    release({ ok: true, iface: "wlan1", detail: "ok" });
    await waitFor(() => {
      expect(container.querySelector("button")?.textContent).toContain("Recover WiFi radio");
    });
  });

  it("the auto-recover toggle dispatches setAutoRecover", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    let toggles: HTMLInputElement[] = [];
    await waitFor(() => {
      toggles = Array.from(
        container.querySelectorAll('input[type="checkbox"]'),
      ) as HTMLInputElement[];
      // Power-save toggle + auto-recover toggle.
      expect(toggles.length).toBe(2);
    });
    expect(toggles[1]!.checked).toBe(false);

    fireEvent.click(toggles[1]!);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("setAutoRecover", true);
    });
  });

  it("shows the paused warning when the watchdog is suspended", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") {
        return Promise.resolve({ ...offStatus, watchdogSuspended: true });
      }
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Auto-recovery paused");
    });
  });
});
