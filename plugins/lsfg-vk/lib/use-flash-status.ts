// Auto-clearing status-banner hook. Returns the current message + a
// flash() function the caller pipes RPC errors / "Copied!" notices /
// vkcube launch results into.
//
// Single timer slot — keeping the id in a ref means (a) a new
// flash() call cancels the previous timer (no stale "Copied!" wiping
// a newer error), and (b) the cleanup effect clears it on unmount so
// React's "setState on unmounted component" warning doesn't fire if
// the user navigates away while a message is still in-flight.
//
// Extracted from app.tsx's inline timer logic as part of the D-010
// decomposition. No behaviour change.

import { useCallback, useEffect, useRef, useState } from "react";

export function useFlashStatus(): {
  statusMsg: string;
  flashStatus: (msg: string, ms: number) => void;
} {
  const [statusMsg, setStatusMsg] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashStatus = useCallback((msg: string, ms: number) => {
    setStatusMsg(msg);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setStatusMsg("");
      timerRef.current = null;
    }, ms);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { statusMsg, flashStatus };
}
