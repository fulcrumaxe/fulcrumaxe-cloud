import type { NextRequest } from "next/server";
import { fleetSandboxCommandHandler } from "../controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => fleetSandboxCommandHandler(req, (await ctx.params).id);
