import https from "node:https";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { githubProxyForwardUrl, loadGithubForwardConfig, type GithubForwardConfig } from "@fx/runner";
import { resolveChecked, NetGuardError, type HostLookup } from "@fx/net-guard";
import {
  decideProxyRequest,
  defaultSandboxRunResolver,
  InstallationTokenCache,
  loadAppCredentials,
  MintTimeoutError,
  verifySandboxOidcToken,
  OidcVerifyError,
  type AccessTokenRequester,
  type ProxyDecisionDeps,
  type SandboxRunResolver,
} from "@fx/github";
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet } from "jose";
import { loadProxyOidcEnv } from "./proxyEnv";

/**
 * D#2 H13b: the gh-proxy route's Next.js glue. All decision logic (OIDC
 * verification, the sandbox->role/installation resolve, decide(), token
 * minting) lives in @fx/github; this file owns request/response
 * translation, the two host checks (O2), the cold-start self-check (O4),
 * and the pinned upstream connection (O3) -- the parts that are Node
 * runtime/socket-level and don't belong in a pure decision package.
 */

const OIDC_HEADER = "vercel-sandbox-oidc-token";
export const MAX_PROXY_BODY_BYTES = 50_000_000;

class BodyTooLargeError extends Error {}

async function readBodyCapped(req: NextRequest, maxBytes: number): Promise<Uint8Array> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * O2: the proxy refuses, with 421 and no upstream request, any request
 * whose `Host` is not EXACTLY `config.host` (strict string equality --
 * never lower-cased or trimmed first, so a trailing-dot or upper-case
 * `Host` already fails to match), or whose `X-Forwarded-Host` (when
 * present) disagrees with it.
 */
function hostBindingOk(req: NextRequest, config: GithubForwardConfig): boolean {
  const host = req.headers.get("host");
  if (host !== config.host) return false;
  const xfh = req.headers.get("x-forwarded-host");
  if (xfh !== null && xfh !== config.host) return false;
  return true;
}

export interface ColdStartResult {
  ok: boolean;
}

export interface GhProxyHandlerDeps extends ProxyDecisionDeps {
  githubForward: GithubForwardConfig;
  /** O4: resolved once at cold start, reused for every request this instance serves. */
  coldStartCheck: Promise<ColdStartResult>;
  oidcJwks: JWTVerifyGetKey;
  oidcIssuer: string;
  oidcTeamId: string;
  oidcProjectId: string;
  /** O3: resolves the upstream host; injectable so tests never make a real DNS query. */
  resolveUpstream: (host: string, lookup?: HostLookup) => Promise<string[]>;
  /** O3: performs the pinned forward; injectable so tests never open a real socket. */
  forwardPinned: PinnedRequester;
}

