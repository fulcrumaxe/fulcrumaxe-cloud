import type { NextRequest, NextResponse } from "next/server";
import { githubWebhookHandler } from "./handler";

export async function POST(req: NextRequest): Promise<NextResponse> {
  return githubWebhookHandler(req);
}
