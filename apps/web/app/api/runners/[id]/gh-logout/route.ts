import type { NextRequest } from "next/server";
import { ghLogoutHandler } from "../controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => ghLogoutHandler(req, (await ctx.params).id);
