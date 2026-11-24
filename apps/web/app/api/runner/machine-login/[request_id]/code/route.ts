import type { NextRequest } from "next/server";
import { machineLoginCodeHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = async (req: NextRequest, ctx: { params: Promise<{ request_id: string }> }) => machineLoginCodeHandler(req, (await ctx.params).request_id);
