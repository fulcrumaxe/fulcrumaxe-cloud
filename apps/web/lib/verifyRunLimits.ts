import { deployVerifySettings } from "@fx/plan-data";
import type { VerifyRunLimits } from "@fx/worker";

/**
 * D#749 V3c: the post-merge tester's figures for the worker, read from plan data on each call (so a changed setting applies at once): the most one job may reserve, and the per-repository daily
 * cap its jobs count against (the claim verifier's own `discovery.perRepoDailyUsd`). Plan data that is unavailable, or carries no per-run figure, THROWS: the stage reads a throw as
 * "hold the row and ask again next tick", so nothing starts on a guessed number. No figure has a default.
 */
export function verifyRunLimits(): VerifyRunLimits {
  const s = deployVerifySettings();
  if (!s.on) throw new Error(s.code);
  return { runUsd: s.perRunUsd, perRepoDailyUsd: s.perRepoDailyUsd };
}
