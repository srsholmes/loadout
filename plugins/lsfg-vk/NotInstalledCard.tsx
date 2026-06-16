// "LSFG-VK is not installed" placeholder shown on the picker view
// when the layer hasn't been installed yet. Steers the user toward
// the gear icon (which opens settings, where the Install button
// lives), and offers a Re-check in case the layer was just installed
// out-of-band (no event fires for that, so the status stays stale).

import { Button } from "@loadout/ui";

interface NotInstalledCardProps {
  rechecking: boolean;
  onRecheck: () => void;
}

export function NotInstalledCard({
  rechecking,
  onRecheck,
}: NotInstalledCardProps) {
  return (
    <div className="card">
      <div className="subsection">
        <div className="subsection-label">LSFG-VK is not installed</div>
        <div className="subsection-desc">
          Open settings (gear icon, top right) to install the
          Vulkan layer first. Once installed, the apply-to-game
          picker will appear here.
        </div>
        <div style={{ marginTop: 12 }}>
          <Button size="sm" onClick={onRecheck} disabled={rechecking}>
            {rechecking ? "Checking…" : "Re-check installation"}
          </Button>
        </div>
      </div>
    </div>
  );
}
