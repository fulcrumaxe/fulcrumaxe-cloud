import type { NextRequest } from "next/server";
import { getSandboxAllowancesHandler, putSandboxAllowancesHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => getSandboxAllowancesHandler(req, (await ctx.params).id);
export const PUT = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => putSandboxAllowancesHandler(req, (await ctx.params).id);
