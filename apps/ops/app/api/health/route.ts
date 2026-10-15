import { NextResponse } from "next/server";
import { envProblems } from "../../../lib/env";
import { log } from "../../../lib/log";

export const dynamic = "force-dynamic";

/** 200 when the required settings are present and well formed; otherwise 503 naming each one (never its value). */
export async function GET(): Promise<NextResponse> {
  const problems = envProblems(process.env);
  if (problems.length > 0) {
    log.error("ops.health.degraded", { route: "/api/health", count: problems.length });
    return NextResponse.json({ status: "unhealthy", problems }, { status: 503 });
  }
  return NextResponse.json({ status: "ok" });
}
