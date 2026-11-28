import type { NextRequest } from "next/server";
import { stateCarryBeginHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ job_id: string }> }) => stateCarryBeginHandler(req, (await ctx.params).job_id);
