import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { claudePricing } from "../../../spend/src/pricing.js";
import { PREVIEW_SEAT_REFUSALS } from "../../src/preview.js";
import type { RetrySeatSource } from "../../src/retry.js";

/**
 * D#31 API-6b-2, Q-6b-3: what ANY retry seat source must answer, on real Postgres. The test fake runs it
 * today; H14c-3-2d-2 adds one line running it against `resolveRunSeat` (`{ accountId, role, workItemId }`).
 */
export function retrySeatContract(label: string, source: RetrySeatSource, getAdmin: () => PoolClient): void {
  describe(`retry seat contract: ${label} [pg]`, () => {
    it("an ok seat for a run's role on its work item: a priced model, a card, a cap, spend facts, the repo, and it survives structuredClone", async () => {
      const a = await seedAccount(getAdmin(), randomUUID());
      const r = await source.retrySeat({ accountId: a.accountId, role: "code-reviewer", workItemId: a.workItemId });
      if (!r.ok) throw new Error(`expected an ok seat, got ${r.reason}`);
      expect(Object.keys(claudePricing())).toContain(r.seat.model);
      expect(r.seat.roleCard.trim().length).toBeGreaterThan(0);
      expect(r.seat.capUsd).toBeGreaterThan(0);
      expect(r.seat.repoId).toBe(a.repoId);
      expect(r.seat.spend).toBeDefined();
      expect(structuredClone(r)).toEqual(r);
    });

    it("another account's work item and a missing one refuse with the same fixed reason", async () => {
      const a = await seedAccount(getAdmin(), randomUUID());
      const b = await seedAccount(getAdmin(), randomUUID());
      const theirs = await source.retrySeat({ accountId: a.accountId, role: "code-reviewer", workItemId: b.workItemId });
      const missing = await source.retrySeat({ accountId: a.accountId, role: "code-reviewer", workItemId: randomUUID() });
      expect(theirs.ok).toBe(false);
      expect(missing).toEqual(theirs);
      if (!theirs.ok) expect(PREVIEW_SEAT_REFUSALS).toContain(theirs.reason);
    });
  });
}
