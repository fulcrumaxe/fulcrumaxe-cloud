/**
 * A fake of GitHub's REST API that is as strict as the real one about everything this repo's code
 * touches. Two ways in:
 *
 *   - `checkGithubRequest` is the rule set (pure, on a request description). The local TLS server in
 *     `localTlsServer.ts` applies it to a raw HTTPS request, where nothing is added for the caller, so a
 *     missing User-Agent really is a missing User-Agent.
 *   - `strictGithubFetch` wraps an in-process `fetch` fake with the same rules. Node's `fetch` (undici)
 *     adds `user-agent: node` and `accept: *` itself, so the wrapper adds them too: a fetch fake that
 *     rejected a header real `fetch` always sends would only be wrong the other way.
 *
 * Enforced here (each is something the real service does, and each has a test in strictGithub.test.ts):
 *   - User-Agent required: 403 with GitHub's plain-text body.
 *   - Accept: absent, a wildcard, application/json or an application/vnd.github media type; else 415.
 *   - X-GitHub-Api-Version: a published version; else 400.
 *   - Authorization: `Bearer <t>` or `token <t>`; any other form is 401 "Bad credentials".
 *   - App-level routes (`/app/...`) need an App JWT: RS256, an issuer, an expiry in the future and at most
 *     ten minutes away. Anything else is 401.
 *   - Routes that act as an installation or a user (`/installation/...`, `/user...`) need credentials: 401
 *     "Requires authentication" without them.
 *   - A request body must be JSON with a JSON content type; else 400 "Problems parsing JSON".
 *   - Every error body is JSON with `message` and `documentation_url` (and a string `status`).
 *   - Listings (`/installation/repositories`, `/user/installations`) carry `total_count`, are cut at
 *     100 per page and send a `Link` header with rel="next" while more pages remain (`pagedListing`).
 *
 * What it cannot fake faithfully: GitHub's rate limiting, secondary rate limits, abuse detection, and the
 * exact wording of every error. The messages used here are the ones the code under test branches on.
 */

export const GITHUB_DOC_URL = "https://docs.github.com/rest";
export const GITHUB_UA_REQUIRED_BODY =
  "Request forbidden by administrative rules. Please make sure your request has a User-Agent header (https://docs.github.com/en/rest/overview/resources-in-the-rest-api#user-agent-required). Check https://developer.github.com for other possible causes.";
export const SUPPORTED_API_VERSIONS: readonly string[] = ["2022-11-28"];
/** What undici's `fetch` sends when the caller sets no User-Agent. */
export const FETCH_DEFAULT_USER_AGENT = "node";

export interface GhRequest {
  method: string;
  /** Path only, no query. */
  path: string;
  /** The raw query string without the `?`, when the server saw one. */
  query?: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: string;
}

export interface GhReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function ghError(status: number, message: string): GhReply {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ message, documentation_url: GITHUB_DOC_URL, status: String(status) }),
  };
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ACCEPT_OK = /^(\*\/\*|application\/\*|application\/json|application\/vnd\.github(\.[\w.-]+)?(\+json)?(\.json)?)$/i;

function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The App-JWT rules GitHub applies on `/app/...`: RS256, an issuer, an expiry in the future and within ten minutes. */
function appJwtProblem(token: string, nowSec: number): string | null {
  if (!JWT_SHAPE.test(token)) return "A JSON web token could not be decoded";
  const [h, p] = token.split(".") as [string, string, string];
  const header = decodeSegment(h);
  const claims = decodeSegment(p);
  if (!header || !claims) return "A JSON web token could not be decoded";
  if (header.alg !== "RS256") return "A JSON web token could not be decoded";
  if (typeof claims.iss !== "string" && typeof claims.iss !== "number") return "'Issuer' claim ('iss') must be set";
  if (typeof claims.exp !== "number") return "'Expiration time' claim ('exp') is missing";
  if (claims.exp <= nowSec) return "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires";
  if (claims.exp > nowSec + 600) return "'Expiration time' claim ('exp') is too far in the future";
  if (typeof claims.iat === "number" && claims.iat > nowSec + 60) return "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued";
  return null;
}

const ACT_AS_PREFIXES = ["/installation/", "/installation", "/user/", "/user"];

