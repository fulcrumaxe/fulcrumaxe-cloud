import type { NextRequest, NextResponse } from "next/server";
import { signOutHandler } from "./handler";

export async function POST(req: NextRequest): Promise<NextResponse> {
  return signOutHandler(req);
}
