import type { Pool } from "pg";
import type { ZodTypeAny } from "zod";
import type { Principal } from "./principal.js";
import type { SessionLimit } from "./ratelimit/session.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type PrincipalKind = "session" | "token";
export type MembershipRole = "owner" | "admin" | "member";
export type IdempotencyMode = "required" | "optional" | "never";

/** "Scopes that can be minted in v1" (API-1 only *declares* the shape; API-3b mints them). */
export type Scope = "read" | "runs:cancel" | "audit:read" | "work_items:write" | "discussions:write" | "corrections:write";

/** Runtime companion to `Scope` -- the mintable scopes as values, read by tokens/service.ts and token-inventory.test.ts. */
export const SCOPES: readonly Scope[] = ["read", "runs:cancel", "audit:read", "work_items:write", "discussions:write", "corrections:write"];

/** Shared role ranking -- single source of truth for handler.ts's minRole gate and tokens/service.ts's scope-vs-role check. */
export const ROLE_RANK: Record<MembershipRole, number> = { member: 0, admin: 1, owner: 2 };

/**
 * D#45 S8: what a handler returns when the response is a stream of text
 * rather than a JSON document (the run-event export, NDJSON). The dispatcher
 * builds the `Response` from `chunks` without buffering it, adding the same
 * `Cache-Control` and `X-Request-Id` every other `/api/v1` response carries.
 * Only a route whose entry sets `rawResponse` may return one.
 */
export class RawBody {
  constructor(
    readonly contentType: string,
    readonly headers: Record<string, string>,
    readonly chunks: AsyncIterable<string>,
  ) {}
}

export interface RouteContext {
  pool: Pool;
  principal: Principal;
  /** The `Idempotency-Key` header, when the request carried one (handler.ts sets it; absent in direct calls). */
  idempotencyKey?: string | null;
  /** A handler that itself replayed an earlier request calls this so the response carries `Idempotent-Replayed: true`. */
  markReplayed?: () => void;
}

export interface RouteInput<Params, Query, Body> {
  params: Params;
  query: Query;
  body: Body;
}

/**
 * "Registry entries: each declares method, path, operationId, zod
 * schemas, principals (default ['session']), minRole, scope,
 * idempotency: 'required'|'optional'|'never', rateClass and startsRun.
 * ... Handlers stay thin and call (ctx:{pool, principal}, input) services."
 *
 * `path` is the full route as a browser or curl sees it
 * (`/api/v1/account`, `/api/v1/runs/{id}`) -- `{name}` segments are path
 * parameters. This is also the literal key `openapi.ts` writes under
 * `paths`, so the registry, the catch-all's dispatch table and the
 * published document are three views of the exact same array rather
 * than three hand-kept lists that can drift apart (criterion 2).
 */
export interface RouteEntry<
  Params = Record<string, string>,
  Query = unknown,
  Body = unknown,
  Response = unknown,
