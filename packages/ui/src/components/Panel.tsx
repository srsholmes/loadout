import type { ReactNode } from "react";

export function Panel({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-base-200 border border-base-300 rounded-2xl p-5 mb-5">
      {title && (
        <h3 className="text-xs font-bold uppercase tracking-wider text-base-content/40 mb-4">
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}
