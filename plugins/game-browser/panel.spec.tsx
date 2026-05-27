import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "../../test/render";

const callMock = vi.fn((method: string) => Promise.resolve(null));

vi.mock("@loadout/ui", async () => {
  const actual = await vi.importActual("@loadout/ui");
  return {
    ...actual,
    PluginProvider: ({ children }: any) => children,
    useBackend: () => ({
      call: callMock,
      useEvent: vi.fn(),
      ready: true,
    }),
    Steam: {
      DialogButton: ({ children, onClick, ...props }: any) => (
        <button onClick={onClick} {...props}>{children}</button>
      ),
      TextField: ({ value, onChange, placeholder, ...props }: any) => (
        <input
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          {...props}
        />
      ),
      ScrollPanel: ({ children, ...props }: any) => (
        <div {...props}>{children}</div>
      ),
      Focusable: ({ children, onActivate, ...props }: any) => (
        <div onClick={onActivate} {...props}>{children}</div>
      ),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  callMock.mockImplementation((method: string) => {
    if (method === "getGames")
      return Promise.resolve([
        {
          appId: "730",
          name: "Counter-Strike 2",
          sizeOnDisk: 30_000_000_000,
          headerUrl: "https://example.com/header.jpg",
          capsuleUrl: "https://example.com/capsule.jpg",
        },
        {
          appId: "570",
          name: "Dota 2",
          sizeOnDisk: 40_000_000_000,
          headerUrl: "https://example.com/header2.jpg",
          capsuleUrl: "https://example.com/capsule2.jpg",
        },
      ]);
    return Promise.resolve(null);
  });
});

describe("game-browser panel", () => {
  it("renders loading state initially", async () => {
    const GameBrowserPanel = (await import("./panel")).default;
    render(<GameBrowserPanel />);
    expect(screen.getByText("Loading library...")).toBeTruthy();
  });

  it("displays game list after loading", async () => {
    const GameBrowserPanel = (await import("./panel")).default;
    render(<GameBrowserPanel />);
    await waitFor(() => {
      expect(screen.getByText("Counter-Strike 2")).toBeTruthy();
      expect(screen.getByText("Dota 2")).toBeTruthy();
    });
  });

  it("shows game count text", async () => {
    const GameBrowserPanel = (await import("./panel")).default;
    render(<GameBrowserPanel />);
    await waitFor(() => {
      expect(screen.getByText("2 games installed")).toBeTruthy();
    });
  });

  it("shows Refresh Library button", async () => {
    const GameBrowserPanel = (await import("./panel")).default;
    render(<GameBrowserPanel />);
    await waitFor(() => {
      expect(screen.getByText("Refresh Library")).toBeTruthy();
    });
  });

  it("shows disk size for games", async () => {
    const GameBrowserPanel = (await import("./panel")).default;
    render(<GameBrowserPanel />);
    await waitFor(() => {
      expect(screen.getByText("27.9 GB")).toBeTruthy(); // 30_000_000_000 bytes
    });
  });
});
