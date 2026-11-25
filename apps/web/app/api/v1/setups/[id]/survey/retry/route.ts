import type { NextRequest } from "next/server";
import { retrySurveyHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => retrySurveyHandler(req, (await ctx.params).id);
