import type { NextRequest, NextResponse } from "next/server";
import { shellSessionHandler } from "../../../../lib/shell/session-routes";
import { defaultAuthDeps } from "../../auth/_lib/deps";

/**
 * D#37 WS-C criterion 5: the ONE route module every rewritten shell
 * session path lands on (the rewrite itself is
 * `shellSessionRewriteStep` in `apps/web/middleware.ts` -- see
 * `lib/shell/shell-paths.ts`'s header comment for the full mechanism,
 * including why the original path travels as a header rather than the
 * query parameter the Spec names). GET covers
 * `me`/`entitlements`/`license`/`preferences`; POST is `preferences`
 * only (the other three never rewrite a POST here -- see the rewrite
 * table in shell-paths.ts).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return shellSessionHandler(req, defaultAuthDeps());
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return shellSessionHandler(req, defaultAuthDeps());
}
