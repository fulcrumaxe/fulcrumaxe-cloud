import type { NextRequest, NextResponse } from "next/server";
import { githubSignInHandler } from "./handler";

export async function GET(req: NextRequest): Promise<NextResponse> {
  return githubSignInHandler(req);
}
