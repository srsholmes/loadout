/**
 * Pure backlog helpers — status transitions and manual ordering, with no
 * I/O or clock of their own (callers pass `now`). Unit-tested in
 * `backlog.test.ts`.
 */

import type { BacklogEntry, BacklogStatus } from "./types";

/** Status cycle order, also the display grouping order. */
export const STATUS_ORDER: readonly BacklogStatus[] = [
  "playing",
  "toPlay",
  "beaten",
  "dropped",
];

export const STATUS_LABELS: Record<BacklogStatus, string> = {
  toPlay: "To Play",
  playing: "Playing",
  beaten: "Beaten",
  dropped: "Dropped",
};

/** Next status when the user taps the status chip. Cycles
 *  To Play → Playing → Beaten → Dropped → To Play. */
export function nextStatus(status: BacklogStatus): BacklogStatus {
  const cycle: BacklogStatus[] = ["toPlay", "playing", "beaten", "dropped"];
  const i = cycle.indexOf(status);
  return cycle[(i + 1) % cycle.length]!;
}

/** Backlog sorted by manual order (ascending), returned as a new array. */
export function sortBacklog(backlog: BacklogEntry[]): BacklogEntry[] {
  return backlog.slice().sort((a, b) => a.order - b.order);
}

/** True when a game is already in the backlog. */
export function inBacklog(backlog: BacklogEntry[], appId: string): boolean {
  return backlog.some((e) => e.appId === appId);
}

/** Add a game to the backlog (no-op if already present). New entries land
 *  at the end of the manual order with status "toPlay". */
export function addToBacklog(
  backlog: BacklogEntry[],
  appId: string,
  now: number,
): BacklogEntry[] {
  if (inBacklog(backlog, appId)) return backlog;
  const maxOrder = backlog.reduce((m, e) => Math.max(m, e.order), -1);
  return [
    ...backlog,
    { appId, status: "toPlay", order: maxOrder + 1, addedAt: now },
  ];
}

/** Remove a game from the backlog. */
export function removeFromBacklog(
  backlog: BacklogEntry[],
  appId: string,
): BacklogEntry[] {
  return backlog.filter((e) => e.appId !== appId);
}

/** Set an explicit status on a backlog entry. */
export function setBacklogStatus(
  backlog: BacklogEntry[],
  appId: string,
  status: BacklogStatus,
): BacklogEntry[] {
  return backlog.map((e) => (e.appId === appId ? { ...e, status } : e));
}

/** Advance a game to its next status in the cycle. */
export function cycleBacklogStatus(
  backlog: BacklogEntry[],
  appId: string,
): BacklogEntry[] {
  return backlog.map((e) =>
    e.appId === appId ? { ...e, status: nextStatus(e.status) } : e,
  );
}

/**
 * Move a game one slot up or down in the manual order. Operates on the
 * order-sorted list and swaps `order` values with the adjacent entry, so
 * the result is stable regardless of gaps in the stored order numbers.
 */
export function reorderBacklog(
  backlog: BacklogEntry[],
  appId: string,
  direction: "up" | "down",
): BacklogEntry[] {
  const sorted = sortBacklog(backlog);
  const idx = sorted.findIndex((e) => e.appId === appId);
  if (idx === -1) return backlog;
  const swapWith = direction === "up" ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= sorted.length) return backlog;

  const a = sorted[idx]!;
  const b = sorted[swapWith]!;
  const aOrder = a.order;
  const bOrder = b.order;
  return backlog.map((e) => {
    if (e.appId === a.appId) return { ...e, order: bOrder };
    if (e.appId === b.appId) return { ...e, order: aOrder };
    return e;
  });
}

/** Swap the manual `order` of two entries by appId. Used to reorder
 *  within a status group, where the two rows are visually adjacent but
 *  may not be adjacent in the global order. No-op if either is missing. */
export function swapBacklogOrder(
  backlog: BacklogEntry[],
  aAppId: string,
  bAppId: string,
): BacklogEntry[] {
  const a = backlog.find((e) => e.appId === aAppId);
  const b = backlog.find((e) => e.appId === bAppId);
  if (!a || !b) return backlog;
  return backlog.map((e) => {
    if (e.appId === aAppId) return { ...e, order: b.order };
    if (e.appId === bAppId) return { ...e, order: a.order };
    return e;
  });
}

/** Group the backlog by status in display order, each group sorted by
 *  manual order. Empty groups are omitted. */
export function groupBacklog(
  backlog: BacklogEntry[],
): Array<{ status: BacklogStatus; entries: BacklogEntry[] }> {
  const sorted = sortBacklog(backlog);
  return STATUS_ORDER.map((status) => ({
    status,
    entries: sorted.filter((e) => e.status === status),
  })).filter((g) => g.entries.length > 0);
}
