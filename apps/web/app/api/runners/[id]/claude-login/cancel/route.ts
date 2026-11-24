import type { NextRequest } from "next/server";
import { claudeLoginCancelHandler } from "../../controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => claudeLoginCancelHandler(req, (await ctx.params).id);
