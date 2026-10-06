import type { NextRequest, NextResponse } from "next/server";
import { stripeWebhookHandler } from "./handler";

export async function POST(req: NextRequest): Promise<NextResponse> {
  return stripeWebhookHandler(req);
}
