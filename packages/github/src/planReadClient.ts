import type { AppCredentialsSource } from "./appCredentials.js";
import { GH_OWNER_LOGIN_RE, GH_REPO_NAME_RE } from "./eventMapper.js";
import { getInstallationToken, InstallationTokenCache, InstallationTokenError, MintTimeoutError, type AccessTokenRequester } from "./installationToken.js";
import { ALLOWED_GRAPHQL_DOCUMENTS, assertSingleQueryDocument, GraphqlDocumentRefused } from "./planQueries.js";

/**
 * D#483 S3 (M0): the read-only GitHub client the plan import uses, for ONE repository.
 *
 * What it guarantees, so a bug in a caller cannot widen it (E1, E2):
 *   - it mints a `plan_read` token (see installationToken.ts): one repository, metadata, contents, issues and discussions
 *     at `read`. The mint is refused unless GitHub's own answer says every permission is `read` (`token_not_read_only`);
 *   - it sends only `GET` under `/repos/<owner>/<name>/` and `POST /graphql` with a document from the allowlist in
 *     planQueries.ts that also parses as a single `query`. Anything else throws `request_refused` BEFORE a token is minted
 *     or used (the mint is lazy: a client that is only ever asked for refused things never calls GitHub at all);
 *   - at most `maxRequests` requests (default 400, REST and GraphQL together): the request after the last throws
 *     `request_budget_exceeded` without being sent;
 *   - every request is logged (method, path with a GraphQL document named by its operation, status) for the import's
 *     evidence (acceptance A2). The log never holds a token, a header or a body.
 *
 * It maps GitHub's failures to one fixed set of codes (`PlanReadErrorCode`), because the Plan view has one sentence per
 * code. A 200 GraphQL answer with an `errors` array is a failure, never "no data".
 */
export type PlanReadErrorCode =
  | "repo_not_connected"
  | "app_permission_missing"
  | "discussions_disabled"
  | "token_not_read_only"
  | "github_unavailable"
  | "rate_limited_by_github"
  | "plan_file_too_large"
  | "request_refused"
  | "request_budget_exceeded";

export class PlanReadError extends Error {
  readonly code: PlanReadErrorCode;
  constructor(code: PlanReadErrorCode) {
    super(`planRead: ${code}`);
    this.name = "PlanReadError";
    this.code = code;
  }
}

export interface PlanReadLogEntry {
  method: "GET" | "POST";
  /** `/repos/<owner>/<name>/...` as sent, or `/graphql` with the operation name appended (`/graphql PlanRepoHead`). */
  path: string;
  status: number;
}

export interface PlanReadTarget {
  repoId: string;
  owner: string;
  name: string;
}

export interface PlanReadDeps {
  resolveInstallation: (repoId: string) => Promise<{ installationId: number; appKind: string } | null>;
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  fetchImpl?: typeof fetch;
  /** Default 400. */
  maxRequests?: number;
  /** Per call, default 15 s. */
  callTimeoutMs?: number;
  now?: () => number;
}

export interface PlanReadRestResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  /** The body text. A `maxBytes` read that went over throws instead. */
  text: string;
}

export interface PlanReadClient {
  /** A REST request. Only `GET` is accepted; anything else throws `request_refused` before any token is minted. */
  request(req: { method: string; path: string; query?: Readonly<Record<string, string | number>>; accept?: string; maxBytes?: number }): Promise<PlanReadRestResponse>;
  /** A GraphQL request. The document must be in the allowlist and a single `query`; else `request_refused` before any token is minted. Returns `data`. */
  graphqlDocument(document: string, variables: Readonly<Record<string, unknown>>): Promise<unknown>;
  readonly requestLog: readonly PlanReadLogEntry[];
  readonly requestCount: number;
  /** The permissions GitHub reported for the minted token, or null before the first request. */
  readonly tokenPermissions: Readonly<Record<string, string>> | null;
}

export const PLAN_READ_USER_AGENT = "fulcrumaxe-cloud-plan-import";
export const DEFAULT_MAX_REQUESTS = 400;
const PATH_RE = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.~%:/@+=-]*$/;

