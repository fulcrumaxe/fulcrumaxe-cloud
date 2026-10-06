import type { NextRequest, NextResponse } from "next/server";
import { createRepoCallbackHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** D#2 RC-1b: the return from GitHub's user authorization for a repo creation. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return createRepoCallbackHandler(req);
}
