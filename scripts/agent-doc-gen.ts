/**
 * Derive agent-facing API docs from a plugin's `backend.ts`.
 *
 * Every public method on a plugin's default-exported backend class is
 * already an RPC endpoint — `resolveMethod` finds them by reflection at
 * runtime. Reflection is where the type information stops, though: a
 * runtime function object knows its arity and nothing else. The
 * signatures only exist in the TypeScript source, so that is what we
 * read.
 *
 * This module is **build-time only**. It imports `typescript`, a root
 * devDependency that the compiled loader binary does not ship — which is
 * exactly why the output is written to `plugins/<id>/agent.json` and
 * committed, rather than computed on the user's device.
 *
 * Two deliberate design points:
 *
 * 1. **Method selection is delegated, not reimplemented.** Which methods
 *    are callable is decided by `resolveMethod` in `@loadout/types`; this
 *    module imports the same predicate rather than restating the rules,
 *    so generated docs cannot drift from what the RPC layer will
 *    actually dispatch.
 * 2. **Unlowerable types degrade honestly.** TypeScript has plenty of
 *    constructs with no JSON Schema equivalent. Rather than fail the
 *    build or emit a confident lie, those become
 *    `{ type: "unknown", tsType: "<the real TypeScript>" }` — a reader
 *    still learns the true signature.
 */

import ts from "typescript";
import { join } from "node:path";
import type {
  AgentDoc,
  AgentEventDoc,
  AgentMethodDoc,
  AgentParam,
  AgentSchema,
} from "@loadout/types";
import { AGENT_DOC_VERSION, inferSafety } from "@loadout/agent-docs";

/**
 * How deep to follow object properties before giving up and emitting the
 * type name. Guards against both runaway output (some plugin types nest
 * many levels) and self-referential types, which would otherwise recurse
 * forever. Four levels covers every shape the shipped plugins return
 * while keeping a single method's schema readable.
 */
const MAX_DEPTH = 4;

/**
 * Names the RPC layer refuses to dispatch. Mirrors `BLOCKED_METHODS` in
 * `packages/types/src/plugin.ts` — kept as a local list only because
 * that set isn't exported; `isCallableMethodName` below is the single
 * place the rule is applied.
 */
const BLOCKED = new Set([
  "onLoad",
  "onUnload",
  "emit",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
]);

/** Whether the RPC layer would dispatch a method of this name. */
export function isCallableMethodName(name: string): boolean {
  return !BLOCKED.has(name) && !name.startsWith("_");
}

/** Compiler options for the generator's program, from the root tsconfig. */
export function loadCompilerOptions(repoRoot: string): ts.CompilerOptions {
  const configPath = join(repoRoot, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, repoRoot);
  return {
    ...parsed.options,
    // `paths` in the root config are written relative to the repo root;
    // without an explicit baseUrl the resolver anchors them elsewhere and
    // every `@loadout/*` import silently fails to resolve, which would
    // downgrade every cross-package type to `unknown`.
    baseUrl: repoRoot,
    noEmit: true,
    skipLibCheck: true,
  };
}

// ── Type lowering ────────────────────────────────────────────────────

function unknownSchema(checker: ts.TypeChecker, type: ts.Type): AgentSchema {
  return { type: "unknown", tsType: checker.typeToString(type) };
}

/** Unwrap `Promise<T>` (and `PromiseLike<T>`) to `T`. */
function unwrapPromise(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  const symbolName = type.getSymbol()?.getName();
  if (symbolName !== "Promise" && symbolName !== "PromiseLike") return type;
  const args = checker.getTypeArguments(type as ts.TypeReference);
  return args[0] ?? type;
}

function literalValue(type: ts.Type): string | number | boolean | undefined {
  if (type.isStringLiteral()) return type.value;
  if (type.isNumberLiteral()) return type.value;
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return checkerIntrinsicName(type) === "true";
  }
  return undefined;
}

function checkerIntrinsicName(type: ts.Type): string {
  return (type as ts.Type & { intrinsicName?: string }).intrinsicName ?? "";
}

/**
 * Lower a TypeScript type to an {@link AgentSchema}.
 *
 * Handles the shapes that actually appear in plugin backends: primitives,
 * literal unions, arrays, `T | null`, `T | undefined`, and object types
 * (interfaces and type literals). Everything else — generics over
 * plugin-local classes, `Record<string, unknown>` with no declared
 * properties, function types, `Timer` — falls through to the honest
 * `unknown` form carrying the printed TypeScript.
 */
