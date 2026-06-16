import { useState } from "react";
import {
  PluginProvider,
  Spinner,
  mountComponent,
  mountHeaderStub,
} from "@loadout/ui";
import { createRoot } from "react-dom/client";
import { AdvancedSettings } from "./AdvancedSettings";
import { GamePicker } from "./GamePicker";
import { CustomDllField } from "./CustomDllField";
import { InstallCard } from "./InstallCard";
import { LaunchOptionsCard } from "./LaunchOptionsCard";
import { LsfgVkHeader } from "./LsfgVkHeader";
import { NotInstalledCard } from "./NotInstalledCard";
import { QamWidget } from "./QamWidget";
import { StatusBanner } from "./StatusBanner";
import { TroubleshootingCard } from "./TroubleshootingCard";
import { useFlashStatus } from "./lib/use-flash-status";
import { useLsfgManager } from "./lib/use-lsfg-manager";
import { usePickerFilters } from "./lib/use-picker-filters";

export { FaGauge as icon } from "react-icons/fa6";

function LsfgVkManager() {
  const { statusMsg, flashStatus } = useFlashStatus();
  const {
    status,
    loading,
    installing,
    rechecking,
    progress,
    customDllInput,
    setCustomDllInput,
    handleInstall,
    handleUninstall,
    handleRecheck,
    handleSelectLayerVersion,
    handleUpdateSetting,
    handleSetCustomDll,
  } = useLsfgManager({ flashStatus });

  /** Toggles between the apply-to-game picker (default) and the
   *  install/tunables/diagnostics settings cards (gear icon). */
  const [showConfig, setShowConfig] = useState(false);

  /** Picker filter state — search input, collection dropdown, the
   *  live library count + collection options. Owned by a single
   *  hook so the header and the body's GamePicker consume the same
   *  shape without ten loose props threaded through here. */
  const filters = usePickerFilters();

  // Subtitle reflects install status and current view.
  const subtitle = (() => {
    if (!status) return "Loading…";
    if (showConfig) return "Plugin preferences";
    if (!status.install.installed) return "Not installed · open settings to install";
    if (filters.librarySize !== null) {
      return `Apply to game · ${filters.librarySize} games available`;
    }
    return "Apply to game";
  })();

  // Dynamic topbar header — title + subtitle on the left, search +
  // collection filter + gear (or back arrow) on the right.
  const headerNode = (
    <LsfgVkHeader
      subtitle={subtitle}
      showConfig={showConfig}
      installed={!!status?.install.installed}
      filters={filters}
      onEnterConfig={() => setShowConfig(true)}
      onLeaveConfig={() => setShowConfig(false)}
    />
  );

  if (loading || !status) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <Spinner size={32} />
              </div>
            ) : (
              <div className="card">
                <div className="subsection">Failed to load status.</div>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  const { install, dll, settings, launchOptions } = status;
  const tunablesDisabled = !install.installed;

  // ───── Default view: apply-to-game picker ─────
  if (!showConfig) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <StatusBanner message={statusMsg} />

            {!install.installed ? (
              <NotInstalledCard
                rechecking={rechecking}
                onRecheck={handleRecheck}
              />
            ) : (
              <div className="card">
                <GamePicker
                  wrapperToken={install.wrapperToken}
                  search={filters.search}
                  collectionFilter={filters.collection}
                  onCollectionsLoaded={filters.onCollectionsLoaded}
                />
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  // ───── Settings view (gear icon) ─────
  return (
    <>
      {headerNode}
      <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <StatusBanner message={statusMsg} />

        <InstallCard
          install={install}
          installing={installing}
          rechecking={rechecking}
          progress={progress}
          onInstall={handleInstall}
          onUninstall={handleUninstall}
          onRecheck={handleRecheck}
          onSelectLayerVersion={handleSelectLayerVersion}
        />

        <CustomDllField
          dll={dll}
          customDllInput={customDllInput}
          rechecking={rechecking}
          onCustomDllChange={setCustomDllInput}
          onApplyCustomDll={handleSetCustomDll}
          onRecheck={handleRecheck}
        />

        <AdvancedSettings
          settings={settings}
          disabled={tunablesDisabled}
          onUpdateSetting={handleUpdateSetting}
        />

        <TroubleshootingCard
          flashStatus={flashStatus}
          verboseLogging={settings.verbose_logging}
          onUpdateSetting={handleUpdateSetting}
        />

        <LaunchOptionsCard
          launchOptions={launchOptions}
          flashStatus={flashStatus}
        />
      </div>
      </div>
    </>
  );
}

// ---------- Mount entry points ----------
//
// Body: `mountComponent` factory from @loadout/ui handles the
// createRoot + PluginProvider boilerplate.
//
// Header: the actual header content is portaled from inside `mount()`
// via `<PluginHeader>` inside LsfgVkHeader, so the header export is
// the `mountHeaderStub` no-op (its mere presence is what tells the
// overlay shell to reserve the 60px topbar slot).
//
// Home widget: separate React tree for the QAM/home surface. We use
// a one-off `mount()` (not the factory) so the QAM tree doesn't
// reserve a topbar slot.

export const mount = mountComponent(LsfgVkManager);

export function mountHomeWidget(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <QamWidget />
    </PluginProvider>,
  );
  return () => root.unmount();
}

export const mountHeader = mountHeaderStub;
