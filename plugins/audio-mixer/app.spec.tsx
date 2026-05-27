import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "../../test/render";

const callMock = vi.fn((_method: string, ..._args: unknown[]) =>
  Promise.resolve(null as unknown),
);
const eventHandlers = new Map<string, (data: unknown) => void>();

vi.mock("@loadout/ui", async () => {
  const actual = await vi.importActual("@loadout/ui");
  return {
    ...(actual as Record<string, unknown>),
    PluginProvider: ({ children }: { children: React.ReactNode }) => children,
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
  };
});

const mockState = {
  available: true,
  unavailableReason: null,
  sinks: [
    {
      id: 42,
      label: "Built-in Audio Speakers",
      description: "Built-in Audio Speakers",
      isDefault: true,
      volume: 0.5,
      muted: false,
      kind: "sink" as const,
    },
    {
      id: 43,
      label: "USB Headset",
      description: "USB Headset",
      isDefault: false,
      volume: 0.7,
      muted: false,
      kind: "sink" as const,
    },
  ],
  sources: [],
  playbackStreams: [
    {
      id: 100,
      label: "Firefox",
      appName: "Firefox",
      iconName: null,
      mediaName: "AudioStream",
      volume: 1,
      muted: false,
      kind: "playback" as const,
    },
    {
      id: 101,
      label: "Hades II",
      appName: "Hades II",
      iconName: null,
      mediaName: null,
      volume: 0.5,
      muted: true,
      kind: "playback" as const,
    },
  ],
  recordingStreams: [],
};

describe("audio-mixer plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getMixerState") return Promise.resolve(mockState);
      return Promise.resolve(null);
    });
  });

  it("mounts and renders the heading", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Audio Mixer");
    });
  });

  it("calls getMixerState on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getMixerState");
    });
  });

  it("renders the default sink as a chip in the OUTPUT card", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Built-in Audio Speakers");
    });
  });

  it("renders both sinks when more than one is present", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("USB Headset");
    });
  });

  it("renders playback streams (apps)", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Firefox");
      expect(container.textContent).toContain("Hades II");
    });
  });

  it("shows the unavailable card when the backend reports it", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getMixerState") {
        return Promise.resolve({
          ...mockState,
          available: false,
          unavailableReason: "wpctl not found (install wireplumber)",
          sinks: [],
          playbackStreams: [],
        });
      }
      return Promise.resolve(null);
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Audio mixer unavailable");
      expect(container.textContent).toContain("wpctl not found");
    });
  });

  it("homepage widget renders the master volume percent", async () => {
    const container = document.createElement("div");
    const { mountHomeWidget } = await import("./app");
    mountHomeWidget(container);
    await waitFor(() => {
      expect(container.textContent).toContain("50");
      expect(container.textContent).toContain("Built-in Audio Speakers");
    });
  });
});
