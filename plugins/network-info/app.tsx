import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { FaWifi, FaArrowsRotate } from "react-icons/fa6";
import { Button, PluginProvider, useBackend } from "@loadout/ui";
import {
  fmtSpeed,
  fmtLatency,
  fmtTime,
  signalLabel,
  CF_DATACENTERS,
  type NetworkInterface,
  type ConnectionInfo,
} from "./lib/network";

export { FaNetworkWired as icon } from "react-icons/fa6";

// --- Cloudflare Speed Test ---

async function fetchCloudflareLocation(): Promise<string | null> {
  try {
    const res = await fetch("https://speed.cloudflare.com/cdn-cgi/trace", {
      cache: "no-store",
    });
    const text = await res.text();
    const match = text.match(/colo=(\w+)/);
    if (match) return CF_DATACENTERS[match[1]] || match[1];
    return null;
  } catch {
    return null;
  }
}

/**
 * `crypto.getRandomValues` is capped at 65 536 bytes per call by the
 * Web Crypto spec; Chromium (and therefore CEF, where the overlay
 * runs) enforces it strictly, Bun and most test runners don't. Without
 * chunking, the multi-MB upload buffer below throws
 * `QuotaExceededError` the moment we try to seed it — which was the
 * actual cause of the speed test bailing with "Test failed" the
 * instant the upload phase started.
 */
