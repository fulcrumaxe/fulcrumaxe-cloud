import { NextResponse, type NextRequest } from "next/server";
import { gateRequest } from "./gate";

/**
 * Defence in depth: the build holds only the gh-proxy route, and this refuses
 * everything else before it. Host, path prefix and method are checked in
 * gate.ts; a refusal is an empty 404 (it names no reason to the caller).
 */
export function middleware(req: NextRequest): NextResponse {
  let decision: ReturnType<typeof gateRequest>;
  try {
    decision = gateRequest(
      {
        method: req.method,
        url: req.url,
        host: req.headers.get("host"),
        xForwardedHost: req.headers.get("x-forwarded-host"),
      },
      process.env.FX_GH_PROXY_PUBLIC_HOST,
    );
  } catch {
    // Anything unexpected while reading the request is a refusal, not Next's 500 page.
    // (A TRACE request fails earlier, inside Next, before this function runs.)
    return new NextResponse(null, { status: 404 });
  }
  if (!decision.allow) {
    if (decision.reason === "public_host_unset") {
      console.error("gh-proxy gate: FX_GH_PROXY_PUBLIC_HOST is not set -- every request is refused until this is fixed");
    }
    return new NextResponse(null, { status: decision.status });
  }
  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
