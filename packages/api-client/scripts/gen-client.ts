import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * `pnpm --filter @fx/api-client gen`. Reads packages/api/openapi.json and writes src/generated.ts: the
 * response/request types and one table of operations keyed by operationId. There is no OpenAPI generator
 * dependency; the JSON Schema subset that openapi.json uses is small enough to convert here.
 * test/drift.test.ts calls generate() on the committed spec and diffs it against the committed file.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: Json } | boolean;
type Parameter = { name: string; in: string; required?: boolean; schema?: Schema };
type Operation = {
  operationId: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
  "x-fx-token-self-only"?: boolean;
  "x-fx-idempotency"?: "required" | "optional";
};
export type OpenApiDoc = {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
};

const METHODS = ["get", "put", "post", "delete", "patch"];
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));
const asObj = (v: Json | undefined): { [k: string]: Json } | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;

function scalar(t: string): string {
  if (t === "string") return "string";
  if (t === "number" || t === "integer") return "number";
  if (t === "boolean") return "boolean";
  if (t === "null") return "null";
  return "unknown";
}

/** JSON Schema (the subset openapi.json emits) to a TypeScript type expression. */
export function toTs(schema: Schema | Json | undefined, pad = ""): string {
  const s = asObj(schema as Json);
  if (!s) return "unknown";
  if (typeof s.$ref === "string") return `Components[${JSON.stringify(s.$ref.split("/").pop())}]`;
  if ("const" in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  for (const k of ["anyOf", "oneOf"]) {
    const alts = s[k];
    if (Array.isArray(alts)) return alts.map((a) => `(${toTs(a, pad)})`).join(" | ");
  }
  if (Array.isArray(s.allOf)) return s.allOf.map((a) => `(${toTs(a, pad)})`).join(" & ");
  if (Array.isArray(s.type)) return s.type.map((t) => toTs({ ...s, type: t }, pad)).join(" | ");
  if (s.type === "array") {
    if (Array.isArray(s.prefixItems)) return `[${s.prefixItems.map((i) => toTs(i, pad)).join(", ")}]`;
    return `Array<${toTs(s.items, pad)}>`;
  }
  if (s.type === "object" || s.properties) {
    const props = asObj(s.properties) ?? {};
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    const inner = `${pad}  `;
    const lines = Object.entries(props).map(([k, v]) => `${inner}${key(k)}${required.has(k) ? "" : "?"}: ${toTs(v, inner)};`);
    const extra = s.additionalProperties;
    if (extra !== undefined && extra !== false && extra !== null) {
      lines.push(`${inner}[key: string]: ${extra === true ? "unknown" : toTs(extra, inner)};`);
    }
    return lines.length === 0 ? "Record<string, never>" : `{\n${lines.join("\n")}\n${pad}}`;
  }
  return typeof s.type === "string" ? scalar(s.type) : "unknown";
}

function paramsType(params: Parameter[]): string {
  if (params.length === 0) return "undefined";
  const lines = params.map((p) => `      ${key(p.name)}${p.required ? "" : "?"}: ${toTs(p.schema, "      ")};`);
  return `{\n${lines.join("\n")}\n    }`;
}

function jsonSchema(content: { [media: string]: { schema?: Schema } } | undefined): Schema | undefined {
  return content?.["application/json"]?.schema;
}

/** The whole of src/generated.ts for a given spec. Pure, so the drift test can call it. */
export function generate(spec: OpenApiDoc): string {
  const components = Object.entries(spec.components?.schemas ?? {});
  const seen = new Set<string>();
  const types: string[] = [];
  const table: string[] = [];
  for (const [route, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      if (seen.has(op.operationId)) throw new Error(`duplicate operationId ${op.operationId}`);
      seen.add(op.operationId);
      const params = op.parameters ?? [];
      const pathParams = params.filter((p) => p.in === "path");
      const queryParams = params.filter((p) => p.in === "query");
      const body = jsonSchema(op.requestBody?.content);
      const ok = Object.entries(op.responses ?? {}).filter(([code]) => code.startsWith("2"));
      const response = ok.map(([, r]) => toTs(jsonSchema(r.content), "    ")).join(" | ") || "unknown";
      const token = (op.security ?? []).find((s) => "token" in s);
      const scope = token?.token?.[0] ?? null;
      types.push(
        `  ${key(op.operationId)}: {\n    path: ${paramsType(pathParams)};\n    query: ${paramsType(queryParams)};\n    body: ${body === undefined ? "undefined" : toTs(body, "    ")};\n    response: ${response};\n  };`,
      );
      table.push(
        `  ${key(op.operationId)}: {\n    method: "${method.toUpperCase()}",\n    path: ${JSON.stringify(route)},\n    tokenAccess: ${token !== undefined},\n    scope: ${JSON.stringify(scope)},\n    tokenSelfOnly: ${op["x-fx-token-self-only"] === true},\n    idempotency: "${op["x-fx-idempotency"] ?? "never"}",\n    pathParams: ${JSON.stringify(pathParams.map((p) => p.name))},\n    queryParams: ${JSON.stringify(queryParams.map((p) => p.name))},\n    hasBody: ${body !== undefined},\n  },`,
      );
    }
  }
  const comps = components.map(([name, schema]) => `  ${key(name)}: ${toTs(schema, "  ")};`);
  return [
    "// GENERATED by scripts/gen-client.ts from packages/api/openapi.json. Do not edit.",
    "// Regenerate with: pnpm --filter @fx/api-client gen",
    "",
    `export interface Components {\n${comps.join("\n")}\n}`,
    "",
    `/** Per operation: the path and query parameters, the JSON body and the 2xx JSON response. */\nexport interface Operations {\n${types.join("\n")}\n}`,
    "",
    `/** Every operation by operationId. scope is the scope a token needs (null when it needs none or cannot be used). */\nexport const operations = {\n${table.join("\n")}\n} as const;`,
    "",
    "export type OperationId = keyof typeof operations;",
    "",
  ].join("\n");
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = path.join(here, "..", "..", "api", "openapi.json");
export const OUT_PATH = path.join(here, "..", "src", "generated.ts");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OUT_PATH, generate(JSON.parse(readFileSync(SPEC_PATH, "utf8")) as OpenApiDoc));
  console.log(`wrote ${OUT_PATH}`);
}
