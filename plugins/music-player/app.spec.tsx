import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "../../test/render";

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
    if (method === "getTracks")
      return Promise.resolve(["track1.mp3", "ambient.ogg", "boss_theme.flac"]);
    if (method === "getStatus")
      return Promise.resolve({
        currentTrack: "track1.mp3",
        trackIndex: 0,
        volume: 80,
        paused: false,
        playing: true,
      });
    if (method === "getMusicDir")
      return Promise.resolve("/home/deck/Music");
    return Promise.resolve(null);
  });
});

describe("music-player plugin", () => {
  it("mounts and renders the header", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() =>
      expect(container.textContent).toContain("Music Player"),
    );
  });

  it("displays the currently playing track", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => expect(container.textContent).toContain("track1"));
  });

  it("shows track list with all tracks", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Queue");
      expect(container.textContent).toContain("ambient");
      expect(container.textContent).toContain("boss_theme");
    });
  });

  it("indicates the playing track in the queue", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      // Currently-playing row is annotated with PLAYING.
      expect(container.textContent).toContain("PLAYING");
    });
  });

  it("shows volume percentage", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => expect(container.textContent).toContain("80%"));
  });

  it("displays the music folder path", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() =>
      expect(container.textContent).toContain("/home/deck/Music"),
    );
  });
});
