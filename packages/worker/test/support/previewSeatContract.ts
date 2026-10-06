import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { claudePricing } from "../../../spend/src/pricing.js";
import { RUN_LIMIT_BOUNDS } from "../../../core/src/run-limits/limits.js";
import { PREVIEW_COMPUTE_CAP_USD, PREVIEW_MAX_RUN_MS, PREVIEW_MODEL_CAP_USD, PREVIEW_SEAT_REFUSALS, type PreviewSeatSource } from "../../src/preview.js";
import { seedPreviewTarget } from "./previewTarget.js";

/**
 * D#2 H17c-2b, CT-1: what ANY preview seat source must answer, run on real Postgres. H17c runs it
 * against its test fake; H14c-3-2d-2 adds one line running it against `resolveRunSeat` (with
 * `{ accountId, role, repoId, purpose: "preview" }`), so the real piece is held to the same shape.
 */

/**
 * D-TIMEOUT, q-H14c-3-2d.txt lines 88-92 (3-2d-2 builds it; it is not on main yet, so the formula is
 * restated here exactly as written and a test of the real seat will fail if the two ever disagree):
 *   maxPossibleRunMs = min(maxRunMs + maxExtensions x floor(0.5 x maxRunMs), ceilingRunMs)
 *   ceilingRunMs     = RUN_LIMIT_BOUNDS.max_run_minutes.ceiling x 60 000
 *   run.timeoutMs    = maxPossibleRunMs + SANDBOX_TIMEOUT_MARGIN_MS      (the PM default margin is 10 minutes)
 * `maxExtensions` is the resolved limit; the seeded accounts here have no override, so it is the platform default.
 * When 3-2d-2 exports SANDBOX_TIMEOUT_MARGIN_MS, import it instead of this copy.
 */
export const SANDBOX_TIMEOUT_MARGIN_MS = 10 * 60_000;
export function expectedSandboxTimeoutMs(maxRunMs: number, maxExtensions: number = RUN_LIMIT_BOUNDS.max_extensions.default): number {
  const ceilingRunMs = RUN_LIMIT_BOUNDS.max_run_minutes.ceiling * 60_000;
  const maxPossibleRunMs = Math.min(maxRunMs + maxExtensions * Math.floor(0.5 * maxRunMs), ceilingRunMs);
  return maxPossibleRunMs + SANDBOX_TIMEOUT_MARGIN_MS;
}

const inRange = (n: unknown, bounds: { floor: number; ceiling: number }, unit = 1): boolean =>
  typeof n === "number" && Number.isInteger(n) && n >= bounds.floor * unit && n <= bounds.ceiling * unit;

export function previewSeatContract(label: string, source: PreviewSeatSource, getAdmin: () => PoolClient): void {
  describe(`CT-1 preview seat contract: ${label} [pg]`, () => {
    it("an ok seat for a team_readonly repo: purpose preview, the $20 model cap, compute within $1, a priced model, a card, bounded limits, no work item", async () => {
      const a = await seedAccount(getAdmin(), randomUUID());
      const t = await seedPreviewTarget(getAdmin(), a);
      const r = await source.previewSeat(a.accountId, t.repoId);
      if (!r.ok) throw new Error(`expected an ok seat, got ${r.reason}`);
      const s = r.seat;
      expect(s.spend.purpose).toBe("preview");
      expect(s.capUsd).toBe(PREVIEW_MODEL_CAP_USD);
      expect(s.spend.estimateComputeUsd ?? 0).toBeLessThanOrEqual(PREVIEW_COMPUTE_CAP_USD);
      expect(Object.keys(claudePricing())).toContain(s.model);
      expect(typeof s.roleCard).toBe("string");
      expect(s.roleCard.trim().length).toBeGreaterThan(0);
      expect(s.repoId).toBe(t.repoId);
      const l = s.limits as Record<string, number>;
      expect(inRange(l.maxRunMs, RUN_LIMIT_BOUNDS.max_run_minutes, 60_000), "maxRunMs").toBe(true);
      expect(inRange(l.maxTurns, RUN_LIMIT_BOUNDS.max_turns), "maxTurns").toBe(true);
      expect(inRange(l.maxModelCalls, RUN_LIMIT_BOUNDS.max_model_calls), "maxModelCalls").toBe(true);
      expect(inRange(l.meteringSilenceMs, RUN_LIMIT_BOUNDS.silence_minutes, 60_000), "meteringSilenceMs").toBe(true);
      expect((s as { workItemId?: unknown }).workItemId ?? null).toBeNull();
    });

    it("D-TIMEOUT: timeoutMs is the run's longest possible length (limits plus extensions, capped at the platform ceiling) plus the 10-minute margin, exactly", async () => {
      const a = await seedAccount(getAdmin(), randomUUID());
      const t = await seedPreviewTarget(getAdmin(), a);
      const r = await source.previewSeat(a.accountId, t.repoId);
      if (!r.ok) throw new Error(`expected an ok seat, got ${r.reason}`);
      const maxRunMs = (r.seat.limits as Record<string, number>).maxRunMs!;
      // A preview takes no extension and ends by its own limit inside the invocation that reads its stream.
      expect(maxRunMs).toBeLessThanOrEqual(PREVIEW_MAX_RUN_MS);
      expect(r.seat.timeoutMs).toBe(expectedSandboxTimeoutMs(maxRunMs, 0));
      expect(r.seat.timeoutMs).toBeGreaterThan(maxRunMs);
    });

    it("a team installation's repo, a sitekit one, another account's repo and a missing repo each refuse with a fixed reason", async () => {
      const a = await seedAccount(getAdmin(), randomUUID());
      const b = await seedAccount(getAdmin(), randomUUID());
      const team = await seedPreviewTarget(getAdmin(), a, "team");
      const sitekit = await seedPreviewTarget(getAdmin(), a, "sitekit");
      const theirs = await seedPreviewTarget(getAdmin(), b);
      const reasons: Record<string, string> = {};
      for (const [name, repoId] of Object.entries({ team: team.repoId, sitekit: sitekit.repoId, theirs: theirs.repoId, missing: randomUUID() })) {
        const r = await source.previewSeat(a.accountId, repoId);
        expect(r.ok, name).toBe(false);
        if (r.ok) continue;
        expect(PREVIEW_SEAT_REFUSALS, name).toContain(r.reason);
        reasons[name] = r.reason;
      }
      // Another account's repo must not be told apart from one that does not exist.
      expect(reasons.theirs).toBe(reasons.missing);
    });

    it("the result survives structuredClone unchanged (it is handed across a workflow step)", async () => {
      const a = await seedAccount(getAdmin(), randomUUID());
      const t = await seedPreviewTarget(getAdmin(), a);
      const r = await source.previewSeat(a.accountId, t.repoId);
      expect(structuredClone(r)).toEqual(r);
    });
  });
}
