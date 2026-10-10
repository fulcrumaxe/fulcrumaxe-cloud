import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { MAX_REVIEWED_HEADS, VERIFIED_REVIEW_COMPUTE_CAP_USD, readVerifiedReviewGate, type VerifiedReviewGate } from "../src/verifiedReviewGate.js";

const MIN = 60_000;
const PR = 41;
const sha = (c: string): string => c.repeat(40);
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * D#6 R5b-2b-i (C38 section 1, C40) [pg]: the 3-head round cap and the monthly compute cap on the reviews of a cloud-verified pull request.
 * Both are derived from existing rows (review runs, compute ledger rows), never stored, and both fail closed.
 */
describe("cloud-verified reviews: the round cap and the compute cap [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  /** A verified repo whose seeded executor is cancelled, so the quiet period is over (the clock is a day ahead) and the key is present. */
  async function world(): Promise<{ a: SeedRefs; now: Date }> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_verified' WHERE id = $1", [a.repoId]);
    await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [a.runId]);
    return { a, now: new Date(Date.now() + 60 * MIN) };
  }
  const gate = (w: { a: SeedRefs; now: Date }, headSha: string, op = false): Promise<VerifiedReviewGate> =>
    readVerifiedReviewGate(writerPool, { accountId: w.a.accountId, workItemId: w.a.workItemId, prNumber: PR, headSha, seenHead: null, now: w.now, ...(op ? { isOperatorAccount: () => true } : {}) });

  async function review(w: { a: SeedRefs }, head: string | null, over: { role?: string; mode?: string; runtime?: string } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, execution_mode, status, head_sha) VALUES ($1, $2, $3, $4, $5, $6, 'succeeded', $7)", [id, w.a.accountId, w.a.workItemId, over.role ?? "code-reviewer", over.runtime ?? "production", over.mode ?? "runner_verified", head]);
    return id;
  }
  async function ledger(accountId: string, runId: string, kind: "compute" | "model", usd: number, createdAt?: Date): Promise<void> {
    await admin.query("INSERT INTO ledger (account_id, kind, source, usd, run_id, budget, created_at) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))", [accountId, kind, kind === "compute" ? "sandbox" : "customer_anthropic", usd, runId, kind === "compute" ? "foreground_compute" : "model", createdAt ?? null]);
  }

  it("acceptance 1: heads 1 to 3 dispatch, and a fourth head gets no dispatch (round_cap)", async () => {
    const w = await world();
    expect(MAX_REVIEWED_HEADS).toBe(3);
    for (const h of ["1", "2", "3"]) {
      expect(await gate(w, sha(h)), `head ${h}`).toEqual({ state: "dispatch" });
      await review(w, sha(h));
    }
    expect(await gate(w, sha("4"))).toEqual({ state: "round_cap" });
    // A head already reviewed is not a new one: a second reviewer on it still dispatches.
    expect(await gate(w, sha("3"))).toEqual({ state: "dispatch" });
  });

  it("the round count is the distinct heads of sandbox review runs of this item: other roles, runner runs and other items do not count", async () => {
    const w = await world();
    await review(w, sha("1"));
    await review(w, sha("1"), { role: "security-reviewer" }); // the same head twice is one head
    await review(w, sha("2"), { role: "executor", runtime: "runner" }); // not a review
    await review(w, sha("3"), { runtime: "runner" }); // a runner's review is advisory and is not a sandbox dispatch
    await review(w, sha("5"), { mode: "sandbox" });
    const other = await world();
    for (const h of ["a", "b", "c"]) await review(other, sha(h));
    expect(await gate(w, sha("9"))).toEqual({ state: "dispatch" });
    await review(w, sha("2"), { role: "debater" });
    await review(w, sha("3"), { role: "acceptance-tester" });
    expect(await gate(w, sha("9"))).toEqual({ state: "round_cap" });
  });

  it("acceptance 2: at cap minus a cent a review dispatches; once the cap is reached the next is skipped (compute_cap)", async () => {
    expect(VERIFIED_REVIEW_COMPUTE_CAP_USD).toBe(5);
    const w = await world();
    const run = await review(w, sha("1"));
    await ledger(w.a.accountId, run, "compute", 4.99);
    expect(await gate(w, sha("2"))).toEqual({ state: "dispatch" });
    await ledger(w.a.accountId, await review(w, sha("1"), { role: "debater" }), "compute", 0.01); // one compute row per run
    expect(await gate(w, sha("2"))).toEqual({ state: "compute_cap" });
  });

  it("customer-key model tokens of any size never move the compute total", async () => {
    const w = await world();
    const run = await review(w, sha("1"));
    await ledger(w.a.accountId, run, "model", 500);
    await ledger(w.a.accountId, run, "compute", 1);
    expect(await gate(w, sha("2"))).toEqual({ state: "dispatch" });
  });

  it("only verified production review compute counts: a sandbox repo's run, a runner run and another account do not", async () => {
    const w = await world();
    await ledger(w.a.accountId, await review(w, sha("1"), { mode: "sandbox" }), "compute", 50);
    await ledger(w.a.accountId, await review(w, sha("2"), { role: "executor", runtime: "runner" }), "compute", 50);
    const other = await world();
    await ledger(other.a.accountId, await review(other, sha("3")), "compute", 50);
    expect(await gate(w, sha("9"))).toEqual({ state: "dispatch" });
    expect(await gate(other, sha("3"))).toEqual({ state: "compute_cap" });
  });

  it("the month resets by itself: spend before the UTC month start does not count, spend at it does", async () => {
    const w = await world();
    const run = await review(w, sha("1"));
    const start = (await admin.query<{ s: Date }>("SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS s")).rows[0]!.s;
    await ledger(w.a.accountId, run, "compute", 40, new Date(start.getTime() - 1000));
    expect(await gate(w, sha("2"))).toEqual({ state: "dispatch" });
    await ledger(w.a.accountId, await review(w, sha("1"), { role: "debater" }), "compute", 5, start);
    expect(await gate(w, sha("2"))).toEqual({ state: "compute_cap" });
  });

  it("the round cap is checked first, and both caps apply to an account on our own subscription", async () => {
    const w = await world();
    const run = await review(w, sha("1"));
    await review(w, sha("2"));
    await review(w, sha("3"));
    await ledger(w.a.accountId, run, "compute", 9);
    expect(await gate(w, sha("4"))).toEqual({ state: "round_cap" });
    expect(await gate(w, sha("3"))).toEqual({ state: "compute_cap" });
    expect(await gate(w, sha("3"), true)).toEqual({ state: "compute_cap" });
  });

  it("fail closed: the figure lives in the database function, not an argument, the TS mirror equals it, and only an exact false dispatches", () => {
    const sql = readFileSync(path.join(here, "..", "..", "db", "migrations", "0773_verified_review_compute_cap.sql"), "utf8");
    expect(sql).toMatch(new RegExp(`COALESCE\\(SUM\\(l\\.usd\\), 0\\) >= ${VERIFIED_REVIEW_COMPUTE_CAP_USD}\\b`));
    expect(sql).toMatch(/verified_review_compute_capped\(p_account_id uuid\)/);
    const src = readFileSync(path.join(here, "..", "src", "verifiedReviewGate.ts"), "utf8");
    expect(src).toMatch(/capped !== false\) return \{ state: "compute_cap" \}/);
  });
});
