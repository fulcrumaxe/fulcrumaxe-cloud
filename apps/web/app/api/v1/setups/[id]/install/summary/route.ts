import type { NextRequest } from "next/server";
import { installSummaryHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => installSummaryHandler(req, (await ctx.params).id);
