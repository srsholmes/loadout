// Install / Uninstall card.
//
// The "is the layer on disk?" row with the Install or Uninstall
// button. Stateless — apply / uninstall handlers are passed in by
// the parent (LsfgVkManager) so this component doesn't have to know
// the `lsfg-vk` backend exists.

import { Button, Select } from "@loadout/ui";

import { LAYER_VERSION_OPTIONS } from "./lib/constants";
import type { InstallStatus, LayerVersion } from "./lib/types";

interface InstallCardProps {
  install: InstallStatus;
  installing: boolean;
  rechecking: boolean;
  progress: string;
  onInstall: () => void;
  onUninstall: () => void;
  onRecheck: () => void;
  onSelectLayerVersion: (version: LayerVersion) => void;
}

export function InstallCard({
  install,
  installing,
  rechecking,
  progress,
  onInstall,
  onUninstall,
  onRecheck,
  onSelectLayerVersion,
}: InstallCardProps) {
  const versionDesc = LAYER_VERSION_OPTIONS.find(
    (o) => o.value === install.layerVersion,
  )?.description;
  return (
    <div className="card">
      <div className="subsection">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div className="subsection-label" style={{ marginBottom: 2 }}>
              LSFG-VK Layer
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
              Vulkan frame generation by{" "}
              <span className="mono">PancakeTAS/lsfg-vk</span>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {install.installed ? (
              <span className="chip chip-success">Installed</span>
            ) : installing ? (
              <span className="chip">{progress || "Installing…"}</span>
            ) : (
              <span className="chip chip-danger">Not installed</span>
            )}
            <Button
              size="sm"
              onClick={onRecheck}
              disabled={installing || rechecking}
            >
              {rechecking ? "Checking…" : "Re-check"}
            </Button>
            {install.installed ? (
              <Button size="sm" onClick={onUninstall} disabled={installing}>
                Uninstall
              </Button>
            ) : (
              <Button
                size="sm"
                variant="accent"
                onClick={onInstall}
                disabled={installing}
              >
                {installing ? "Installing…" : "Install"}
              </Button>
            )}
          </div>
        </div>
        {installing && progress && (
          <div
            className="subsection-desc"
            style={{ marginTop: 10, fontSize: 12 }}
          >
            {progress}
          </div>
        )}
      </div>

      <div className="subsection">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: 8,
          }}
        >
          <div className="subsection-label" style={{ marginBottom: 0 }}>
            Layer version
          </div>
          <div style={{ minWidth: 180 }}>
            <Select
              value={install.layerVersion}
              options={LAYER_VERSION_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              onChange={(v) => {
                if (!installing) onSelectLayerVersion(v);
              }}
            />
          </div>
        </div>
        {versionDesc && (
          <div className="subsection-desc">{versionDesc}</div>
        )}
        {install.installed && install.installedVersion && (
          <div
            className="subsection-desc mono"
            style={{ marginTop: 4, fontSize: 11 }}
          >
            Installed: {install.installedVersion}
          </div>
        )}
      </div>
    </div>
  );
}
