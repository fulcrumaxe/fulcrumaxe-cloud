import { deployVerifySettings } from "@fx/plan-data";
import type { VerifyRunLimits } from "@fx/worker";

/**
 * D#749 V3c: the post-merge tester's figures for the worker, read from plan data on each call (so a changed setting applies at once): the most one job may reserve, and the per-repository daily
 * cap its jobs count against (`discovery.deployVerifyPerRepoDailyUsd`, the stage's own: the shared `discovery.perRepoDailyUsd` is the claim verifier's and analysis's and is never read here and counts none of the tester's runs).
 * Plan data that is unavailable, that lacks either figure (`deploy_verify_unconfigured`) or that has a run figure above the daily one (`deploy_verify_run_over_daily`) THROWS: the stage reads a throw as
 * "hold the row and ask again next tick", so nothing starts on a guessed number. No figure has a default.
 */
export function verifyRunLimits(): VerifyRunLimits {
  const s = deployVerifySettings();
  if (!s.on) throw new Error(s.code);
  return { runUsd: s.perRunUsd, perRepoDailyUsd: s.perRepoDailyUsd };
}
