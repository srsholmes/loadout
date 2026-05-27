import { describe, it, expect, mock } from "bun:test";
import { render, fireEvent } from "../../../../../test/render";
import type { PluginInfo } from "../hooks/usePlugins";

// Real modules captured before mock.module() runs — bun's module mocks
// are process-global and persist across files, so we spread the real
// module and override only what we need. Full replacement would hide
// the module's other exports from sibling specs in the same run.
import * as actualGamepadNav from "./GamepadNav";
import * as actualUi from "@loadout/ui";
import * as actualArtwork from "@loadout/steam-paths/artwork";
import * as actualPluginIcons from "../hooks/usePluginIcons";
import * as actualFavorites from "../hooks/useFavorites";
import * as actualScrollFade from "../hooks/useScrollFade";

// Stub the spatial-nav GamepadNav module so the sidebar can mount in a
// pure DOM without booting norigin-spatial-navigation. We assert click
// handlers + DOM presence here — focus behaviour has its own specs.
mock.module("./GamepadNav", () => ({
  ...actualGamepadNav,
  useFocusable: () => ({ ref: { current: null }, focusKey: "", focused: false, focusSelf: () => {} }),
  FocusContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
  Focusable: ({ children }: { children: React.ReactNode }) => children,
  setFocus: () => {},
}));

mock.module("@loadout/ui", () => ({
  ...actualUi,
  useCurrentGame: () => null,
  Spinner: () => <span data-testid="spinner" />,
}));

mock.module("@loadout/steam-paths/artwork", () => ({
  ...actualArtwork,
  steamArtworkUrls: () => ({ capsule: "", hero: "", logo: "" }),
}));

mock.module("../hooks/usePluginIcons", () => ({
  ...actualPluginIcons,
  usePluginIcons: () => ({}),
}));

mock.module("../hooks/useFavorites", () => ({
  ...actualFavorites,
  useFavorites: () => ({
    favorites: [] as string[],
    toggleFavorite: () => {},
  }),
}));

mock.module("../hooks/useScrollFade", () => ({
  ...actualScrollFade,
  useScrollFade: () => ({ ref: { current: null } }),
}));

// SUT imported dynamically *after* the mocks register (mock.module is
// not hoisted, unlike vitest's vi.mock).
const { Sidebar } = await import("./Sidebar");

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
    const onSelectSettings = mock();
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
    expect(getByText("Settings")).toBeTruthy();
  });

  it("fires onSelectSettings when the Settings row is clicked", () => {
    const onSelectSettings = mock();
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
    const labelNode = getByText("Settings");
    const button = labelNode.closest("button");
    expect(button).not.toBeNull();
    expect(button!.className).toMatch(/primary|active|bg-/);
  });
});
