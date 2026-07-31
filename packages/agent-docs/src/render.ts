/**
 * Render resolved docs as Markdown.
 *
 * Markdown rather than JSON is the *default* representation for the
 * `/api/agent` routes because the primary consumer is a language model
 * reading the response into a prompt. JSON is still served on
 * `Accept: application/json` for programmatic use — the two are the same
 * data, not two sources of truth.
 *
 * Pure and deterministic: no timestamps, no clock, no randomness, so
 * responses are byte-stable and safe to cache or diff.
 */

import type { AgentMethodDoc, AgentSchema } from "@loadout/types";
import { countBySafety, type ResolvedPluginDoc } from "./merge";

export interface RenderContext {
  /** Origin the agent should call, e.g. `http://127.0.0.1:33820`. */
  origin: string;
  /** Installed Loadout version, from `LOADER_VERSION`. */
  version: string;
  /** Whether non-read calls are currently permitted. */
  writesEnabled: boolean;
}

/** Compact, human-readable rendering of a lowered TypeScript type. */
export function formatSchema(schema: AgentSchema): string {
  const base = ((): string => {
    if (schema.enum) {
      return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
    }
    switch (schema.type) {
      case "array":
        return `${schema.items ? formatSchema(schema.items) : "unknown"}[]`;
      case "object": {
        const props = schema.properties;
        if (!props || Object.keys(props).length === 0) return "object";
        const required = new Set(schema.required ?? []);
        const inner = Object.entries(props)
          .map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${formatSchema(v)}`)
          .join("; ");
        return `{ ${inner} }`;
      }
      case "unknown":
        // The generator couldn't lower this one — show the real
        // TypeScript instead of a uselessly vague "unknown".
        return schema.tsType ?? "unknown";
      default:
        return schema.type;
    }
  })();
  return schema.nullable ? `${base} | null` : base;
}

/** `setTdp(watts: number, opts?: { … })` */
function formatSignature(method: AgentMethodDoc): string {
  const args = method.args
    .map((a) => `${a.name}${a.optional ? "?" : ""}: ${formatSchema(a.schema)}`)
    .join(", ");
  return `${method.name}(${args}) => ${formatSchema(method.returns)}`;
}

const SAFETY_LABEL: Record<string, string> = {
  read: "read",
  write: "write",
  destructive: "destructive",
};

/** The shared preamble: how to authenticate and how to make a call. */
export function renderCallingConvention(ctx: RenderContext): string {
  return `## Calling convention

Loadout's backend listens on \`${ctx.origin}\` (loopback only). Every
capability below is invoked the same way — one POST, no per-plugin
endpoints.

**1. Get a session token.** It is regenerated on every restart, so fetch
it rather than storing it. This route is public:

\`\`\`sh
TOKEN=$(curl -s ${ctx.origin}/api/token | jq -r .token)
\`\`\`

**2. Call a method.** \`args\` is a positional array matching the
signature shown in the docs:

\`\`\`sh
curl -s ${ctx.origin}/api/agent/call \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"plugin":"bluetooth","method":"connectDevice","args":["AA:BB:CC:DD:EE:FF"]}'
\`\`\`

The response is \`{"id": "...", "result": ...}\`, or
\`{"id": "...", "error": "..."}\` with HTTP 500 when the method threw.
Unknown plugins and methods return 404 with a pointer to the right index,
and a malformed request returns 400 naming the problem.

\`/api/rpc\` takes the same body and is the raw path the overlay itself
uses. Prefer \`/api/agent/call\`: it checks the safety class first and
gives you a specific error instead of silently doing the thing.

**Safety classes.** Every method is labelled \`read\`, \`write\` or
\`destructive\`. Where a label is marked *(inferred)* it was guessed from
the method name, not declared by the plugin author — treat those with
more care.

${
  ctx.writesEnabled
    ? "Write access is currently **enabled** on this machine, so `write` and\n`destructive` methods will execute. These adjust real hardware — power\nlimits, fan behaviour, storage — on a device the user is holding. Confirm\nwith them before changing anything they didn't ask you to change."
    : "Write access is currently **disabled** on this machine. `read` methods\nwork normally; `write` and `destructive` calls to `/api/agent/call`\nreturn HTTP 403 until you opt in, either by sending the header\n`X-Loadout-Agent-Write: 1` or by setting `agentWrites: true` in\n`~/.config/loadout/config.json`.\n\nThis is a guardrail against accidents, not a security boundary — the\ntoken is public on loopback and `/api/rpc` is ungated. Ask the user\nbefore opting in."
}`;
}

/** The `/api/agent` index page. */
export function renderIndexMarkdown(plugins: ResolvedPluginDoc[], ctx: RenderContext): string {
  const loaded = plugins.filter((p) => p.status === "loaded");
  const unavailable = plugins.filter((p) => p.status !== "loaded");

  const byCategory = new Map<string, ResolvedPluginDoc[]>();
  for (const p of loaded) {
    const key = p.category ?? "Other";
    const list = byCategory.get(key) ?? [];
    list.push(p);
    byCategory.set(key, list);
  }

  const sections = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, entries]) => {
      const rows = entries
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => {
          const c = countBySafety(p.methods);
          const counts = `${c.read}r / ${c.write}w / ${c.destructive}d`;
          return `| \`${p.id}\` | ${p.summary || p.name} | ${counts} |`;
        })
        .join("\n");
      return `### ${category}\n\n| Plugin | What it does | Methods |\n| --- | --- | --- |\n${rows}`;
    })
    .join("\n\n");

  const unavailableSection = unavailable.length
    ? `\n\n## Installed but not callable\n\n${unavailable
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => `- \`${p.id}\` — ${p.status}`)
        .join(
          "\n",
        )}\n\nA disabled plugin's backend is never loaded, so its methods cannot be\ncalled. Enable it via \`PATCH /api/user-config\` (\`disabledPlugins\`) or in\nthe Loadout overlay's settings.`
    : "";

  return `# Loadout — agent API

