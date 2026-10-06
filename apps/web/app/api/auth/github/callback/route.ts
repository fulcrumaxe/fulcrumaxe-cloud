import type { NextRequest, NextResponse } from "next/server";
import { githubCallbackHandler } from "./handler";

export async function GET(req: NextRequest): Promise<NextResponse> {
  return githubCallbackHandler(req);
}
