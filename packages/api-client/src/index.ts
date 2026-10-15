import { operations, type OperationId, type Operations, type Components } from "./generated.js";

export { operations } from "./generated.js";
export type { OperationId, Operations, Components } from "./generated.js";

/** The API's error body: `{ error: { code, message, request_id, ... } }`. */
export type ErrorBody = Components["Error"];

export interface ClientConfig {
  /** Origin (and any path prefix) the API is served from, for example `https://example.test`. */
  baseUrl: string;
  /** The bearer token. The caller decides where it comes from; this package never reads the environment. */
  token: string;
  /** The fetch to use. Defaults to the global one. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Sent as `Idempotency-Key`. Refused up front for operations that reject the header. */
  idempotencyKey?: string;
  /** Extra headers, applied last (so `Accept: text/event-stream` can replace the JSON default). */
  headers?: Record<string, string>;
  /** Defaults to "manual": a redirect is returned to the caller rather than followed with a token attached. */
  redirect?: RequestRedirect;
}

type Op<K extends OperationId> = Operations[K];
type Slot<Name extends "path" | "query" | "body", K extends OperationId> = Op<K>[Name] extends undefined
  ? { [P in Name]?: never }
  : Record<never, never> extends Op<K>[Name]
    ? { [P in Name]?: Op<K>[Name] }
    : { [P in Name]: Op<K>[Name] };

/** What a call to operation K takes: its path parameters, query parameters and JSON body. */
export type RequestInput<K extends OperationId> = Slot<"path", K> & Slot<"query", K> & Slot<"body", K>;

type CallArgs<K extends OperationId> = Record<never, never> extends RequestInput<K>
  ? [input?: RequestInput<K>, options?: RequestOptions]
  : [input: RequestInput<K>, options?: RequestOptions];

export type ApiResult<K extends OperationId> =
  | { ok: true; status: number; data: Op<K>["response"]; headers: Headers }
  /** `error` is the parsed API error body, or null when the response was not one. `text` is the raw body. */
  | { ok: false; status: number; error: ErrorBody | null; text: string; headers: Headers };

export class ApiClientUsageError extends Error {
  override name = "ApiClientUsageError";
}

/** The URL and RequestInit for operation `id`, for callers that need the raw Response (for example to stream). */
export function buildRequest<K extends OperationId>(
  config: Pick<ClientConfig, "baseUrl" | "token">,
  id: K,
  ...args: CallArgs<K>
): { url: string; init: RequestInit } {
  const [input, options] = args as [RequestInput<K>?, RequestOptions?];
  const op = operations[id];
  const { path = {}, query = {}, body } = (input ?? {}) as { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
  if (config.token === "") throw new ApiClientUsageError("token is empty");
  if (options?.idempotencyKey !== undefined && op.idempotency === "never") {
    throw new ApiClientUsageError(`${id} does not accept an Idempotency-Key`);
  }
  if (op.idempotency === "required" && options?.idempotencyKey === undefined) {
    throw new ApiClientUsageError(`${id} requires an Idempotency-Key`);
  }
  if (op.hasBody && body === undefined) throw new ApiClientUsageError(`${id} requires a body`);
  const route = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = path[name];
    if (v === undefined || v === null || v === "") throw new ApiClientUsageError(`${id} requires path parameter ${name}`);
    const text = String(v);
    // "." and ".." survive encodeURIComponent and a URL parser would resolve them away, turning the call into a different route
    if (text === "." || text === "..") throw new ApiClientUsageError(`${id} path parameter ${name} is not a valid identifier`);
    return encodeURIComponent(text);
  });
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (!(op.queryParams as readonly string[]).includes(k)) throw new ApiClientUsageError(`${id} has no query parameter ${k}`);
    for (const item of Array.isArray(v) ? v : [v]) search.append(k, String(item));
  }
  const qs = search.toString();
  const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${config.token}` };
  if (op.hasBody) headers["content-type"] = "application/json";
  if (options?.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
  for (const [k, v] of Object.entries(options?.headers ?? {})) headers[k.toLowerCase()] = v;
  return {
    url: `${config.baseUrl.replace(/\/+$/, "")}${route}${qs === "" ? "" : `?${qs}`}`,
    init: {
      method: op.method,
      headers,
      redirect: options?.redirect ?? "manual",
      ...(op.hasBody ? { body: JSON.stringify(body) } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  };
}

function asErrorBody(v: unknown): ErrorBody | null {
  const e = v !== null && typeof v === "object" ? (v as { error?: unknown }).error : undefined;
  return e !== null && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (v as ErrorBody) : null;
}

/**
 * Calls operation `id`. An HTTP error status is a result (`ok: false`), not a throw; only a failure to get a
 * response at all (network, abort) rejects. Retries, redirects and credential storage are the caller's business.
 */
export async function request<K extends OperationId>(config: ClientConfig, id: K, ...args: CallArgs<K>): Promise<ApiResult<K>> {
  const { url, init } = buildRequest(config, id, ...args);
  const res = await (config.fetch ?? fetch)(url, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    // fx-swallow-ok: a body that is not JSON is reported as an error result carrying its text
    json = undefined;
  }
  if (res.status >= 200 && res.status < 300 && json !== undefined) {
    return { ok: true, status: res.status, data: json as Op<K>["response"], headers: res.headers };
  }
  return { ok: false, status: res.status, error: asErrorBody(json), text, headers: res.headers };
}
