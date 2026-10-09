/**
 * The shared API client, and the one place that decides whether a request may carry the Vercel bypass secret.
 *
 * The rule (exact origin): the secret goes on a request only when `new URL(url).origin` equals the target's
 * origin, scheme, host and port. A prefix or suffix test (`startsWith`, `endsWith`, `includes`) would also
 * match `<host>.evil.test` or another port, so none is used. Redirects are followed by hand, hop by hop, and
 * the rule is applied again to every hop: a target response that sends the client to another origin produces
 * a follow-up request without the header (and without any credential header the caller supplied).
 *
 * The write fence (layer 4 of the production guard) is applied here to every hop, before any socket opens:
 *  - on production a non-read method to the production host throws, unless it is a declared refusal probe
 *    (`probe()`), which is sent from a fresh state: no ambient headers, no cookie, no Authorization, no redirect
 *    followed;
 *  - on staging every request, of any method, to the production host throws (a redirect can lead there), and a
 *    staging fence with no production origin refuses everything.
 * A non-read that is answered with a 3xx, on either target, is an error: it is never followed (method and body can
 * survive a hop), and the same holds for a declared probe.
 * The DENY decision compares a canonical HOSTNAME (`isSameHost`: lowercase, trailing dots stripped, scheme and port
 * ignored), so `https://<host>.`, `http://<host>` and `<host>:8443` all count as the production host. The exact
 * origin rule (`isTargetOrigin`) stays for where the bypass secret is SENT.
 * A client built without a fence config is fenced as production, so forgetting to configure it fails closed.
 */

export const BYPASS_HEADER = "x-vercel-protection-bypass";
/** Asks Vercel to answer with a bypass cookie, scoped to the deployment host, that carries later requests (redirect hops). */
export const SET_COOKIE_HEADER = "x-vercel-set-bypass-cookie";
export const MAX_REDIRECTS = 5;
const READ_METHODS = ["GET", "HEAD"] as const;
const PROBE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
/** Headers that are credentials: never forwarded to an origin other than the target's. */
const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", BYPASS_HEADER];

export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientError";
  }
}

/** Exact origin equality. Anything that does not parse is not the target. */
export function isTargetOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/**
 * The canonical hostname of a URL or origin: lowercase, trailing dots stripped, scheme and port left out. The
 * dotted name resolves to the same server, so it must not be told apart from the plain one. Undefined when it does
 * not parse.
 */
