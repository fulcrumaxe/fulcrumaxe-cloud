import type { NextRequest } from "next/server";
import { setupPushTokenHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ setup_id: string }> }) => setupPushTokenHandler(req, (await ctx.params).setup_id);