Loadout v${ctx.version} is running on this machine. It manages a Steam
gaming handheld: power limits, fan curves, displays, Bluetooth, WiFi,
storage, Steam library metadata and artwork, and more — each as a plugin
exposing RPC methods.

This page lists what is **currently enabled here**. Fetch
\`${ctx.origin}/api/agent/<plugin-id>\` for a plugin's full method
documentation, including argument types and examples.

${renderCallingConvention(ctx)}

## Available plugins

${sections}${unavailableSection}
`;
}

/** The `/api/agent/<id>` page. */
export function renderPluginMarkdown(doc: ResolvedPluginDoc, ctx: RenderContext): string {
  const header = `# ${doc.name} (\`${doc.id}\`)

${doc.summary || "_No description provided._"}
`;

  const statusNote =
    doc.status === "loaded"
      ? ""
      : `\n> **This plugin is ${doc.status} and its methods cannot be called.**\n> The documentation below is provided so you know what enabling it would offer.\n`;

  const degradedNote = doc.degraded
    ? `\n> **Signatures unavailable.** No generated \`agent.json\` was found for\n> this plugin, so the methods below were discovered by reflection and\n> their argument types are unknown.\n`
    : "";

  const methods = doc.methods.length
    ? doc.methods.map((m) => renderMethod(m, doc.id, ctx)).join("\n\n")
    : "_This plugin exposes no callable methods._";

  const events = doc.events.length
    ? `\n\n## Events\n\nSubscribe over the WebSocket at \`${ctx.origin.replace(/^http/, "ws")}/ws?token=<token>\`; events arrive as \`{"type":"event","plugin":"${doc.id}","event":"...","data":...}\`.\n\n${doc.events
        .map(
          (e) =>
            `- \`${e.event}\`${e.description ? ` — ${e.description}` : ""}${
              e.data ? ` \`${formatSchema(e.data)}\`` : ""
            }`,
        )
        .join("\n")}`
    : "";

  return `${header}${statusNote}${degradedNote}
## Methods

${methods}${events}
`;
}

function renderMethod(method: AgentMethodDoc, pluginId: string, ctx: RenderContext): string {
  const safety = `${SAFETY_LABEL[method.safety] ?? method.safety}${
    method.safetyInferred ? " *(inferred)*" : ""
  }`;

  const parts: string[] = [
    `### \`${method.name}\``,
    "",
    `\`\`\`ts\n${formatSignature(method)}\n\`\`\``,
    "",
    `**Safety:** ${safety}`,
  ];

  if (method.description) parts.push("", method.description);

  if (method.args.length) {
    const rows = method.args
      .map(
        (a) =>
          `| \`${a.name}\` | \`${formatSchema(a.schema)}\` | ${
            a.optional ? "no" : "yes"
          } | ${a.description ?? ""} |`,
      )
      .join("\n");
    parts.push("", "| Argument | Type | Required | Notes |", "| --- | --- | --- | --- |", rows);
  }

  if (method.notes) parts.push("", `**Note:** ${method.notes}`);

  const exampleArgs = method.example?.args;
  if (exampleArgs) {
    const body = JSON.stringify({
      plugin: pluginId,
      method: method.name,
      args: exampleArgs,
    });
    parts.push(
      "",
      "```sh",
      `curl -s ${ctx.origin}/api/agent/call \\`,
      `  -H "Authorization: Bearer $TOKEN" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '${body}'`,
      "```",
    );
  }

  return parts.join("\n");
}
