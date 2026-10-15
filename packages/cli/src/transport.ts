import { randomInt, randomUUID } from "node:crypto";
import { operations, request, type ApiResult, type OperationId, type RequestInput, type RequestOptions } from "@fx/api-client";
import type { Io } from "./context.js";
import { CliExit, EXIT } from "./errors.js";
import { developerTokensLink, workspaceLink } from "./links.js";
import type { Output } from "./output.js";
import type { Session } from "./session.js";

const MAX_RETRIES = 3;
const MAX_WAIT_SECONDS = 60;
const TIMEOUT_MS = 30_000;
/** The largest response body the CLI will buffer. The API's own answers are a few KB; a hostile server could send gigabytes. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const tooLarge = (): CliExit => new CliExit(EXIT.unexpected, "response_too_large", `the server's answer was larger than ${MAX_BODY_BYTES / (1024 * 1024)} MB, so it was dropped`);

/** The response with its body read under the size cap (checked on Content-Length first, then on the bytes actually received). */
async function capBody(res: Response): Promise<Response> {
  if (res.body === null) return res;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new Response(Buffer.concat(chunks), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Seconds from an integer `Retry-After`; 1 when it is absent or not an integer. */
function retryAfter(headers: Headers): number {
  const raw = headers.get("retry-after");
  return raw !== null && /^\d{1,6}$/.test(raw) ? Number(raw) : 1;
}

/** The exit a final non-2xx answer maps to. The messages are fixed text or the API's own words. */
function failure(id: OperationId, res: Extract<ApiResult<OperationId>, { ok: false }>, origin: string): CliExit {
  const code = res.error?.error.code;
  const words = res.error?.error.message ?? `the server answered ${res.status}`;
  if (res.status === 401) {
    const link = developerTokensLink(origin);
    return new CliExit(EXIT.auth, code ?? "invalid_token", `the token was refused: it is wrong, expired, revoked, or its creator is no longer a member of the account. Make a new one at ${link}, then run \`fx login\`.`, link);
  }
  if (res.status === 403 && code === "session_required") {
    const link = workspaceLink(origin);
    return new CliExit(EXIT.sessionOnly, code, `${id} needs the workspace (tokens can't do this by design): ${link}`, link);
  }
  if (res.status === 403 && code === "insufficient_scope") {
    return new CliExit(EXIT.permission, code, `this needs a token with the \`${operations[id].scope}\` scope: make a new token with it in the Developer app (${developerTokensLink(origin)}), then run \`fx login\``);
  }
  if (res.status === 403) return new CliExit(EXIT.permission, code ?? "forbidden", "your role in the account no longer allows this action");
  if (res.status === 404) return new CliExit(EXIT.notFound, code ?? "not_found", words);
  if (res.status === 409 || res.status === 422) return new CliExit(EXIT.refused, code ?? "refused", `${code ?? "refused"}: ${words}`);
  if (res.status >= 300 && res.status < 400) return new CliExit(EXIT.unexpected, "redirect_refused", "the server answered with a redirect, which the CLI never follows");
  if (res.status < 300) return new CliExit(EXIT.unexpected, "unreadable_response", "the server's answer was not JSON");
  return new CliExit(EXIT.unexpected, code ?? "unexpected", words);
}

/** A fetch that times out, never follows a redirect, and, under --debug, logs method, path, status, request id and timing with the token redacted. */
function tracedFetch(out: Output): typeof fetch {
  return async (url, init) => {
    const target = new URL(String(url));
    const started = Date.now();
    out.trace(`> ${init?.method ?? "GET"} ${target.pathname}${target.search}`);
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) out.trace(`> ${k}: ${k.toLowerCase() === "authorization" ? "[redacted]" : v}`);
    const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    out.trace(`< ${res.status} request-id=${res.headers.get("x-request-id") ?? "-"} ${Date.now() - started}ms`);
    return capBody(res);
  };
}

/**
 * One API call. A 429 is retried at most 3 times, after the `Retry-After` wait plus jitter (never less than the header); a wait over 60 s is
 * reported at once. An operation that requires an Idempotency-Key gets one UUID per call, reused by every retry.
 */
export async function call<K extends OperationId>(io: Io, out: Output, session: Session, id: K, input?: RequestInput<K>): Promise<Extract<ApiResult<K>, { ok: true }>["data"]> {
  const options: RequestOptions = operations[id].idempotency === "required" ? { idempotencyKey: randomUUID() } : {};
  const send = request as (c: { baseUrl: string; token: string; fetch: typeof fetch }, id: K, input?: RequestInput<K>, o?: RequestOptions) => Promise<ApiResult<K>>;
  const config = { baseUrl: session.origin, token: session.token, fetch: tracedFetch(out) };
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let res: ApiResult<K>;
    try {
      res = await send(config, id, input, options);
    } catch (e) {
      if (e instanceof CliExit) throw e;
      // fx-swallow-ok: the transport's own text can name the host or hold a cause chain; the message is fixed
      throw new CliExit(EXIT.network, "network", `could not reach ${session.origin}: DNS, connection, TLS or timeout failure`);
    }
    if (res.ok) return res.data;
    if (res.status !== 429) throw failure(id, res, session.origin);
    const wait = retryAfter(res.headers);
    const streams = res.error?.error.code === "stream_limit";
    if (wait > MAX_WAIT_SECONDS || attempt >= MAX_RETRIES) {
      throw streams
        ? new CliExit(EXIT.streamLimit, "stream_limit", `too many open streams for this account; close another watch or retry in ${wait}s`)
        : new CliExit(EXIT.rateLimited, "rate_limited", `rate limited: retry in ${wait}s`);
    }
    out.trace(`429: waiting ${wait}s before retry ${attempt + 1}`);
    await sleep(wait * 1000 + randomInt(0, 250));
  }
}