export interface PinnedRequestParams {
  host: string;
  address: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface PinnedResponse {
  status: number;
  headers: Record<string, string>;
  bodyStream: ReadableStream<Uint8Array> | null;
}

export type PinnedRequester = (params: PinnedRequestParams) => Promise<PinnedResponse>;

/**
 * D#2 Correction C28 §3 item 8: named timeout constants.
 * - The mint call (`api.github.com/app/installations/.../access_tokens`)
 *   gets the short one -- it's a small JSON round trip, never a stream.
 * - The general proxied forward gets a longer time-to-response-headers
 *   allowance (a busy upstream can take longer to start answering) and its
 *   own, separate idle-between-chunks timeout once streaming starts.
 *   There is deliberately NO total-duration cap on the forward: a slow but
 *   steadily-streaming clone must keep going.
 */
export const MINT_TIMEOUT_MS = 10_000;
export const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;
export const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

export class UpstreamTimeoutError extends Error {
  readonly stage: "headers" | "idle";
  constructor(stage: "headers" | "idle") {
    super(`gh-proxy: upstream timeout (${stage})`);
    this.name = "UpstreamTimeoutError";
    this.stage = stage;
  }
}

/**
 * Wraps `bodyStream` so `idleTimeoutMs` of silence between chunks errors
 * the stream with `UpstreamTimeoutError("idle")` -- no total-duration cap,
 * the timer resets on every chunk. Pass-through otherwise: bytes are
 * enqueued as they arrive, never buffered or delayed.
 */
function applyIdleTimeout(
  stream: ReadableStream<Uint8Array> | null,
  idleTimeoutMs: number,
  logContext: { host: string; path: string },
): ReadableStream<Uint8Array> | null {
  if (!stream) return stream;
  const reader = stream.getReader();
  // `finished` guards against the pump loop below reacting a SECOND time
  // once the idle timer has already errored the stream and cancelled the
  // reader -- without it, the reader's now-cancelled pending read() can
  // settle afterward and this function would try to error an
  // already-errored controller (a TypeError, and an unhandled rejection
  // since nothing downstream is still awaiting `start()`'s own promise).
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (finished) return;
          finished = true;
          // D#2 C28 §3 item 8: "an idle timeout mid-stream ... is logged."
          console.warn("gh-proxy: upstream timeout", { reason: "idle", ...logContext });
          try {
            controller.error(new UpstreamTimeoutError("idle"));
          } catch {
            // already closed/errored -- nothing left to do.
          }
          reader.cancel().catch(() => {});
        }, idleTimeoutMs);
      };
      arm();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (finished) return;
          if (done) {
            clearTimeout(idleTimer);
            finished = true;
            controller.close();
            return;
          }
          arm();
          controller.enqueue(value);
        }
      } catch (err) {
        clearTimeout(idleTimer);
        if (finished) return;
        finished = true;
        try {
          controller.error(err);
        } catch {
          // already closed/errored -- nothing left to do.
        }
      }
    },
    cancel(reason) {
      finished = true;
      return reader.cancel(reason);
    },
  });
}

/**
 * Wraps any `PinnedRequester` with (a) a time-to-response-headers timeout
 * -- `inner` must resolve within `headersTimeoutMs` or this rejects with
 * `UpstreamTimeoutError("headers")` -- and (b), once resolved, the idle-
 * between-chunks timeout on the returned `bodyStream` (`applyIdleTimeout`
 * above). Kept independent of any concrete transport (`inner` is just a
 * function) so it's unit-testable with a fake `inner` and
 * `vi.useFakeTimers()`, never a real socket or a real sleep -- the actual
 * `https.request`-based transport (`rawNodeHttpsPinnedRequester` below) is
 * exercised only by the live Gate 2 check, per C28's own note that these
 * tests "use stubbed requesters and fake timers, not real sleeps."
 */
export function withPinnedTimeouts(
  inner: PinnedRequester,
  opts: { headersTimeoutMs: number; idleTimeoutMs: number },
): PinnedRequester {
  return (params) =>
    new Promise<PinnedResponse>((resolve, reject) => {
      let settled = false;
      const headersTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new UpstreamTimeoutError("headers"));
      }, opts.headersTimeoutMs);

      inner(params).then(
        (response) => {
          if (settled) return; // already timed out -- drop this late response
          settled = true;
          clearTimeout(headersTimer);
          resolve({
            ...response,
            bodyStream: applyIdleTimeout(response.bodyStream, opts.idleTimeoutMs, {
              host: params.host,
              path: params.path,
            }),
          });
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(headersTimer);
          reject(err);
        },
      );
    });
}

/**
 * O3, pure half: pins the TCP connection to `params.address` via Node's
 * `lookup` override, while keeping SNI and `Host` as `params.host` --
 * never a second DNS resolution, never a fetch-by-name. Exported and
 * tested directly (call `.lookup` with a fake callback) so O3 is proven
 * with no real socket.
 */
export function buildPinnedRequestOptions(params: PinnedRequestParams): https.RequestOptions {
  const family = params.address.includes(":") ? 6 : 4;
  return {
    hostname: params.host,
    servername: params.host,
    path: params.path,
    method: params.method,
    headers: { ...params.headers, host: params.host },
    // Node's connect path (autoSelectFamily, on by default since Node 20) calls lookup
    // with { all: true } and expects an array of { address, family }; a bare string
    // there fails with ERR_INVALID_IP_ADDRESS. Answer both forms with the one pinned address.
    lookup: ((_hostname: string, opts: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) =>
      opts && opts.all
        ? callback(null, [{ address: params.address, family }])
        : callback(null, params.address, family)) as unknown as https.RequestOptions["lookup"],
  };
}

