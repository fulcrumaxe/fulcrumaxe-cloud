import { normalizeHostname, partnerLayerOn, type HostResolver, type PartnerEnv, type ResolvedHost } from "../host/index.js";
import {
  PartnerBrandingEnvelope,
  colorsFor,
  emailOrNull,
  httpsUrlOrNull,
  suspendedEnvelope,
} from "./envelope.js";
import { STATIC_BRAND, type StaticBrand } from "./staticBrand.js";

/**
 * Who the request is for. `direct` is every host that is not an approved partner host: our own, an unknown one, an unverified or
 * detached one, with the layer off. A request that is not `direct` is bound to one partner by its host.
 */
export type PartnerContext =
  | { kind: "direct" }
  | { kind: "suspended"; partnerId: string; host: string }
  | { kind: "partner"; partnerId: string; host: string; branding: PartnerBrandingEnvelope };

export const DIRECT: PartnerContext = Object.freeze({ kind: "direct" });

export interface ResolvePartnerContextInput {
  /** The request's `Host` header, raw. Nothing else names the host: not `X-Forwarded-Host`, not `Forwarded`. */
  hostHeader: string | null;
  env: PartnerEnv;
  resolver: HostResolver;
}

/**
 * The single entry point from a request to a `PartnerContext`.
 *  - Layer off (`FX_PARTNER_LAYER` not exactly `on`): `direct`, and the resolver is not touched.
 *  - A Host that does not normalise, or is our own origin's host (`FX_APP_ORIGIN`): `direct`, resolver not touched.
 *  - Otherwise one resolver call. `active` becomes `partner` only when the row also passes the checks here (a product name, https
 *    terms and privacy links); otherwise it is `direct`, as is `unknown`. `suspended` stays `suspended`.
 * A resolver error propagates: the caller decides what an outage looks like. It is never turned into a brand.
 */
export async function resolvePartnerContext(input: ResolvePartnerContextInput): Promise<PartnerContext> {
  if (!partnerLayerOn(input.env)) return DIRECT;
  const host = normalizeHostname(input.hostHeader);
  if (host === null || host === ownHost(input.env)) return DIRECT;
  const resolved = await input.resolver.resolve(host);
  if (resolved.state === "suspended" && resolved.partnerId) {
    return { kind: "suspended", partnerId: resolved.partnerId, host };
  }
  if (resolved.state === "active" && resolved.partnerId) {
    const branding = activeEnvelope(resolved);
    if (branding) return { kind: "partner", partnerId: resolved.partnerId, host, branding };
  }
  return DIRECT;
}

/** The host of `FX_APP_ORIGIN`, normalised, or null when it is unset or not an origin. */
function ownHost(env: PartnerEnv): string | null {
  const origin = env.FX_APP_ORIGIN;
  if (!origin) return null;
  try {
    return normalizeHostname(new URL(origin).host);
  } catch {
    // fx-swallow-ok: an unset or malformed FX_APP_ORIGIN means no host is "ours"; the manifest check reports the setting
    return null;
  }
}

function activeEnvelope(row: ResolvedHost): PartnerBrandingEnvelope | null {
  const name = row.productName?.trim();
  const terms = httpsUrlOrNull(row.termsUrl);
  const privacy = httpsUrlOrNull(row.privacyUrl);
  if (!name || !terms || !privacy) return null;
  return PartnerBrandingEnvelope.parse({
    page_title: name,
    product_name: name,
    os_name: name,
    system_tag: name,
    copyright: `© ${name}`,
    welcome_message: `Welcome to ${name}.`,
    logo_url: null,
    support_email: emailOrNull(row.supportEmail),
    terms_url: terms,
    privacy_url: privacy,
    state: "active",
    colors: colorsFor(row.colorPrimary, row.colorAccent),
  });
}

/** The JSON body the branding path sends for a context: our six static keys, or the envelope. */
export function brandingBodyFor(context: PartnerContext): StaticBrand | PartnerBrandingEnvelope {
  switch (context.kind) {
    case "partner":
      return context.branding;
    case "suspended":
      return suspendedEnvelope();
    case "direct":
      return STATIC_BRAND;
  }
}

/**
 * Sent on every response of the partner branding path, whatever the host, so a response never reveals through its headers whether
 * a host is a partner's. `private, no-store` until the CDN is proven to key its cache on the Host header (spike PS2); `Vary: Host`
 * is there as well so a cache that ignores `no-store` still keys on it.
 */
export const BRANDING_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "private, no-store",
  Vary: "Host",
});
