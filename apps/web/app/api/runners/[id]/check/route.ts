import type { NextRequest } from "next/server";
import { fleetCheckHandler } from "../controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => fleetCheckHandler(req, (await ctx.params).id);
