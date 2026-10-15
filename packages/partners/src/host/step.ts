import { partnerLayerOn, type PartnerEnv } from "./layer.js";
import { normalizeHostname } from "./normalize.js";

/** The request header the middleware step sets for downstream code: the normalised request host, or absent. */
export const HOST_HEADER = "x-fx-host";

/**
 * The `hostBrand` step of apps/web/middleware.ts (D#4 X3.1). It runs on the Edge runtime, which has no database, so it resolves
 * nothing: it only gives the rest of the request one trustworthy copy of the host.
 *
 * Whatever the client sent as `x-fx-host` is dropped first. When the partner layer is on, the header is then set from the `Host`
 * header alone, through `normalizeHostname`. `X-Forwarded-Host` and `Forwarded` are never read, because a client can send them
 * and the platform in front of us does not strip them. With the layer off, or a Host that is not a hostname, no header is set.
 */
export function hostBrandStep(req: { headers: Headers }, headers: Headers, env: PartnerEnv = process.env): void {
  headers.delete(HOST_HEADER);
  if (!partnerLayerOn(env)) return;
  const host = normalizeHostname(req.headers.get("host"));
  if (host) headers.set(HOST_HEADER, host);
}
