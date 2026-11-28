import type { NextRequest } from "next/server";
import { ghLoginReadHandler, ghLoginStartHandler } from "../controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => ghLoginStartHandler(req, (await ctx.params).id);
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => ghLoginReadHandler(req, (await ctx.params).id);
