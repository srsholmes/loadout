import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, waitFor } from "../../test/render";

const callMock = vi.fn((method: string) => Promise.resolve(null));
const eventHandlers = new Map<string, (data: unknown) => void>();

vi.mock("@loadout/ui", async () => {
  const actual = await vi.importActual("@loadout/ui");
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

beforeEach(() => {
  vi.clearAllMocks();
  eventHandlers.clear();
  callMock.mockImplementation((method: string) => {
    if (method === "getRgbInfo")
      return Promise.resolve({
        available: true,
        driver: "openrgb",
        zones: [
          {
            id: "zone1",
            name: "Left Stick",
            color: { r: 255, g: 0, b: 0 },
            brightness: 80,
            mode: "static",
            supportedModes: ["static", "breathing", "rainbow"],
          },
        ],
        supportedModes: ["static", "breathing", "rainbow", "off"],
      });
    if (method === "getPresets")
      return Promise.resolve([
        { name: "Red", r: 255, g: 0, b: 0 },
        { name: "Green", r: 0, g: 255, b: 0 },
        { name: "Off", r: 0, g: 0, b: 0 },
      ]);
    return Promise.resolve(null);
  });
});

describe("rgb-control plugin", () => {
  it("mounts and renders the header", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => expect(container.textContent).toContain("RGB Zones"));
  });

  it("shows driver information", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => expect(container.textContent).toContain("openrgb"));
  });

  it("displays color preset buttons", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Red");
      expect(container.textContent).toContain("Green");
      expect(container.textContent).toContain("Off");
    });
  });

  it("shows RGB slider labels", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      // Labels are now single letters in the slider rows.
      expect(container.textContent).toMatch(/R\s*\d/);
      expect(container.textContent).toMatch(/G\s*\d/);
      expect(container.textContent).toMatch(/B\s*\d/);
    });
  });

  it("displays LED mode buttons", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Static");
      expect(container.textContent).toContain("Breathing");
      expect(container.textContent).toContain("Rainbow");
    });
  });

  it("no Apply button — colour writes happen on slider change", async () => {
    // Apply button was removed in the reliability pass — clicking a
    // preset / dragging a slider applies live with a 150 ms debounce.
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => expect(container.textContent).toContain("openrgb"));
    expect(container.textContent).not.toContain("Apply");
  });

  it("clears applying state on a thrown call so the lockout can't stick", async () => {
    // Regression: a thrown RPC used to leave `setApplying(false)` un-
    // fired, permanently disabling every button. Now wrapped in
    // try/finally — pressing a preset that throws should leave the
    // grid clickable for the next attempt.
    const setColorErrors: number[] = [];
    callMock.mockImplementation((method: string) => {
      if (method === "getRgbInfo")
        return Promise.resolve({
          available: true,
          driver: "openrgb",
          zones: [
            {
              id: "zone1",
              name: "Left Stick",
              color: { r: 255, g: 0, b: 0 },
              brightness: 80,
              mode: "static",
              supportedModes: ["static"],
            },
          ],
          supportedModes: ["static"],
        });
      if (method === "getPresets")
        return Promise.resolve([{ name: "Red", r: 255, g: 0, b: 0 }]);
      if (method === "applyPreset") {
        setColorErrors.push(1);
        return Promise.reject(new Error("simulated RPC failure"));
      }
      return Promise.resolve(null);
    });

    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => expect(container.textContent).toContain("Red"));
    // Click the Red preset twice. Both attempts should hit the
    // backend — if the lockout stuck, the second click would be
    // disabled and `applyPreset` would only be called once.
    const buttons = Array.from(
      container.querySelectorAll("button"),
    ) as HTMLButtonElement[];
    const redBtn = buttons.find((b) => b.textContent?.includes("Red"));
    expect(redBtn).toBeDefined();
    fireEvent.click(redBtn!);
    await waitFor(() => expect(setColorErrors.length).toBe(1));
    fireEvent.click(redBtn!);
    await waitFor(() => expect(setColorErrors.length).toBe(2));
  });

  it("marks the active preset / mode tile with aria-pressed", async () => {
    // Selected state should be announced to screen readers — native
    // <button> has no built-in mechanism, so `FocusableButton`
    // surfaces it via aria-pressed.
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => expect(container.textContent).toContain("Static"));
    // The initial mode is "static" per the mock zone.
    const staticBtn = Array.from(
      container.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Static") as HTMLButtonElement;
    expect(staticBtn).toBeDefined();
    expect(staticBtn.getAttribute("aria-pressed")).toBe("true");

    // Non-selected modes do NOT carry aria-pressed at all (deliberate
    // — undefined > false so AT doesn't read "not pressed" on every
    // tile in the grid).
    const breathingBtn = Array.from(
      container.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "Breathing") as HTMLButtonElement;
    expect(breathingBtn.getAttribute("aria-pressed")).toBeNull();
  });

  it("shows 'No RGB Hardware Detected' when not available", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getRgbInfo")
        return Promise.resolve({
          available: false,
          driver: "",
          zones: [],
          supportedModes: [],
        });
      if (method === "getPresets") return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() =>
      expect(container.textContent).toContain("No RGB hardware detected"),
    );
  });
});
