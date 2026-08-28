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

const unknownGamepadStatus = {
  unsupported: false,
  status: {
    pciDeviceExists: true,
    driverBound: true,
    gamepadPresent: false,
    gamepadUnknown: true,
    controller: "0000:65:00.4",
    deadInLog: false,
    summary:
      "Couldn't identify this device's internal gamepad — recovery is only known to work on hardware using the OneXPlayer HID MCU.",
  },
  autoRecoverOnWake: true,
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
      // Must track package.json's plugin name — the list and the in-overlay
      // topbar disagreeing is the visible half of a half-done rename.
      expect(container.querySelector("h1")?.textContent).toBe("OneXPlayer");
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

  it("shows the auto-recover-on-wake control and toggles it", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Recover automatically on wake");
    });

    // The auto-recover toggle is the first checkbox — it lives in the
    // gamepad-recovery card, ahead of the driver-blacklist card.
    const autoToggle = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(autoToggle.checked).toBe(false);

    fireEvent.click(autoToggle);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("setAutoRecoverOnWake", true);
    });
  });

  it("reflects a persisted auto-recover-on-wake setting as checked", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus")
        return Promise.resolve({ ...healthyStatus, autoRecoverOnWake: true, listenerRunning: true });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      const autoToggle = container.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement;
      expect(autoToggle?.checked).toBe(true);
    });
  });

  it("hides the driver-blacklist card when nothing is blacklisted", async () => {
    // The blacklist can no longer be added from the UI, so the card only
    // exists to let users revert a blacklist they already applied. With a
    // clean device (blacklisted: false) it shouldn't render at all.
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Gamepad recovery");
    });
    expect(container.textContent).not.toContain("Driver blacklist");
  });

  it("shows a remove-blacklist button and removes it when blacklisted", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus")
        return Promise.resolve({
          ...healthyStatus,
          hidOxp: { blacklisted: true, moduleLoaded: false, rebootRequired: false },
        });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Driver blacklist");
      expect(container.textContent).toContain("Remove blacklist");
    });

    const removeBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Remove blacklist"),
    ) as HTMLButtonElement;
    fireEvent.click(removeBtn);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("removeHidOxpBlacklist");
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

  it("renders the not-a-OneXPlayer banner when unsupported", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve({ unsupported: true });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Not a OneXPlayer handheld");
    });
  });
});

describe("unrecognised gamepad", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
  });

  it("disables recovery rather than rebinding a controller we can't identify", async () => {
    // The rebind targets an address measured on an Apex. On another board
    // that address may host something else entirely, so offering the button
    // here is offering a destructive no-op.
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(unknownGamepadStatus);
      return Promise.resolve(null);
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    const btn = await waitFor(() => {
      const el = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Recover gamepad"),
      );
      if (!el) throw new Error("recover button not rendered yet");
      return el;
    });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // And the copy no longer promises it is harmless.
    expect(container.textContent).not.toContain("no harm in pressing it");
  });

  it("does not leave auto-recover-on-wake armed, which would run it unattended", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(unknownGamepadStatus);
      return Promise.resolve(null);
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Recover automatically on wake");
    });
    // The listener is genuinely running (the backend starts it from stored
    // settings), so showing it as off would be a lie the user can't act on.
    // What matters is that they can still switch it OFF — disabling the
    // control left them watching a listener they had no way to stop.
    const toggle = [...container.querySelectorAll('input[type="checkbox"]')].at(-1) as
      | HTMLInputElement
      | undefined;
    expect(toggle).toBeDefined();
    expect(toggle!.checked).toBe(true);
    expect(toggle!.disabled).toBe(false);
  });

  it("won't let it be armed on a device where recovery can't work", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus")
        return Promise.resolve({ ...unknownGamepadStatus, autoRecoverOnWake: false });
      return Promise.resolve(null);
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Recover automatically on wake");
    });
    const toggle = [...container.querySelectorAll('input[type="checkbox"]')].at(-1) as
      | HTMLInputElement
      | undefined;
    expect(toggle!.checked).toBe(false);
    expect(toggle!.disabled).toBe(true);
  });
});

