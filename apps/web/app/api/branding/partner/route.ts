import type { NextRequest, NextResponse } from "next/server";
import { lazyHostResolver } from "../../../../lib/partners/hostResolver";
import { partnerBrandingResponse } from "./handler";

/** Dynamic on purpose: the answer depends on the request's Host. The static `../route.ts` is unchanged and serves our own hosts. */
export const dynamic = "force-dynamic";

export function GET(req: NextRequest): Promise<NextResponse> {
  return partnerBrandingResponse(req.headers.get("host"), process.env, lazyHostResolver);
}
