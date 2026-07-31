/**
 * Agent-facing API documentation — `GET /api/agent` and
 * `GET /api/agent/<plugin-id>`.
 *
 * Loadout's whole capability surface has always been reachable over
 * `/api/rpc`, but nothing described it: `resolveMethod` finds backend
 * methods by reflection, so there was no method list, no argument types
 * and no prose. These two routes are that missing description.
 *
 * **Why the live server is the source of truth.** Which plugins exist and
 * which are callable is a property of *this machine* — the user's
 * `disabledPlugins` config decides it, and a disabled plugin's backend is
 * never even loaded. A static document would be wrong on any machine
 * whose plugin set differs from the repo's, and stale the moment someone
 * toggled one. The repo-root `AGENTS.md` therefore only points here.
 *
 * **Two representations, one source.** Markdown by default because the
 * consumer is usually a language model reading into a prompt; JSON on
 * `Accept: application/json` for programmatic use. Both render from the
 * same merged data via `@loadout/agent-docs`, so they cannot disagree.
 *
 * Per-plugin schemas are read lazily from `plugins/<id>/agent.json`
 * rather than being held on `PluginMeta`: `/api/plugins` returns raw meta
 * objects and the overlay fetches that list on every boot, so a schema
 * blob there would be paid for by every one of those requests.
 */

import { join } from "node:path";
import type { AgentDoc, AgentManifest } from "@loadout/types";
import {
  mergePluginDoc,
  renderIndexMarkdown,
  renderPluginMarkdown,
  requiresWriteOptIn,
  toIndexEntry,
  type ResolvedPluginDoc,
} from "@loadout/agent-docs";
import { resolveMethod } from "@loadout/types";
import { jsonResponse } from "../index";
import { LOADER_VERSION } from "../../version";
import { readUserConfig } from "../user-config";
import type { RouteContext } from "./types";
import type { RouteHandler } from "./types";

/** Opt-in header for calling non-read methods through the agent surface. */
export const AGENT_WRITE_HEADER = "x-loadout-agent-write";
/** Opt-in key in `~/.config/loadout/config.json`. */
export const AGENT_WRITES_KEY = "agentWrites";

const AGENT_PATH = "/api/agent";
const AGENT_PLUGIN_PATTERN = /^\/api\/agent\/(.+)$/;

function markdownResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      // Regenerated per request from in-memory state; cheap, and a stale
      // capability list is worse than a re-render.
      "Cache-Control": "no-store",
    },
  });
}

/** True when the caller asked for JSON rather than the Markdown default. */
function wantsJson(req: Request, url: URL): boolean {
  if (url.searchParams.get("format") === "json") return true;
  if (url.searchParams.get("format") === "markdown") return false;
  const accept = req.headers.get("accept") ?? "";
  // `*/*` (curl's default) must fall through to Markdown, so test for an
  // explicit JSON preference rather than merely "json appears somewhere".
  return /\bapplication\/json\b/.test(accept);
}

/**
 * Whether non-read methods may be dispatched through this surface.
 *
 * Not a security boundary and documented as such: `/api/token` is public
 * on loopback, so any local process can already reach `/api/rpc`
 * unrestricted. This is a guardrail against an agent one-shotting
 * `setTdp` or `removeShortcut` while exploring, and it deliberately does
 * not touch the RPC path the overlay and plugins use.
 */
