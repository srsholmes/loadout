import { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { FaGamepad, FaTriangleExclamation, FaXmark } from "react-icons/fa6";
import {
  Button,
  IconButton,
  PluginProvider,
  Spinner,
  Toggle,
  useBackend,
} from "@loadout/ui";

export const icon = FaGamepad;

interface ControllerRow {
  hash: number;
  name: string;
  connected: boolean;
  disabled: boolean;
  savedKinds: string[];
}

interface ListResult {
  unavailable: boolean;
  controllers: ControllerRow[];
}

function DisableControllerInput() {
  const { call, useEvent } = useBackend("disable-controller-input");

  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyHash, setBusyHash] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const r = (await call("listControllers")) as ListResult;
    setData(r);
  }, [call]);

  const hardRefresh = useCallback(async () => {
    const r = (await call("refreshControllers")) as ListResult;
    setData(r);
  }, [call]);

  useEvent({
    event: "controllersChanged",
    handler: () => {
      refresh();
    },
  });

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggle = useCallback(
    async (row: ControllerRow) => {
      setBusyHash(row.hash);
      setError(null);
      try {
        const res = (await call("setDisabled", row.hash, !row.disabled)) as {
          ok: boolean;
          error?: string;
        };
        if (!res.ok) setError(res.error ?? "Toggle failed");
        await refresh();
      } finally {
        setBusyHash(null);
      }
    },
    [call, refresh],
  );

  const handleForget = useCallback(
    async (row: ControllerRow) => {
      setBusyHash(row.hash);
      setError(null);
      try {
        const res = (await call("forgetController", row.hash)) as {
          ok: boolean;
          error?: string;
        };
        if (!res.ok) setError(res.error ?? "Forget failed");
        await refresh();
      } finally {
        setBusyHash(null);
      }
    },
    [call, refresh],
  );

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size={32} />
      </div>
    );
  }

  if (data.unavailable) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="card">
            <div className="card-body p-6">
              <div className="subsection-label mb-2 flex items-center gap-2">
                <FaTriangleExclamation className="w-3 h-3" />
                InputPlumber not detected
              </div>
              <div className="text-sm text-base-content/80 leading-relaxed">
                This plugin needs the <span className="mono">inputplumber.service</span>
                {" "}DBus daemon to silence controllers. It looks like
                InputPlumber isn't running on the system bus.
              </div>
              <div className="text-sm text-base-content/60 mt-3 leading-relaxed">
                On Bazzite, ChimeraOS, and most handheld distros it's
                installed by default — try{" "}
                <span className="mono">
                  systemctl status inputplumber.service
                </span>
                {" "}to check.
              </div>
              <div className="mt-4">
                <Button onClick={hardRefresh}>Re-check</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const sorted = [...data.controllers].sort((a, b) => {
    // Connected first, then disabled-but-known, then alphabetical.
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        <div className="card">
          <div className="card-body p-6">
            <div className="text-sm text-base-content/80 leading-relaxed">
              Disabled controllers stay hidden from Steam, this overlay,
              and any running game by telling InputPlumber to drop their
              virtual targets. Use this if a built-in gamepad is being
              assigned player 1 ahead of an external controller.
            </div>
            <div className="text-sm text-base-content mt-3 leading-relaxed flex gap-2">
              <FaTriangleExclamation
                className="w-3 h-3 mt-1 shrink-0"
                style={{ color: "var(--color-warning)" }}
              />
              <span>
                If you disable every connected controller you'll need a
                keyboard, mouse, or touchscreen to re-enable it.
              </span>
            </div>
          </div>
        </div>

        {error && (
          <div className="card">
            <div className="card-body p-4">
              <div
                className="text-sm"
                style={{ color: "var(--color-error)" }}
              >
                {error}
              </div>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-header flex items-center justify-between py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaGamepad className="w-3 h-3" /> Controllers
            </div>
            <Button onClick={hardRefresh}>Refresh</Button>
          </div>
          <div>
            {sorted.length === 0 ? (
              <div className="p-7 text-sm text-base-content/50 text-center">
                No InputPlumber composite devices found yet. Plug a
                controller in or tap Refresh.
              </div>
            ) : (
              sorted.map((row) => (
                <ControllerRowItem
                  key={row.hash}
                  row={row}
                  busy={busyHash === row.hash}
                  onToggle={() => handleToggle(row)}
                  onForget={() => handleForget(row)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ControllerRowItem({
  row,
  busy,
  onToggle,
  onForget,
}: {
  row: ControllerRow;
  busy: boolean;
  onToggle: () => void;
  onForget: () => void;
}) {
  const dimmed = !row.connected;
  return (
    <div
      className="flex items-center justify-between gap-3 px-4.5 py-3.5 border-b border-base-300/50 last:border-b-0"
      style={dimmed ? { opacity: 0.55 } : undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-base-content truncate">
          {row.name}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className={row.connected ? "chip chip-success" : "chip"}>
            {row.connected ? "Connected" : "Not connected"}
          </span>
          {row.disabled && (
            <span
              className="chip"
              style={{
                borderColor: "var(--color-warning)",
                color: "var(--color-warning)",
              }}
            >
              Silenced
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Toggle
          checked={!row.disabled}
          onChange={() => !busy && onToggle()}
          disabled={busy}
        />
        <IconButton
          onClick={() => !busy && onForget()}
          disabled={busy}
          ariaLabel={`Forget ${row.name}`}
          title="Forget this device"
          size={32}
          className="border-none bg-transparent text-base-content/40 hover:text-base-content"
        >
          <FaXmark className="w-3.5 h-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

export function mount(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <DisableControllerInput />
    </PluginProvider>,
  );
  return () => root.unmount();
}

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        Disable Controller Input
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Silence controllers via InputPlumber
      </span>
    </div>
  );
}

export function mountHeader(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <Header />
    </PluginProvider>,
  );
  return () => root.unmount();
}
