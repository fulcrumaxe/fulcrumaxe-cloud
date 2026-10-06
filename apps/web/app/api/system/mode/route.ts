import { NextResponse } from "next/server";

/** D#37 WS-C criterion 2: "GET /api/system/mode -> {"cloud":true}." Anonymous, static, no version/env/host/account data -- see api/mode/route.ts's fuller comment. */
export const dynamic = "force-static";

export function GET(): NextResponse {
  return NextResponse.json({ cloud: true });
}
