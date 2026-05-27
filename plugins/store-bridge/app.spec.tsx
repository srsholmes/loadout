import { describe, it, expect, vi } from "vitest";
import type * as UiModule from "@loadout/ui";
import { waitFor } from "../../test/render";

const callMock = vi.fn(
  (_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown),
);

const browserCallMock = vi.fn(
  (_method: string, ..._args: unknown[]) => Promise.resolve(null as unknown),
);

vi.mock("@loadout/ui", async () => {
  const actual = await vi.importActual<typeof UiModule>("@loadout/ui");
  return {
    ...actual,
    PluginProvider: ({ children }: any) => children,
    PluginHeader: ({ children }: any) => children,
    HeaderBackButton: ({ onBack, title }: any) => (
      <button type="button" aria-label={title ?? "Back"} onClick={onBack}>
        Back
      </button>
    ),
    IconButton: ({ children, onClick, "aria-label": al }: any) => (
      <button type="button" aria-label={al} onClick={onClick}>
        {children}
      </button>
    ),
    useBackend: (pluginId: string) => ({
      call: pluginId === "gaming-mode-browser" ? browserCallMock : callMock,
      useEvent: () => {},
      ready: true,
    }),
    useFocusable: () => ({ ref: () => {}, focused: false }),
    notify: () => {},
  };
});

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
          autoAddToSteam: true,
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
