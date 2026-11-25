import type { NextRequest } from "next/server";
import { draftHandler } from "../handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) => {
  const { id, action } = await ctx.params;
  return draftHandler(req, id, action);
};
