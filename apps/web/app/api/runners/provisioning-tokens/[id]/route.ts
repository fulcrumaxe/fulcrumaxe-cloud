import type { NextRequest } from "next/server";
import { revokeTokenHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const DELETE = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => revokeTokenHandler(req, (await ctx.params).id);
