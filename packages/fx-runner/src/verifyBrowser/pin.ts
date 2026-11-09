/**
 * D#749 V2c-2a: the one origin a verify browser may reach. Pure functions; the driver applies them in three layers (the browser's host rules, a request route,
 * and a URL check after every action), so a mistake in one layer is caught by the next.
 */
export interface BasePin {
  /** Scheme, host and port of the app under test, exactly as the browser reports `URL.origin`. */
  origin: string;
  /** The host name alone, for the browser's resolver rules. */
  host: string;
  href: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The pin for a base URL, or undefined when it is not one: https only (plain http is allowed for a loopback address, which is how the tests serve a page), no credentials. */
export function parseBase(baseUrl: string): BasePin | undefined {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    // fx-swallow-ok: an unparsable base URL is refused with undefined, which the caller turns into a closed error
    return undefined;
  }
  const secure = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  if (!secure || u.username !== "" || u.password !== "" || u.hostname === "") return undefined;
  return { origin: u.origin, host: u.hostname, href: u.href };
}

/** Exact origin match: no suffix match, no scheme change, no other port. `about:blank` is the parked page and is the only non-network URL allowed. */
export function isAllowedUrl(url: string, base: BasePin): boolean {
  if (url === "about:blank") return true;
  try {
    return new URL(url).origin === base.origin;
  } catch {
    // fx-swallow-ok: a URL that does not parse is not the base origin
    return false;
  }
}

/** The address `open` visits: a path that starts with one slash, joined to the base. A scheme, a `//host`, a backslash or a control character is refused. */
export function resolveOpenPath(path: string, base: BasePin): string | undefined {
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 500 || /[\\\u0000-\u001f\u007f]/.test(path)) return undefined;
  const target = new URL(path, base.href).href;
  return isAllowedUrl(target, base) ? target : undefined;
}

/**
 * Chromium's resolver rule: every host fails to resolve except the base host and the loopback address of the origin proxy (which is how the browser reaches it). The rule
 * names hosts, not ports; the proxy is what holds the line on ports.
 */
export function hostRulesArg(base: BasePin): string {
  return `--host-rules=MAP * ~NOTFOUND, EXCLUDE ${base.host}${base.host === "127.0.0.1" ? "" : ", EXCLUDE 127.0.0.1"}`;
}
