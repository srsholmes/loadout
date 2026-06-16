// Custom Lossless.dll detection + path-override field.
//
// Lossless Scaling is a paid Steam app — its `Lossless.dll` is what
// lsfg-vk loads. We auto-detect it across the user's Steam libraries
// at install time; if it's not on the default library, the user can
// point at a custom path here.

import { Button, TextInput } from "@loadout/ui";

import type { DllStatus } from "./lib/types";

interface CustomDllFieldProps {
  dll: DllStatus;
  customDllInput: string;
  rechecking: boolean;
  onCustomDllChange: (value: string) => void;
  onApplyCustomDll: () => void;
  onRecheck: () => void;
}

export function CustomDllField({
  dll,
  customDllInput,
  rechecking,
  onCustomDllChange,
  onApplyCustomDll,
  onRecheck,
}: CustomDllFieldProps) {
  return (
    <div className="card">
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
            Lossless.dll
          </div>
          <div className="flex items-center gap-2.5">
            {dll.found ? (
              <span className="chip chip-success">
                Found {dll.isCustom ? "(custom)" : ""}
              </span>
            ) : (
              <span className="chip chip-danger">Missing</span>
            )}
            <Button size="sm" onClick={onRecheck} disabled={rechecking}>
              {rechecking ? "Checking…" : "Re-check"}
            </Button>
          </div>
        </div>
        <div className="subsection-desc" style={{ marginBottom: 8 }}>
          {dll.found
            ? dll.path
            : "Lossless Scaling must be installed via Steam (paid app). Set a custom path if your Steam library is non-default."}
        </div>
        <div className="flex items-center gap-2">
          <TextInput
            value={customDllInput}
            onChange={(v) => onCustomDllChange(v)}
            placeholder="/path/to/Lossless.dll (optional)"
            style={{ flex: 1 }}
          />
          <Button size="sm" onClick={onApplyCustomDll}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
