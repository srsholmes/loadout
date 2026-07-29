/**
 * Storage app spec.
 *
 * Tests the overlay UI: header, initial status fetch, the Detect button
 * wiring, listing an unmounted drive + mounting it, and reflecting a
 * mounted, boot-pinned drive (the auto-mount toggle).
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

const emptyStatus = { drives: [] };

const unmountedDrive = {
  path: "/dev/nvme1n1p1",
  label: "Games",
  uuid: "GAME-1",
  fstype: "ext4",
  size: 1024 ** 4,
  mounted: false,
  mountpoint: null,
  suggestedMountpoint: "/run/media/deck/Games",
  steamLibraryFound: false,
  inFstab: false,
};

describe("storage plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    notifyMock.mockReset();
    eventHandlers.clear();
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(emptyStatus);
      return Promise.resolve({ success: true });
    });
  });

  it("renders the header", async () => {
    const container = document.createElement("div");
    const { mountHeader } = await import("./app");
    mountHeader(container);
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Storage");
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

  it("renders the storage card and detects drives", async () => {
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Storage drive");
      expect(container.textContent).toContain("No data drives detected yet");
    });

    const detectBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Detect drives"),
    );
    expect(detectBtn).toBeTruthy();

    fireEvent.click(detectBtn as HTMLButtonElement);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("detectDrives");
    });
  });

  it("lists an unmounted drive and mounts it", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve({ drives: [unmountedDrive] });
      if (method === "mountDrive")
        return Promise.resolve({ success: true, mountpoint: "/run/media/deck/Games", steamLibraryFound: true });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    let mountBtn: HTMLButtonElement | undefined;
    await waitFor(() => {
      expect(container.textContent).toContain("Games");
      const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Mount");
      expect(btn).toBeTruthy();
      mountBtn = btn as HTMLButtonElement;
    });

    fireEvent.click(mountBtn!);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("mountDrive", "GAME-1");
    });
  });

  it("reflects a mounted, boot-pinned drive and toggles auto-mount off", async () => {
    const mountedDrive = {
      ...unmountedDrive,
      mounted: true,
      mountpoint: "/run/media/deck/Games",
      steamLibraryFound: true,
      inFstab: true,
    };
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve({ drives: [mountedDrive] });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Steam library found");
      expect(container.textContent).toContain("Mounted");
    });

    // The boot-mount toggle is the last checkbox; it reflects inFstab=true.
    const toggles = [...container.querySelectorAll('input[type="checkbox"]')];
    const bootToggle = toggles[toggles.length - 1] as HTMLInputElement;
    expect(bootToggle.checked).toBe(true);

    fireEvent.click(bootToggle);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("setDriveAutoMount", "GAME-1", false);
    });
  });
});
