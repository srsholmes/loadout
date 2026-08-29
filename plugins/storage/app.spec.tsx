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
        return Promise.resolve({
          success: true,
          mountpoint: "/run/media/deck/Games",
          steamLibraryFound: true,
        });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    let mountBtn: HTMLButtonElement | undefined;
    await waitFor(() => {
      expect(container.textContent).toContain("Games");
      const btn = [...container.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === "Mount",
      );
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

describe("healSummary", () => {
  const empty = { repinned: [], remounted: [], unpinned: [], failed: [] };

  it("says nothing when the reconcile had nothing to do", async () => {
    const { healSummary } = await import("./app");
    expect(healSummary(empty)).toBeNull();
  });

  it("names the missing pin without asserting a cause it can't know", async () => {
    // This plugin runs on every distro, including ones where nothing
    // regenerates /etc — so an update is offered as the usual cause, not
    // stated as fact.
    const { healSummary } = await import("./app");
    const res = healSummary({ ...empty, repinned: ["Games"], remounted: ["Games"] });
    expect(res?.kind).toBe("success");
    expect(res?.message).toContain("had gone missing");
    expect(res?.message).toContain("usually");
    expect(res?.message).toContain("“Games”");
    expect(res?.message).toContain("mounted the drive");
  });

  it("reports a leftover entry it removed", async () => {
    const { healSummary } = await import("./app");
    const res = healSummary({ ...empty, unpinned: ["Games"] });
    expect(res?.kind).toBe("success");
    expect(res?.message).toContain("Loadout removed it");
  });

  it("doesn't blame an update when the pin was fine and the mount just missed", async () => {
    // Different bug, different fix — telling a user an update ate their pin
    // when it didn't sends them looking in the wrong place.
    const { healSummary } = await import("./app");
    const res = healSummary({ ...empty, remounted: ["Games"] });
    expect(res?.message).not.toContain("system update");
    expect(res?.message).toContain("didn't mount on boot");
  });

  it("leads with a failure even when something else succeeded", async () => {
    // The failure is the only part the user has to act on.
    const { healSummary } = await import("./app");
    const res = healSummary({
      repinned: ["Games"],
      remounted: [],
      unpinned: [],
      failed: [{ name: "SD", error: "wrong fs type" }],
    });
    expect(res?.kind).toBe("error");
    expect(res?.message).toContain("“SD”");
    expect(res?.message).toContain("wrong fs type");
  });

  it("lists several drives readably", async () => {
    const { healSummary } = await import("./app");
    const res = healSummary({ ...empty, repinned: ["Games", "SD", "Media"] });
    expect(res?.message).toContain("“Games”, “SD” and “Media”");
  });
});

describe("boot-reconcile UI", () => {
  const healed = { repinned: ["Games"], remounted: [], unpinned: [], failed: [] };

  beforeEach(() => {
    callMock.mockReset();
    notifyMock.mockReset();
    eventHandlers.clear();
  });

  /** The shell dispatches this once the window is actually on screen. */
  function showOverlay() {
    window.dispatchEvent(
      new CustomEvent("loadout:overlay-visibility", { detail: { isOpen: true } }),
    );
  }

  function makeApi(notice: unknown) {
    return {
      call: mock(async (method: string, surface?: unknown) =>
        method === "getHealNotice" && surface === "toast" ? notice : null,
      ),
      subscribe: mock(() => () => {}),
    };
  }

  it("says nothing at startup when no reconcile happened", async () => {
    const { init } = await import("./app");
    await init(makeApi(null));
    showOverlay();
    await new Promise((r) => setTimeout(r, 20));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("says nothing when the reconcile found nothing to fix", async () => {
    const { init } = await import("./app");
    await init(makeApi({ repinned: [], remounted: [], unpinned: [], failed: [] }));
    showOverlay();
    await new Promise((r) => setTimeout(r, 20));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("waits for the window to be visible before toasting", async () => {
    // The overlay boots hidden and starts at login, so a toast fired at boot
    // is consumed while nobody is looking.
    const { init } = await import("./app");
    const api = makeApi(healed);
    await init(api);
    await new Promise((r) => setTimeout(r, 20));
    expect(notifyMock).not.toHaveBeenCalled(); // still hidden

    showOverlay();
    await new Promise((r) => setTimeout(r, 20));
    expect(String(notifyMock.mock.calls[0]![0])).toContain("had gone missing");
    expect(api.call).toHaveBeenCalledWith("ackHealNotice", "toast");
  });

  it("catches the window opening while the RPC is still in flight", async () => {
    // The listener has to be attached before the first await: the event fires
    // once, on the transition, so a listener registered after the round-trip
    // misses it and the toast never appears.
    const { init } = await import("./app");
    const done = init(makeApi(healed));
    showOverlay(); // fires immediately, before api.call resolves
    await done;
    await new Promise((r) => setTimeout(r, 20));
    expect(notifyMock).toHaveBeenCalled();
  });

  it("survives a backend that isn't up yet", async () => {
    const { init } = await import("./app");
    await init({
      call: mock(async () => {
        throw new Error("ECONNREFUSED");
      }),
      subscribe: mock(() => () => {}),
    });
    showOverlay();
    await new Promise((r) => setTimeout(r, 20));
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("shows the reconcile on the page too, for a user who missed the toast", async () => {
    callMock.mockImplementation((method: string, surface?: unknown) => {
      if (method === "getStatus") return Promise.resolve(emptyStatus);
      // The page reads its OWN surface; the toast having acked "toast" must
      // not hide it here.
      if (method === "getHealNotice" && surface === "page") return Promise.resolve(healed);
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("had gone missing");
    });
    expect(callMock).toHaveBeenCalledWith("ackHealNotice", "page");
  });

  it("shows a failed reconcile on the page rather than dropping it", async () => {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(emptyStatus);
      if (method === "getHealNotice")
        return Promise.resolve({
          repinned: [],
          remounted: [],
          unpinned: [],
          failed: [{ name: "Games", error: "read-only file system" }],
        });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("read-only file system");
    });
  });

  it("keeps the toggle on when an update wiped the entry but not the intent", async () => {
    // Bound to inFstab, the toggle would spring back to off after an update
    // and quietly agree the user never wanted the drive mounted.
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus")
        return Promise.resolve({
          drives: [{ ...unmountedDrive, inFstab: false, autoMountWanted: true }],
        });
      return Promise.resolve({ success: true });
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Games");
    });
    const toggles = [...container.querySelectorAll('input[type="checkbox"]')];
    expect((toggles[toggles.length - 1] as HTMLInputElement).checked).toBe(true);
  });
});
