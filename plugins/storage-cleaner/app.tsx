import { useState, useEffect, useCallback, useMemo } from "react";
import { FaTrash } from "react-icons/fa6";
import {
  Button,
  Spinner,
  mountComponent,
  useBackend,
} from "@loadout/ui";
import { parseSizeToGB, bytesToGB, formatGB } from "./lib/size";
import type { DiskPartition } from "./lib/parse-df";

export { FaHardDrive as icon } from "react-icons/fa6";

interface GameEntry {
  appId: string;
  name: string;
  sizeBytes: number;
  sizeFormatted: string;
}

interface OrphanedEntry extends GameEntry {
  type: "shadercache" | "compatdata";
}

interface CacheData {
  total: number;
  totalFormatted: string;
  games: GameEntry[];
}

interface OrphanedData {
  total: number;
  totalFormatted: string;
  entries: OrphanedEntry[];
}

type CleanableKind = "shader" | "compat" | "orphanedShader" | "orphanedCompat";

interface CleanableRow {
  key: CleanableKind;
  name: string;
  why: string;
  bytes: number;
  appIds: string[];
  endpoint: "cleanShaderCache" | "cleanCompatData";
}

// --- Main Plugin Component ---

/** Swatch palette matching the Loadout spec, reused across categories. */
const CATEGORY_COLORS = [
  "oklch(0.55 0.12 230)",
  "oklch(0.6 0.18 30)",
  "oklch(0.7 0.18 90)",
  "oklch(0.5 0.12 285)",
  "oklch(0.65 0.18 180)",
  "oklch(0.5 0.02 260)",
];

