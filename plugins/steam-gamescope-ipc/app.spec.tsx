/**
 * steam-gamescope-ipc frontend spec.
 *
 * The plugin's backend is intentionally hollow — game state lives in
 * the loader's `__core:game-detection` service. The frontend renders
 * three subsections:
 *
 *   1. CONNECTED/IDLE chip driven by `useCurrentGame()`.
 *   2. "Now Playing" panel with the cover art + elapsed timer.
 *   3. Launch-game input that calls `SteamClient.URL.ExecuteSteamURL`.
 *
 * We mock `useBackend` (so `getRecentSessions` is controllable) and
 * `useCurrentGame` (so we can flip between connected / idle states).
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below, so this holds the real
// module for the partial-mock spread. (bun's mock.module is not hoisted,
// unlike vitest's vi.mock — static imports evaluate first.)
import * as actualUi from "@loadout/ui";
import { waitFor, fireEvent } from "../../test/render";

const callMock = mock((method: string) => Promise.resolve(null));
const eventHandlers = new Map<string, (data: unknown) => void>();

let currentGameValue: { appId: number; gameName: string; startTime: number } | null = null;

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
  useCurrentGame: () => currentGameValue,
}));

const mockRecentSessions = [
  {
    appId: 730,
    gameName: "Counter-Strike 2",
    startTime: Date.now() - 1000 * 60 * 30,
    endTime: Date.now() - 1000 * 60,
  },
  {
    appId: 570,
    gameName: "Dota 2",
    startTime: Date.now() - 1000 * 60 * 90,
    endTime: Date.now() - 1000 * 60 * 60,
  },
];

describe("steam-gamescope-ipc plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    currentGameValue = null;

    callMock.mockImplementation((method: string) => {
      if (method === "getRecentSessions") return Promise.resolve(mockRecentSessions);
      return Promise.resolve(null);
    });
  });

  it("renders the IDLE chip when no game is running", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("IDLE");
      expect(container.textContent).toContain("No game currently running");
    });
  });

  it("calls getRecentSessions on mount", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getRecentSessions");
    });
  });

  it("registers a gameChanged handler that re-fetches recents", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(eventHandlers.has("gameChanged")).toBe(true);
    });

    callMock.mockClear();
    // Simulate the game-detection service firing a gameChanged event.
    eventHandlers.get("gameChanged")!({ currentGame: null, recentSessions: [] });

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("getRecentSessions");
    });
  });

  it("renders CONNECTED + Now Playing details when a game is active", async () => {
    currentGameValue = {
      appId: 730,
      gameName: "Counter-Strike 2",
      startTime: Date.now() - 5_000,
    };

    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("CONNECTED");
      expect(container.textContent).toContain("Counter-Strike 2");
      expect(container.textContent).toContain("AppID 730");
    });
  });

  it("invokes SteamClient.URL.ExecuteSteamURL when the user launches a game", async () => {
    const executeSteamURL = mock();
    (globalThis as any).SteamClient = { URL: { ExecuteSteamURL: executeSteamURL } };

    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    // Wait for the loading spinner to clear (getRecentSessions resolves).
    await waitFor(() => {
      expect(container.textContent).toContain("Launch Game");
    });

    const input = container.querySelector(
      'input[placeholder*="AppID"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "730" } });

    // The Launch button should now be enabled; click it.
    const launchButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Launch"),
    );
    expect(launchButton).toBeTruthy();
    fireEvent.click(launchButton!);

    expect(executeSteamURL).toHaveBeenCalledWith("steam://rungameid/730");

    delete (globalThis as any).SteamClient;
  });

  it("ignores launch attempts with an empty or invalid AppID", async () => {
    const executeSteamURL = mock();
    (globalThis as any).SteamClient = { URL: { ExecuteSteamURL: executeSteamURL } };

    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Launch Game");
    });

    // Don't type anything — Launch button must be disabled and clicking
    // it must not reach SteamClient.
    const launchButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Launch"),
    ) as HTMLButtonElement;
    expect(launchButton.disabled).toBe(true);
    fireEvent.click(launchButton);
    expect(executeSteamURL).not.toHaveBeenCalled();

    delete (globalThis as any).SteamClient;
  });

  it("mountHeader renders the plugin heading", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toContain("Gamescope IPC");
    });
  });
});