function refused(): never {
  throw new PlanReadError("request_refused");
}

/** A token mint that failed, in the import's own words. */
function mapMintError(err: unknown): PlanReadError {
  if (err instanceof PlanReadError) return err;
  if (err instanceof MintTimeoutError) return new PlanReadError("github_unavailable");
  if (err instanceof InstallationTokenError) {
    if (err.reason === "token_not_read_only") return new PlanReadError("token_not_read_only");
    if (err.reason === "mint_failed") {
      const status = (err.cause as { status?: unknown } | undefined)?.status;
      // 422: the install does not hold a permission the token asked for. 404: the installation is gone.
      if (status === 422) return new PlanReadError("app_permission_missing");
      if (status === 404) return new PlanReadError("repo_not_connected");
      if (status === 403 || status === 429) return new PlanReadError("rate_limited_by_github");
    }
    if (err.reason === "purpose_not_allowed") return new PlanReadError("repo_not_connected");
  }
  return new PlanReadError("github_unavailable");
}

/** GitHub's rate limits: the primary one is 403 or 429 with `x-ratelimit-remaining: 0`; the secondary one carries `retry-after`. */
function isRateLimited(status: number, headers: Readonly<Record<string, string>>): boolean {
  if (status !== 403 && status !== 429) return false;
  return headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined || status === 429;
}

function headerRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

