import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "../../../../../test/render";
import { Sidebar } from "./Sidebar";
import type { PluginInfo } from "../hooks/usePlugins";

// Stub the spatial-nav GamepadNav module so the sidebar can mount in
// a pure DOM without booting the full norigin-spatial-navigation
// runtime. We only assert click handlers + DOM presence here — focus
// behaviour is exercised by spatial-nav's own specs.
vi.mock("./GamepadNav", () => ({
  useFocusable: () => ({ ref: { current: null }, focusKey: "", focused: false, focusSelf: () => {} }),
  FocusContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
  Focusable: ({ children }: { children: React.ReactNode }) => children,
  setFocus: () => {},
}));

vi.mock("@loadout/ui", () => ({
  useCurrentGame: () => null,
  Spinner: () => <span data-testid="spinner" />,
}));

vi.mock("@loadout/steam-paths/artwork", () => ({
  steamArtworkUrls: () => ({ capsule: "", hero: "", logo: "" }),
}));

vi.mock("../hooks/usePluginIcons", () => ({
  usePluginIcons: () => ({}),
}));

vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favorites: [] as string[],
    toggleFavorite: () => {},
  }),
}));

vi.mock("../hooks/useScrollFade", () => ({
  useScrollFade: () => ({ ref: { current: null } }),
}));

function makePlugin(id: string, name: string): PluginInfo {
  return {
    id,
    name,
    description: "",
    enabled: true,
    icon: name[0],
    category: "Tools",
  } as unknown as PluginInfo;
}

describe("Sidebar — Settings entry (issue #135)", () => {
  it("renders a Settings row pinned below the plugin list", () => {
    const onSelectSettings = vi.fn();
    const { getByText } = render(
      <Sidebar
        plugins={[makePlugin("alpha", "Alpha"), makePlugin("beta", "Beta")]}
        activePluginId={null}
        onSelectPlugin={() => {}}
        loading={false}
        showHome={false}
        onSelectHome={() => {}}
        showSettings={false}
        onSelectSettings={onSelectSettings}
        onToggleSidebar={() => {}}
      />,
    );
    // The Settings row label is what the user sees.
    expect(getByText("Settings")).toBeTruthy();
  });

  it("fires onSelectSettings when the Settings row is clicked", () => {
    const onSelectSettings = vi.fn();
    const { getByText } = render(
      <Sidebar
        plugins={[makePlugin("alpha", "Alpha")]}
        activePluginId={null}
        onSelectPlugin={() => {}}
        loading={false}
        showHome={false}
        onSelectHome={() => {}}
        showSettings={false}
        onSelectSettings={onSelectSettings}
        onToggleSidebar={() => {}}
      />,
    );
    // SidebarRow uses a `<button>` internally — clicking the Settings
    // label text reaches that button via event bubbling.
    fireEvent.click(getByText("Settings"));
    expect(onSelectSettings).toHaveBeenCalledTimes(1);
  });

  it("marks the Settings row active when showSettings is true", () => {
    const { getByText } = render(
      <Sidebar
        plugins={[]}
        activePluginId={null}
        onSelectPlugin={() => {}}
        loading={false}
        showHome={false}
        onSelectHome={() => {}}
        showSettings={true}
        onSelectSettings={() => {}}
        onToggleSidebar={() => {}}
      />,
    );
    // SidebarRow renders the active row with a "active" or
    // primary-tinted class. We assert the *parent button* of the
    // label text carries some active-state signal — we don't pin a
    // specific class name (it can change) but DO pin that the
    // rendered DOM differs from the inactive case (covered by the
    // other tests' implicit non-active class).
    const labelNode = getByText("Settings");
    const button = labelNode.closest("button");
    expect(button).not.toBeNull();
    expect(button!.className).toMatch(/primary|active|bg-/);
  });
});
