// "LSFG-VK is not installed" placeholder shown on the picker view
// when the layer hasn't been installed yet. Steers the user toward
// the gear icon (which opens settings, where the Install button
// lives).

export function NotInstalledCard() {
  return (
    <div className="card">
      <div className="subsection">
        <div className="subsection-label">LSFG-VK is not installed</div>
        <div className="subsection-desc">
          Open settings (gear icon, top right) to install the
          Vulkan layer first. Once installed, the apply-to-game
          picker will appear here.
        </div>
      </div>
    </div>
  );
}
