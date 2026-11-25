import type { NextRequest } from "next/server";
import { startSurveyHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => startSurveyHandler(req, (await ctx.params).id);