function flattenHeaders(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * The only transport knobs a caller may change: the port and the trusted CA. Production never sets them
 * (443, system roots); the tests point the real transport at a local TLS server that verifies like GitHub's.
 */
export type TransportOverrides = Pick<https.RequestOptions, "port" | "ca">;

/** The bare, untimeouted `https.request` transport. `nodeHttpsPinnedRequester` below is this wrapped with the default proxy timeouts -- see `withPinnedTimeouts`'s doc comment for why the two are kept separate. */
function rawNodeHttpsPinnedRequester(params: PinnedRequestParams, transport: TransportOverrides = {}): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...buildPinnedRequestOptions(params), ...transport }, (res) => {
      resolve({
        status: res.statusCode ?? 502,
        headers: flattenHeaders(res.headers),
        bodyStream: Readable.toWeb(res) as ReadableStream<Uint8Array>,
      });
    });
    req.on("error", reject);
    req.end(params.body ? Buffer.from(params.body) : undefined);
  });
}

/** O3's real transport, with the general-forward timeouts (C28 §3 item 8) applied. `transport` is for tests only. */
export function createNodeHttpsPinnedRequester(transport: TransportOverrides = {}): PinnedRequester {
  return withPinnedTimeouts((params) => rawNodeHttpsPinnedRequester(params, transport), {
    headersTimeoutMs: UPSTREAM_HEADERS_TIMEOUT_MS,
    idleTimeoutMs: UPSTREAM_IDLE_TIMEOUT_MS,
  });
}

export const nodeHttpsPinnedRequester: PinnedRequester = createNodeHttpsPinnedRequester();

/** Picks exactly one, already-validated address to connect the real socket to (O3: "connects only to the validated one"). */
function pickAddress(addresses: readonly string[]): string {
  const first = addresses[0];
  // `resolveChecked` throws `dns_failed` on an empty result, so this
  // never fires in production -- it's here so a fake `resolveUpstream`
  // in a test can't silently hand back `undefined` as if it were a host.
  if (first === undefined) throw new NetGuardError("dns_failed", "gh-proxy-upstream");
  return first;
}

/**
 * The token-mint call to `api.github.com/app/installations/.../access_tokens`
 * is itself an upstream GitHub connection -- O3 pins it too. D#2 C28 §3
 * item 8: it gets its OWN, shorter headers-timeout (`MINT_TIMEOUT_MS`)
 * regardless of what `deps.forwardPinned` itself defaults to -- wrapping
 * it again here is harmless even when the outer `forwardPinned` is
 * already timeout-wrapped (the tighter of the two timers just fires
 * first) -- and translates a headers-timeout specifically into
 * `MintTimeoutError`, the one signal `decideProxyRequest` recognizes to
 * answer 502 `upstream_unavailable` instead of the generic 403
 * `token_mint_failed` every OTHER mint failure still gets.
 */
