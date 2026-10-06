import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { StartAgentRunInput } from "@fx/runner";
import type { RunStarter } from "../../src/preview.js";

/**
 * D#2 H17c-2b, CT-2: what ANY run starter must do, run on real Postgres. H17c runs it against a
 * starter built from the real `startAgentRun` and the real `SandboxTarget` over the SDK fake with an
 * in-process hook channel; H14c-3-3 adds one line running it against the production starter.
 *
 * The settle assertions are about the run's reservations, never about compute ending `released`:
 * finalize and settle behaviour for compute is changing (COMPUTE-SETTLE), so only "nothing left open"
 * and "the model reservation settled" are asserted.
 */
export interface RunStarterWorld {
  starter: RunStarter;
  /** A start input for a fresh account and repo, carrying this idempotency key. */
  newInput(key: string): Promise<StartAgentRunInput>;
  /** Makes the run's sandbox hook fire, the way the production path ends a sandbox. */
  fireHook(runId: string): Promise<void>;
  /** A superuser connection, for counting rows. */
  admin: PoolClient;
  /** Errors from the starter's background finalize (nothing may be left as an unhandled rejection). */
  finalizeErrors(): unknown[];
}

export async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 200 && !done(v); i++) {
    await new Promise((r) => setTimeout(r, 25));
    v = await read();
  }
  return v;
}

export function runStarterContract(label: string, getWorld: () => RunStarterWorld): void {
  describe(`CT-2 run starter contract: ${label} [pg]`, () => {
    const counts = async (w: RunStarterWorld, accountId: string, runId: string) => ({
      // Runs dispatched by a start (the account's seeded baseline run has no dispatch repo).
      runs: Number((await w.admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND dispatch_repo_id IS NOT NULL", [accountId])).rows[0].n),
      // One reservation per budget the run draws on (model, compute), all for the preview purpose.
      reservations: (
        await w.admin.query(
          "SELECT budget, purpose, count(*)::int AS n FROM spend_reservations WHERE account_id = $1 AND run_id = $2 GROUP BY budget, purpose ORDER BY budget",
          [accountId, runId],
        )
      ).rows as { budget: string; purpose: string; n: number }[],
    });

    it("start creates one run and one preview reservation per budget; the same key again returns the same run and creates nothing", async () => {
      const w = getWorld();
      const key = `run-action:${crypto.randomUUID()}`;
      const input = await w.newInput(key);
      const first = await w.starter.start(input);
      const afterFirst = await counts(w, input.accountId, first.runId);
      expect(afterFirst.runs).toBe(1);
      // Exactly one model and one compute reservation, both for the preview purpose: a missing compute one fails.
      expect(afterFirst.reservations.map((r) => r.budget).sort()).toEqual(["foreground_compute", "model"]);
      for (const r of afterFirst.reservations) {
        expect(r.purpose).toBe("preview");
        expect(r.n).toBe(1);
      }
      const again = await w.starter.start(input);
      expect(again.runId).toBe(first.runId);
      expect(await counts(w, input.accountId, first.runId)).toEqual(afterFirst);
    });

    it("start hands inCreateTransaction the new run's id exactly once, and a replay of the same key does not call it again (R-ATOMIC)", async () => {
      const w = getWorld();
      const input = await w.newInput(`run-action:${crypto.randomUUID()}`);
      const seen: string[] = [];
      const seamed: StartAgentRunInput = { ...input, inCreateTransaction: async (_client, runId) => void seen.push(runId) };
      const first = await w.starter.start(seamed);
      expect(seen).toEqual([first.runId]);
      expect((await w.starter.start(seamed)).runId).toBe(first.runId);
      expect(seen).toEqual([first.runId]);
    });

    it("after the sandbox's hook fires the run is finalized once and its reservations are settled", async () => {
      const w = getWorld();
      const input = await w.newInput(`run-action:${crypto.randomUUID()}`);
      const { runId } = await w.starter.start(input);
      const running = (await w.admin.query("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0].status;
      expect(running).toBe("running");
      await w.fireHook(runId);
      const final = await eventually(
        async () => (await w.admin.query("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0].status as string,
        (s) => s !== "running",
      );
      expect(w.finalizeErrors()).toEqual([]);
      expect(final).toBe("succeeded");
      // The status is written before the settle, so wait for the reservations to stop being open.
      const res = await eventually(
        () => w.admin.query("SELECT budget, state FROM spend_reservations WHERE run_id = $1", [runId]),
        (q) => q.rows.every((r) => r.state !== "open"),
      );
      expect(res.rows.length).toBeGreaterThan(0);
      expect(res.rows.filter((r) => r.budget === "model").map((r) => r.state)).toEqual(["settled"]);
      for (const r of res.rows) expect(r.state).not.toBe("open");
      const finals = await w.admin.query(
        "SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' AND payload->>'to' = 'succeeded'",
        [runId],
      );
      expect(finals.rows[0].n).toBe(1);
    });
  });
}
