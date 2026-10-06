/**
 * The request gate for the proxy-only deployment. Pure: middleware.ts feeds it
 * the request and the configured public host. Anything it does not recognise
 * is a 404 from here, never a redirect.
 *
 * What the gate does NOT see: Next parses the URL (WHATWG) before middleware
 * runs, so `.`/`..` segments and `%2e` dot segments are already resolved by
 * the time `url` arrives, and a path with `//` or `\` is answered with a 308
 * by Next's server before middleware runs at all (known gap, see
 * docs/ops/gh-proxy-project.md). The guarantee that holds for a request that
 * passes is that the policy decision and the upstream request are both built
 * from that same parsed path (handler.ts), so they cannot disagree. The
 * dot-segment and encoding checks below are defence in depth for what parsing
 * leaves alone (`%2f`, `%5c`, `%00`) and for direct callers.
 */

export const GH_PROXY_PATH_PREFIX = "/api/gh-proxy/";
export const GH_PROXY_METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

export interface GateRequest {
  method: string;
  /** The request URL as middleware receives it: already parsed by Next, not the raw request line. */
  url: string;
  host: string | null;
  xForwardedHost: string | null;
}

export type GateDecision = { allow: true } | { allow: false; status: 404; reason: string };

const deny = (reason: string): GateDecision => ({ allow: false, status: 404, reason });

/** The path of an absolute URL, with no decoding. */
function rawPath(url: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(url);
  if (!match) return null;
  return match[1] ?? "/";
}

export function gateRequest(req: GateRequest, publicHost: string | undefined): GateDecision {
  if (!publicHost) return deny("public_host_unset");
  if (req.host !== publicHost) return deny("host");
  if (req.xForwardedHost !== null && req.xForwardedHost !== publicHost) return deny("forwarded_host");
  if (!GH_PROXY_METHODS.includes(req.method)) return deny("method");

  const path = rawPath(req.url);
  if (path === null || !path.startsWith(GH_PROXY_PATH_PREFIX)) return deny("path");
  // Encoded dots, slashes and nulls, and backslashes, could mean something else
  // once a later layer normalises the path.
  if (/%2e|%2f|%5c|%00|\\/i.test(path)) return deny("path_encoding");
  const segments = path.slice(GH_PROXY_PATH_PREFIX.length).split("/");
  if (segments.some((s, i) => s === "." || s === ".." || (s === "" && i < segments.length - 1))) {
    return deny("path_segments");
  }
  if (segments.length === 1 && segments[0] === "") return deny("path");
  return { allow: true };
}
