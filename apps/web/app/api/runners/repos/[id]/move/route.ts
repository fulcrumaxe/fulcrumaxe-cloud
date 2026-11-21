import type { NextRequest } from "next/server";
import { moveProjectHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => moveProjectHandler(req, (await ctx.params).id);
