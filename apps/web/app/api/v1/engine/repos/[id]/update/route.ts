import type { NextRequest } from "next/server";
import { updateEngineHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => updateEngineHandler(req, (await ctx.params).id);
