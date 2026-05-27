// Install / Uninstall card.
//
// The "is the layer on disk?" row with the Install or Uninstall
// button. Stateless — apply / uninstall handlers are passed in by
// the parent (LsfgVkManager) so this component doesn't have to know
// the `lsfg-vk` backend exists.
//
// Lossless.dll detection lives in its own `CustomDllField` card now —
// the two used to share this file but had zero state in common
// (PR #103 review medium).
//
// Extracted from app.tsx as part of the D-010 decomposition.

import { Button } from "@loadout/ui";

import type { InstallStatus } from "./lib/types";

interface InstallCardProps {
  install: InstallStatus;
  installing: boolean;
  progress: string;
  onInstall: () => void;
  onUninstall: () => void;
}

export function InstallCard({
  install,
  installing,
  progress,
  onInstall,
  onUninstall,
}: InstallCardProps) {
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
    </div>
  );
}
