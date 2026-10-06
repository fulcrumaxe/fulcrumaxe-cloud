import type { NextRequest, NextResponse } from "next/server";
import { installCallbackHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** D#2 H17a: a GitHub App's "Setup URL". `{kind}` is one of the three App kinds. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ kind: string }> }): Promise<NextResponse> {
  const { kind } = await ctx.params;
  return installCallbackHandler(req, kind);
}
