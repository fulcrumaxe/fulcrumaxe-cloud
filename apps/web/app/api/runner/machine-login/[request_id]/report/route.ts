import type { NextRequest } from "next/server";
import { machineLoginReportHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ request_id: string }> }) => machineLoginReportHandler(req, (await ctx.params).request_id);