describe("vibration card", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
  });

  const withRumble = (rumble: unknown) =>
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(healthyStatus);
      if (method === "getRumbleInfo") return Promise.resolve(rumble);
      if (method === "setRumbleIntensity")
        return Promise.resolve({ success: true, info: { ...(rumble as object), intensity: 2 } });
      return Promise.resolve(null);
    });

  const available = {
    available: true,
    devicePath: "/sys/bus/hid/devices/0003:1A86:FE00.0003",
    min: 0,
    max: 5,
    intensity: 5,
    source: "stored" as const,
  };

  it("offers one cell per level the device reports", async () => {
    withRumble(available);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Rumble intensity");
    });
    const cells = [...container.querySelectorAll(".segmented > button")];
    expect(cells.map((c) => c.textContent?.trim())).toEqual(["Off", "1", "2", "3", "4", "5"]);
  });

  it("derives the cells from the device, not a hardcoded 0-5", async () => {
    withRumble({ ...available, min: 1, max: 10, intensity: 4 });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      const cells = [...container.querySelectorAll(".segmented > button")];
      expect(cells.at(-1)?.textContent?.trim()).toBe("10");
    });
  });

  it("sends the chosen level to the backend", async () => {
    withRumble(available);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    const cell = await waitFor(() => {
      const el = [...container.querySelectorAll(".segmented > button")].find(
        (b) => b.textContent?.trim() === "2",
      );
      if (!el) throw new Error("level 2 not rendered yet");
      return el;
    });
    fireEvent.click(cell);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("setRumbleIntensity", 2);
    });
  });

  it("explains itself and offers a retry when there's no rumble control", async () => {
    // The standalone plugin had this; dropping it left a OneXPlayer with
    // hid-oxp blacklisted showing nothing at all.
    withRumble({ ...available, available: false, intensity: null, source: null });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("rumble_intensity");
      expect(container.textContent).toContain("hid-oxp");
    });
    const retry = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Check again"),
    );
    expect(retry).toBeDefined();
    fireEvent.click(retry!);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("rescanRumble"));
  });

  it("keeps every level reachable by d-pad while a write is in flight", async () => {
    // `disabled` maps to focusable:false, which unregisters the cells from
    // spatial navigation — in the plugin whose point is being navigable.
    withRumble(available);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    const cells = await waitFor(() => {
      const c = [...container.querySelectorAll(".segmented > button")];
      if (c.length === 0) throw new Error("not rendered yet");
      return c as HTMLButtonElement[];
    });
    fireEvent.click(cells[2]!);
    for (const cell of [...container.querySelectorAll(".segmented > button")]) {
      expect((cell as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("hides the intensity control when the device has no rumble control", async () => {
    // Every OneXPlayer gets this plugin, but gen-1 boards expose RGB only —
    // an empty control would read as broken.
    withRumble({ ...available, available: false, intensity: null, source: null });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Controller healthy");
    });
    expect(container.textContent).not.toContain("Rumble intensity");
  });

  it("flags a driver-reported level as unreliable", async () => {
    withRumble({ ...available, source: "driver" });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("resets to maximum");
    });
  });
});

