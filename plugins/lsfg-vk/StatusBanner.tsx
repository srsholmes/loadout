// Tiny error/status banner shown at the top of both views (picker +
// settings). Renders inside its own card so it sits flush with the
// rest of the page content. Caller is expected to gate visibility on
// the truthiness of `message` already, but we double-check here so
// stale empty strings can't print an empty card.
//
// Extracted from app.tsx as part of the D-010 decomposition.

interface StatusBannerProps {
  message: string;
}

export function StatusBanner({ message }: StatusBannerProps) {
  if (!message) return null;
  return (
    <div className="card">
      <div className="subsection">
        <div
          className="subsection-label"
          style={{ color: "var(--color-error)", marginBottom: 6 }}
        >
          Error
        </div>
        <div style={{ fontSize: 13 }}>{message}</div>
      </div>
    </div>
  );
}
