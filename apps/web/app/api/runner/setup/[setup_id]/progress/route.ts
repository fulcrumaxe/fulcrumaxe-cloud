import type { NextRequest } from "next/server";
import { setupProgressHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ setup_id: string }> }) => setupProgressHandler(req, (await ctx.params).setup_id);