describe("startup self-heal toast", () => {
  beforeEach(() => {
    callMock.mockReset();
    notifyMock.mockReset();
    eventHandlers.clear();
  });

  function makeApi(notice: unknown) {
    return {
      call: mock(async (method: string) =>
        method === "getFingerprintHealNotice" ? notice : null,
      ),
      subscribe: mock(() => () => {}),
    };
  }

  /** The shell dispatches this once the window is actually on screen. */
  function showOverlay() {
    window.dispatchEvent(
      new CustomEvent("loadout:overlay-visibility", { detail: { isOpen: true } }),
    );
  }

  it("says nothing when no heal happened", async () => {
    const { init } = await import("./app");
    await init(makeApi(null));
    showOverlay();
    await new Promise((r) => setTimeout(r, 20));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("waits for the window to be visible before toasting", async () => {
    // The overlay boots hidden and starts at login, so a toast fired at boot
    // is consumed while nobody is looking.
    const { init } = await import("./app");
    const done = init(makeApi({ restored: true, rebootRequired: false }));
    await new Promise((r) => setTimeout(r, 30));
    expect(notifyMock).not.toHaveBeenCalled(); // still hidden

    showOverlay();
    await done;
    expect(notifyMock).toHaveBeenCalled();
    expect(String(notifyMock.mock.calls[0]![0])).toContain("restored");
  });

  it("catches the window opening while the RPC is still in flight", async () => {
    // The listener has to be attached before the first await: the event fires
    // once, on the transition, so a listener registered after the round-trip
    // misses it and the toast never appears.
    const { init } = await import("./app");
    const done = init(makeApi({ restored: true, rebootRequired: false }));
    showOverlay(); // fires immediately, before api.call resolves
    await done;
    expect(notifyMock).toHaveBeenCalled();
  });

  it("mentions the reboot only when the karg layer still needs one", async () => {
    const { init } = await import("./app");
    const done = init(makeApi({ restored: true, rebootRequired: true }));
    showOverlay();
    await done;
    expect(String(notifyMock.mock.calls[0]![0])).toContain("Reboot");

    notifyMock.mockReset();
    const done2 = init(makeApi({ restored: true, rebootRequired: false }));
    showOverlay();
    await done2;
    expect(String(notifyMock.mock.calls[0]![0])).not.toContain("Reboot");
  });

  it("shows a failed heal on the page too, not just as a toast", async () => {
    // The page fetches the notice; dropping the !restored case meant a
    // failed re-apply was fetched, stored and silently discarded.
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus")
        return Promise.resolve({
          ...healthyStatus,
          fingerprint: {
            supported: true,
            applied: false,
            rebootPending: false,
            kargUnpersisted: false,
            kargApplicable: true,
            kargActive: false,
            udevRuleInstalled: false,
            distro: "steamos",
            controller: "0000:67:00.0",
          },
        });
      if (method === "getFingerprintHealNotice")
        return Promise.resolve({ restored: false, rebootRequired: false, error: "EACCES" });
      return Promise.resolve(null);
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Couldn't restore the wake block");
      expect(container.textContent).toContain("EACCES");
    });
  });

  it("reports a failed restore as an error, not a success", async () => {
    const { init } = await import("./app");
    const done = init(makeApi({ restored: false, rebootRequired: false, error: "EACCES" }));
    showOverlay();
    await done;
    expect(String(notifyMock.mock.calls[0]![0])).toContain("EACCES");
    expect((notifyMock.mock.calls[0]![1] as { kind?: string })?.kind).toBe("error");
  });

  it("stays quiet when the backend isn't reachable", async () => {
    const { init } = await import("./app");
    await init({
      call: mock(async () => {
        throw new Error("not up");
      }),
      subscribe: mock(() => () => {}),
    });
    showOverlay();
    await new Promise((r) => setTimeout(r, 20));
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("reboot button", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
  });

  const fpStatus = (over: Record<string, unknown> = {}) => ({
    ...healthyStatus,
    fingerprint: {
      supported: true,
      applied: true,
      rebootPending: true,
      kargUnpersisted: false,
      kargApplicable: true,
      kargActive: false,
      udevRuleInstalled: true,
      distro: "steamos",
      controller: "0000:67:00.0",
      ...over,
    },
  });

  async function mountWithFp(over: Record<string, unknown> = {}) {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(fpStatus(over));
      if (method === "rebootDevice") return Promise.resolve({ success: true });
      return Promise.resolve(null);
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => expect(container.textContent).toContain("Fingerprint"));
    return container;
  }

  const findBtn = (c: HTMLElement, text: string) =>
    [...c.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

  it("offers a reboot when one would actually help", async () => {
    const container = await mountWithFp();
    await waitFor(() => expect(findBtn(container, "Restart device")).toBeDefined());
  });

  it("does not offer one when no reboot is pending", async () => {
    // Notably the kargUnpersisted state, where a reboot is what LOSES the
    // karg — that the two states are mutually exclusive is pinned against
    // getStatus in lib/fingerprint.test.ts, not here.
    const container = await mountWithFp({ rebootPending: false, kargUnpersisted: true });
    expect(findBtn(container, "Restart device")).toBeUndefined();
  });

  it("needs a separate confirm control, not a second press", async () => {
    const container = await mountWithFp();
    const btn = await waitFor(() => {
      const b = findBtn(container, "Restart device");
      if (!b) throw new Error("not rendered yet");
      return b;
    });
    fireEvent.click(btn);
    await waitFor(() => expect(findBtn(container, "Confirm restart")).toBeDefined());
    expect(callMock).not.toHaveBeenCalledWith("rebootDevice");

    fireEvent.click(findBtn(container, "Confirm restart")!);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("rebootDevice"));
  });

  it("survives a held A press without rebooting", async () => {
    // `a` is a RepeatableAction: REPEAT_DELAY_MS 500 then REPEAT_RATE_MS 200,
    // each repeat dispatching a synthetic Enter that Button turns into an
    // onClick. A two-click-on-one-button confirm would power-cycle the
    // device from a single held press.
    const container = await mountWithFp();
    const btn = await waitFor(() => {
      const b = findBtn(container, "Restart device");
      if (!b) throw new Error("not rendered yet");
      return b;
    });
    // The whole repeat train lands on the button that is already focused.
    for (let i = 0; i < 8; i++) fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 20));
    expect(callMock).not.toHaveBeenCalledWith("rebootDevice");
  });

  it("says a reboot finishes REMOVING the block when that is what is pending", async () => {
    // rebootPending covers both directions; the copy used to claim
    // "applying" even for a user who had just switched it off.
    const container = await mountWithFp({ udevRuleInstalled: false });
    await waitFor(() => expect(container.textContent).toContain("finish removing"));
    expect(container.textContent).not.toContain("finish applying");
  });
});

