import { BYPASS_HEADER } from "../protectionBypass.js";
import type { BasePin } from "./pin.js";

/**
 * D#749: the Vercel Deployment Protection bypass for the verify browser. Staging answers an unauthenticated request with a redirect to Vercel's sign-in, so the browser needs the same
 * secret the runner's cloud HTTP layer already holds. It is added in the driver's request route, not in the origin proxy: the base is https, so the proxy only ever sees an opaque CONNECT
 * tunnel and cannot touch a header. It is not set as a context-wide extra header either, which would travel with every request the page makes. The route only continues requests the origin
 * pin allows, and this adds the header to those whose origin is exactly the base origin, and only when the server found the base origin to be the registered cloud origin.
 * A redirect to another origin never gets that far: the driver fails it at the response stage before the browser follows it.
 */
export const SET_COOKIE_HEADER = "x-vercel-set-bypass-cookie";

/** Whether the secret may be used for this base: the base origin is exactly the registered cloud origin. */
export function bypassAllowedFor(base: BasePin, cloudOrigin: string | undefined): boolean {
  return cloudOrigin !== undefined && cloudOrigin === base.origin;
}

/**
 * The headers to send for a request to `url`: the request's own plus the bypass pair when `url` has exactly the base origin and a secret is held; otherwise the request's own,
 * unchanged. The cookie header asks Vercel to set a bypass cookie, so later same-origin navigations and assets need no header of ours.
 */
export function headersWithBypass(own: Readonly<Record<string, string>>, url: string, base: BasePin, secret: string | undefined): Record<string, string> {
  if (secret === undefined) return { ...own };
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    // fx-swallow-ok: an address that does not parse gets no header
    return { ...own };
  }
  if (origin !== base.origin) return { ...own };
  return { ...own, [BYPASS_HEADER]: secret, [SET_COOKIE_HEADER]: "true" };
}