function StorageCleaner() {
  const { call } = useBackend("storage-cleaner");

  const [loading, setLoading] = useState(true);
  const [diskUsage, setDiskUsage] = useState<DiskPartition[]>([]);
  const [shaderCache, setShaderCache] = useState<CacheData | null>(null);
  const [compatData, setCompatData] = useState<CacheData | null>(null);
  const [orphanedData, setOrphanedData] = useState<OrphanedData | null>(null);
  const [cleaning, setCleaning] = useState<CleanableKind | "all" | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setStatusMsg(null);
    try {
      const [disk, shader, compat, orphaned] = await Promise.all([
        call("getDiskUsage"),
        call("getShaderCacheSize"),
        call("getCompatDataSize"),
        call("getOrphanedData"),
      ]);
      setDiskUsage(disk as DiskPartition[]);
      setShaderCache(shader as CacheData);
      setCompatData(compat as CacheData);
      setOrphanedData(orphaned as OrphanedData);
    } catch (err) {
      setStatusMsg(`Failed to load data: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Pick the primary partition (usually `/` or the largest). Fallback to first.
  const primary = useMemo<DiskPartition | null>(() => {
    const first = diskUsage[0];
    if (first === undefined) return null; // empty list → no primary
    const rootMount = diskUsage.find((d) => d.mountpoint === "/");
    return rootMount ?? first;
  }, [diskUsage]);

  const totalGB = primary ? parseSizeToGB(primary.size) : 0;
  const usedGB  = primary ? parseSizeToGB(primary.used) : 0;
  const pctUsed = primary ? Math.min(100, Math.max(0, parseInt(primary.usePercent) || 0)) : 0;

  // Categories we can back with real data: shader cache + compat data.
  // Anything else on disk becomes "Other used".
  const categories = useMemo(() => {
    const shaderGB = shaderCache ? bytesToGB(shaderCache.total) : 0;
    const compatGB = compatData  ? bytesToGB(compatData.total)  : 0;
    const known = shaderGB + compatGB;
    const otherGB = Math.max(0, usedGB - known);
    return [
      { n: "Other used",   gb: otherGB,  c: CATEGORY_COLORS[0] },
      { n: "Shader caches", gb: shaderGB, c: CATEGORY_COLORS[2] },
      { n: "Compat data",  gb: compatGB, c: CATEGORY_COLORS[3] },
      { n: "Free",          gb: Math.max(0, totalGB - usedGB), c: CATEGORY_COLORS[5] },
    ].filter((c) => c.gb > 0.01);
  }, [shaderCache, compatData, usedGB, totalGB]);

  // Build cleanable rows from real backend data.
  const cleanables = useMemo<CleanableRow[]>(() => {
    const rows: CleanableRow[] = [];
    const orphanedShaderIds = orphanedData?.entries
      .filter((e) => e.type === "shadercache")
      .map((e) => e.appId) ?? [];
    const orphanedCompatIds = orphanedData?.entries
      .filter((e) => e.type === "compatdata")
      .map((e) => e.appId) ?? [];

    const orphanedShaderBytes = orphanedData?.entries
      .filter((e) => e.type === "shadercache")
      .reduce((a, b) => a + b.sizeBytes, 0) ?? 0;
    const orphanedCompatBytes = orphanedData?.entries
      .filter((e) => e.type === "compatdata")
      .reduce((a, b) => a + b.sizeBytes, 0) ?? 0;

    if (orphanedShaderIds.length > 0) {
      rows.push({
        key: "orphanedShader",
        name: "Orphaned shader caches",
        why: `${orphanedShaderIds.length} cache${orphanedShaderIds.length === 1 ? "" : "s"} from uninstalled games`,
        bytes: orphanedShaderBytes,
        appIds: orphanedShaderIds,
        endpoint: "cleanShaderCache",
      });
    }

    if (orphanedCompatIds.length > 0) {
      rows.push({
        key: "orphanedCompat",
        name: "Orphaned Proton compat data",
        why: `${orphanedCompatIds.length} prefix${orphanedCompatIds.length === 1 ? "" : "es"} from uninstalled games`,
        bytes: orphanedCompatBytes,
        appIds: orphanedCompatIds,
        endpoint: "cleanCompatData",
      });
    }

    if (shaderCache && shaderCache.games.length > 0) {
      rows.push({
        key: "shader",
        name: "Shader precache (all)",
        why: `${shaderCache.games.length} game${shaderCache.games.length === 1 ? "" : "s"} · auto-rebuilt per game, safe to clear`,
        bytes: shaderCache.total,
        appIds: shaderCache.games.map((g) => g.appId),
        endpoint: "cleanShaderCache",
      });
    }

    if (compatData && compatData.games.length > 0) {
      rows.push({
        key: "compat",
        name: "Proton compat data (all)",
        why: `${compatData.games.length} prefix${compatData.games.length === 1 ? "" : "es"} · Proton regenerates as needed`,
        bytes: compatData.total,
        appIds: compatData.games.map((g) => g.appId),
        endpoint: "cleanCompatData",
      });
    }

    return rows;
  }, [shaderCache, compatData, orphanedData]);

  const totalCleanableBytes = cleanables.reduce((a, r) => a + r.bytes, 0);

  const runClean = useCallback(
    async (row: CleanableRow) => {
      if (row.appIds.length === 0) return;
      setCleaning(row.key);
      setStatusMsg(null);
      try {
        const result = (await call(row.endpoint, row.appIds)) as {
          deleted: string[];
          errors: string[];
        };
        if (result.errors.length > 0) {
          setStatusMsg(`Errors: ${result.errors.join(", ")}`);
        } else {
          setStatusMsg(`Cleaned ${row.name}: ${result.deleted.length} item(s)`);
        }
        await loadAll();
      } catch (err) {
        setStatusMsg(`Clean failed: ${String(err)}`);
      } finally {
        setCleaning(null);
      }
    },
    [call, loadAll],
  );

  // "Safe" cleanables: only the orphaned rows. These are always safe because
  // the owning game is no longer installed — nothing to regenerate for.
  const handleCleanAllSafe = useCallback(async () => {
    const safeRows = cleanables.filter(
      (r) => r.key === "orphanedShader" || r.key === "orphanedCompat",
    );
    if (safeRows.length === 0) {
      setStatusMsg("Nothing safe to clean — no orphaned data found.");
      return;
    }
    setCleaning("all");
    setStatusMsg(null);
    const results: string[] = [];
    try {
      for (const row of safeRows) {
        const r = (await call(row.endpoint, row.appIds)) as {
          deleted: string[];
          errors: string[];
        };
        results.push(`${row.name}: ${r.deleted.length} deleted`);
        if (r.errors.length) results.push(`${row.name} errors: ${r.errors.join(", ")}`);
      }
      setStatusMsg(results.join(" · "));
      await loadAll();
    } catch (err) {
      setStatusMsg(`Clean failed: ${String(err)}`);
    } finally {
      setCleaning(null);
    }
  }, [call, cleanables, loadAll]);

  if (loading) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="flex items-center justify-center h-64">
            <Spinner size={32} />
          </div>
        </div>
      </div>
    );
  }

  const mountLabel = primary ? primary.mountpoint : "disk";

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          {/* Disk header + stacked bar + legend */}
          <div className="subsection">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 10,
              }}
            >
              <div>
                <div className="subsection-label" style={{ marginBottom: 2 }}>
                  {mountLabel === "/" ? "Internal SSD" : `Disk · ${mountLabel}`}
                </div>
                {primary ? (
                  <div className="metric-value mono" style={{ fontSize: 28 }}>
                    {formatGB(usedGB)}{" "}
                    <span style={{ fontSize: 13, color: "var(--fg-3)" }}>
                      / {formatGB(totalGB)} GB
                    </span>
                  </div>
                ) : (
                  <div className="metric-value mono" style={{ fontSize: 20, color: "var(--fg-3)" }}>
                    No disk data
                  </div>
                )}
              </div>
              {primary && <div className="chip">{pctUsed}% used</div>}
            </div>

            {primary && totalGB > 0 && (
              <>
                <div
                  style={{
                    display: "flex",
                    height: 14,
                    borderRadius: 8,
                    overflow: "hidden",
                    background: "var(--bg-inset)",
                  }}
                >
                  {categories.map((c) => (
                    <div
                      key={c.n}
                      title={`${c.n}: ${formatGB(c.gb)} GB`}
                      style={{ width: `${(c.gb / totalGB) * 100}%`, background: c.c }}
                    />
                  ))}
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 6,
                    marginTop: 12,
                  }}
                >
                  {categories.map((c) => (
                    <div
                      key={c.n}
                      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}
                    >
                      <div
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          background: c.c,
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          color: "var(--fg-2)",
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {c.n}
                      </span>
                      <span className="mono" style={{ color: "var(--fg-3)" }}>
                        {formatGB(c.gb)}G
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Cleanable */}
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
                Cleanable
              </div>
              {cleanables.length > 0 && (
                <div className="chip chip-accent">
                  {formatGB(bytesToGB(totalCleanableBytes))} GB total
                </div>
              )}
            </div>

            {cleanables.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--fg-3)", padding: "12px 0" }}>
                Nothing to clean — no shader caches, compat data, or orphaned entries found.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {cleanables.map((c) => {
                  const busy = cleaning !== null;
                  const thisBusy = cleaning === c.key || cleaning === "all";
                  return (
                    <div
                      key={c.key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: 12,
                        background: "var(--bg-inset)",
                        borderRadius: 10,
                      }}
                    >
                      <FaTrash size={14} style={{ color: "var(--fg-3)", flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                        <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2 }}>
                          {c.why}
                        </div>
                      </div>
                      <span
                        className="mono"
                        style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)" }}
                      >
                        {formatGB(bytesToGB(c.bytes))} GB
                      </span>
                      <Button size="sm" onClick={() => runClean(c)} disabled={busy}>
                        {thisBusy ? "Cleaning..." : "Clear"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {cleanables.length > 0 && (
              <Button
                variant="primary"
                style={{ marginTop: 14 }}
                onClick={handleCleanAllSafe}
                disabled={cleaning !== null}
              >
                <FaTrash size={12} />{" "}
                {cleaning === "all" ? "Cleaning safe items..." : "Clear all safe items"}
              </Button>
            )}

            {statusMsg && (
              <div
                style={{
                  marginTop: 12,
                  fontSize: 12,
                  color: statusMsg.toLowerCase().includes("error") || statusMsg.toLowerCase().includes("failed")
                    ? "var(--danger)"
                    : "var(--fg-2)",
                }}
              >
                {statusMsg}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Header ----------

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        Storage
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Shader caches, compat data, cleanup
      </span>
    </div>
  );
}

// ---------- Mount entry points ----------

export const mount = mountComponent(StorageCleaner);
export const mountHeader = mountComponent(Header);
