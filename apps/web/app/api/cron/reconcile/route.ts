import type { NextRequest, NextResponse } from "next/server";
import { reconcileHandler } from "./handler";

/** Not under /api/v1 -- see handler.ts's header for the auth model. A tick is budgeted at 240 s, inside this. */
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  return reconcileHandler(req);
}
