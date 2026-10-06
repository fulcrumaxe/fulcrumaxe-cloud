/**
 * The shared API client, and the one place that decides whether a request may carry the Vercel bypass secret.
 *
 * The rule (exact origin): the secret goes on a request only when `new URL(url).origin` equals the target's
 * origin, scheme, host and port. A prefix or suffix test (`startsWith`, `endsWith`, `includes`) would also
 * match `<host>.evil.test` or another port, so none is used. Redirects are followed by hand, hop by hop, and
 * the rule is applied again to every hop: a target response that sends the client to another origin produces
 * a follow-up request without the header (and without any credential header the caller supplied).
 *
 * This slice sends reads only (GET and HEAD). Writes, and the production write fence that lets declared
 * refusal probes through, arrive with T1c; until then a non-read method is refused here rather than sent.
 */

export const BYPASS_HEADER = "x-vercel-protection-bypass";
/** Asks Vercel to answer with a bypass cookie, scoped to the deployment host, that carries later requests (redirect hops). */
export const SET_COOKIE_HEADER = "x-vercel-set-bypass-cookie";
export const MAX_REDIRECTS = 5;
const READ_METHODS = ["GET", "HEAD"] as const;
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

/** The bypass header for `url`, or nothing. Used by the browser fixture and by the client. */
export function bypassHeadersFor(url: string, origin: string, secret: string | undefined): Record<string, string> {
  if (secret === undefined || secret === "") return {};
  return isTargetOrigin(url, origin) ? { [BYPASS_HEADER]: secret } : {};
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
  /** `follow` (default) follows up to MAX_REDIRECTS hops; `manual` returns the first 3xx as it is. */
  redirect?: "follow" | "manual";
}

export interface ApiClient {
  readonly origin: string;
  request(path: string, options?: RequestOptions): Promise<ClientResponse>;
  get(path: string, options?: Omit<RequestOptions, "method">): Promise<ClientResponse>;
}

export interface ClientOptions {
  origin: string;
  /** Absent for a client that must behave as an anonymous visitor (the deployment wall check). */
  bypassSecret?: string | undefined;
  fetchImpl?: typeof fetch;
}

export function createClient(options: ClientOptions): ApiClient {
  const origin = new URL(options.origin).origin;
  const doFetch = options.fetchImpl ?? fetch;

  async function request(path: string, opts: RequestOptions = {}): Promise<ClientResponse> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
      throw new ClientError(`client: "${path}" is not a path on the target (it must start with a single "/")`);
    }
    const method = (opts.method ?? "GET").toUpperCase();
    if (!(READ_METHODS as readonly string[]).includes(method)) {
      throw new ClientError(`client: ${method} is not sent from here (reads only until the write fence lands)`);
    }
    let url = new URL(path, origin).href;
    if (!isTargetOrigin(url, origin)) throw new ClientError(`client: "${path}" does not resolve to the target origin`);
    const hops: Hop[] = [];
    for (let hop = 0; ; hop += 1) {
      const onTarget = isTargetOrigin(url, origin);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(opts.headers ?? {})) {
        if (onTarget || !CREDENTIAL_HEADERS.includes(k.toLowerCase())) headers[k] = v;
      }
      // The caller never sets the bypass header itself: it is added here, for the target origin only.
      for (const k of Object.keys(headers)) if (k.toLowerCase() === BYPASS_HEADER) delete headers[k];
      Object.assign(headers, bypassHeadersFor(url, origin, options.bypassSecret));
      const res = await doFetch(url, { method, headers, redirect: "manual" });
      hops.push({ url, status: res.status, bypass: BYPASS_HEADER in headers });
      const location = res.headers.get("location");
      const follow = (opts.redirect ?? "follow") === "follow" && REDIRECT_STATUSES.includes(res.status) && location !== null;
      if (!follow) {
        return { status: res.status, headers: res.headers, body: method === "HEAD" ? "" : await res.text(), url, hops };
      }
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new ClientError(`client: more than ${MAX_REDIRECTS} redirects from ${path}`);
      url = new URL(location, url).href;
    }
  }

  return { origin, request, get: (path, o) => request(path, { ...o, method: "GET" }) };
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
