import type { NextRequest } from "next/server";
import { draftHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => draftHandler(req, (await ctx.params).id, null);
export const PUT = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => draftHandler(req, (await ctx.params).id, null);