export function lowerType(checker: ts.TypeChecker, type: ts.Type, depth = 0): AgentSchema {
  const t = unwrapPromise(checker, type);

  // void / undefined / null read as "returns nothing".
  if (t.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) {
    return { type: "null" };
  }
  if (t.flags & ts.TypeFlags.Null) return { type: "null" };

  if (t.isUnion()) return lowerUnion(checker, t, depth);

  if (t.flags & ts.TypeFlags.StringLike) {
    const v = literalValue(t);
    return v === undefined ? { type: "string" } : { type: "string", enum: [v] };
  }
  if (t.flags & ts.TypeFlags.NumberLike) {
    const v = literalValue(t);
    return v === undefined ? { type: "number" } : { type: "number", enum: [v] };
  }
  if (t.flags & ts.TypeFlags.BooleanLike) return { type: "boolean" };

  if (checker.isArrayType(t)) {
    const [element] = checker.getTypeArguments(t as ts.TypeReference);
    return {
      type: "array",
      items:
        element && depth < MAX_DEPTH ? lowerType(checker, element, depth + 1) : { type: "unknown" },
    };
  }

  if (checker.isTupleType(t)) {
    // A tuple is an array with per-position types; collapse to the array
    // form rather than inventing a positional schema nothing consumes.
    return { type: "array", items: { type: "unknown" } };
  }

  // An intersection (`Result & { unsupported?: boolean }` — a common
  // shape for "the normal return, plus a flag") isn't Object-flagged, but
  // `getProperties()` on it returns the merged property set, so it lowers
  // exactly like an object type. Without this it degrades to `unknown`
  // and the caller loses the whole shape over one extra field.
  if (t.isIntersection() || t.flags & ts.TypeFlags.Object) {
    return lowerObject(checker, t, depth);
  }

  return unknownSchema(checker, t);
}

function lowerUnion(checker: ts.TypeChecker, type: ts.UnionType, depth: number): AgentSchema {
  const members = type.types;

  // Strip the nullish members and record them as flags — `string | null`
  // is far more useful rendered as a nullable string than as a union.
  const nullable = members.some((m) => m.flags & ts.TypeFlags.Null);
  const optional = members.some((m) => m.flags & ts.TypeFlags.Undefined);
  const rest = members.filter((m) => !(m.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));

  if (rest.length === 0) return { type: "null" };

  // `boolean` is internally the union `true | false`; don't emit it as an
  // enum of two literals.
  const allBooleanLiterals = rest.every((m) => m.flags & ts.TypeFlags.BooleanLiteral);
  if (allBooleanLiterals) {
    return withFlags({ type: "boolean" }, nullable, optional);
  }

  const literals = rest.map(literalValue);
  if (literals.every((v) => v !== undefined)) {
    const first = rest[0]!;
    const base: AgentSchema["type"] = first.isNumberLiteral() ? "number" : "string";
    return withFlags(
      { type: base, enum: literals as Array<string | number | boolean> },
      nullable,
      optional,
    );
  }

  if (rest.length === 1) {
    return withFlags(lowerType(checker, rest[0]!, depth), nullable, optional);
  }

  return withFlags(unknownSchema(checker, type), nullable, optional);
}

function withFlags(schema: AgentSchema, nullable: boolean, optional: boolean): AgentSchema {
  if (nullable) schema.nullable = true;
  if (optional) schema.optional = true;
  return schema;
}

function lowerObject(checker: ts.TypeChecker, type: ts.Type, depth: number): AgentSchema {
  // Callable types (functions, classes with construct signatures) have no
  // JSON representation — an agent can't send one over the wire.
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return unknownSchema(checker, type);
  }

  const props = type.getProperties();
  // An index-signature-only type (`Record<string, unknown>`) has no named
  // properties to enumerate; say "object" and leave it there.
  if (props.length === 0) return { type: "object" };
  if (depth >= MAX_DEPTH) return unknownSchema(checker, type);

  const properties: Record<string, AgentSchema> = {};
  const required: string[] = [];

  for (const prop of props) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!decl) continue;
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    const schema = lowerType(checker, propType, depth + 1);

    const isOptional = Boolean(prop.flags & ts.SymbolFlags.Optional);
    if (!isOptional && !schema.optional) required.push(prop.getName());
    // Optionality is recorded once, in the parent's `required` list. An
    // optional property's type is `T | undefined`, so the union lowering
    // also sets `schema.optional` — keeping both would put the same fact
    // in two places and add a line to every optional field on disk.
    delete schema.optional;

    const doc = ts.displayPartsToString(prop.getDocumentationComment(checker));
    if (doc) schema.description = doc.split("\n")[0];

    properties[prop.getName()] = schema;
  }

  const out: AgentSchema = { type: "object", properties };
  if (required.length) out.required = required;
  return out;
}

// ── Class walking ────────────────────────────────────────────────────

/** Find `export default class …` in a source file. */
function findDefaultExportedClass(source: ts.SourceFile): ts.ClassDeclaration | undefined {
  for (const stmt of source.statements) {
    if (!ts.isClassDeclaration(stmt)) continue;
    const mods = ts.getModifiers(stmt) ?? [];
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    const isExport = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (isDefault && isExport) return stmt;
  }
  return undefined;
}

function isPubliclyVisible(member: ts.ClassElement): boolean {
  const mods = ts.getModifiers(member) ?? [];
  return !mods.some(
    (m) =>
      m.kind === ts.SyntaxKind.PrivateKeyword ||
      m.kind === ts.SyntaxKind.ProtectedKeyword ||
      m.kind === ts.SyntaxKind.StaticKeyword,
  );
}