export async function writesEnabled(req: Request): Promise<boolean> {
  if (req.headers.get(AGENT_WRITE_HEADER) === "1") return true;
  try {
    const config = await readUserConfig();
    return config[AGENT_WRITES_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * Load a plugin's generated baseline, if one shipped with it.
 *
 * Absent is a normal state, not an error: a third-party plugin may never
 * have been through the generator. The merge step falls back to
 * reflecting live method names and marks the result degraded, so an
 * undocumented plugin still lists what it can do.
 */
async function loadBaseline(pluginsDir: string, pluginId: string): Promise<AgentDoc | undefined> {
  try {
    const file = Bun.file(join(pluginsDir, pluginId, "agent.json"));
    if (!(await file.exists())) return undefined;
    const doc = (await file.json()) as AgentDoc;
    // A doc whose id disagrees with the directory is a staging mistake;
    // trusting it would attribute one plugin's methods to another.
    return doc.id === pluginId ? doc : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Method names the RPC layer would actually dispatch on a live instance.
 * Walks the prototype chain because backend methods live on the class
 * prototype, not the instance.
 */
function reflectMethodNames(instance: object): string[] {
  const names = new Set<string>();
  let current: object | null = instance;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (resolveMethod({ instance: instance as never, name })) names.add(name);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names];
}

interface PluginSource {
  meta: {
    id: string;
    name: string;
    description?: string;
    category?: string;
    agent?: AgentManifest;
  };
  status: "loaded" | "disabled" | "error";
  instance?: object;
}

/**
 * Every plugin worth documenting, from the discovery registry rather than
 * the loaded map — a disabled plugin is still worth describing so an
 * agent knows what enabling it would offer.
 */
function collectPlugins(ctx: RouteContext): PluginSource[] {
  const out: PluginSource[] = [];

  for (const [id, entry] of ctx.registry) {
    const loaded = ctx.plugins.get(id);
    out.push({
      meta: entry.meta as PluginSource["meta"],
      status: entry.status,
      instance: loaded?.instance,
    });
  }

  // Core services are absent from the registry (they're synthetic, not
  // discovered on disk) but are callable over exactly the same RPC
  // surface, so they belong in an agent's capability list.
  for (const [id, plugin] of ctx.plugins) {
    if (!id.startsWith("__core:")) continue;
    out.push({
      meta: plugin.meta as PluginSource["meta"],
      status: "loaded",
      instance: plugin.instance,
    });
  }

  return out;
}

async function resolveDoc(ctx: RouteContext, source: PluginSource): Promise<ResolvedPluginDoc> {
  const baseline = await loadBaseline(ctx.pluginsDir, source.meta.id);
  return mergePluginDoc({
    meta: source.meta,
    status: source.status,
    baseline,
    methodNames: source.instance ? reflectMethodNames(source.instance) : [],
  });
}

export const agentIndexRoute: RouteHandler = {
  name: "agent.index",
  match: (_req, url) => url.pathname === AGENT_PATH || url.pathname === `${AGENT_PATH}/`,
  async handle(req, url, ctx) {
    const writes = await writesEnabled(req);
    const sources = collectPlugins(ctx).filter((s) => !s.meta.agent?.hidden);
    const docs = await Promise.all(sources.map((s) => resolveDoc(ctx, s)));

    const renderCtx = {
      origin: url.origin,
      version: LOADER_VERSION,
      writesEnabled: writes,
    };

    if (wantsJson(req, url)) {
      return jsonResponse({
        version: LOADER_VERSION,
        origin: url.origin,
        writesEnabled: writes,
        rpc: {
          endpoint: "/api/rpc",
          method: "POST",
          body: { plugin: "<id>", method: "<name>", args: [] },
          tokenEndpoint: "/api/token",
        },
        plugins: docs.map(toIndexEntry),
      });
    }

    return markdownResponse(renderIndexMarkdown(docs, renderCtx));
  },
};

/**
 * `POST /api/agent/call` — the same dispatch as `/api/rpc`, with the
 * safety gate applied.
 *
 * This exists so the write gate is a real thing rather than a claim in
 * the documentation. It cannot live on `/api/rpc` itself: the overlay and
 * every plugin frontend call writes through that path constantly, and
 * gating it would break the product. So the gate lives on the endpoint
 * the agent docs tell agents to use.
 *
 * That does mean an agent could bypass it by calling `/api/rpc` directly.
 * That is understood and stated plainly in the docs — the token is public
 * on loopback, so no endpoint here is a security boundary. The value is
 * in making the *default* path the careful one.
 */
export const agentCallRoute: RouteHandler = {
  name: "agent.call",
  match: (req, url) => url.pathname === `${AGENT_PATH}/call` && req.method === "POST",
  async handle(req, _url, ctx) {
    let parsed: { plugin?: string; method?: string; args?: unknown[] };
    try {
      parsed = JSON.parse(await req.text());
    } catch (err) {
      return jsonResponse({ error: `Invalid JSON body: ${err}` }, 400);
    }

    const { plugin: pluginId, method: methodName, args = [] } = parsed;
    if (!pluginId || !methodName) {
      return jsonResponse(
        {
          error: "Missing required field(s). Body shape is { plugin, method, args? }.",
        },
        400,
      );
    }

    const source = collectPlugins(ctx).find((s) => s.meta.id === pluginId);
    if (!source) {
      return jsonResponse(
        {
          error: `Unknown plugin "${pluginId}"`,
          hint: `GET ${AGENT_PATH} lists the plugins available on this machine.`,
        },
        404,
      );
    }
    if (source.status !== "loaded") {
      return jsonResponse(
        {
          error: `Plugin "${pluginId}" is ${source.status} — its backend is not loaded, so nothing can be called on it.`,
          hint: "Enable it via PATCH /api/user-config (disabledPlugins), or in the Loadout overlay settings.",
        },
        409,
      );
    }

    const doc = await resolveDoc(ctx, source);
    const method = doc.methods.find((m) => m.name === methodName);
    if (!method) {
      return jsonResponse(
        {
          error: `Unknown method "${methodName}" on plugin "${pluginId}"`,
          hint: `GET ${AGENT_PATH}/${encodeURIComponent(pluginId)} lists its methods.`,
        },
        404,
      );
    }

    if (requiresWriteOptIn(method) && !(await writesEnabled(req))) {
      return jsonResponse(
        {
          error: `"${pluginId}.${methodName}" is classified ${method.safety} and write access is not enabled.`,
          safety: method.safety,
          safetyInferred: method.safetyInferred ?? false,
          hint: `Re-send with the header "${AGENT_WRITE_HEADER}: 1", or set "${AGENT_WRITES_KEY}": true in ~/.config/loadout/config.json. Confirm with the user first — this changes real hardware state.`,
        },
        403,
      );
    }

    const response = await ctx.rpcHandler(
      JSON.stringify({
        id: crypto.randomUUID(),
        plugin: pluginId,
        method: methodName,
        args,
      }),
    );
    if (!response) {
      return jsonResponse(
        { error: "RPC handler returned no response for a well-formed request" },
        500,
      );
    }

    const envelope = JSON.parse(response) as Record<string, unknown>;
    // Same convention as /api/rpc (audit A-028): a plugin error is an
    // HTTP 500 so clients branch on status, not on body shape.
    return jsonResponse(envelope, "error" in envelope ? 500 : 200);
  },
};

export const agentPluginRoute: RouteHandler = {
  name: "agent.plugin",
  match: (req, url) => req.method === "GET" && AGENT_PLUGIN_PATTERN.test(url.pathname),
  async handle(req, url, ctx) {
    const match = url.pathname.match(AGENT_PLUGIN_PATTERN);
    // `match` already gated this, so group 1 is always present; the
    // fallback only satisfies the type checker.
    const pluginId = decodeURIComponent(match?.[1] ?? "");

    const source = collectPlugins(ctx).find((s) => s.meta.id === pluginId);
    if (!source) {
      return jsonResponse(
        {
          error: `Unknown plugin "${pluginId}"`,
          hint: `GET ${AGENT_PATH} lists the plugins available on this machine.`,
        },
        404,
      );
    }

    const doc = await resolveDoc(ctx, source);
    const writes = await writesEnabled(req);
    const renderCtx = {
      origin: url.origin,
      version: LOADER_VERSION,
      writesEnabled: writes,
    };

    if (wantsJson(req, url)) {
      return jsonResponse({
        ...doc,
        writesEnabled: writes,
      });
    }

    return markdownResponse(renderPluginMarkdown(doc, renderCtx));
  },
};

// `agentCallRoute` must precede `agentPluginRoute`: the latter's
// `/api/agent/(.+)` pattern would otherwise swallow `/api/agent/call`.
// (It also only matches GET, so this is belt and braces.)
export const agentRoutes: RouteHandler[] = [agentIndexRoute, agentCallRoute, agentPluginRoute];