async function readCapped(res: Response, maxBytes: number | undefined): Promise<string> {
  if (maxBytes === undefined || res.body === null) return res.text();
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => undefined);
    throw new PlanReadError("plan_file_too_large");
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PlanReadError("plan_file_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createPlanReadClient(deps: PlanReadDeps): (target: PlanReadTarget) => PlanReadClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxRequests = deps.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const timeoutMs = deps.callTimeoutMs ?? 15_000;

  return (target) => {
    if (!GH_OWNER_LOGIN_RE.test(target.owner) || !GH_REPO_NAME_RE.test(target.name)) refused();
    const prefix = `/repos/${target.owner}/${target.name}/`;
    // One cache per client: the token is minted for this import, its permissions are the ones recorded as evidence,
    // and an expiry mid-import re-mints through the same cache.
    const cache = new InstallationTokenCache();
    const log: PlanReadLogEntry[] = [];
    let permissions: Record<string, string> | null = null;
    let count = 0;

    const requester: AccessTokenRequester = async (params) => {
      const minted = await deps.requester(params);
      permissions = minted.permissions ? { ...minted.permissions } : null;
      return minted;
    };

    async function token(): Promise<string> {
      const installation = await deps.resolveInstallation(target.repoId).catch(() => {
        throw new PlanReadError("github_unavailable");
      });
      if (!installation) throw new PlanReadError("repo_not_connected");
      try {
        return await getInstallationToken({
          installationId: installation.installationId,
          appKind: installation.appKind,
          purpose: "plan_read",
          role: "plan_read",
          scope: { repositories: [target.name], permissions: {} },
          appCredentials: deps.appCredentials,
          requester,
          cache,
          ...(deps.now ? { now: deps.now } : {}),
        });
      } catch (err) {
        throw mapMintError(err);
      }
    }

    function spend(): void {
      if (count >= maxRequests) throw new PlanReadError("request_budget_exceeded");
      count += 1;
    }

    async function send(url: URL, init: RequestInit, entry: Omit<PlanReadLogEntry, "status">, maxBytes?: number): Promise<{ res: Response; headers: Record<string, string>; text: string }> {
      let res: Response;
      try {
        res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        // fx-swallow-ok: rethrown as a fixed code; the transport error can carry the URL and headers
        log.push({ ...entry, status: 0 });
        throw new PlanReadError("github_unavailable");
      }
      const headers = headerRecord(res.headers);
      let text: string;
      try {
        text = await readCapped(res, maxBytes);
      } catch (err) {
        log.push({ ...entry, status: res.status });
        if (err instanceof PlanReadError) throw err;
        // fx-swallow-ok: a body that cannot be read is GitHub being unavailable
        throw new PlanReadError("github_unavailable");
      }
      log.push({ ...entry, status: res.status });
      return { res, headers, text };
    }

    return {
      get requestLog() {
        return log;
      },
      get requestCount() {
        return count;
      },
      get tokenPermissions() {
        return permissions;
      },

      async request(req) {
        // Every refusal comes before the token and before the budget.
        if (req.method !== "GET") refused();
        if (!req.path.startsWith(prefix) || !PATH_RE.test(req.path) || req.path.split("/").some((s) => s === "..")) refused();
        spend();
        const bearer = await token();
        const url = new URL(`https://api.github.com${req.path}`);
        for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
        const { res, headers, text } = await send(
          url,
          {
            method: "GET",
            headers: {
              accept: req.accept ?? "application/vnd.github+json",
              authorization: `Bearer ${bearer}`,
              "x-github-api-version": "2022-11-28",
              "user-agent": PLAN_READ_USER_AGENT,
            },
          },
          { method: "GET", path: req.path },
          req.maxBytes,
        );
        if (isRateLimited(res.status, headers)) throw new PlanReadError("rate_limited_by_github");
        if (res.status === 401) throw new PlanReadError("github_unavailable");
        if (res.status === 403) throw new PlanReadError("app_permission_missing");
        if (res.status >= 500) throw new PlanReadError("github_unavailable");
        return { status: res.status, headers, text };
      },

      async graphqlDocument(document, variables) {
        try {
          if (!ALLOWED_GRAPHQL_DOCUMENTS.has(document)) throw new GraphqlDocumentRefused("not in the allowlist");
          assertSingleQueryDocument(document);
        } catch {
          // fx-swallow-ok: the refusal reason is for the developer; the caller sees one fixed code
          return refused();
        }
        spend();
        const bearer = await token();
        const opName = /^query\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(document)?.[1] ?? "anonymous";
        const { res, headers, text } = await send(
          new URL("https://api.github.com/graphql"),
          {
            method: "POST",
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${bearer}`,
              "content-type": "application/json",
              "x-github-api-version": "2022-11-28",
              "user-agent": PLAN_READ_USER_AGENT,
            },
            body: JSON.stringify({ query: document, variables }),
          },
          { method: "POST", path: `/graphql ${opName}` },
        );
        if (isRateLimited(res.status, headers)) throw new PlanReadError("rate_limited_by_github");
        if (res.status === 401) throw new PlanReadError("github_unavailable");
        if (res.status === 403) throw new PlanReadError("app_permission_missing");
        if (res.status !== 200) throw new PlanReadError("github_unavailable");
        let body: { data?: unknown; errors?: unknown };
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          // fx-swallow-ok: not JSON is GitHub being unavailable, never an empty answer
          throw new PlanReadError("github_unavailable");
        }
        if (body === null || typeof body !== "object") throw new PlanReadError("github_unavailable");
        if (Array.isArray(body.errors) && body.errors.length > 0) throw graphqlErrorCode(body.errors);
        if (body.data === null || typeof body.data !== "object") throw new PlanReadError("github_unavailable");
        return body.data;
      },
    };
  };
}

interface GraphqlError {
  type?: unknown;
  message?: unknown;
  path?: unknown;
}

/**
 * A 200 answer that carries `errors`. A rate limit is its own code. A repository that came back null with NOT_FOUND, or a
 * "not accessible by integration" refusal, is the install lacking a permission. Anything else is GitHub failing; none of
 * it is ever read as "there was nothing".
 */
function graphqlErrorCode(errors: unknown[]): PlanReadError {
  const list = errors.filter((e): e is GraphqlError => e !== null && typeof e === "object");
  if (list.some((e) => e.type === "RATE_LIMITED")) return new PlanReadError("rate_limited_by_github");
  if (list.some((e) => e.type === "NOT_FOUND" || e.type === "FORBIDDEN" || e.type === "INSUFFICIENT_SCOPES" || (typeof e.message === "string" && /not accessible by integration/i.test(e.message)))) {
    return new PlanReadError("app_permission_missing");
  }
  return new PlanReadError("github_unavailable");
}
