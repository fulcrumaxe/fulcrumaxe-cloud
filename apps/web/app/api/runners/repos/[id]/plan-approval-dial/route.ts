import type { NextRequest } from "next/server";
import { getPlanApprovalDialHandler, putPlanApprovalDialHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => getPlanApprovalDialHandler(req, (await ctx.params).id);
export const PUT = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => putPlanApprovalDialHandler(req, (await ctx.params).id);
