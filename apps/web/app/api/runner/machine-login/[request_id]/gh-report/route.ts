import type { NextRequest } from "next/server";
import { ghLoginReportHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ request_id: string }> }) => ghLoginReportHandler(req, (await ctx.params).request_id);