/** The rule set. Returns the reply GitHub would give, or null when the request is acceptable. `nowMs` only matters for JWT expiry. */
export function checkGithubRequest(req: GhRequest, nowMs: number = Date.now()): GhReply | null {
  const h = req.headers;
  if (!h["user-agent"]) return { status: 403, headers: { "content-type": "text/plain; charset=utf-8" }, body: GITHUB_UA_REQUIRED_BODY };

  const accept = h["accept"];
  if (accept !== undefined) {
    const kinds = accept.split(",").map((s) => s.split(";")[0]!.trim());
    if (!kinds.some((k) => ACCEPT_OK.test(k))) return ghError(415, `Unsupported 'Accept' header: [${accept}]. Must accept 'application/json'.`);
  }

  const version = h["x-github-api-version"];
  if (version !== undefined && !SUPPORTED_API_VERSIONS.includes(version)) return ghError(400, `Unsupported 'X-GitHub-Api-Version' header: ${version}`);

  const authorization = h["authorization"];
  let token: string | null = null;
  if (authorization !== undefined) {
    const m = /^(bearer|token) (\S+)$/i.exec(authorization);
    if (!m) return ghError(401, "Bad credentials");
    token = m[2]!;
  }

  if (req.path === "/app" || req.path.startsWith("/app/")) {
    if (token === null) return ghError(401, "'Authorization' header is missing or malformed");
    const problem = appJwtProblem(token, Math.floor(nowMs / 1000));
    if (problem) return ghError(401, problem);
  } else if (token === null && ACT_AS_PREFIXES.some((p) => req.path === p || (p.endsWith("/") && req.path.startsWith(p)))) {
    return ghError(401, "Requires authentication");
  }

  if (req.body !== "") {
    const type = (h["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    let parses = true;
    try {
      JSON.parse(req.body);
    } catch {
      parses = false;
    }
    if (type !== "application/json" || !parses) return ghError(400, "Problems parsing JSON");
  }
  return null;
}

export class StrictFakeError extends Error {
  constructor(message: string) {
    super(`strict GitHub fake: ${message}`);
    this.name = "StrictFakeError";
  }
}

const LISTING_KEYS: Record<string, string> = {
  "/installation/repositories": "repositories",
  "/user/installations": "installations",
};

/**
 * One page of a GitHub listing: `total_count` for the whole set, at most 100 entries (the real cap on
 * `per_page`; 30 when unstated), and a `Link` header with rel="next" and rel="last" while pages remain.
 */
export function pagedListing(key: "repositories" | "installations", all: readonly unknown[], url: string | URL): Response {
  const u = new URL(String(url));
  const perPage = Math.min(100, Math.max(1, Number(u.searchParams.get("per_page") ?? 30) || 30));
  const page = Math.max(1, Number(u.searchParams.get("page") ?? 1) || 1);
  const last = Math.max(1, Math.ceil(all.length / perPage));
  const link = (n: number, rel: string) => {
    const l = new URL(u);
    l.searchParams.set("page", String(n));
    return `<${l.toString()}>; rel="${rel}"`;
  };
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (page < last) headers["link"] = `${link(page + 1, "next")}, ${link(last, "last")}`;
  return new Response(JSON.stringify({ total_count: all.length, [key]: all.slice((page - 1) * perPage, page * perPage) }), { status: 200, headers });
}

function headerRecord(init: RequestInit | undefined, input: string | URL | Request): Record<string, string> {
  const out: Record<string, string> = {};
  const merged = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((v, k) => merged.set(k, v));
  merged.forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

const KNOWN_HOSTS = new Set(["api.github.com", "github.com"]);

/**
 * Wraps a `fetch` fake with the rule set. A request that breaks a rule gets GitHub's reply instead of
 * reaching `inner`, so the code under test sees what it would see in production. The reply to a listing
 * is checked too: a 200 without `total_count` or its array means the FAKE is wrong, and throws.
 */
export function strictGithubFetch(inner: typeof fetch, options: { now?: () => number; explicitUserAgent?: boolean } = {}): typeof fetch {
  const now = options.now ?? Date.now;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" || !KNOWN_HOSTS.has(url.hostname)) throw new StrictFakeError(`unexpected target ${url.origin}`);
    const headers = headerRecord(init, input);
    // `explicitUserAgent`: for a caller that sets its own User-Agent on purpose, so dropping it must show.
    if (!options.explicitUserAgent) headers["user-agent"] ??= FETCH_DEFAULT_USER_AGENT;
    headers["accept"] ??= "*/*";
    const body = init?.body === undefined || init.body === null ? "" : typeof init.body === "string" ? init.body : String(init.body);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const refusal = url.hostname === "api.github.com" ? checkGithubRequest({ method, path: url.pathname, headers, body }, now()) : null;
    if (refusal) return new Response(refusal.body, { status: refusal.status, headers: refusal.headers });

    const res = await inner(input, init);
    const key = url.hostname === "api.github.com" && method === "GET" ? LISTING_KEYS[url.pathname] : undefined;
    if (key && res.status === 200) {
      const parsed = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
      if (typeof parsed?.total_count !== "number" || !Array.isArray(parsed[key])) {
        throw new StrictFakeError(`${url.pathname} answered 200 without total_count and a ${key} array (use pagedListing)`);
      }
    }
    return res;
  }) as typeof fetch;
}
