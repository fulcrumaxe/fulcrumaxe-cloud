import type { NextRequest } from "next/server";
import { claudeLoginReadHandler, claudeLoginStartHandler } from "../controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => claudeLoginStartHandler(req, (await ctx.params).id);
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => claudeLoginReadHandler(req, (await ctx.params).id);
