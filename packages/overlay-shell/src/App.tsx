import { useEffect, useMemo, useState } from "react";
import { BackendProvider } from "@loadout/ui";
import { GamepadNavProvider } from "./GamepadNav";
import { usePlugins, type PluginInfo } from "./usePlugins";
import { PluginHost } from "./PluginHost";

interface Route {
  view: "home" | "plugin";
  pluginId?: string;
}

function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  if (h.startsWith("plugin/")) {
    const id = h.slice("plugin/".length);
    if (id) return { view: "plugin", pluginId: id };
  }
  return { view: "home" };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function Home({ plugins }: { plugins: PluginInfo[] }) {
  // M1: jump straight into the first available plugin if there's exactly one.
  // Later milestones will replace this with a real launcher / plugin list.
  useEffect(() => {
    const first = plugins.find((p) => p.hasApp);
    if (first) {
      window.location.hash = `#/plugin/${first.id}`;
    }
  }, [plugins]);

  return (
    <div className="p-6">
      <h2 className="text-lg font-semibold mb-2">Loadout</h2>
      <p className="text-sm text-base-content/60">
        {plugins.length === 0
          ? "No plugins loaded."
          : `Loaded: ${plugins.map((p) => p.name).join(", ")}`}
      </p>
    </div>
  );
}

export function App() {
  const route = useHashRoute();
  const { plugins, loading, error } = usePlugins();

  const activePlugin = useMemo(() => {
    if (route.view !== "plugin" || !route.pluginId) return undefined;
    return plugins.find((p) => p.id === route.pluginId);
  }, [route, plugins]);

  return (
    <BackendProvider>
      <GamepadNavProvider onBack={() => (window.location.hash = "#/")}>
        <main className="h-screen w-screen bg-base-100 text-base-content">
          {loading && <div className="p-6 text-base-content/60">Loading plugins…</div>}
          {error && <div className="p-6 text-error">{error}</div>}
          {!loading && !error && route.view === "home" && <Home plugins={plugins} />}
          {!loading && !error && route.view === "plugin" && activePlugin && (
            <PluginHost plugin={activePlugin} />
          )}
          {!loading && !error && route.view === "plugin" && !activePlugin && (
            <div className="p-6 text-error">
              Plugin not found: {route.pluginId}
            </div>
          )}
        </main>
      </GamepadNavProvider>
    </BackendProvider>
  );
}
