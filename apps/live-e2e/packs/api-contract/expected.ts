/**
 * Pure checks for the api-contract pack (row W21). The OpenAPI document is read from the deployment under test, so
 * the pack checks the live answers against what that same deployment publishes; nothing is imported from the app.
 */

export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const STATUS_RE = /^[1-5][0-9][0-9]$/;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: Json[];
  [key: string]: unknown;
}

export interface Operation {
  /** The path template, `{id}` style. */
  template: string;
  operationId: string;
  /** True when the path has a parameter, so the call needs an id. */
  hasPathParam: boolean;
  hasRequiredQuery: boolean;
  documented: number[];
  /** The 200 schema when the answer is JSON; undefined for a stream or a download. */
  okSchema: Schema | undefined;
  /** Whether the route serves a JSON answer at all (a pure stream or download is left out of the read sweep). */
  json: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every documented GET operation, sorted by path. */
export function listGetOperations(doc: unknown): Operation[] {
  if (!isObject(doc) || !isObject(doc["paths"])) throw new Error("the OpenAPI document has no paths");
  const out: Operation[] = [];
  for (const [template, item] of Object.entries(doc["paths"])) {
    if (!isObject(item) || !isObject(item["get"])) continue;
    const get = item["get"];
    const params = Array.isArray(get["parameters"]) ? get["parameters"].filter(isObject) : [];
    const responses = isObject(get["responses"]) ? get["responses"] : {};
    const ok = isObject(responses["200"]) ? responses["200"] : {};
    const content = isObject(ok["content"]) ? ok["content"] : {};
    const jsonBody = isObject(content["application/json"]) ? content["application/json"] : undefined;
    out.push({
      template,
      operationId: typeof get["operationId"] === "string" ? get["operationId"] : template,
      hasPathParam: template.includes("{"),
      hasRequiredQuery: params.some((p) => p["in"] === "query" && p["required"] === true),
      documented: Object.keys(responses).filter((k) => STATUS_RE.test(k)).map(Number),
      okSchema: jsonBody !== undefined && isObject(jsonBody["schema"]) ? (jsonBody["schema"] as Schema) : undefined,
      json: jsonBody !== undefined,
    });
  }
  return out.sort((a, b) => a.template.localeCompare(b.template));
}

/** The path to call: a path parameter becomes the all-zero id the API's own id pattern accepts. */
export function concretePath(template: string): string {
  return template.replace(/\{[^}]+\}/g, ZERO_UUID);
}

/**
 * A small structural check of a JSON value against the part of JSON Schema the API publishes: type, enum,
 * properties, required and items (the first three items of a list). It does not check `format` or `pattern`.
 * Returns the problems as `path: what`, never the value itself.
 */
export function schemaViolations(schema: Schema | undefined, value: unknown, path = "$"): string[] {
  if (schema === undefined) return [];
  const out: string[] = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some((t) => matchesType(t, value))) return [`${path}: expected ${types.join(" or ")}`];
  if (schema.enum !== undefined && !schema.enum.includes(value as Json)) out.push(`${path}: not one of the documented values`);
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) out.push(`${path}.${key}: missing`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in value) out.push(...schemaViolations(sub, value[key], `${path}.${key}`));
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.slice(0, 3).forEach((item, i) => out.push(...schemaViolations(schema.items, item, `${path}[${i}]`)));
  }
  return out;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
    case "string":
    case "boolean":
      return typeof value === type;
    default:
      return true;
  }
}

/** The error envelope every `/api/v1` refusal uses: `{ error: { code, message, request_id } }`. */
export function errorEnvelopeViolations(body: unknown): string[] {
  if (!isObject(body) || !isObject(body["error"])) return ["body has no error object"];
  const e = body["error"];
  return ["code", "message", "request_id"].filter((k) => typeof e[k] !== "string" || e[k] === "").map((k) => `error.${k} is not a non-empty string`);
}

function parse(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

/** Signed out, every operation must answer 401 with the error envelope. */
export function signedOutViolations(op: Operation, res: { status: number; body: string }): string[] {
  if (res.status !== 401) return [`${op.operationId}: answered ${res.status}, expected 401`];
  const p = parse(res.body);
  return p.ok ? errorEnvelopeViolations(p.value).map((v) => `${op.operationId}: ${v}`) : [`${op.operationId}: 401 body is not JSON`];
}

/**
 * Signed in, an answer must be a documented status, never a 5xx, and match its shape: the 200 schema on a 200, the
 * error envelope on anything else. `expectOk` demands the 200 (collection reads on an open account).
 */
export function signedInViolations(op: Operation, res: { status: number; body: string }, expectOk: boolean): string[] {
  const label = op.operationId;
  if (res.status >= 500) return [`${label}: answered ${res.status}`];
  if (!op.documented.includes(res.status)) return [`${label}: answered ${res.status}, which the document does not list`];
  if (expectOk && res.status !== 200) return [`${label}: answered ${res.status}, expected 200`];
  const p = parse(res.body);
  if (!p.ok) return [`${label}: ${res.status} body is not JSON`];
  if (res.status === 200) return schemaViolations(op.okSchema, p.value).map((v) => `${label}: ${v}`);
  return errorEnvelopeViolations(p.value).map((v) => `${label}: ${v}`);
}

/** Collection reads that must answer 200 for an open account (the rest may answer any documented status). */
export const MUST_ANSWER_200: readonly string[] = [
  "/api/v1/account",
  "/api/v1/repos",
  "/api/v1/runs",
  "/api/v1/work-items",
  "/api/v1/usage",
  "/api/v1/budgets",
  "/api/v1/run-limits",
  "/api/v1/stats",
];

/** Milliseconds to wait before one retry of a 429, from `retry-after` (seconds); capped so a bad header cannot stall the run. */
export function retryDelayMs(header: string | null, capMs = 65_000): number {
  const secs = header === null ? NaN : Number(header);
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, capMs) : 15_000;
}