export function buildAccessTokenRequester(deps: {
  resolveUpstream: GhProxyHandlerDeps["resolveUpstream"];
  forwardPinned: PinnedRequester;
}): AccessTokenRequester {
  const mintForward = withPinnedTimeouts(deps.forwardPinned, {
    headersTimeoutMs: MINT_TIMEOUT_MS,
    idleTimeoutMs: UPSTREAM_IDLE_TIMEOUT_MS,
  });
  return async ({ installationId, appJwt, repositories, permissions }) => {
    // null is the explicit installation-wide variant; anything but null or exactly one repo is refused before any network call.
    if (repositories !== null && repositories.length !== 1) throw new Error("mint: repositories must be one repo or the installation-wide variant");
    const host = "api.github.com";
    const addresses = await deps.resolveUpstream(host);
    const body = Buffer.from(JSON.stringify(repositories === null ? { permissions } : { repositories, permissions }), "utf8");
    let response: PinnedResponse;
    try {
      response = await mintForward({
        host,
        address: pickAddress(addresses),
        method: "POST",
        path: `/app/installations/${installationId}/access_tokens`,
        headers: {
          authorization: `Bearer ${appJwt}`,
          accept: "application/vnd.github+json",
          // GitHub refuses API calls with no User-Agent (403 "Request forbidden by
          // administrative rules"); raw https.request sends none, unlike fetch.
          "user-agent": "fulcrumaxe-cloud",
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        },
        body,
      });
    } catch (err) {
      if (err instanceof UpstreamTimeoutError) {
        throw new MintTimeoutError();
      }
      throw err;
    }
    const text = await new Response(response.bodyStream).text();
    if (response.status < 200 || response.status >= 300) {
      // Diagnostics: the HTTP status, plus GitHub's own short error message reduced to
      // letters and spaces. It stays on the error object only: the sync log prints it solely
      // when it starts with a known fixed phrase (see syncFailureTag).
      let ghMessage = "";
      let raw: unknown;
      try {
        raw = (JSON.parse(text) as { message?: unknown } | null)?.message;
      } catch {
        // GitHub answers a request without a User-Agent with PLAIN TEXT ("Request forbidden by administrative
        // rules ..."), not JSON, and that is the very failure worth naming. The same reduction applies.
        raw = text;
      }
      if (typeof raw === "string") ghMessage = raw.replace(/[^A-Za-z ]/g, "").slice(0, 80);
      throw Object.assign(new Error("access_token_mint_failed"), { status: response.status, ghMessage });
    }
    const parsed = JSON.parse(text) as { token?: string; expires_at?: string; permissions?: unknown };
    if (!parsed.token || !parsed.expires_at) {
      throw new Error("access_token_mint_failed");
    }
    // The permissions GitHub reports for the token: only the plan_read mint checks them (E2), but they are always passed on.
    // Passed through unchanged (never filtered): a value that is not a string makes the read-only check fail, not vanish.
    const reported =
      parsed.permissions !== null && typeof parsed.permissions === "object" && !Array.isArray(parsed.permissions)
        ? (parsed.permissions as Record<string, string>)
        : undefined;
    return { token: parsed.token, expiresAt: parsed.expires_at, ...(reported ? { permissions: reported } : {}) };
  };
}

export function defaultGhProxyHandlerDeps(
  githubForward: GithubForwardConfig = loadGithubForwardConfig(process.env),
): GhProxyHandlerDeps {
  // Checked first, so a bad setting denies every request.
  const oidc = loadProxyOidcEnv(process.env);
  const resolveUpstream = (host: string, lookup?: HostLookup) => resolveChecked(host, lookup);
  const coldStartCheck: Promise<ColdStartResult> = resolveUpstream(githubForward.host).then(
    () => ({ ok: true }),
    () => ({ ok: false }),
  );
  const forwardPinned = nodeHttpsPinnedRequester;
  return {
    githubForward,
    coldStartCheck,
    oidcJwks: createRemoteJWKSet(new URL(oidc.jwksUrl)),
    oidcIssuer: oidc.issuer,
    oidcTeamId: oidc.teamId,
    // Not VERCEL_PROJECT_ID: in the proxy deployment that is the proxy itself.
    oidcProjectId: oidc.sandboxProjectId,
    resolveUpstream,
    forwardPinned,
    resolveSandboxRun: defaultSandboxRunResolver as SandboxRunResolver,
    appCredentials: loadAppCredentials(process.env),
    tokenCache: new InstallationTokenCache(),
    accessTokenRequester: buildAccessTokenRequester({
      resolveUpstream,
      forwardPinned,
    }),
  };
}

function pathFromParams(segments: string[]): string {
  return "/" + segments.map((s) => s).join("/");
}

/**
 * D#2 Correction C28 §3 item 4: headers are forwarded by ALLOWLIST, not
 * denylist -- the security review's should-fix 1 (CWE-444). Only these
 * five sandbox-supplied headers ever reach GitHub; everything else the
 * proxy itself sets (`authorization`, `host`, `content-length`) below.
 */
const FORWARD_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-github-api-version",
  "git-protocol",
]);

/**
 * D#2 fix round 1, must-fix 1: `content-encoding` is deliberately never in
 * `FORWARD_HEADER_ALLOWLIST` above -- it's the one header this proxy
 * forwards CONDITIONALLY, not by static allowlist membership.
 * `decideProxyRequest` has already judged, before any mint, whether this
 * exact request is the single case that may carry it upstream (a POST to
 * the literal `git-upload-pack` endpoint, with `gzip`); `forwardContentEncoding`
 * is that verdict, never re-derived here from the path or method a second
 * time. Every other request that carried the header was already denied
 * before `forwardHeaders` is ever called.
 */