function fillRandom(buf: Uint8Array): void {
  const CHUNK = 65536;
  for (let off = 0; off < buf.length; off += CHUNK) {
    crypto.getRandomValues(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
  }
}

interface SpeedResults {
  download: number | null;
  upload: number | null;
  latency: number | null;
  jitter: number | null;
  downloadLatency: number | null;
  downloadJitter: number | null;
  uploadLatency: number | null;
  uploadJitter: number | null;
  measuredAt: Date | null;
}

type Phase = "idle" | "latency" | "download" | "upload" | "done";

interface Measurement {
  bytes: number;
  bps: number;
  duration: number;
}

class SpeedTestEngine {
  private abortController: AbortController | null = null;
  private isRunning = false;

  onProgress: (results: SpeedResults, phase: Phase) => void = () => {};
  onComplete: (results: SpeedResults) => void = () => {};
  onError: (msg: string) => void = () => {};
  onChartUpdate: (
    type: "download" | "upload",
    points: number[],
    p90: number,
  ) => void = () => {};

  private MIN_DURATION_MS = 10;
  private MAX_DURATION_MS = 1000;
  private BANDWIDTH_PERCENTILE = 0.9;
  private LATENCY_PERCENTILE = 0.5;

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();

    const results: SpeedResults = {
      download: null,
      upload: null,
      latency: null,
      jitter: null,
      downloadLatency: null,
      downloadJitter: null,
      uploadLatency: null,
      uploadJitter: null,
      measuredAt: null,
    };

    try {
      this.onProgress(results, "latency");
      const lat = await this.measureLatency();
      results.latency = lat.latency;
      results.jitter = lat.jitter;
      this.onProgress(results, "latency");
      if (this.aborted()) return;

      this.onProgress(results, "download");
      const dl = await this.measureDownload(results);
      results.download = dl.speed;
      results.downloadLatency = dl.latency;
      results.downloadJitter = dl.jitter;
      this.onProgress(results, "download");
      if (this.aborted()) return;

      this.onProgress(results, "upload");
      const ul = await this.measureUpload(results);
      results.upload = ul.speed;
      results.uploadLatency = ul.latency;
      results.uploadJitter = ul.jitter;
      results.measuredAt = new Date();
      this.onProgress(results, "done");
      this.onComplete(results);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      this.onError(e instanceof Error ? e.message : String(e));
    } finally {
      this.isRunning = false;
    }
  }

  stop() {
    this.isRunning = false;
    this.abortController?.abort();
  }

  private aborted() {
    return this.abortController?.signal.aborted ?? false;
  }
  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(i, sorted.length - 1))];
  }

  private calcBandwidth(points: Measurement[]): number {
    const valid = points.filter((p) => p.duration >= this.MIN_DURATION_MS);
    if (valid.length === 0) return 0;
    const speeds = valid.map((p) => p.bps).sort((a, b) => a - b);
    return this.percentile(speeds, this.BANDWIDTH_PERCENTILE);
  }

  private calcLatencyStats(latencies: number[]) {
    if (latencies.length === 0) return { latency: 0, jitter: 0 };
    const sorted = [...latencies].sort((a, b) => a - b);
    const latency = this.percentile(sorted, this.LATENCY_PERCENTILE);
    const jitter =
      latencies.reduce((s, p) => s + Math.abs(p - latency), 0) /
      latencies.length;
    return { latency, jitter };
  }

  private async singlePing(): Promise<number> {
    try {
      const start = performance.now();
      await fetch(
        `https://speed.cloudflare.com/__down?bytes=0&r=${Math.random()}`,
        {
          signal: this.abortController?.signal,
          cache: "no-store",
        },
      );
      return performance.now() - start;
    } catch {
      return 0;
    }
  }

  private async measureLatency() {
    const pings: number[] = [];
    for (let i = 0; i < 20; i++) {
      if (this.aborted()) break;
      const d = await this.singlePing();
      if (d > 0) pings.push(d);
      await this.sleep(50);
    }
    return this.calcLatencyStats(pings);
  }

  private async measureDownload(results: SpeedResults) {
    const configs = [
      { bytes: 100000, count: 4 },
      { bytes: 1000000, count: 4 },
      { bytes: 5000000, count: 3 },
      { bytes: 10000000, count: 3 },
      { bytes: 25000000, count: 2 },
    ];
    return this.measureTransfer("download", configs, results, async (bytes) => {
      const res = await fetch(
        `https://speed.cloudflare.com/__down?bytes=${bytes}&r=${Math.random()}`,
        {
          signal: this.abortController?.signal,
          cache: "no-store",
        },
      );
      const blob = await res.blob();
      return blob.size;
    });
  }

  private async measureUpload(results: SpeedResults) {
    const configs = [
      { bytes: 100000, count: 4 },
      { bytes: 500000, count: 3 },
      { bytes: 1000000, count: 3 },
      { bytes: 5000000, count: 2 },
    ];
    const maxBytes = Math.max(...configs.map((c) => c.bytes));
    const randomData = new Uint8Array(maxBytes);
    fillRandom(randomData);

    return this.measureTransfer("upload", configs, results, async (bytes) => {
      const data = randomData.slice(0, bytes);
      await fetch("https://speed.cloudflare.com/__up", {
        method: "POST",
        body: new Blob([data]),
        signal: this.abortController?.signal,
      });
      return bytes;
    });
  }

  private async measureTransfer(
    type: "download" | "upload",
    configs: { bytes: number; count: number }[],
    results: SpeedResults,
    transfer: (bytes: number) => Promise<number>,
  ) {
    const measurements: Measurement[] = [];
    const loadedLatencies: number[] = [];
    let shouldStop = false;

    for (const config of configs) {
      if (this.aborted() || shouldStop) break;
      for (let i = 0; i < config.count; i++) {
        if (this.aborted() || shouldStop) break;
        try {
          const latencyP = this.singlePing();
          const start = performance.now();
          const actualBytes = await transfer(config.bytes);
          const duration = performance.now() - start;
          const bps = (actualBytes * 8) / (duration / 1000);
          measurements.push({ bytes: config.bytes, bps, duration });

          const lat = await latencyP;
          if (lat > 0) loadedLatencies.push(lat);

          const speed = this.calcBandwidth(measurements);
          const latStats = this.calcLatencyStats(loadedLatencies);

          if (type === "download") {
            results.download = speed;
            results.downloadLatency = latStats.latency;
            results.downloadJitter = latStats.jitter;
          } else {
            results.upload = speed;
            results.uploadLatency = latStats.latency;
            results.uploadJitter = latStats.jitter;
          }
          this.onProgress(results, type);
          this.onChartUpdate(
            type,
            measurements.map((m) => m.bps),
            speed,
          );

          if (duration > this.MAX_DURATION_MS) {
            shouldStop = true;
            break;
          }
        } catch {
          /* continue */
        }
      }
    }

    const speed = this.calcBandwidth(measurements);
    const { latency, jitter } = this.calcLatencyStats(loadedLatencies);
    return { speed, latency, jitter };
  }
}

// --- Animated number ---

