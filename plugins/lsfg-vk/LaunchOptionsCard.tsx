// Steam Launch Options preview card.
//
// Renders the `~/lsfg %command%` string the user can paste into a
// game's launch options, plus a Copy button that round-trips through
// the lsfg-vk backend's `copyToClipboard` RPC (so the copy works in
// gamescope too, where the webview's navigator.clipboard is blocked).
//
// Owns its own `useBackend("lsfg-vk")` handle rather than taking an
// untyped `call: (method, ...args) => Promise<unknown>` prop from the
// parent — keeping the typed-RPC contract isolated per component.
//
// Extracted from app.tsx as part of the D-010 decomposition.

import { Button, useBackend } from "@loadout/ui";

interface LaunchOptionsCardProps {
  launchOptions: string;
  flashStatus: (msg: string, ms: number) => void;
}

export function LaunchOptionsCard({
  launchOptions,
  flashStatus,
}: LaunchOptionsCardProps) {
  const { call } = useBackend("lsfg-vk");
  return (
    <div className="card">
      <div className="subsection">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <div className="subsection-label" style={{ marginBottom: 0 }}>
            Steam Launch Options
          </div>
          <Button
            size="sm"
            variant="accent"
            onClick={async () => {
              const res = (await call("copyToClipboard", launchOptions)) as {
                success: boolean;
                error?: string;
              };
              flashStatus(
                res.success
                  ? "Copied to clipboard"
                  : (res.error ?? "Failed to copy"),
                2000,
              );
            }}
          >
            Copy
          </Button>
        </div>
        <div
          className="mono"
          style={{
            fontSize: 11.5,
            color: "var(--fg-2)",
            background: "var(--bg-inset)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "10px 12px",
            wordBreak: "break-all",
          }}
        >
          {launchOptions}
        </div>
        <div className="subsection-desc">
          Paste into a game's Launch Options in Steam. The wrapper carries
          the layer config from <span className="mono">~/.config/lsfg-vk/conf.toml</span>.
        </div>
      </div>

      {/* Apply-to-game picker now lives in the default view —
          the gear icon flips between picker and settings. */}
    </div>
  );
}
