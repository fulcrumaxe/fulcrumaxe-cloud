import type { NextRequest } from "next/server";
import { setupPlanHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = async (req: NextRequest, ctx: { params: Promise<{ setup_id: string }> }) => setupPlanHandler(req, (await ctx.params).setup_id);