function useAnimatedValue(target: number | null, duration = 500): number | null {
  const [display, setDisplay] = useState(target);
  const animRef = useRef<number | null>(null);
  const startRef = useRef(0);
  const startValRef = useRef(0);
  const displayRef = useRef(display);
  displayRef.current = display;

  useEffect(() => {
    if (target === null) {
      setDisplay(null);
      return;
    }
    startValRef.current = displayRef.current ?? 0;
    startRef.current = performance.now();

    const animate = (now: number) => {
      const progress = Math.min((now - startRef.current) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(startValRef.current + (target - startValRef.current) * eased);
      if (progress < 1) animRef.current = requestAnimationFrame(animate);
    };
    animRef.current = requestAnimationFrame(animate);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [target, duration]);

  return display;
}

function AnimatedNumber({
  value,
  format,
}: {
  value: number | null;
  format: (v: number | null) => string;
}) {
  const animated = useAnimatedValue(value);
  return <>{format(animated)}</>;
}

// --- Main Plugin ---

function NetworkInfo() {
  const { call } = useBackend("network-info");

  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);

  // Speed test state
  const [status, setStatus] = useState<"idle" | "running" | "finished" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<SpeedResults>({
    download: null,
    upload: null,
    latency: null,
    jitter: null,
    downloadLatency: null,
    downloadJitter: null,
    uploadLatency: null,
    uploadJitter: null,
    measuredAt: null,
  });
  const [server, setServer] = useState<string | null>(null);
  const engineRef = useRef<SpeedTestEngine | null>(null);

  useEffect(() => {
    call("getNetworkInfo")
      .then((info) => setInterfaces(info as NetworkInterface[]))
      .catch(() => {});
    call("getConnectionInfo")
      .then((info) => setConnectionInfo(info as ConnectionInfo))
      .catch(() => {});
  }, [call]);

  useEffect(() => {
    fetchCloudflareLocation().then(setServer);
  }, []);

  const handleRefresh = useCallback(async () => {
    call("getNetworkInfo")
      .then((info) => setInterfaces(info as NetworkInterface[]))
      .catch(() => {});
    call("getConnectionInfo")
      .then((info) => setConnectionInfo(info as ConnectionInfo))
      .catch(() => {});
  }, [call]);

  const startTest = useCallback(() => {
    engineRef.current?.stop();
    setErrorMsg(null);
    setResults({
      download: null,
      upload: null,
      latency: null,
      jitter: null,
      downloadLatency: null,
      downloadJitter: null,
      uploadLatency: null,
      uploadJitter: null,
      measuredAt: null,
    });

    const engine = new SpeedTestEngine();
    engine.onProgress = (r, p) => {
      setResults((prev) => ({ ...prev, ...r }));
      setPhase(p);
    };
    engine.onComplete = (r) => {
      setResults(r);
      setStatus("finished");
      setPhase("done");
    };
    engine.onError = (msg) => {
      setErrorMsg(msg);
      setStatus("error");
    };

    engineRef.current = engine;
    setStatus("running");
    engine.start();
  }, []);

  useEffect(() => {
    return () => {
      engineRef.current?.stop();
    };
  }, []);

  const phaseLabel =
    phase === "latency"
      ? "Testing latency…"
      : phase === "download"
        ? "Testing download…"
        : phase === "upload"
          ? "Testing upload…"
          : "";

  // Pick primary interface — first non-lo with state up, or just first
  const primaryIface =
    interfaces.find((i) => i.state === "up") ?? interfaces[0] ?? null;
  const isWifi = primaryIface?.type === "WiFi";
  const ssid = connectionInfo?.ssid ?? null;
  const connected = primaryIface?.state === "up";
  const signal = connectionInfo?.signal ?? null;

  // Header subtitle — security / channel-ish info from what's available
  const headerSubParts: string[] = [];
  if (isWifi) {
    if (connectionInfo?.frequency) headerSubParts.push(connectionInfo.frequency);
    if (connectionInfo?.bitRate) headerSubParts.push(connectionInfo.bitRate);
  } else if (primaryIface) {
    headerSubParts.push(primaryIface.type);
    headerSubParts.push(primaryIface.name);
  }
  const headerSub = headerSubParts.length > 0 ? headerSubParts.join(" · ") : "--";

  const headerTitle = ssid ?? primaryIface?.name ?? "Network";

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          {/* SSID HEADER */}
          <div className="subsection">
            <div className="flex items-center gap-3.5">
              <div
                className="rounded-xl flex items-center justify-center shrink-0"
                style={{
                  width: 44,
                  height: 44,
                  background: "var(--accent-soft)",
                  color: "var(--accent)",
                }}
              >
                <FaWifi className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-semibold truncate">{headerTitle}</div>
                <div className="mono text-[11.5px] text-base-content/50 truncate">
                  {headerSub}
                </div>
              </div>
              <span className={connected ? "chip chip-success" : "chip"}>
                ● {connected ? "CONNECTED" : "DISCONNECTED"}
              </span>
              <Button onClick={handleRefresh}>
                <FaArrowsRotate className="w-3.5 h-3.5" /> Refresh
              </Button>
            </div>
          </div>

          {/* THROUGHPUT */}
          <div className="subsection">
            <div className="flex items-center justify-between mb-2">
              <div className="subsection-label mb-0">
                Throughput{server ? ` · ${server}` : ""}
              </div>
              {status === "idle" && (
                <Button variant="primary" onClick={startTest}>
                  Run Speed Test
                </Button>
              )}
              {status === "running" && (
                <Button
                  onClick={() => {
                    engineRef.current?.stop();
                    setStatus("finished");
                  }}
                >
                  Stop
                </Button>
              )}
              {(status === "finished" || status === "error") && (
                <Button variant="primary" onClick={startTest}>
                  Retest
                </Button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div
                style={{
                  background: "var(--bg-inset)",
                  padding: 16,
                  borderRadius: 10,
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--fg-3)",
                    letterSpacing: "0.08em",
                    marginBottom: 4,
                  }}
                >
                  ↓ DOWNLOAD
                </div>
                <div
                  className="metric-value mono"
                  style={{ fontSize: 28, color: "var(--color-success)" }}
                >
                  <AnimatedNumber value={results.download} format={fmtSpeed} />
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
                  Mbps
                </div>
              </div>
              <div
                style={{
                  background: "var(--bg-inset)",
                  padding: 16,
                  borderRadius: 10,
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--fg-3)",
                    letterSpacing: "0.08em",
                    marginBottom: 4,
                  }}
                >
                  ↑ UPLOAD
                </div>
                <div
                  className="metric-value mono"
                  style={{ fontSize: 28, color: "var(--accent)" }}
                >
                  <AnimatedNumber value={results.upload} format={fmtSpeed} />
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
                  Mbps
                </div>
              </div>
            </div>
            {status === "running" && (
              <div className="subsection-desc mt-2" style={{ color: "var(--accent)" }}>
                {phaseLabel}
              </div>
            )}
            {status === "error" && (
              <div
                className="subsection-desc mt-2"
                style={{ color: "var(--color-error)" }}
              >
                Test failed{errorMsg ? `: ${errorMsg}` : " — check network connection"}
              </div>
            )}
            {status === "finished" && results.measuredAt && (
              <div className="subsection-desc mt-2 mono">
                Latency {fmtLatency(results.latency)} ms · Jitter{" "}
                {fmtLatency(results.jitter)} ms · Measured {fmtTime(results.measuredAt)}
              </div>
            )}
          </div>

          {/* CONNECTION DETAILS */}
          <div className="subsection">
            <div className="subsection-label">Connection Details</div>
            <div className="row">
              <span className="row-label">IPv4</span>
              <span className="row-value mono">{primaryIface?.ip ?? "--"}</span>
            </div>
            <div className="row">
              <span className="row-label">Interface</span>
              <span className="row-value mono">
                {primaryIface ? `${primaryIface.name} (${primaryIface.type})` : "--"}
              </span>
            </div>
            <div className="row">
              <span className="row-label">Status</span>
              <span className="row-value mono">{primaryIface?.state ?? "--"}</span>
            </div>
            {isWifi && connectionInfo?.ssid && (
              <div className="row">
                <span className="row-label">SSID</span>
                <span className="row-value mono">{connectionInfo.ssid}</span>
              </div>
            )}
            {isWifi && (
              <div className="row">
                <span className="row-label">Signal</span>
                <span className="row-value">
                  {signal != null ? (
                    <span className="chip chip-success mono">
                      {signal}% · {signalLabel(signal)}
                    </span>
                  ) : (
                    <span className="mono">--</span>
                  )}
                </span>
              </div>
            )}
            {isWifi && connectionInfo?.frequency && (
              <div className="row">
                <span className="row-label">Frequency</span>
                <span className="row-value mono">{connectionInfo.frequency}</span>
              </div>
            )}
            {isWifi && connectionInfo?.bitRate && (
              <div className="row">
                <span className="row-label">Link speed</span>
                <span className="row-value mono">{connectionInfo.bitRate}</span>
              </div>
            )}
            <div className="row">
              <span className="row-label">MAC</span>
              <span className="row-value mono">{primaryIface?.mac ?? "--"}</span>
            </div>
          </div>

          {/* OTHER INTERFACES */}
          {interfaces.length > 1 && (
            <div className="subsection">
              <div className="subsection-label">Other Interfaces</div>
              {interfaces
                .filter((i) => i.name !== primaryIface?.name)
                .map((iface) => (
                  <div className="row" key={iface.name}>
                    <span className="row-label">
                      {iface.name} ({iface.type})
                    </span>
                    <span className="row-value mono">
                      {iface.ip} · {iface.state}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- mountComponent factory ---

function mountComponent(
  Component: React.ComponentType,
): (container: HTMLElement, opts?: { parentFocusKey?: string }) => () => void {
  return (container, opts) => {
    const root = createRoot(container);
    root.render(
      <PluginProvider parentFocusKey={opts?.parentFocusKey}>
        <Component />
      </PluginProvider>,
    );
    return () => root.unmount();
  };
}

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        Network
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Connection info & speed tests
      </span>
    </div>
  );
}

export const mount = mountComponent(NetworkInfo);
export const mountHeader = mountComponent(Header);