function firstLine(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // The first paragraph, collapsed — enough to orient a reader without
  // pasting a 40-line design note into every method entry.
  const paragraph = trimmed.split(/\n\s*\n/)[0] ?? trimmed;
  return paragraph.replace(/\s+/g, " ").trim();
}

function paramDescriptions(node: ts.MethodDeclaration): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of ts.getAllJSDocTagsOfKind(node, ts.SyntaxKind.JSDocParameterTag)) {
    const t = tag as ts.JSDocParameterTag;
    const name = ts.isIdentifier(t.name) ? t.name.text : undefined;
    const comment =
      typeof t.comment === "string" ? t.comment : ts.displayPartsToString(t.comment ?? []);
    if (name && comment) out.set(name, comment.replace(/\s+/g, " ").trim());
  }
  return out;
}

function methodDoc(
  checker: ts.TypeChecker,
  node: ts.MethodDeclaration,
  name: string,
): AgentMethodDoc {
  const docs = paramDescriptions(node);

  const args: AgentParam[] = node.parameters.map((param) => {
    const paramName = ts.isIdentifier(param.name) ? param.name.text : param.name.getText();
    const type = checker.getTypeAtLocation(param);
    const schema = lowerType(checker, type);
    const optional = Boolean(param.questionToken || param.initializer);
    const schemaOptional = Boolean(schema.optional);
    // Same one-fact-one-place rule as object properties: `AgentParam.optional`
    // owns this, so drop the duplicate the `T | undefined` union produced.
    delete schema.optional;
    const description = docs.get(paramName);
    return {
      name: paramName,
      schema,
      optional: optional || schemaOptional,
      ...(description ? { description } : {}),
    };
  });

  const signature = checker.getSignatureFromDeclaration(node);
  const returns = signature
    ? lowerType(checker, checker.getReturnTypeOfSignature(signature))
    : { type: "unknown" as const };

  const symbol = checker.getSymbolAtLocation(node.name);
  const description = symbol
    ? firstLine(ts.displayPartsToString(symbol.getDocumentationComment(checker)))
    : undefined;

  return {
    name,
    args,
    returns,
    ...(description ? { description } : {}),
    safety: inferSafety(name),
    safetyInferred: true,
  };
}

/**
 * Collect `this.emit({ event: "name" })` calls.
 *
 * Event names are string literals at every emit site in the shipped
 * plugins, so a literal scan recovers them exactly. A computed event name
 * is simply not collected rather than guessed at — a missing entry is
 * recoverable, a wrong one is not.
 */
function collectEvents(node: ts.Node): AgentEventDoc[] {
  const names = new Set<string>();

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const isEmit =
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "emit") ||
        (ts.isNonNullExpression(callee) &&
          ts.isPropertyAccessExpression(callee.expression) &&
          callee.expression.name.text === "emit");

      if (isEmit) {
        const [arg] = n.arguments;
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "event" &&
              ts.isStringLiteralLike(prop.initializer)
            ) {
              names.add(prop.initializer.text);
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
  return [...names].sort().map((event) => ({ event }));
}

// ── Entry point ──────────────────────────────────────────────────────

export interface GenerateResult {
  doc: AgentDoc;
  /** Non-fatal problems worth printing but not worth failing over. */
  warnings: string[];
}

/**
 * Build the `agent.json` baseline for one plugin.
 *
 * Returns `null` when the plugin has no `backend.ts` in the program —
 * a UI-only plugin exposes no RPC surface, so there is nothing to
 * document and no file should be written.
 */
export function generateForBackend(
  program: ts.Program,
  pluginId: string,
  backendPath: string,
): GenerateResult | null {
  const source = program.getSourceFile(backendPath);
  if (!source) return null;

  const checker = program.getTypeChecker();
  const warnings: string[] = [];

  const cls = findDefaultExportedClass(source);
  if (!cls) {
    return {
      doc: { id: pluginId, generatorVersion: AGENT_DOC_VERSION, methods: [] },
      warnings: [
        `${pluginId}: no default-exported class in backend.ts — the loader would fail to instantiate it`,
      ],
    };
  }

  const methods: AgentMethodDoc[] = [];
  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (!ts.isIdentifier(member.name)) continue;
    const name = member.name.text;
    if (!isCallableMethodName(name)) continue;
    if (!isPubliclyVisible(member)) continue;
    methods.push(methodDoc(checker, member, name));
  }

  methods.sort((a, b) => a.name.localeCompare(b.name));

  const unknownReturns = methods.filter((m) => m.returns.type === "unknown").length;
  if (unknownReturns > 0) {
    warnings.push(
      `${pluginId}: ${unknownReturns}/${methods.length} method(s) have a return type that couldn't be lowered to a schema`,
    );
  }

  const events = collectEvents(cls);

  return {
    doc: {
      id: pluginId,
      generatorVersion: AGENT_DOC_VERSION,
      methods,
      ...(events.length ? { events } : {}),
    },
    warnings,
  };
}

/** Stable, diff-friendly serialisation — what gets written to disk. */
export function serializeDoc(doc: AgentDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
