import type { NextRequest, NextResponse } from "next/server";
import { healthResponse } from "./handler";

/** Read at request time: a static route would judge the build's environment, not the running one. */
export const dynamic = "force-dynamic";

export function GET(req: NextRequest): NextResponse {
  return healthResponse(process.env, req.headers.get("authorization"));
}
