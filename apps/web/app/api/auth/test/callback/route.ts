import type { NextRequest, NextResponse } from "next/server";
import { testSignInHandler } from "./handler";

export async function GET(req: NextRequest): Promise<NextResponse> {
  return testSignInHandler(req);
}
