import type { NextRequest } from "next/server";
import { stateCarryChunkPutHandler, stateCarryChunkTakeHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ job_id: string; index: string }> };
export const PUT = async (req: NextRequest, ctx: Ctx) => {
  const { job_id, index } = await ctx.params;
  return stateCarryChunkPutHandler(req, job_id, index);
};
export const GET = async (req: NextRequest, ctx: Ctx) => {
  const { job_id, index } = await ctx.params;
  return stateCarryChunkTakeHandler(req, job_id, index);
};
