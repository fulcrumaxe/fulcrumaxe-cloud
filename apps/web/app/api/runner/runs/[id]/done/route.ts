import type { NextRequest } from "next/server";
import { doneHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => doneHandler(req, (await ctx.params).id);
