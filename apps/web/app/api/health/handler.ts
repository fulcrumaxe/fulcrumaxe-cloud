import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { planDataStatus } from "@fx/plan-data";
import { ENV_MANIFEST } from "../../../env-manifest";
import { deployKindOf, evaluateEnv, type EnvLike, type EnvReport } from "../../../lib/env/check";

/**
 * Liveness plus a check of the required settings (apps/web/env-manifest.ts).
 *
 * Anonymous callers get only a verdict: 200 {ok:true,config:"ok"} when every
 * setting required for this deployment's kind is present and valid, else
 * 503 {ok:false,config:"incomplete"}. Both carry planData: "ok" | "missing", the state of the plan data setting
 * (never a value); a missing plan data setting does not fail the verdict, since the app starts and shows the
 * unavailable state instead. No variable name appears, because a
 * list of missing secrets tells an attacker which protections are off.
 *
 * A caller that presents the deployment's CRON_SECRET as a bearer token (the
 * same credential the three cron routes already trust) also gets the detail:
 * which required settings are missing or invalid, by name and a fixed reason
 * code, and which optional features are off. Never a value. With CRON_SECRET
 * unset nobody gets the detail (fail closed).
 */

function isOperator(authHeader: string | null, secret: string | undefined): boolean {
  if (!secret || !authHeader) return false;
  // Hash both sides so the comparison is constant-length whatever the header holds.
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const actual = createHash("sha256").update(authHeader).digest();
  return timingSafeEqual(expected, actual);
}

function detail(report: EnvReport) {
  return {
    deploy_kind: report.kind,
    missing: report.missing,
    invalid: report.invalid,
    invalid_optional: report.invalidOptional,
    disabled: report.disabled,
  };
}

export function healthResponse(env: EnvLike, authHeader: string | null): NextResponse {
  const report = evaluateEnv(ENV_MANIFEST, env, deployKindOf(env));
  const body = { ok: report.ok, config: report.ok ? "ok" : "incomplete", planData: planDataStatus() };
  const init = { status: report.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } };
  if (isOperator(authHeader, env.CRON_SECRET)) return NextResponse.json({ ...body, ...detail(report) }, init);
  return NextResponse.json(body, init);
}
