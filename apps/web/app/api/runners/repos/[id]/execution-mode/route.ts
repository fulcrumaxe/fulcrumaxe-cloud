import type { NextRequest } from "next/server";
import { executionModeHandler, getRepoModeHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => executionModeHandler(req, (await ctx.params).id);
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => getRepoModeHandler(req, (await ctx.params).id);
