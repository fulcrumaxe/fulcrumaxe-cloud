import { NextResponse } from "next/server";
import openApiDocument from "@fx/api/openapi.json";

/**
 * D#31 API-1 criterion 10: "GET /api/v1/openapi.json is anonymous and
 * static, with Cache-Control: public, max-age=300." This is a more
 * specific route than `apps/web/app/api/v1/[...path]/route.ts`, so Next
 * matches this file first -- the catch-all (and its principal
 * resolution) never runs for this path. The committed
 * `packages/api/openapi.json` is served verbatim; `force-static` means
 * Next builds this response once rather than per-request.
 */
export const dynamic = "force-static";

export async function GET(): Promise<NextResponse> {
  const res = NextResponse.json(openApiDocument);
  res.headers.set("Cache-Control", "public, max-age=300");
  return res;
}
