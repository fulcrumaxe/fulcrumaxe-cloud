import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { sessionSecretProblems } from "@fx/core/src/auth/session";
import { planDataStatus } from "@fx/plan-data";
import { outsideMeterOn } from "@fx/spend";
import { ENV_MANIFEST } from "../../../env-manifest";
import { HUMAN_MERGE_ONLY_ENV, HUMAN_MERGE_ONLY_INVALID_CODE } from "@fx/db/src/humanMergeOnly";
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
 *
 * Every caller also gets `outside_meter`: "on" only when FX_OUTSIDE_METER is exactly "on" (any other value, or unset, is "off";
 * the same test the sweep and the tag minting use). It names no key and no connection.
 *
 * Every caller also gets `deploy_env` (FX_DEPLOY_ENV, or null when unset). Only when that is "staging" does the
 * body also carry `project_id` (VERCEL_PROJECT_ID) and `commit` (VERCEL_GIT_COMMIT_SHA, or null): the live-test
 * runner compares them before it runs anything that is not safe on production. Any other deployment, production
 * included, discloses neither.
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

const orNull = (value: string | undefined): string | null => (value === undefined || value === "" ? null : value);

/** The deployment's self-description. The Vercel project id and commit are given to staging only. */
function identity(env: EnvLike) {
  const deploy_env = orNull(env.FX_DEPLOY_ENV);
  if (deploy_env !== "staging") return { deploy_env };
  return { deploy_env, project_id: orNull(env.VERCEL_PROJECT_ID), commit: orNull(env.VERCEL_GIT_COMMIT_SHA) };
}

/**
 * The session secret rotation window is judged as a trio (packages/core/src/auth/session.ts): one half set without the other,
 * an end further out than the session lifetime allows, and an expired previous secret still set are errors in every deploy
 * kind, because they mean a rotation is half done or a retired secret is still present.
 */
function withSessionSecretProblems(report: EnvReport, env: EnvLike, nowMs: number): EnvReport {
  const rotationNames = new Set(["FX_SESSION_SECRET_PREVIOUS", "FX_SESSION_SECRET_PREVIOUS_UNTIL", "FX_SESSION_SECRET_ROTATED_AT"]);
  // The three are optional, so the manifest check files a malformed value as optional-invalid; a malformed rotation setting is an error.
  const malformed = report.invalidOptional.filter((i) => rotationNames.has(i.name));
  const problems = [...malformed, ...sessionSecretProblems(env as NodeJS.ProcessEnv, nowMs)];
  if (problems.length === 0) return report;
  return {
    ...report,
    ok: false,
    invalid: [...report.invalid, ...problems],
    invalidOptional: report.invalidOptional.filter((i) => !rotationNames.has(i.name)),
  };
}

/**
 * D#6 M1G-a: a malformed human-merge-only list is an error in every deploy kind, not a quiet optional miss: the merge gate
 * is then locking EVERY repository to human merges (fail closed), and the operator has to fix the value. The detail names the
 * setting and the fixed code `human_merge_only_config_invalid`, never the value.
 */
function withHumanMergeOnlyProblem(report: EnvReport): EnvReport {
  const bad = report.invalidOptional.filter((i) => i.name === HUMAN_MERGE_ONLY_ENV);
  if (bad.length === 0) return report;
  return {
    ...report,
    ok: false,
    invalid: [...report.invalid, ...bad.map((i) => ({ name: i.name, reason: HUMAN_MERGE_ONLY_INVALID_CODE }))],
    invalidOptional: report.invalidOptional.filter((i) => i.name !== HUMAN_MERGE_ONLY_ENV),
  };
}

export function healthResponse(env: EnvLike, authHeader: string | null, nowMs: number = Date.now()): NextResponse {
  const report = withHumanMergeOnlyProblem(withSessionSecretProblems(evaluateEnv(ENV_MANIFEST, env, deployKindOf(env)), env, nowMs));
  const body = { ok: report.ok, config: report.ok ? "ok" : "incomplete", planData: planDataStatus(), outside_meter: outsideMeterOn(env.FX_OUTSIDE_METER) ? "on" : "off", ...identity(env) };
  const init = { status: report.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } };
  if (isOperator(authHeader, env.CRON_SECRET)) return NextResponse.json({ ...body, ...detail(report) }, init);
  return NextResponse.json(body, init);
}
