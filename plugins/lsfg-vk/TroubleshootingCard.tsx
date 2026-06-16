// Diagnostics / troubleshooting card.
//
// Owns the "Verify layer loaded" + "Test with vkcube" buttons, the
// inline VulkanCheck result panel, and the verbose-logging toggle.

import { useState } from "react";
import { Button, Toggle, useBackend } from "@loadout/ui";

import type { LsfgSettings, VulkanCheck } from "./lib/types";

interface TroubleshootingCardProps {
  flashStatus: (msg: string, ms: number) => void;
  verboseLogging: boolean;
  onUpdateSetting: <K extends keyof LsfgSettings>(
    key: K,
    value: LsfgSettings[K],
  ) => void;
}

export function TroubleshootingCard({
  flashStatus,
  verboseLogging,
  onUpdateSetting,
}: TroubleshootingCardProps) {
  const { call } = useBackend("lsfg-vk");
  const [vulkanCheck, setVulkanCheck] = useState<VulkanCheck | null>(null);
  const [checkingVulkan, setCheckingVulkan] = useState(false);

  return (
    <div className="card">
      <div className="subsection">
        <div className="subsection-label">Diagnostics</div>
        <div className="subsection-desc" style={{ marginBottom: 10 }}>
          Most FPS overlays show submitted frames, not presented frames —
          so you can have framegen working and see no number change.
          vkcube prints actual presented FPS in its title bar; toggle Off /
          2× / 3× between launches to verify.
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={checkingVulkan}
            onClick={async () => {
              setCheckingVulkan(true);
              try {
                const result = (await call("runVulkanCheck")) as VulkanCheck;
                setVulkanCheck(result);
              } finally {
                setCheckingVulkan(false);
              }
            }}
          >
            {checkingVulkan ? "Checking…" : "Verify layer loaded"}
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              const res = (await call("launchVkcube")) as {
                success: boolean;
                error?: string;
              };
              flashStatus(
                res.success
                  ? "vkcube launched — check title bar FPS"
                  : (res.error ?? "Failed to launch vkcube"),
                4000,
              );
            }}
          >
            Test with vkcube
          </Button>
        </div>

        {vulkanCheck && (
          <div
            style={{
              marginTop: 10,
              padding: "10px 12px",
              background: "var(--bg-inset)",
              border: `1px solid ${
                vulkanCheck.layerLoaded
                  ? "var(--accent)"
                  : "var(--color-error, #c33)"
              }`,
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            <div style={{ marginBottom: 6, fontWeight: 600 }}>
              {vulkanCheck.layerLoaded
                ? "✓ Layer is loaded by Vulkan"
                : vulkanCheck.jsonExists
                ? "✗ Layer JSON on disk but not loaded"
                : "✗ Layer not installed"}
            </div>
            <div
              className="mono"
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                fontSize: 11,
                color: "var(--fg-2)",
              }}
            >
              {vulkanCheck.excerpt}
            </div>
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
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div className="subsection-label" style={{ marginBottom: 2 }}>
              Verbose logging
            </div>
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
              Adds <span className="mono">LSFG_LOG=1</span> +{" "}
              <span className="mono">VK_LOADER_DEBUG=layer</span> to the
              wrapper. Inspect with{" "}
              <span className="mono">journalctl --user -f</span> while the
              game is launching.
            </div>
          </div>
          <Toggle
            checked={verboseLogging}
            onChange={(v) => onUpdateSetting("verbose_logging", v)}
          />
        </div>
      </div>
    </div>
  );
}
