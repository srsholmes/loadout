import type { ReactNode } from "react";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between items-center py-3 border-b border-base-300/50 last:border-b-0 min-h-[48px]">
      <span className="text-sm text-base-content/60">{label}</span>
      <span className="text-sm text-base-content font-medium">{children}</span>
    </div>
  );
}