export function canonicalHost(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

/** Whether `url` is on the same canonical host as `origin` (any scheme, any port). For DENY decisions only. */
export function isSameHost(url: string, origin: string): boolean {
  const host = canonicalHost(url);
  return host !== undefined && host === canonicalHost(origin);
}

/** The bypass header for `url`, or nothing. Used by the browser fixture and by the client. */
export function bypassHeadersFor(url: string, origin: string, secret: string | undefined): Record<string, string> {
  if (secret === undefined || secret === "") return {};
  return isTargetOrigin(url, origin) ? { [BYPASS_HEADER]: secret } : {};
}

/** What the fence needs to know: which run this is, its origin, and (on staging) the production origin to keep out of. */
export interface FenceConfig {
  target: "staging" | "production";
  /** The origin this run tests (exact). */
  targetOrigin: string;
  /** Staging only: every request to this origin's canonical host is refused. `fenceConfigFor` always sets it on staging. */
  productionOrigin?: string | undefined;
}

/**
 * The non-GET requests the shell itself makes in a browser on production: sign-out and the two telemetry sinks.
 * (The sign-in routes are GET-only in the app, so they are reads and need no entry.) Exact method and path.
 */
export const SHELL_WRITE_ALLOWLIST: readonly { method: string; path: string }[] = [
  { method: "POST", path: "/api/auth/signout" },
  { method: "POST", path: "/api/csp-report" },
  { method: "POST", path: "/api/rum" },
];

export function isReadMethod(method: string): boolean {
  return (READ_METHODS as readonly string[]).includes(method.toUpperCase());
}

export interface FenceRequest {
  method: string;
  url: string;
  /** A declared refusal probe, sent from a fresh state (the API client's `probe()` only). */
  probe?: boolean;
  /**
   * The browser fence only. On production a browser run has no reason to write anywhere, so a non-read to ANY
   * origin is refused (a 307/308 from another origin could carry it to production, and the browser's redirect hop
   * is never shown to the route handler); the shell's own allowlisted writes to the exact production origin pass.
   */
  shell?: boolean;
}

/** The refusal reason for a request, or null when the fence lets it through. Pure; one rule for browser and client. */
export function fenceVerdict(req: FenceRequest, config: FenceConfig): string | null {
  if (config.target === "staging") {
    // No production origin to keep out of means no fence to apply: refuse everything rather than let it all through.
    if (config.productionOrigin === undefined) return "staging-no-production-origin";
    return isSameHost(req.url, config.productionOrigin) ? "staging-blocks-production" : null;
  }
  if (isReadMethod(req.method)) return null;
  const exact = isTargetOrigin(req.url, config.targetOrigin);
  if (!isSameHost(req.url, config.targetOrigin) && req.shell !== true) return null;
  if (req.probe === true && exact) return null;
  if (req.shell === true && exact) {
    let path = "";
    try {
      path = new URL(req.url).pathname;
    } catch {
      path = "";
    }
    const method = req.method.toUpperCase();
    if (SHELL_WRITE_ALLOWLIST.some((a) => a.method === method && a.path === path)) return null;
  }
  return "production-write-fence";
}

export interface Hop {
  url: string;
  status: number;
  /** Whether the bypass header was sent on this hop (never its value). */
  bypass: boolean;
}

export interface ClientResponse {
  status: number;
  headers: Headers;
  body: string;
  /** The URL of the last request made. */
  url: string;
  hops: Hop[];
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** A text body, sent to the target origin only (a redirect to another origin gets none). Ignored for GET and HEAD. */
  body?: string;
  /** `follow` (default) follows up to MAX_REDIRECTS hops; `manual` returns the first 3xx as it is. */
  redirect?: "follow" | "manual";
}

/** A declared refusal probe as the client sees it: the schema and its rules live in probes.ts. */
export interface ProbeSend {
  method: string;
  path: string;
}

export interface ApiClient {
  readonly origin: string;
  request(path: string, options?: RequestOptions): Promise<ClientResponse>;
  get(path: string, options?: Omit<RequestOptions, "method">): Promise<ClientResponse>;
  /**
   * Sends one DECLARED refusal probe (method and path must equal an entry of the client's `probes`) from a fresh
   * state: only the bypass header (exact-origin rule), never `ambientHeaders`, never a caller header, and a
   * redirect is an error (a write is never followed, and its 3xx is not an answer to inspect).
   */
  probe(probe: ProbeSend): Promise<ClientResponse>;
}

export interface ClientOptions {
  origin: string;
  /** Absent for a client that must behave as an anonymous visitor (the deployment wall check). */
  bypassSecret?: string | undefined;
  fetchImpl?: typeof fetch;
  /** Absent means fenced as production (reads only). */
  fence?: FenceConfig | undefined;
  /** The refusal probes the owning pack declared in pack.json; `probe()` sends nothing else. */
  probes?: readonly ProbeSend[] | undefined;
  /** Credentials this client adds to every ordinary request to the target origin (a role's session cookie). Never on a probe. */
  ambientHeaders?: Record<string, string> | undefined;
}

export function createClient(options: ClientOptions): ApiClient {
  const origin = new URL(options.origin).origin;
  const doFetch = options.fetchImpl ?? fetch;

  const fence: FenceConfig = options.fence ?? { target: "production", targetOrigin: origin };

  async function send(path: string, opts: RequestOptions, isProbe: boolean): Promise<ClientResponse> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
      throw new ClientError(`client: "${path}" is not a path on the target (it must start with a single "/")`);
    }
    const method = (opts.method ?? "GET").toUpperCase();
    let url = new URL(path, origin).href;
    if (!isTargetOrigin(url, origin)) throw new ClientError(`client: "${path}" does not resolve to the target origin`);
    const hops: Hop[] = [];
    for (let hop = 0; ; hop += 1) {
      // The fence is asked about every hop before any socket opens, so a redirect cannot lead around it.
      const refusal = fenceVerdict({ method, url, probe: isProbe }, fence);
      if (refusal !== null) {
        throw new ClientError(
          refusal === "production-write-fence"
            ? `client: ${method} to the production origin is refused (${refusal}: reads only, plus declared refusal probes)`
            : refusal === "staging-no-production-origin"
              ? `client: every request is refused (${refusal}: the staging fence has no production origin to keep out of)`
              : `client: a request to the production origin is refused (${refusal})`,
        );
      }
      const onTarget = isTargetOrigin(url, origin);
      const headers: Record<string, string> = {};
      // A probe is sent from a fresh state: neither the client's ambient credentials nor any caller header.
      const supplied = isProbe ? {} : { ...(options.ambientHeaders ?? {}), ...(opts.headers ?? {}) };
      for (const [k, v] of Object.entries(supplied)) {
        if (onTarget || !CREDENTIAL_HEADERS.includes(k.toLowerCase())) headers[k] = v;
      }
      // The caller never sets the bypass header itself: it is added here, for the target origin only.
      for (const k of Object.keys(headers)) if (k.toLowerCase() === BYPASS_HEADER) delete headers[k];
      Object.assign(headers, bypassHeadersFor(url, origin, options.bypassSecret));
      const body = onTarget && opts.body !== undefined && !isReadMethod(method) ? opts.body : undefined;
      const res = await doFetch(url, { method, headers, redirect: "manual", ...(body === undefined ? {} : { body }) });
      hops.push({ url, status: res.status, bypass: BYPASS_HEADER in headers });
      // A write is never followed: method, body and credentials would travel on to wherever the answer points.
      if (!isReadMethod(method) && res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new ClientError(`client: ${method} ${path} was answered with a ${res.status} redirect; a redirect on a write is never followed`);
      }
      const location = res.headers.get("location");
      const follow = !isProbe && (opts.redirect ?? "follow") === "follow" && REDIRECT_STATUSES.includes(res.status) && location !== null;
      if (!follow) {
        return { status: res.status, headers: res.headers, body: method === "HEAD" ? "" : await res.text(), url, hops };
      }
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new ClientError(`client: more than ${MAX_REDIRECTS} redirects from ${path}`);
      url = new URL(location, url).href;
    }
  }

  const request = (path: string, opts: RequestOptions = {}): Promise<ClientResponse> => send(path, opts, false);

  async function probe(p: ProbeSend): Promise<ClientResponse> {
    const method = p.method.toUpperCase();
    const declared = (options.probes ?? []).some((d) => d.method.toUpperCase() === method && d.path === p.path);
    if (!declared) throw new ClientError(`client: ${method} ${p.path} is not a declared refusal probe`);
    if (!(PROBE_METHODS as readonly string[]).includes(method)) throw new ClientError(`client: ${method} is not a probe method`);
    return send(p.path, { method, redirect: "manual" }, true);
  }

  return { origin, request, get: (path, o) => request(path, { ...o, method: "GET" }), probe };
}

/**
 * True when an anonymous answer is Vercel's Deployment Protection wall rather than the app: a 401, or a redirect
 * whose target is a vercel.com host (the SSO page). Exact host match on `vercel.com` or a subdomain of it.
 */
export function isDeploymentWall(res: Pick<ClientResponse, "status" | "headers">): boolean {
  if (res.status === 401) return true;
  if (!REDIRECT_STATUSES.includes(res.status)) return false;
  const location = res.headers.get("location");
  if (location === null) return false;
  try {
    const host = new URL(location).hostname;
    return host === "vercel.com" || host.endsWith(".vercel.com");
  } catch {
    return false;
  }
}
