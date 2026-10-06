import type { NextRequest, NextResponse } from "next/server";
import { acceptInvitationHandler } from "./handler";

export async function POST(req: NextRequest): Promise<NextResponse> {
  return acceptInvitationHandler(req);
}
