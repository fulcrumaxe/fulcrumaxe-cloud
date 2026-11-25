import type { NextRequest } from "next/server";
import { mergeInstallHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => mergeInstallHandler(req, (await ctx.params).id);
