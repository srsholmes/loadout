import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Panel, Text, Button, Field, useBackend, PluginProvider } from "@loadout/ui";

interface DeviceSnapshot {
  id: string;
  gamescope: boolean;
  capabilities: Record<string, boolean>;
}

function HelloWorldPanel() {
  const backend = useBackend("hello-world");
  const [reply, setReply] = useState<string>("(not pinged yet)");
  const [device, setDevice] = useState<DeviceSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!backend.ready) return;
    backend
      .call("getDevice")
      .then((d) => setDevice(d as DeviceSnapshot))
      .catch((err) => console.error("[hello-world] getDevice failed:", err));
  }, [backend.ready, backend]);

  async function ping() {
    setBusy(true);
    try {
      const value = await backend.call("ping");
      setReply(String(value));
    } catch (err) {
      setReply(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6 space-y-4">
      <Panel title="Hello, Loadout">
        <Text variant="heading">Hello World</Text>
        <Text variant="secondary">
          The overlay is alive. Press Ping to call the backend RPC and confirm the device.
        </Text>
        <div className="mt-4">
          <Button variant="primary" onClick={ping} disabled={busy}>
            {busy ? "Pinging…" : "Ping"}
          </Button>
        </div>
        <div className="mt-3">
          <Text variant="body">{reply}</Text>
        </div>
      </Panel>

      {device && (
        <Panel title="Device">
          <Field label="ID">{device.id}</Field>
          <Field label="Gamescope">{device.gamescope ? "yes" : "no"}</Field>
          {Object.entries(device.capabilities).map(([cap, on]) => (
            <Field key={cap} label={cap}>
              {on ? "yes" : "no"}
            </Field>
          ))}
        </Panel>
      )}
    </div>
  );
}

export function mount(
  container: HTMLElement,
  opts: { parentFocusKey?: string } = {},
): () => void {
  const root: Root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts.parentFocusKey}>
      <HelloWorldPanel />
    </PluginProvider>,
  );
  return () => root.unmount();
}

export default mount;
