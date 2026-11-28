import type { NextRequest } from "next/server";
import { stateCarryFailHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ job_id: string }> }) => stateCarryFailHandler(req, (await ctx.params).job_id);
