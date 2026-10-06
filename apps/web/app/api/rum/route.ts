import type { NextRequest, NextResponse } from "next/server";
import { handleRumPost } from "./handler";

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handleRumPost(req);
}
