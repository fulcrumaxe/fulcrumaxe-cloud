import type { NextRequest } from "next/server";
import { abandonCarryHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => abandonCarryHandler(req, (await ctx.params).id);