> {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary?: string;
  /** Long-form operation description, published as-is in openapi.json. */
  description?: string;
  /** Extra documented error responses beyond the common floor, by status -> description (openapi.ts only). */
  extraResponses?: Record<string, string>;
  /** Defaults to `['session']` when omitted -- see `effectivePrincipals`. */
  principals?: PrincipalKind[];
  minRole: MembershipRole;
  /** The scope a TOKEN principal must hold. Required for every entry whose `principals` includes `'token'` -- omitting both `scope` and `tokenSelfOnly` rejects every token unconditionally. */
  scope?: Scope;
  /**
   * `DELETE /api/v1/tokens/{id}` is the one route a token may call with
   * NO scope requirement -- "a token deleting itself", never `T(scope)`.
   * `true` admits any token past handler.ts's scope check; the route's
   * OWN handler then enforces the self-only rule (target id === its own).
   */
  tokenSelfOnly?: boolean;
  idempotency: IdempotencyMode;
  rateClass?: string;
  /**
   * The cap on SESSION callers (token callers have their own, `enforceTokenRateLimits`). A route that
   * calls an outside service or starts compute declares its own; every other session write gets
   * `DEFAULT_SESSION_WRITE_LIMIT`; a session read gets none unless it declares one.
   */
  sessionLimit?: SessionLimit;
  /** True for a route that admits a spend reservation and starts an agent run. No `startsRun: true` entry may list `token` (criterion 2 / the Spec's resolved disagreement 3: no token can start a run in v1). */
  startsRun?: boolean;
  paramsSchema?: ZodTypeAny;
  querySchema?: ZodTypeAny;
  bodySchema?: ZodTypeAny;
  /** The 2xx response body shape, used both for runtime response validation in tests/fixtures and for OpenAPI generation. */
  responseSchema: ZodTypeAny;
  /** HTTP status the handler's return value is served with. Default 200. */
  successStatus?: number;
  /**
   * Set on a route that also has a `text/event-stream` variant (D#31
   * API-5b, served by the dedicated route files under `apps/web/app/api/v1/`
   * when `Accept` asks for it). Its presence documents, in `openapi.json`,
   * the SSE 200, the 429 `stream_limit` with `Retry-After`, and the 422
   * `invalid_cursor`. `description` names the events the stream sends.
   */
  stream?: { description: string };
  /**
   * Set on a route whose 2xx body is a `RawBody` (see above) instead of
   * JSON. `openapi.ts` then documents `contentType` for the 2xx response in
   * place of `application/json`, with `description` as the body's schema
   * description and `headers` as its documented response headers.
   */
  rawResponse?: { contentType: string; description: string; headers: Record<string, string> };
  handler: (ctx: RouteContext, input: RouteInput<Params, Query, Body>) => Promise<Response>;
}

/** An entry declaring no `principals` resolves to session-only (security-expert: "An entry with no principals defaults to session-only"). */
export function effectivePrincipals(entry: Pick<RouteEntry, "principals">): PrincipalKind[] {
  return entry.principals ?? ["session"];
}

/**
 * Throws if any `startsRun: true` entry lists `token` among its
 * principals -- the one invariant the Spec calls out by name (resolved
 * disagreement 3: "no token can start a run in v1"; criterion 2: "The
 * test fails if any startsRun: true entry lists token"). Called once
 * over the real registry from routes/index.ts, and directly in
 * inventory.test.ts against a synthetic bad entry to prove it isn't
 * vacuous.
 */
export function validateRegistry(routes: readonly RouteEntry[]): void {
  for (const route of routes) {
    if (route.startsRun && effectivePrincipals(route).includes("token")) {
      throw new Error(
        `registry: ${route.method} ${route.path} (${route.operationId}) has startsRun: true but lists 'token' among its principals`,
      );
    }
  }
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Matches `method`+`pathname` against `routes`, supporting `{name}`
 * path-parameter segments. Returns `null` for no match -- the caller
 * (the catch-all route) maps that to 404 `not_found`. This is the ONE
 * place routing decisions are made; the catch-all never hand-rolls its
 * own path comparison, so "the set the catch-all dispatches" (criterion
 * 2) is exactly `routes` by construction.
 *
 * Security fix round item 2 (CWE-755): `decodeURIComponent` throws
 * `URIError` on a malformed `%` escape (e.g. a lone `%` or an
 * incomplete/invalid hex pair). A route this loop is currently checking
 * simply doesn't match on that segment -- exactly like an ordinary
 * literal mismatch just below it -- rather than that exception
 * propagating up through the dispatcher as an uncaught 500.
 */
export function matchRoute(
  routes: readonly RouteEntry[],
  method: string,
  pathname: string,
): { entry: RouteEntry; params: Record<string, string> } | null {
  const requestSegments = splitPath(pathname);
  for (const entry of routes) {
    if (entry.method !== method) continue;
    const routeSegments = splitPath(entry.path);
    if (routeSegments.length !== requestSegments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < routeSegments.length; i++) {
      const routeSeg = routeSegments[i]!;
      const reqSeg = requestSegments[i]!;
      if (routeSeg.startsWith("{") && routeSeg.endsWith("}")) {
        try {
          params[routeSeg.slice(1, -1)] = decodeURIComponent(reqSeg);
        } catch {
          // fx-swallow-ok: a malformed % escape (URIError) means this route does not match the path; routing goes on
          matched = false;
          break;
        }
      } else if (routeSeg !== reqSeg) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { entry, params };
    }
  }
  return null;
}