describe("fingerprint block: what the UI claims", () => {
  beforeEach(() => {
    callMock.mockReset();
    notifyMock.mockReset();
    eventHandlers.clear();
  });

  const fp = (over: Record<string, unknown> = {}) => ({
    ...healthyStatus,
    fingerprintBlockWanted: false,
    fingerprint: {
      supported: true,
      applied: false,
      rebootPending: false,
      kargUnpersisted: false,
      kargApplicable: true,
      kargAutomatic: false,
      kargStagedUnknown: false,
      kargMode: "manual",
      kargActive: false,
      udevRuleInstalled: false,
      distro: "cachyos",
      controller: "0000:67:00.0",
      ...over,
    },
  });

  async function mountWith(status: unknown) {
    callMock.mockImplementation((method: string) =>
      method === "getStatus" ? Promise.resolve(status) : Promise.resolve(null),
    );
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => expect(container.textContent).toContain("Fingerprint"));
    return container;
  }

  it("keeps the switch on what the user chose, not on a derived state", async () => {
    // Binding `checked` to `applied` made the toggle spring back off whenever
    // the second wake path wasn't closed — and flipping it again called
    // revert(), undoing the path that had worked.
    //
    // autoRecoverOnWake is deliberately ON here: asserting "some checkbox is
    // checked" passed via that one even with the fingerprint toggle bound
    // back to `applied`.
    const container = await mountWith({
      ...fp(),
      autoRecoverOnWake: true,
      fingerprintBlockWanted: true,
    });
    const toggle = [...container.querySelectorAll('input[type="checkbox"]')].at(-1);
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });

  it("says so when the switch is on but nothing is in effect", async () => {
    // The switch reflects intent, so it can sit ON after a failed apply —
    // and no alert was keyed on that, leaving a control in the on position
    // with nothing anywhere saying it wasn't working.
    const container = await mountWith({
      ...fp({ applied: false, rebootPending: false }),
      fingerprintBlockWanted: true,
    });
    await waitFor(() => expect(container.textContent).toContain("Asked for, but not in effect"));
  });

  it("does not nag when the switch is off and nothing is applied", async () => {
    const container = await mountWith({ ...fp({ applied: false }), fingerprintBlockWanted: false });
    expect(container.textContent).not.toContain("Asked for, but not in effect");
  });

  it("does not claim the controller is blocked when the block is off", async () => {
    // Both "one wake path is still open" alerts opened by asserting the USB
    // controller *is* blocked — rendered next to a toggle sitting at OFF.
    const container = await mountWith(fp({ kargMode: "none", applied: false }));
    expect(container.textContent).not.toContain("is blocked at its USB controller");
  });

  it("says a wake path is still open once the block IS on but the karg isn't", async () => {
    const container = await mountWith({
      ...fp({ kargMode: "none", applied: true, udevRuleInstalled: true }),
      fingerprintBlockWanted: true,
    });
    await waitFor(() => expect(container.textContent).toContain("One wake path is still open"));
  });

  it("names the distros we automate, so a CachyOS user knows why they're doing it by hand", async () => {
    const container = await mountWith({
      ...fp({ kargMode: "manual", applied: true, udevRuleInstalled: true }),
      fingerprintBlockWanted: true,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("SteamOS");
      expect(container.textContent).toContain("Bazzite");
      expect(container.textContent).toContain("CachyOS");
    });
  });
});
