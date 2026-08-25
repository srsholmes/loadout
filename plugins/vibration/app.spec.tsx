/**
 * vibration frontend spec.
 *
 * @loadout/ui is partially mocked so call() and useEvent() are controllable
 * without a live backend. bun's mock.module is NOT hoisted, so the real module
 * is captured first for the spread.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import * as actualUi from "@loadout/ui";
import { waitFor, fireEvent, act } from "../../test/render";

const callMock = mock((_method: string, ..._args: unknown[]) => Promise.resolve(null));
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: any) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: any) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

const available = {
  available: true,
  devicePath: "/sys/bus/hid/devices/0003:1A86:FE00.0005",
  min: 0,
  max: 5,
  intensity: 3,
  source: "stored" as const,
};

function createContainer() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  callMock.mockClear();
  eventHandlers.clear();
  callMock.mockImplementation((method: string, ...args: unknown[]) => {
    if (method === "getInfo") return Promise.resolve(available);
    if (method === "setIntensity") {
      return Promise.resolve({
        success: true,
        info: { ...available, intensity: args[0] as number },
      });
    }
    return Promise.resolve(null);
  });
});

describe("vibration plugin", () => {
  it("renders a slider spanning the device's range, at the current level", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    const range = await waitFor(() => {
      const el = container.querySelector('input[type="range"]') as HTMLInputElement | null;
      if (!el) throw new Error("slider not rendered yet");
      return el;
    });
    expect(range.min).toBe("0");
    expect(range.max).toBe("5");
    // Integer steps only — the attribute is a u8.
    expect(range.step).toBe("1");
    expect(range.value).toBe("3");
  });

  it("derives the bounds from the device, not from a hardcoded 0-5", async () => {
    callMock.mockImplementation((method: string) =>
      method === "getInfo"
        ? Promise.resolve({ ...available, min: 1, max: 10, intensity: 4 })
        : Promise.resolve(null),
    );
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      const el = container.querySelector('input[type="range"]') as HTMLInputElement | null;
      if (!el) throw new Error("slider not rendered yet");
      expect(el.min).toBe("1");
      expect(el.max).toBe("10");
    });
  });

  it("sends the released level to the backend", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    const range = await waitFor(() => {
      const el = container.querySelector('input[type="range"]') as HTMLInputElement | null;
      if (!el) throw new Error("slider not rendered yet");
      return el;
    });
    fireEvent.change(range, { target: { value: "2" } });
    fireEvent.blur(range);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("setIntensity", 2);
    });
  });

  it("does not write while the thumb is still moving", async () => {
    // Each write is a synchronous HID report to the MCU. Dragging 5 -> 0
    // must cost one write, not one per level passed through.
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    const range = await waitFor(() => {
      const el = container.querySelector('input[type="range"]') as HTMLInputElement | null;
      if (!el) throw new Error("slider not rendered yet");
      return el;
    });
    await act(async () => {
      for (const v of ["4", "3", "2", "1"]) {
        fireEvent.change(range, { target: { value: v } });
      }
    });

    expect(callMock.mock.calls.filter(([m]) => m === "setIntensity")).toHaveLength(0);
    // The readout still tracks the thumb, so the drag isn't silent.
    expect(container.textContent).toContain("Level 1");

    fireEvent.blur(range);
    await waitFor(() => {
      expect(callMock.mock.calls.filter(([m]) => m === "setIntensity")).toHaveLength(1);
    });
    expect(callMock).toHaveBeenCalledWith("setIntensity", 1);
  });

  it("surfaces a failed write instead of throwing", async () => {
    // An RPC resolving null — method missing, transport hiccup — used to
    // throw out of the commit handler, where nothing catches it.
    callMock.mockImplementation((method: string) =>
      method === "getInfo" ? Promise.resolve(available) : Promise.resolve(null),
    );
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    const range = await waitFor(() => {
      const el = container.querySelector('input[type="range"]') as HTMLInputElement | null;
      if (!el) throw new Error("slider not rendered yet");
      return el;
    });
    await act(async () => {
      fireEvent.change(range, { target: { value: "2" } });
      fireEvent.blur(range);
    });

    // Still mounted and re-read the truth rather than crashing.
    expect(container.textContent).toContain("Rumble intensity");
    expect(callMock).toHaveBeenCalledWith("getInfo");
  });

  it("explains itself when no rumble hardware is present", async () => {
    callMock.mockImplementation((method: string) =>
      method === "getInfo"
        ? Promise.resolve({ ...available, available: false, intensity: null, source: null })
        : Promise.resolve(null),
    );
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("No rumble control found");
      // The three reasons a user can act on, including the blacklist.
      expect(container.textContent).toContain("hid-oxp");
      expect(container.textContent).toContain("first-generation");
    });
  });

  it("flags a driver-reported value as unreliable", async () => {
    // hid-oxp's cache resets to max on reload, so a value we didn't store
    // may not match what the user last felt.
    callMock.mockImplementation((method: string) =>
      method === "getInfo"
        ? Promise.resolve({ ...available, source: "driver" })
        : Promise.resolve(null),
    );
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("resets to maximum");
    });
  });

  it("follows the backend when the level changes elsewhere", async () => {
    const container = createContainer();
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Level 3");
    });

    await act(async () => {
      eventHandlers.get("hardwareChanged")?.({ ...available, intensity: 5 });
    });

    expect(container.textContent).toContain("Full");
  });

  it("renders nothing in the home widget without hardware", async () => {
    callMock.mockImplementation((method: string) =>
      method === "getInfo"
        ? Promise.resolve({ ...available, available: false })
        : Promise.resolve(null),
    );
    const container = createContainer();
    const { mountHomeWidget } = await import("./app");
    mountHomeWidget(container);

    await waitFor(() => {
      expect(container.textContent?.trim()).toBe("");
    });
  });
});
