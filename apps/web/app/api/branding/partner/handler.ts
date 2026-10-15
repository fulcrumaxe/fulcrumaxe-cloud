import { NextResponse } from "next/server";
import { reportError } from "@fx/telemetry";
import {
  BRANDING_RESPONSE_HEADERS,
  brandingBodyFor,
  resolvePartnerContext,
} from "@fx/partners/context";
import type { HostResolver, PartnerEnv } from "@fx/partners/host";

/**
 * The partner branding path (D#4 P02a). `GET /api/branding` stays the static, byte-identical route for our own hosts; this one is
 * dynamic and is what the shell boot calls when the page's host is not ours.
 *
 * The host comes from the `Host` header alone, through the shared normaliser (resolvePartnerContext). Every answer except an
 * outage is a 200 with the same headers: our six static keys for any host that is not an approved partner host, the fixed
 * envelope for one that is, and the envelope with `state: suspended` for a suspended partner. No header differs between those
 * cases, so the response does not say which kind of host asked.
 *
 * A failed lookup is an outage and is answered as one (503): turning it into our static brand would show a reseller's customers
 * our name. It carries the same cache headers, so it is not stored.
 */
export async function partnerBrandingResponse(
  hostHeader: string | null,
  env: PartnerEnv,
  resolver: HostResolver,
): Promise<NextResponse> {
  let context;
  try {
    context = await resolvePartnerContext({ hostHeader, env, resolver });
  } catch (err) {
    reportError(err, { stage: "partners.resolve_host", route: "/api/branding/partner" });
    return NextResponse.json(
      { error: { code: "unavailable", message: "Branding is temporarily unavailable." } },
      { status: 503, headers: BRANDING_RESPONSE_HEADERS },
    );
  }
  return NextResponse.json(brandingBodyFor(context), { headers: BRANDING_RESPONSE_HEADERS });
}
