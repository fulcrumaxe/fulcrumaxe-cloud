import { NextResponse } from "next/server";
import openApiDocument from "@fx/api/openapi.json";
import { describeTokens } from "@fx/api/src/openapi.js";
import { tokensAvailable } from "@fx/api/src/tokens/availability.js";

/**
 * D#31 API-1 criterion 10: "GET /api/v1/openapi.json is anonymous and
 * static, with Cache-Control: public, max-age=300." This is a more
 * specific route than `apps/web/app/api/v1/[...path]/route.ts`, so Next
 * matches this file first -- the catch-all (and its principal
 * resolution) never runs for this path. The committed
 * `packages/api/openapi.json` is served as committed, except that the
 * sentence about API tokens follows the same availability test the mint
 * route uses (`tokensAvailable`), read per request: the flag is a runtime
 * setting, so the page cannot be built once.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const res = NextResponse.json(describeTokens(openApiDocument, tokensAvailable()));
  res.headers.set("Cache-Control", "public, max-age=300");
  return res;
}
