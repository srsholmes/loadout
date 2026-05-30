import { describe, it, expect, mock, beforeEach } from "bun:test";
// Captured BEFORE mock.module() runs below, so this holds the real
// module for the partial-mock spread. (bun's mock.module is not hoisted,
// unlike vitest's vi.mock — static imports evaluate first.)
import * as actualUi from "@loadout/ui";
import { waitFor } from "../../test/render";

interface CallMock {
  (method: string, ...args: unknown[]): Promise<unknown>;
  mockReset: () => void;
  mockImplementation: (
    fn: (method: string, ...args: unknown[]) => Promise<unknown>,
  ) => void;
}

const callMock = mock(
  (_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown),
) as unknown as CallMock;

const browserCallMock = mock(
  (_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown),
) as unknown as CallMock;

const { PluginHeaderSlotProvider } = actualUi as unknown as {
  PluginHeaderSlotProvider: (props: {
    slot: HTMLElement | null;
    children: React.ReactNode;
  }) => React.ReactElement;
};

mock.module("@loadout/ui", () => ({
  ...actualUi,
  PluginProvider: ({
    children,
    headerSlot,
  }: {
    children: React.ReactNode;
    headerSlot?: HTMLElement | null;
  }) => (
    <PluginHeaderSlotProvider slot={headerSlot ?? null}>
      {children}
    </PluginHeaderSlotProvider>
  ),
  useBackend: (pluginId: string) => ({
    call: pluginId === "gaming-mode-browser" ? browserCallMock : callMock,
    useEvent: () => {},
    ready: true,
  }),
  useFocusable: () => ({ ref: () => {}, focused: false }),
  notify: () => {},
}));

function fakeBackend(opts: {
  preflightOk: boolean;
  canSelfInstall?: boolean;
  authStatus?: "unknown" | "authed" | "expired";
} = { preflightOk: false }) {
  callMock.mockReset();
  callMock.mockImplementation((method: string) => {
    switch (method) {
      case "getStores":
        return Promise.resolve([
          {
            id: "epic",
            displayName: "Epic Games",
            authStatus: opts.authStatus ?? "unknown",
            enabled: true,
            preflightOk: opts.preflightOk,
          },
        ]);
      case "checkPreflight":
        return Promise.resolve({
          ok: opts.preflightOk,
          missing: opts.preflightOk ? [] : ["legendary"],
          canSelfInstall: opts.canSelfInstall ?? true,
          installHint: opts.preflightOk
            ? undefined
            : "legendary isn't installed yet.",
        });
      case "getLibrary":
        return Promise.resolve([]);
      case "getSettings":
        return Promise.resolve({
          enabledStores: ["epic"],
          driverOverrides: {},
          scanPaths: [],
        });
      default:
        return Promise.resolve(null);
    }
  });
}

async function mountApp() {
  const { mount } = await import("./app");
  const container = document.createElement("div");
  document.body.appendChild(container);
  mount(container);
  return container;
}

describe("CatalogView", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("renders the install-legendary CTA when preflight fails with canSelfInstall", async () => {
    fakeBackend({ preflightOk: false, canSelfInstall: true });
    const container = await mountApp();
    await waitFor(() => {
      expect(container.textContent).toContain("Install legendary");
    });
  });

  it("renders the sign-in panel when preflight is ok but auth is unknown", async () => {
    fakeBackend({ preflightOk: true, authStatus: "unknown" });
    const container = await mountApp();
    await waitFor(() => {
      expect(container.textContent).toContain("Sign in to Epic Games");
    });
  });
});
