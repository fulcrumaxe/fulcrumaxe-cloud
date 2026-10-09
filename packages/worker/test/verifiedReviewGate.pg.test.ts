import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createAdvanceModule } from "../src/advance.js";
import { QUIET_PERIOD_MS, readVerifiedReviewGate, type VerifiedReviewGate } from "../src/verifiedReviewGate.js";

const MIN = 60_000;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);
const PR = 41;

/**
 * D#6 R5b-2a (C38 section 1, acceptance 1, 3 and 4) [pg]: when the reviewers of a cloud-verified pull request may start. The clock is a
 * parameter: the executor's end is read back from its row and every push is moved to an exact offset from it, so each case is a fixed timeline.
 */
describe("cloud-verified reviews: the quiet period, the key and the mode [pg]", { timeout: 60_000 }, () => {
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

  /** A verified repo with one work item whose executor run ended at the returned time (T). The seeded account holds a model connection. */
  async function world(endStatus = "succeeded"): Promise<{ a: SeedRefs; workItemId: string; t: Date }> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_verified' WHERE id = $1", [a.repoId]);
    // The seed's own run is a live executor: it ends first, so the run made below is the later one in every timeline.
    await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [a.runId]);
    const runId = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, execution_mode, status) VALUES ($1, $2, $3, 'executor', 'runner', 'runner_verified', 'running')", [runId, a.accountId, a.workItemId]);
    await admin.query("UPDATE agent_runs SET status = $2 WHERE id = $1", [runId, endStatus]);
    const t = (await admin.query<{ ended_at: Date }>("SELECT ended_at FROM agent_runs WHERE id = $1", [runId])).rows[0]!.ended_at ?? new Date();
    return { a, workItemId: a.workItemId, t };
  }

  /** A push to the pull request at T + `minutes`, as the webhook records it (the row's time is the database clock; the test moves it to the exact offset). */
  async function push(w: { a: SeedRefs; workItemId: string; t: Date }, sha: string, minutes: number): Promise<void> {
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'pr_head_pushed', 'synchronize', $3, $4, $5)", [w.a.accountId, w.workItemId, sha, PR, `push:${sha}`]);
    await admin.query("UPDATE work_item_driver_events SET created_at = $3 WHERE account_id = $1 AND dedupe_key = $2", [w.a.accountId, `push:${sha}`, new Date(w.t.getTime() + minutes * MIN)]);
  }

  const gate = (w: { a: SeedRefs; workItemId: string; t: Date }, atMinutes: number, headSha = HEAD_A, seenHead: string | null = null, isOperatorAccount?: (id: string) => boolean): Promise<VerifiedReviewGate> =>
    readVerifiedReviewGate(writerPool, { accountId: w.a.accountId, workItemId: w.workItemId, prNumber: PR, headSha, seenHead, now: new Date(w.t.getTime() + atMinutes * MIN), ...(isOperatorAccount ? { isOperatorAccount } : {}) });
  const waiting = (g: VerifiedReviewGate): number => (g.state === "wait" ? g.waitMs : -1);

  it("the quiet period is ten minutes", () => {
    expect(QUIET_PERIOD_MS).toBe(10 * MIN);
  });

  it("acceptance 1: done at T, a push at T+4 gives dispatch at T+14 and not before; a second push at T+12 moves it to T+22", async () => {
    const w = await world();
    // No push yet: the executor's end alone gives T+10.
    expect(await gate(w, 9.5)).toMatchObject({ state: "wait" });
    expect(await gate(w, 10)).toEqual({ state: "dispatch" });

    await push(w, HEAD_A, 4);
    expect(waiting(await gate(w, 13))).toBe(MIN); // 1 minute left
    expect(await gate(w, 13.99)).toMatchObject({ state: "wait" });
    expect(await gate(w, 14)).toEqual({ state: "dispatch" });

    await push(w, HEAD_B, 12);
    expect(await gate(w, 14, HEAD_B)).toMatchObject({ state: "wait" });
    expect(waiting(await gate(w, 15, HEAD_B))).toBe(7 * MIN);
    expect(await gate(w, 21.99, HEAD_B)).toMatchObject({ state: "wait" });
    expect(await gate(w, 22, HEAD_B)).toEqual({ state: "dispatch" });
  });

  it.each(["failed", "timed_out", "cancelled", "killed_spend"])("an executor run that ended %s counts like a finished one: the review waits until its end + 10 minutes (it may have pushed first)", async (status) => {
    const w = await world(status);
    expect(await gate(w, 9.5)).toMatchObject({ state: "wait" });
    expect(waiting(await gate(w, 9))).toBe(MIN);
    expect(await gate(w, 10)).toEqual({ state: "dispatch" });
  });

  it("while an executor run is still pending or running nothing is reviewed, however old the last push is", async () => {
    for (const status of ["running", "pending"]) {
      const w = await world(status);
      await push(w, HEAD_A, 1);
      expect(await gate(w, 60), status).toEqual({ state: "wait", waitMs: QUIET_PERIOD_MS });
    }
  });

  it("an older succeeded run does not hide a newer failed one", async () => {
    const w = await world();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, execution_mode, status) VALUES ($1, $2, $3, 'executor', 'runner', 'runner_verified', 'running')", [randomUUID(), w.a.accountId, w.workItemId]);
    const newer = (await admin.query<{ id: string }>("SELECT id FROM agent_runs WHERE work_item_id = $1 AND status = 'running'", [w.workItemId])).rows[0]!.id;
    await admin.query("UPDATE agent_runs SET status = 'failed' WHERE id = $1", [newer]);
    const end = (await admin.query<{ ended_at: Date }>("SELECT ended_at FROM agent_runs WHERE id = $1", [newer])).rows[0]!.ended_at;
    const skew = (end.getTime() - w.t.getTime()) / MIN; // the two ended moments apart; the later one decides
    expect(await gate(w, skew + 9.9)).toMatchObject({ state: "wait" });
    expect(await gate(w, skew + 10)).toEqual({ state: "dispatch" });
  });

  it("a push back to a head seen before is a new push: A, then B, then A again restarts the ten minutes at the third", async () => {
    const w = await world();
    // The driver sees A, then B (a push), then A (a force-push back): each change is its own fact.
    expect((await gate(w, 1, HEAD_A, null)).state).toBe("wait");
    await gate(w, 1, HEAD_B, HEAD_A);
    await gate(w, 1, HEAD_A, HEAD_B);
    const rows = (await admin.query("SELECT dedupe_key, head_sha FROM work_item_driver_events WHERE account_id = $1 AND kind = 'pr_head_pushed' ORDER BY seq", [w.a.accountId])).rows;
    expect(rows.map((r) => r.dedupe_key)).toEqual([`observed:${HEAD_A}..${HEAD_B}`, `observed:${HEAD_B}..${HEAD_A}`]);
    // Move the three pushes to T+1, T+5 and T+9 and ask at T+15: the third push, back to A, is only six minutes old.
    await admin.query("UPDATE work_item_driver_events SET created_at = $2 WHERE account_id = $1 AND dedupe_key = $3", [w.a.accountId, new Date(w.t.getTime() + 5 * MIN), rows[0]!.dedupe_key]);
    await admin.query("UPDATE work_item_driver_events SET created_at = $2 WHERE account_id = $1 AND dedupe_key = $3", [w.a.accountId, new Date(w.t.getTime() + 9 * MIN), rows[1]!.dedupe_key]);
    expect(await gate(w, 15, HEAD_A, HEAD_A)).toMatchObject({ state: "wait" });
    expect(await gate(w, 19, HEAD_A, HEAD_A)).toEqual({ state: "dispatch" });
  });

  it("several connections: a usable one is found whatever the row order (ok, then unvalidated, then broken)", async () => {
    const w = await world();
    await admin.query("UPDATE model_connections SET status = 'broken' WHERE account_id = $1", [w.a.accountId]);
    await admin.query("INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint) VALUES ($1, 'anthropic', $2, $3, $4, 1, $5)", [w.a.accountId, Buffer.from("c"), Buffer.from("n"), Buffer.from("w"), `fp-${randomUUID()}`]);
    expect((await gate(w, 11)).state).toBe("dispatch");
  });

  it("a wait never exceeds the whole period", async () => {
    const w = await world();
    expect(waiting(await gate(w, 0))).toBe(QUIET_PERIOD_MS);
    expect(waiting(await gate(w, -30))).toBe(QUIET_PERIOD_MS);
  });

  it("a push the webhook has not told us about (the head differs from the last one seen) is recorded as of now and restarts the period; once recorded it is not recorded twice", async () => {
    const w = await world();
    expect(await gate(w, 20, HEAD_A, null)).toEqual({ state: "dispatch" });
    const before = Date.now();
    const moved = await gate(w, 1, HEAD_C, HEAD_A);
    expect(moved.state).toBe("wait");
    const rows = (await admin.query("SELECT code, head_sha, pr_number, created_at FROM work_item_driver_events WHERE account_id = $1 AND kind = 'pr_head_pushed'", [w.a.accountId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "observed", head_sha: HEAD_C, pr_number: PR });
    expect(new Date(rows[0].created_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    await gate(w, 1, HEAD_C, HEAD_A);
    expect((await admin.query("SELECT 1 FROM work_item_driver_events WHERE account_id = $1 AND kind = 'pr_head_pushed'", [w.a.accountId])).rowCount).toBe(1);
  });

  it("a push to another pull request does not move this one's period", async () => {
    const w = await world();
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'pr_head_pushed', $3, 99, 'push:other')", [w.a.accountId, w.workItemId, HEAD_B]);
    await admin.query("UPDATE work_item_driver_events SET created_at = $2 WHERE dedupe_key = 'push:other' AND account_id = $1", [w.a.accountId, new Date(w.t.getTime() + 8 * MIN)]);
    expect(await gate(w, 10)).toEqual({ state: "dispatch" });
  });

  it("acceptance 3: with no connection, or a broken one, nothing is dispatched; the answer is review_key_missing and no reservation exists. Reconnecting dispatches on the next check", async () => {
    const w = await world();
    const state = async () => (await gate(w, 11)).state;
    const reservations = async () => (await admin.query("SELECT count(*)::int AS n FROM spend_reservations WHERE account_id = $1", [w.a.accountId])).rows[0].n as number;
    const seeded = await reservations(); // the seed leaves one row of its own; the gate adds none
    expect(await state()).toBe("dispatch");

    await admin.query("UPDATE model_connections SET status = 'broken' WHERE account_id = $1", [w.a.accountId]);
    expect(await state()).toBe("key_missing");
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [w.a.accountId]);
    expect(await state()).toBe("dispatch");

    await admin.query("DELETE FROM model_connections WHERE account_id = $1", [w.a.accountId]);
    expect(await state()).toBe("key_missing");
    expect(await reservations()).toBe(seeded);
    // An account on our own subscription needs no connection.
    expect((await gate(w, 11, HEAD_A, null, () => true)).state).toBe("dispatch");
    expect((await gate(w, 11, HEAD_A, null, () => false)).state).toBe("key_missing");
  });

  it("the period is checked before the key: a repo with no key still waits out its quiet period", async () => {
    const w = await world();
    await admin.query("DELETE FROM model_connections WHERE account_id = $1", [w.a.accountId]);
    expect((await gate(w, 3)).state).toBe("wait");
    expect((await gate(w, 10)).state).toBe("key_missing");
  });

  it("acceptance 4: a repo that left the mode before the due time is no longer verified, and the answer names the mode it is in now", async () => {
    const w = await world();
    expect((await gate(w, 3)).state).toBe("wait");
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [w.a.repoId]);
    expect(await gate(w, 3)).toEqual({ state: "not_verified", executionMode: "runner_local" });
    await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [w.a.repoId]);
    expect(await gate(w, 30)).toEqual({ state: "not_verified", executionMode: "sandbox" });
  });

  it("a tenant sees only its own rows: another account's push and key are not this account's", async () => {
    const w = await world();
    const other = await world();
    await push(other, HEAD_B, 9);
    await admin.query("DELETE FROM model_connections WHERE account_id = $1", [other.a.accountId]);
    expect(await gate(w, 10)).toEqual({ state: "dispatch" });
    expect(await gate(other, 10)).toMatchObject({ state: "wait" });
    expect(await gate(other, 20)).toEqual({ state: "key_missing" });
  });
  it("the facade method guards its input and the item like every other step, then answers the gate", async () => {
    const w = await world();
    const module = createAdvanceModule(writerPool, { starter: null, resolveRunSeat: async () => ({ ok: false, reason: "no_card" }), startAdvance: null, triage: null });
    const who = { accountId: w.a.accountId, userId: w.a.userId, workItemId: w.workItemId, haltEpoch: 0 };
    const ask = (over: Partial<{ prNumber: number; headSha: string; seenHead: string | null }> = {}, as = who) => module.advanceVerifiedReviewGate(as, { prNumber: PR, headSha: HEAD_A, seenHead: null, ...over });
    expect(await ask()).toMatchObject({ state: "wait" });
    expect(await ask({ prNumber: 0 })).toEqual({ state: "refused", reason: "invalid_input" });
    expect(await ask({ headSha: "HEAD" })).toEqual({ state: "refused", reason: "invalid_input" });
    expect(await ask({ seenHead: "x" })).toEqual({ state: "refused", reason: "invalid_input" });
    expect(await ask({}, { ...who, haltEpoch: 1 })).toEqual({ state: "refused", reason: "halted_since_approval" });
    expect(await ask({}, { ...who, workItemId: randomUUID() })).toEqual({ state: "refused", reason: "target_not_found" });
    await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [w.a.repoId]);
    expect(await ask()).toEqual({ state: "not_verified", executionMode: "sandbox" });
  });
  it("the customer's key never passes through the gate: it reads the connection's status and nothing sealed, logs nothing, and the verified routing file touches no key either", () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const gate = readFileSync(path.join(src, "worker", "src", "verifiedReviewGate.ts"), "utf8");
    const routing = readFileSync(path.join(src, "runner", "src", "targets", "verifiedTarget.ts"), "utf8");
    for (const text of [gate, routing]) expect(text).not.toMatch(/key_ciphertext|key_nonce|wrapped_dek|decrypt|apiKey|api_key|console\./);
    expect(gate).toMatch(/SELECT status FROM model_connections/);
    // The facade's one log line carries the item, the pull request and the state word.
    const facade = readFileSync(path.join(src, "worker", "src", "advance.ts"), "utf8");
    expect(/event: "advance\.verified_review_gate"[^\n]*/.exec(facade)![0]).toBe('event: "advance.verified_review_gate", work_item_id: who.workItemId, pr: input.prNumber, state: out.state }));');
  });
});
