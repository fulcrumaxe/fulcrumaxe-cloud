import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdempotencyKeyTakenError, insertAgentRun } from "../src/runStatusWriter.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import type { ExecutionTarget, ExecutionTargetRegistry } from "../src/executionTarget.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#2 H17c-2b (R-ATOMIC) [pg]: `inCreateTransaction` runs inside insertAgentRun's own
 * transaction, right after the run row exists, so what it writes commits with the run
 * (and its idempotency claim) or not at all. The witness write is a `run_events` row
 * the callback adds for the run; an omitted callback leaves the create as it was.
 */
const HASH = "a".repeat(64);

describe("insertAgentRun / startAgentRun inCreateTransaction [pg]", () => {
  const db = pgHarness();

  async function world() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    return { accountId, repoId };
  }
  const params = (accountId: string, repoId: string) => ({
    id: randomUUID(),
    accountId,
    role: "code-reviewer" as const,
    runtime: "production" as const,
    executionMode: "sandbox",
    dispatchRepoId: repoId,
  });
  const witness = async (accountId: string, runId: string) =>
    Number((await db.admin.query("SELECT count(*) AS n FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = 'test.link'", [accountId, runId])).rows[0].n);
  const runRows = async (accountId: string, runId: string) =>
    Number((await db.admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND id = $2", [accountId, runId])).rows[0].n);
  const claims = async (accountId: string, key: string) =>
    Number((await db.admin.query("SELECT count(*) AS n FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [accountId, key])).rows[0].n);

  const link = (seen: { runVisible?: boolean; calls: number }, accountId: string) => async (client: import("pg").PoolClient, runId: string) => {
    seen.calls++;
    const r = await client.query("SELECT 1 FROM agent_runs WHERE id = $1 AND account_id = $2", [runId, accountId]);
    seen.runVisible = r.rows.length === 1;
    await client.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 900, 'test.link', '{}')", [accountId, runId]);
  };

  it("commits together: the callback sees the new run row on the same client, and its write survives with the run and the claim", async () => {
    const { accountId, repoId } = await world();
    const p = params(accountId, repoId);
    const seen = { calls: 0 } as { runVisible?: boolean; calls: number };
    const key = `k-${randomUUID()}`;
    await insertAgentRun(db.runWriterPool, { ...p, idempotency: { key, requestHash: HASH }, inCreateTransaction: link(seen, accountId) });
    expect(seen).toEqual({ calls: 1, runVisible: true });
    expect([await runRows(accountId, p.id), await witness(accountId, p.id), await claims(accountId, key)]).toEqual([1, 1, 1]);
  });

  it("rolls back together: a throw in the callback leaves no run row, no run.created event, no claim and no callback write", async () => {
    const { accountId, repoId } = await world();
    const p = params(accountId, repoId);
    const key = `k-${randomUUID()}`;
    const boom = new Error("link refused");
    await expect(
      insertAgentRun(db.runWriterPool, {
        ...p,
        idempotency: { key, requestHash: HASH },
        inCreateTransaction: async (client, runId) => {
          await link({ calls: 0 }, accountId)(client, runId);
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect([await runRows(accountId, p.id), await witness(accountId, p.id), await claims(accountId, key)]).toEqual([0, 0, 0]);
    expect(Number((await db.admin.query("SELECT count(*) AS n FROM run_events WHERE run_id = $1", [p.id])).rows[0].n)).toBe(0);
  });

  it("rolls back together the other way: a taken idempotency key undoes the callback's write too", async () => {
    const { accountId, repoId } = await world();
    const key = `k-${randomUUID()}`;
    const first = params(accountId, repoId);
    await insertAgentRun(db.runWriterPool, { ...first, idempotency: { key, requestHash: HASH } });
    const second = params(accountId, repoId);
    await expect(
      insertAgentRun(db.runWriterPool, { ...second, idempotency: { key, requestHash: HASH }, inCreateTransaction: link({ calls: 0 }, accountId) }),
    ).rejects.toBeInstanceOf(IdempotencyKeyTakenError);
    expect([await runRows(accountId, second.id), await witness(accountId, second.id)]).toEqual([0, 0]);
  });

  it("omitted, the create is what it always was: one run row, one run.created event, the claim, and nothing else", async () => {
    const { accountId, repoId } = await world();
    const p = params(accountId, repoId);
    const key = `k-${randomUUID()}`;
    await insertAgentRun(db.runWriterPool, { ...p, idempotency: { key, requestHash: HASH } });
    const events = await db.admin.query("SELECT seq, kind, payload FROM run_events WHERE run_id = $1 ORDER BY seq", [p.id]);
    expect(events.rows).toEqual([{ seq: "1", kind: "run.created", payload: { role: "code-reviewer" } }]);
    expect([await runRows(accountId, p.id), await claims(accountId, key)]).toEqual([1, 1]);
  });

  it("startAgentRun hands input.inCreateTransaction to the create, before admit; a throw there means admit and dispatch never run", async () => {
    const { accountId, repoId } = await world();
    const calls: string[] = [];
    const target: ExecutionTarget = {
      runtime: "production",
      admit: async () => {
        calls.push("admit");
        return { admitted: false, reason: "test" };
      },
      cancel: async () => {},
      finalize: async () => {},
      dispatch: async () => {
        calls.push("dispatch");
        return { hookToken: "t" };
      },
      resume: async () => ({ hookToken: "t" }),
    } as unknown as ExecutionTarget;
    const registry: ExecutionTargetRegistry = { sandbox: target };
    const base: StartAgentRunInput = {
      accountId,
      repoId,
      role: "code-reviewer",
      product: "team",
      roleCard: "c",
      prompt: "p",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    const seen = { calls: 0 } as { runVisible?: boolean; calls: number };
    const ok = await startAgentRun(db.runWriterPool, registry, { ...base, inCreateTransaction: link(seen, accountId) });
    expect(seen).toEqual({ calls: 1, runVisible: true });
    expect(calls).toEqual(["admit"]);
    expect(await witness(accountId, ok.id)).toBe(1);

    calls.length = 0;
    const before = Number((await db.admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1", [accountId])).rows[0].n);
    await expect(
      startAgentRun(db.runWriterPool, registry, {
        ...base,
        inCreateTransaction: async () => {
          throw new Error("no link");
        },
      }),
    ).rejects.toThrow("no link");
    expect(calls).toEqual([]);
    expect(Number((await db.admin.query("SELECT count(*) AS n FROM agent_runs WHERE account_id = $1", [accountId])).rows[0].n)).toBe(before);
  });
});
