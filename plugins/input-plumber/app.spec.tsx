/**
 * input-plumber frontend spec.
 *
 * The page renders a single install card whose state derives from the
 * `getStatus` RPC (`installed` / `serviceActive` / `scriptPresent`). The
 * primary button toggles between "Install InputPlumber" / "Reinstall"
 * and dispatches `startInstall`. The backend streams progress through
 * the `install-log` and `install-state` events; the latter flips the
 * button back to "Install" + records the run result.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below, so this holds the real
// module for the partial-mock spread. (bun's mock.module is not hoisted,
// unlike vitest's vi.mock — static imports evaluate first.)
import * as actualUi from "@loadout/ui";
import { waitFor, fireEvent } from "../../test/render";

const callMock = mock((_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown));
const eventHandlers = new Map<string, (data: unknown) => void>();

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({ children }: { children: React.ReactNode }) => children,
  useBackend: () => ({
    call: callMock,
    useEvent: ({ event, handler }: { event: string; handler: (data: unknown) => void }) => {
      eventHandlers.set(event, handler);
    },
    ready: true,
  }),
}));

const notInstalledStatus = {
  installed: false,
  binaryPath: null,
  managedBy: "none",
  version: null,
  serviceActive: false,
  serviceEnabled: false,
  scriptPresent: true,
  summary: "InputPlumber is not installed.",
};

const installedActiveStatus = {
  installed: true,
  binaryPath: "/usr/bin/inputplumber",
  managedBy: "distro",
  version: "0.46.0",
  serviceActive: true,
  serviceEnabled: true,
  scriptPresent: true,
  summary: "InputPlumber is active.",
};

const scriptMissingStatus = {
  ...notInstalledStatus,
  scriptPresent: false,
  summary: "Install script missing from plugin directory.",
};

function rpcFor(status: typeof notInstalledStatus, running = false) {
  callMock.mockImplementation((method: string) => {
    if (method === "getStatus") return Promise.resolve(status);
    if (method === "isInstallRunning") return Promise.resolve({ running });
    if (method === "startInstall") return Promise.resolve({ started: true });
    return Promise.resolve(null);
  });
}

describe("input-plumber plugin", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
  });

  it("renders the 'Not installed' chip when the binary is absent", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Not installed");
      expect(container.textContent).toContain("Install InputPlumber");
    });
  });

  it("renders the 'Active' chip when the service is running", async () => {
    rpcFor(installedActiveStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Active");
      // Already installed → primary button label flips to Reinstall.
      expect(container.textContent).toContain("Reinstall");
      expect(container.textContent).toContain("v0.46.0");
    });
  });

  it("clicking the install button calls startInstall", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Install InputPlumber");
    });

    const installButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Install InputPlumber"),
    );
    expect(installButton).toBeTruthy();
    fireEvent.click(installButton!);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("startInstall");
    });
  });

  it("install-log events stream into the on-screen log pane", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(eventHandlers.has("install-log")).toBe(true);
    });

    eventHandlers.get("install-log")!({ kind: "stdout", text: "==> building hid-oxp\n" });

    await waitFor(() => {
      expect(container.querySelector("pre")?.textContent).toContain("building hid-oxp");
    });
  });

  it("caps the log buffer at LOG_CAP and keeps the most recent lines", async () => {
    // Regression guard for the unbounded array.push + slice pattern
    // that thrashed GC on chatty installs. We fire well past the cap
    // (500 lines) and assert that the earliest lines are dropped and
    // the latest survive — the cap is enforced and ordering is right.
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(eventHandlers.has("install-log")).toBe(true);
    });

    const handler = eventHandlers.get("install-log")!;
    // 600 lines, each tagged with its index so we can verify which
    // ones got dropped. "FIRST" lines should be evicted, "LAST" lines
    // should survive.
    for (let i = 0; i < 600; i++) {
      handler({ kind: "stdout", text: `line ${i}\n` });
    }

    await waitFor(() => {
      const text = container.querySelector("pre")?.textContent ?? "";
      // The first lines must be evicted.
      expect(text.includes("line 0\n")).toBe(false);
      expect(text.includes("line 99\n")).toBe(false);
      // The most recent line is retained.
      expect(text).toContain("line 599");
      // And exactly LOG_CAP (500) lines are kept.
      const lineCount = text.split("\n").filter(Boolean).length;
      expect(lineCount).toBe(500);
    });
  });

  it("install-state event with success surfaces the duration", async () => {
    rpcFor(notInstalledStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(eventHandlers.has("install-state")).toBe(true);
    });

    eventHandlers.get("install-state")!({
      running: false,
      result: { success: true, exitCode: 0, timedOut: false, durationSeconds: 42 },
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Last run succeeded in 42s");
    });
  });

  it("disables the install button when the install script is missing", async () => {
    rpcFor(scriptMissingStatus);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Install script missing");
    });

    const installButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Install InputPlumber"),
    ) as HTMLButtonElement;
    expect(installButton).toBeTruthy();
    expect(installButton.disabled).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Overlay wake button picker
  // -----------------------------------------------------------------------

  const wakeActive = {
    ipActive: true,
    isDeck: false,
    selectedRaw: "Gamepad:Button:RightPaddle1",
    devices: [
      {
        name: "OrangePi Apex",
        buttons: [
          {
            raw: "Gamepad:Button:RightPaddle1",
            name: "RightPaddle1",
            category: "gamepad",
            label: "Right Back Paddle (R4)",
            recommended: true,
          },
          {
            raw: "Keyboard:KeyRecord",
            name: "KeyRecord",
            category: "keyboard",
            label: "Key Record",
            recommended: true,
          },
          {
            raw: "Gamepad:Button:South",
            name: "South",
            category: "gamepad",
            label: "South",
            recommended: false,
          },
        ],
      },
    ],
  };

  /** Wire the install RPCs to `installedActiveStatus` and the wake RPCs to a
   *  provided wake status, so both cards render. */
  function rpcWithWake(wake: unknown) {
    callMock.mockImplementation((method: string) => {
      if (method === "getStatus") return Promise.resolve(installedActiveStatus);
      if (method === "isInstallRunning")
        return Promise.resolve({ running: false });
      if (method === "getWakeStatus") return Promise.resolve(wake);
      if (method === "setWakeButton") return Promise.resolve({ ok: true });
      if (method === "clearWakeButton") return Promise.resolve({ ok: true });
      if (method === "prepareWake") return Promise.resolve(wake);
      return Promise.resolve(null);
    });
  }

  it("shows the currently-bound button label when one is set", async () => {
    rpcWithWake(wakeActive);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Overlay wake button");
      expect(container.textContent).toContain("Currently bound");
      // The bound capability is RightPaddle1 — show its friendly label.
      expect(container.textContent).toContain("Right Back Paddle (R4)");
    });
    // Press-to-capture: the picker is a single button now, not a list of
    // every capability. The old flat list is intentionally gone.
    expect(container.textContent).not.toContain("Other buttons");
  });

  it("clicking 'Change button' triggers captureWakeButton with the timeout", async () => {
    rpcWithWake(wakeActive);
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Change button");
    });

    const changeBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "Change button",
    )!;
    fireEvent.click(changeBtn);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("captureWakeButton", 10_000);
    });
  });

  it("shows 'Set wake button' when nothing is bound yet", async () => {
    rpcWithWake({
      ipActive: true,
      isDeck: false,
      selectedRaw: null,
      devices: [{ name: "OrangePi Apex", buttons: [] }],
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("Set wake button");
    });
  });

  it("warns about a legacy IP profile before allowing capture", async () => {
    rpcWithWake({
      ipActive: true,
      isDeck: false,
      selectedRaw: null,
      devices: [{ name: "OrangePi Apex", buttons: [] }],
      hasLegacyProfile: true,
    });
    const container = document.createElement("div");
    const { mount } = await import("./app");
    mount(container);

    await waitFor(() => {
      expect(container.textContent).toContain("replaces existing IP profile");
      expect(container.textContent).toContain("I understand, continue");
    });

    // "Set wake button" should be disabled until the user acknowledges.
    const setBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "Set wake button",
    ) as HTMLButtonElement;
    expect(setBtn.disabled).toBe(true);

    const ack = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.trim() === "I understand, continue",
    )!;
    fireEvent.click(ack);

    await waitFor(() => {
      const reSetBtn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.trim() === "Set wake button",
      ) as HTMLButtonElement;
      expect(reSetBtn.disabled).toBe(false);
    });
  });

  // Note: the former "Deck with IP disabled → enable button" case was removed
  // along with that UI branch — it's an unreachable state. On a Deck
  // getWakeStatus always reports ipActive:true (the Deck wake path bypasses
  // InputPlumber), and the IP path only runs on non-Deck hosts (isDeck:false),
  // so isDeck:true + ipActive:false can never occur.
});
