import { useState, useEffect, useCallback } from "react";
import {
  FaArrowsRotate,
  FaCheck,
  FaCubes,
  FaDownload,
  FaTrashCan,
} from "react-icons/fa6";
import {
  Button,
  IconButton,
  PluginHeader,
  SegmentedItem,
  Spinner,
  mountComponent,
  mountHeaderStub,
  useBackend,
} from "@loadout/ui";
import type { InstalledApp, UpdateInfo } from "./lib/parse";

export const icon = FaCubes;

type TabId = "installed" | "updates";

function FlatpakManager() {
  const { call, useEvent } = useBackend("flatpak-manager");

  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [updates, setUpdates] = useState<UpdateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  /** Distinct from `loading` — drives only the header refresh-icon
   *  spin so we don't flash the body's full-page spinner on every
   *  manual refresh. */
  const [refreshing, setRefreshing] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [removingUnused, setRemovingUnused] = useState(false);
  const [busyApps, setBusyApps] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<TabId>("installed");
  const [lastSync, setLastSync] = useState<Date>(() => new Date());

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [installed, available] = await Promise.all([
        call("getInstalled"),
        call("checkUpdates"),
      ]);
      setApps(installed as InstalledApp[]);
      setUpdates(available as UpdateInfo[]);
      setLastSync(new Date());
    } catch (err) {
      console.error("[flatpak-manager] Failed to refresh:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [call]);

  // Listen for update completion events from the backend
  useEvent({
    event: "updateComplete",
    handler: (data) => {
      const { type } = data as { type: string; appId?: string };
      if (type === "all") {
        setUpdatingAll(false);
        refresh();
      } else if (type === "single") {
        refresh();
      }
    },
  });

  // Fetch data on mount
  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleUpdateAll = useCallback(async () => {
    setUpdatingAll(true);
    try {
      await call("updateAll");
    } catch (err) {
      console.error("[flatpak-manager] Update all failed:", err);
    } finally {
      setUpdatingAll(false);
      refresh();
    }
  }, [call, refresh]);

  const handleUpdateApp = useCallback(
    async (appId: string) => {
      setBusyApps((prev) => new Set(prev).add(appId));
      try {
        await call("updateApp", appId);
        // Remove from updates list
        setUpdates((prev) => prev.filter((u) => u.appId !== appId));
      } catch (err) {
        console.error("[flatpak-manager] Update failed:", err);
      } finally {
        setBusyApps((prev) => {
          const next = new Set(prev);
          next.delete(appId);
          return next;
        });
        refresh();
      }
    },
    [call, refresh],
  );

  const handleRemoveUnused = useCallback(async () => {
    setRemovingUnused(true);
    try {
      const result = (await call("removeUnused")) as { removed: string[] };
      if (result.removed.length > 0) {
        refresh();
      }
    } catch (err) {
      console.error("[flatpak-manager] Remove unused failed:", err);
    } finally {
      setRemovingUnused(false);
    }
  }, [call, refresh]);

  /** Check whether a given app has an update available. */
  const getUpdate = (appId: string): UpdateInfo | undefined =>
    updates.find((u) => u.appId === appId);

  const updatable = updates.length;

  // Dynamic topbar header. Title + dynamic subtitle on the left;
  // segmented tab toggle + refresh + tab-specific bulk action on
  // the right. Same React tree as the body — `tab`, `apps`,
  // `updates`, and the bulk-action callbacks are shared by closure,
  // so the header stays in sync without any cross-root plumbing.
  const headerNode = (
    <PluginHeader>
      <div className="flex items-center justify-between gap-4 w-full min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
            Flatpak
          </h1>
          <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
            {loading
              ? "Loading…"
              : `${apps.length} apps · last sync ${formatRelative(lastSync)}`}
          </span>
        </div>

        {!loading && (
          <div className="flex items-center gap-2 shrink-0">
            {updatable > 0 && (
              <span className="chip chip-accent">{updatable} UPDATE</span>
            )}
            <div className="segmented flex">
              <SegmentedItem
                active={tab === "installed"}
                onSelect={() => setTab("installed")}
              >
                Installed ({apps.length})
              </SegmentedItem>
              <SegmentedItem
                active={tab === "updates"}
                onSelect={() => setTab("updates")}
              >
                Updates ({updatable})
              </SegmentedItem>
            </div>
            <IconButton
              onClick={refresh}
              disabled={refreshing}
              title={refreshing ? "Refreshing…" : "Refresh"}
              ariaLabel="Refresh"
            >
              <FaArrowsRotate
                size={11}
                className={refreshing ? "animate-spin" : ""}
              />
            </IconButton>
            {tab === "installed" && apps.length > 0 && (
              <IconButton
                onClick={handleRemoveUnused}
                disabled={removingUnused}
                title="Remove unused runtimes"
                ariaLabel="Remove unused runtimes"
              >
                {removingUnused ? (
                  <Spinner size={11} />
                ) : (
                  <FaTrashCan size={11} />
                )}
              </IconButton>
            )}
            {tab === "updates" && updatable > 0 && (
              <IconButton
                onClick={handleUpdateAll}
                disabled={updatingAll}
                title={updatingAll ? "Updating all…" : `Update all (${updatable})`}
                ariaLabel={`Update all (${updatable})`}
                variant="accent"
              >
                {updatingAll ? (
                  <Spinner size={11} />
                ) : (
                  <FaDownload size={11} />
                )}
              </IconButton>
            )}
          </div>
        )}
      </div>
    </PluginHeader>
  );

  if (loading) {
    return (
      <>
        {headerNode}
        <div className="p-7 h-full overflow-y-auto">
          <div className="page-content">
            <div className="flex items-center justify-center h-64">
              <Spinner size={32} />
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {headerNode}
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          {tab === "installed" && (
            apps.length === 0 ? (
              <div className="card">
                <div className="text-center py-10 text-[var(--fg-3)]">
                  No Flatpak applications installed.
                </div>
              </div>
            ) : (
              <div className="grid gap-1.5">
                {apps.map((app) => {
                  const update = getUpdate(app.appId);
                  const isBusy = busyApps.has(app.appId);
                  return (
                    <AppRow
                      key={app.appId}
                      app={app}
                      update={update}
                      isBusy={isBusy}
                      disabled={updatingAll}
                      onUpdate={() => handleUpdateApp(app.appId)}
                    />
                  );
                })}
              </div>
            )
          )}

          {tab === "updates" && (
            updatable === 0 ? (
              <div className="card">
                <div className="text-center py-10 text-[var(--fg-3)]">
                  <FaCheck className="mx-auto w-7 h-7" />
                  <div className="mt-2.5">Everything is up to date</div>
                </div>
              </div>
            ) : (
              <div className="grid gap-1.5">
                {updates.map((u) => {
                  const isBusy = busyApps.has(u.appId);
                  return (
                    <div
                      key={u.appId}
                      className="flex items-center gap-3.5 p-3 bg-[var(--bg-inset)] rounded-[10px]"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-[13.5px] font-semibold truncate">
                          {u.name}
                        </div>
                        <div className="mono text-[11px] text-[var(--fg-3)] truncate">
                          {u.appId} · → v{u.newVersion}
                        </div>
                      </div>
                      {isBusy ? (
                        <Spinner size={16} />
                      ) : (
                        <IconButton
                          onClick={() => handleUpdateApp(u.appId)}
                          disabled={updatingAll}
                          title={`Update ${u.name}`}
                          ariaLabel={`Update ${u.name}`}
                          variant="accent"
                        >
                          <FaDownload size={11} />
                        </IconButton>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      </div>
    </>
  );
}

/** Single installed-app row with icon tile + metadata + action. */
function AppRow({
  app,
  update,
  isBusy,
  disabled,
  onUpdate,
}: {
  app: InstalledApp;
  update: UpdateInfo | undefined;
  isBusy: boolean;
  disabled: boolean;
  onUpdate: () => void;
}) {
  const initials = app.name
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim()
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: 12,
        background: "var(--bg-inset)",
        borderRadius: 10,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: "var(--bg-2)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          color: "var(--fg-2)",
          fontWeight: 700,
          fontSize: 14,
        }}
      >
        {initials || "??"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="flex items-center gap-2"
          style={{ fontSize: 13.5, fontWeight: 600 }}
        >
          <span className="truncate">{app.name}</span>
          {update && <span className="chip chip-accent">UPDATE</span>}
        </div>
        <div
          className="mono truncate"
          style={{ fontSize: 10.5, color: "var(--fg-3)" }}
        >
          {app.appId}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: "var(--fg-3)",
            marginTop: 2,
          }}
        >
          v{app.version}
          {update ? ` → v${update.newVersion}` : ""} · {app.origin}
        </div>
      </div>
      <span
        className="mono"
        style={{ fontSize: 11, color: "var(--fg-3)", flexShrink: 0 }}
      >
        {app.size}
      </span>
      {isBusy ? (
        <Spinner size={16} />
      ) : update ? (
        <IconButton
          onClick={onUpdate}
          disabled={disabled}
          title={`Update ${app.name}`}
          ariaLabel={`Update ${app.name}`}
          variant="accent"
        >
          <FaDownload size={11} />
        </IconButton>
      ) : null}
    </div>
  );
}

/** Format a timestamp as a coarse "N minutes ago" / "just now" string. */
function formatRelative(d: Date): string {
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Compact sidebar widget showing update count and quick update button.
 */
function FlatpakWidget() {
  const { call } = useBackend("flatpak-manager");

  const [updateCount, setUpdateCount] = useState<number | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    call("checkUpdates")
      .then((result) => {
        const updates = result as UpdateInfo[];
        setUpdateCount(updates.length);
      })
      .catch(() => setError(true));
  }, [call]);

  const handleUpdateAll = useCallback(async () => {
    setUpdating(true);
    try {
      await call("updateAll");
      setUpdateCount(0);
    } catch {
      // ignore
    } finally {
      setUpdating(false);
    }
  }, [call]);

  if (error) {
    return (
      <div className="px-3.5 py-2.5">
        <div className="flex justify-between items-center">
          <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
            Flatpak
          </span>
          <span className="text-xs italic text-base-content/60">
            unavailable
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-3.5 py-2.5">
      <div className="flex justify-between items-center">
        <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
          Flatpak
        </span>
        <span className="text-base font-bold text-base-content">
          {updateCount !== null ? `${updateCount} updates` : "..."}
        </span>
      </div>
      {updateCount !== null && updateCount > 0 && (
        <div className="mt-1.5">
          {updating ? (
            <div className="flex items-center gap-2">
              <Spinner size={14} />
              <span className="text-xs text-base-content/60">Updating...</span>
            </div>
          ) : (
            <Button
              variant="primary"
              onClick={handleUpdateAll}
              style={{ width: "100%", fontSize: "0.75rem", padding: "4px 8px" }}
            >
              Update All
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Keep FlatpakWidget referenced so the tree-shaker doesn't drop it while
// it's not yet wired up as a home widget.
void FlatpakWidget;

/** Mount this plugin into a container element. */
export const mount = mountComponent(FlatpakManager);

/**
 * Stub `mountHeader` export. Its mere presence is what tells the
 * overlay shell to reserve the 60px topbar slot — the actual header
 * content is portaled from inside `mount()` via `<PluginHeader>` so
 * tab state, app/update counts, and the bulk-action callbacks share
 * the body's React tree without any cross-root pub/sub.
 */
export const mountHeader = mountHeaderStub;