function forwardHeaders(
  req: NextRequest,
  installationToken: string,
  target: "git" | "api",
  forwardContentEncoding: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (FORWARD_HEADER_ALLOWLIST.has(k)) {
      headers[k] = value;
    }
  });
  if (forwardContentEncoding) {
    const contentEncoding = req.headers.get("content-encoding");
    if (contentEncoding !== null) {
      headers["content-encoding"] = contentEncoding;
    }
  }
  // GitHub refuses a request with no User-Agent. git, curl and gh always send one; a bare
  // client might not, so supply a default only when the sandbox sent none.
  if (!headers["user-agent"]) headers["user-agent"] = "fulcrumaxe-cloud";
  headers["authorization"] =
    target === "git"
      ? `Basic ${Buffer.from(`x-access-token:${installationToken}`, "utf8").toString("base64")}`
      : `Bearer ${installationToken}`;
  return headers;
}

/**
 * D#2 H13, body criterion 3 / O2-O4 / B1-B7. Every check below runs in
 * the order the Spec requires it: host binding (O2, no upstream request
 * on a mismatch) before the cold-start check (O4), before the body is
 * even read, before OIDC verification, before `decideProxyRequest`.
 */
export async function ghProxyHandler(
  req: NextRequest,
  deps: GhProxyHandlerDeps = defaultGhProxyHandlerDeps(),
  decide = decideProxyRequest,
): Promise<NextResponse> {
  if (!hostBindingOk(req, deps.githubForward)) {
    return NextResponse.json({ error: "host_not_allowed" }, { status: 421 });
  }

  const coldStart = await deps.coldStartCheck;
  if (!coldStart.ok) {
    return NextResponse.json({ error: "proxy_unavailable" }, { status: 503 });
  }

  const oidcToken = req.headers.get(OIDC_HEADER);
  if (!oidcToken) {
    // Reason code only, like the denial log below: no header names, no claims.
    console.warn("gh-proxy: unauthorized", { reason: "missing_oidc_token" });
    return NextResponse.json({ error: "missing_oidc_token" }, { status: 401 });
  }
  let sandboxName: string;
  try {
    const claims = await verifySandboxOidcToken(oidcToken, {
      jwks: deps.oidcJwks,
      expectedIssuer: deps.oidcIssuer,
      expectedTeamId: deps.oidcTeamId,
      expectedProjectId: deps.oidcProjectId,
      // D#2 Correction C28 §2: the ONE source of the expected audience.
      expectedAudience: githubProxyForwardUrl(deps.githubForward),
    });
    sandboxName = claims.sandboxName;
  } catch (err) {
    const code = err instanceof OidcVerifyError ? err.code : "signature";
    // Why the 401, as the fixed code the response already carries. Never a claim, a token or an
    // error message: those can echo caller-supplied text.
    console.warn("gh-proxy: unauthorized", { reason: `oidc_${code}` });
    return NextResponse.json({ error: `oidc_${code}` }, { status: 401 });
  }

  let rawBody: Uint8Array;
  try {
    rawBody = await readBodyCapped(req, MAX_PROXY_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "body_too_large" }, { status: 413 });
    }
    throw err;
  }

  const url = new URL(req.url);
  const pathSegments = url.pathname.replace(/^\/api\/gh-proxy\//, "").split("/");
  const path = pathFromParams(pathSegments);
  // D#2 C28 §3 item 2: pairs in received order, DUPLICATES PRESERVED --
  // `decide`/`decideProxyRequest` is the one place that judges and dedupes
  // this (`normalizeQuery`), never `url.searchParams.forEach`'s own
  // silent last-value-wins into a Record here.
  const queryEntries: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    queryEntries.push([key, value]);
  });

  const decision = await decide(
    {
      method: req.method,
      path,
      query: queryEntries,
      rawBody,
      sandboxName,
      contentEncoding: req.headers.get("content-encoding"),
    },
    deps,
  );

  if (!decision.allow) {
    // Body criterion 3: "logs the reason" -- server-side only, never in
    // the response body (which carries a generic error code, not the
    // internal decide() reason string, so no policy detail or repo/role
    // shape leaks to the sandbox that just got denied).
    console.warn("gh-proxy: denied", { reason: decision.reason, path });
    if (decision.status === 502) {
      // D#2 C28 §3 item 8: a mint timeout -- an upstream availability
      // failure, not a policy denial. Same response shape as the
      // resolveUpstream-failure 502 just below.
      return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
    }
    // H13e: the one denial with its own public code -- the installation is
    // not the write App's, so the caller can tell it apart from a policy denial.
    if (decision.reason === "installation_not_writable") {
      return NextResponse.json({ error: "installation_not_writable" }, { status: 403 });
    }
    return NextResponse.json({ error: "denied" }, { status: decision.status });
  }

  const target = path.startsWith("/repos/") ? "api" : "git";

  // O3: resolved fresh for THIS request's actual forward -- a blocked or
  // unresolvable address means 502 with no upstream connection at all;
  // `deps.forwardPinned` below is never reached.
  let addresses: string[];
  try {
    addresses = await deps.resolveUpstream(decision.upstreamHost);
  } catch (err) {
    console.warn("gh-proxy: upstream host refused", {
      reason: err instanceof NetGuardError ? err.code : "dns_failed",
    });
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }

  // D#2 C28 §3 items 2/3 (item 2 also fixes item (f), REST pagination --
  // the pre-C28 code special-cased `target === "api"` to drop the query
  // string entirely, per PR 140's security review's own code-review note):
  // the forwarded query string is rebuilt from `decision.query` -- the SAME
  // validated map decide() judged -- never `url.searchParams.toString()`'s
  // raw, possibly-duplicated string, and forwarded for BOTH target kinds. A
  // key the proxy judged absent (denylisted, or simply never validated)
  // therefore can never appear upstream.
  const validatedQueryString = new URLSearchParams(decision.query).toString();
  const upstreamPath = path + (validatedQueryString ? `?${validatedQueryString}` : "");

  let upstream: PinnedResponse;
  try {
    upstream = await deps.forwardPinned({
      host: decision.upstreamHost,
      address: pickAddress(addresses),
      method: req.method,
      path: upstreamPath,
      headers: forwardHeaders(req, decision.installationToken, target, decision.forwardContentEncoding),
      body: rawBody.byteLength > 0 ? rawBody : null,
    });
  } catch (err) {
    // D#2 C28 §3 item 8: a time-to-response-headers timeout on the
    // PROXIED forward (as opposed to the mint call, handled inside
    // decideProxyRequest/getInstallationToken) -- 504, logged, no retry.
    // An idle-mid-stream timeout, by contrast, fires AFTER this call has
    // already resolved and the response is already streaming back to the
    // sandbox (see `applyIdleTimeout`) -- there is no status code left to
    // change at that point, so it just aborts the stream, also logged.
    if (err instanceof UpstreamTimeoutError && err.stage === "headers") {
      console.warn("gh-proxy: upstream timeout", { reason: "headers", path });
      return NextResponse.json({ error: "upstream_timeout" }, { status: 504 });
    }
    throw err;
  }

  return new NextResponse(countBytes(upstream.bodyStream, target, path), {
    status: upstream.status,
    headers: upstream.headers,
  });
}

/**
 * Body criterion 6, first half: "confirm the clone response is streamed
 * rather than buffered." This wraps the already-streaming upstream body
 * (never `Buffer.concat`'d, never awaited-then-resent) with a byte
 * counter only -- chunks pass through untouched and un-delayed.
 *
 * Second half: this Function terminates GitHub's TLS connection and opens
 * its own to the sandbox, so these bytes ARE its own egress on both legs
 * (the answer the body criterion asks to be recorded; see the PR
 * description). Writing the count into `ledger` needs `@fx/spend`,
 * outside H13b's `acceptance_files` -- this measures/logs it; wiring the
 * write is a flagged follow-up.
 */
function countBytes(
  stream: ReadableStream<Uint8Array> | null,
  target: "git" | "api",
  path: string,
): ReadableStream<Uint8Array> | null {
  if (!stream || target !== "git") return stream;
  let total = 0;
  const [forMetering, forResponse] = stream.tee();
  void (async () => {
    const reader = forMetering.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) total += value.byteLength;
    }
    console.info("gh-proxy: git response bytes", { path, bytes: total });
  })().catch(() => {});
  return forResponse;
}
