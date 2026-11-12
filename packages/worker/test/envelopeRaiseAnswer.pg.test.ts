import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AskAnswerError, answerAsk } from "@fx/core/src/decisions/index.js";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { currentEnvelope, envelopeAdmits } from "@fx/spend";
import { createEnvelopeAsk } from "../src/envelopeAsk.js";
import { raiseItemEnvelope } from "../src/envelopeRaise.js";

/** Answering "raise the limit" on a spend_past_envelope ask writes the new envelope version, up to the figure the person was shown and no further. */
const INVOKER_LOGIN = "fx_envelope_raise_invoker_test";

describe("answering the envelope ask applies the raise [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool]) await p.end();
  });

  async function askedItem(a: SeedRefs, runUsd: number) {
    const itemId = randomUUID();
    const envelopeId = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 0.5, 1, $3)`, [envelopeId, a.accountId, a.userId]);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, envelope_id) VALUES ($1, $2, $3, 'issue', 'internal', 'spec_ready', $4)`, [itemId, a.accountId, a.repoId, envelopeId]);
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, ended_at) VALUES ($1, $2, $3, 'project-manager', 'local', 'succeeded', now())`, [runId, a.accountId, itemId]);
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 0.3, $2, 'model')`, [a.accountId, runId]);
    expect(await createEnvelopeAsk(receiptPool)({ accountId: a.accountId, workItemId: itemId, runUsd })).toBe("raised");
    const ask = (await admin.query(`SELECT id FROM decision_asks WHERE account_id = $1 AND work_item_id = $2 AND decision_type = 'spend_past_envelope'`, [a.accountId, itemId])).rows[0];
    return { itemId, envelopeId, askId: ask.id as string };
  }
  const versions = async (a: SeedRefs, envelopeId: string) => (await admin.query(`SELECT version, amount_usd::float AS amount, created_by FROM approval_envelopes WHERE account_id = $1 AND id = $2 ORDER BY version`, [a.accountId, envelopeId])).rows;
  const ctx = (a: SeedRefs, withRaiser = true) => ({ pool: receiptPool, principal: { accountId: a.accountId, userId: a.userId }, ...(withRaiser ? { envelopeRaise: raiseItemEnvelope } : {}) });

  it("writes the next version at the shown figure, authored by the person, and the next start is admitted", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await askedItem(a, 0.4);
    expect(await withTenant(receiptPool, a.accountId, (c) => envelopeAdmits(c, a.accountId, s.envelopeId, 0.4))).toBe(false);
    const out = await answerAsk(ctx(a), { askId: s.askId, choice: "raise_limit" });
    expect(out.answeredOption).toBe("raise_limit");
    expect(await versions(a, s.envelopeId)).toEqual([
      { version: 1, amount: 0.5, created_by: a.userId },
      { version: 2, amount: 0.7, created_by: a.userId },
    ]);
    expect(await withTenant(receiptPool, a.accountId, (c) => envelopeAdmits(c, a.accountId, s.envelopeId, 0.4))).toBe(true);
    const receipt = (await admin.query(`SELECT chosen FROM decision_receipts WHERE id = $1`, [out.receiptId])).rows[0];
    expect(receipt.chosen).toBe("raise_limit");
  });

  it("stopping the item raises nothing", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await askedItem(a, 0.4);
    await answerAsk(ctx(a), { askId: s.askId, choice: "stop_item" });
    expect((await versions(a, s.envelopeId)).map((v) => v.version)).toEqual([1]);
  });

  it("a figure above what the account can still spend is refused, nothing is written and the ask stays open", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await askedItem(a, 900_000);
    await expect(answerAsk(ctx(a), { askId: s.askId, choice: "raise_limit" })).rejects.toMatchObject({ status: 409, code: "raise_over_budget" });
    expect((await versions(a, s.envelopeId)).map((v) => v.version)).toEqual([1]);
    const ask = (await admin.query(`SELECT state FROM decision_asks WHERE id = $1`, [s.askId])).rows[0];
    expect(ask.state).toBe("open");
    expect((await admin.query(`SELECT 1 FROM decision_receipts WHERE work_item_id = $1 AND decision_type = 'spend_past_envelope'`, [s.itemId])).rows).toHaveLength(0);
  });

  it("without a raiser configured the raise is refused rather than recorded as a receipt that changes nothing", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await askedItem(a, 0.4);
    await expect(answerAsk(ctx(a, false), { askId: s.askId, choice: "raise_limit" })).rejects.toBeInstanceOf(AskAnswerError);
    expect((await versions(a, s.envelopeId)).map((v) => v.version)).toEqual([1]);
  });

  it("a limit lowered or voided after the question was asked makes the old question stale: refused, nothing written, ask untouched", async () => {
    for (const amount of [0.4, 0]) {
      const a = await seedAccount(admin, randomUUID());
      const s = await askedItem(a, 0.4);
      await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', $3, 2, $4)`, [s.envelopeId, a.accountId, amount, a.userId]);
      await expect(answerAsk(ctx(a), { askId: s.askId, choice: "raise_limit" })).rejects.toMatchObject({ status: 409, code: "raise_stale" });
      expect((await versions(a, s.envelopeId)).map((v) => v.version)).toEqual([1, 2]);
      expect((await admin.query(`SELECT state FROM decision_asks WHERE id = $1`, [s.askId])).rows[0].state).toBe("open");
      expect((await admin.query(`SELECT 1 FROM decision_receipts WHERE work_item_id = $1 AND decision_type = 'spend_past_envelope'`, [s.itemId])).rows).toHaveLength(0);
    }
  });

  it("a limit raised elsewhere since the question was asked is not lowered or doubled either", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await askedItem(a, 0.4);
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 2, 2, $3)`, [s.envelopeId, a.accountId, a.userId]);
    await expect(answerAsk(ctx(a), { askId: s.askId, choice: "raise_limit" })).rejects.toMatchObject({ code: "raise_stale" });
    const cur = await withTenant(receiptPool, a.accountId, (c) => currentEnvelope(c, a.accountId, s.envelopeId));
    expect(cur).toEqual({ amountUsd: 2, version: 2 });
  });

  it("writes the same envelope.changed audit row a settings edit writes: both versions, both amounts, the envelope", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await askedItem(a, 0.4);
    await answerAsk(ctx(a), { askId: s.askId, choice: "raise_limit" });
    const rows = (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'envelope.changed'`, [a.accountId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ envelope_id: s.envelopeId, scope: "item", from_version: 1, to_version: 2, from: 0.5, to: 0.7 });
    expect(rows[0].actor).toBe(a.userId);
  });

  it("losing the race for the next version to a settings edit answers 409 raise_conflict and writes nothing", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await askedItem(a, 0.4);
    const lost: typeof raiseItemEnvelope = async () => "conflict";
    await expect(answerAsk({ ...ctx(a), envelopeRaise: lost }, { askId: s.askId, choice: "raise_limit" })).rejects.toMatchObject({ status: 409, code: "raise_conflict" });
    expect((await versions(a, s.envelopeId)).map((v) => v.version)).toEqual([1]);
  });

  it("two asks on one item at different versions: the old one is refused, the current one applies", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await askedItem(a, 0.4);
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 0.6, 2, $3)`, [s.envelopeId, a.accountId, a.userId]);
    expect(await createEnvelopeAsk(receiptPool)({ accountId: a.accountId, workItemId: s.itemId, runUsd: 0.5 })).toBe("raised");
    const newer = (await admin.query(`SELECT id FROM decision_asks WHERE account_id = $1 AND work_item_id = $2 AND id <> $3`, [a.accountId, s.itemId, s.askId])).rows[0].id as string;
    await expect(answerAsk(ctx(a), { askId: s.askId, choice: "raise_limit" })).rejects.toMatchObject({ status: 409, code: "raise_stale" });
    expect((await versions(a, s.envelopeId)).map((v) => v.version)).toEqual([1, 2]);
    await answerAsk(ctx(a), { askId: newer, choice: "raise_limit" });
    expect((await versions(a, s.envelopeId)).map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it("an item moved to a different envelope whose version equals the old ask's: refused", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await askedItem(a, 0.4);
    const other = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 0.5, 1, $3)`, [other, a.accountId, a.userId]);
    await admin.query(`UPDATE work_items SET envelope_id = $1 WHERE id = $2`, [other, s.itemId]);
    await expect(answerAsk(ctx(a), { askId: s.askId, choice: "raise_limit" })).rejects.toMatchObject({ status: 409, code: "raise_stale" });
    expect((await versions(a, other)).map((v) => v.version)).toEqual([1]);
    expect((await versions(a, s.envelopeId)).map((v) => v.version)).toEqual([1]);
  });

  it("a void or edit that commits on another connection between the check and the write is not overwritten: raise_conflict, nothing written, no audit row", async () => {
    for (const amount of [0, 0.45]) {
      const a = await seedAccount(admin, randomUUID());
      const s = await askedItem(a, 0.4);
      let injected = false;
      const racing: typeof raiseItemEnvelope = async (client, facts) => {
        const proxy = new Proxy(client, {
          get(target, prop, recv) {
            if (prop !== "query") return Reflect.get(target, prop, recv);
            return async (sql: unknown, ...rest: unknown[]) => {
              if (!injected && typeof sql === "string" && sql.startsWith("SELECT scope, repo_id FROM approval_envelopes")) {
                injected = true;
                // Another admin changes the limit in Settings; it commits on its own connection while the answer's transaction is open.
                await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', $3, 2, $4)`, [s.envelopeId, a.accountId, amount, a.userId]);
              }
              return (target.query as (...x: unknown[]) => unknown).call(target, sql, ...rest);
            };
          },
        });
        return raiseItemEnvelope(proxy as PoolClient, facts);
      };
      await expect(answerAsk({ ...ctx(a), envelopeRaise: racing }, { askId: s.askId, choice: "raise_limit" })).rejects.toMatchObject({ status: 409, code: "raise_conflict" });
      expect(injected).toBe(true);
      expect(await versions(a, s.envelopeId)).toEqual([
        { version: 1, amount: 0.5, created_by: a.userId },
        { version: 2, amount, created_by: a.userId },
      ]);
      expect((await admin.query(`SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'envelope.changed'`, [a.accountId])).rows).toHaveLength(0);
      expect((await admin.query(`SELECT state FROM decision_asks WHERE id = $1`, [s.askId])).rows[0].state).toBe("open");
    }
  });
});
