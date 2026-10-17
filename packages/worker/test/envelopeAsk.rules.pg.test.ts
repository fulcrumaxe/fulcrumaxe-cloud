import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createEnvelopeAsk } from "../src/envelopeAsk.js";

/** D#7 AAP-a4 [pg]: the customer's approval rules at the spend_past_envelope raise site. Real Postgres as the real roles. */
const INVOKER_LOGIN = "fx_envelope_rules_invoker_test";
type Rule = { id: string; outcome: "approve" | "deny" | "ask"; when: unknown };
const ANY = { op: "exists", field: "/facts/spent_usd" };
const DENY_ALL: Rule[] = [{ id: "stop-asking", outcome: "deny", when: ANY }];

describe("the spend_past_envelope ask under approval rules [pg]", { timeout: 60_000 }, () => {
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

  async function writeRules(a: SeedRefs, repoId: string | null, rules: Rule[]): Promise<number> {
    const json = JSON.stringify({ rules });
    const { rows } = await admin.query(
      `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by)
       VALUES ($1, $2, (SELECT COALESCE(MAX(version), 0) + 1 FROM action_rules WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2), $3::jsonb, $4,
               encode(sha256(convert_to($3::jsonb::text, 'UTF8')), 'hex'), $5) RETURNING version`,
      [a.accountId, repoId, json, rules.length, a.userId],
    );
    return rows[0].version;
  }
  async function setup(a: SeedRefs, opts: { amount?: number; repoId?: string | null } = {}) {
    const itemId = randomUUID();
    const envelopeId = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', $3, 1, $4)`, [envelopeId, a.accountId, opts.amount ?? 1.5, a.userId]);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, envelope_id) VALUES ($1, $2, $3, 'issue', 'internal', 'spec_ready', $4)`, [itemId, a.accountId, opts.repoId === undefined ? a.repoId : opts.repoId, envelopeId]);
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, ended_at) VALUES ($1, $2, $3, 'project-manager', 'local', 'succeeded', now())`, [runId, a.accountId, itemId]);
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 1.234, $2, 'model')`, [a.accountId, runId]);
    return { itemId, envelopeId, runId };
  }
  const asks = async (a: SeedRefs, itemId: string) => (await admin.query(`SELECT * FROM decision_asks WHERE account_id = $1 AND work_item_id = $2 ORDER BY raised_at`, [a.accountId, itemId])).rows;
  const memory = async (a: SeedRefs, itemId: string) => (await admin.query(`SELECT * FROM envelope_pause_asks WHERE account_id = $1 AND work_item_id = $2 ORDER BY envelope_version`, [a.accountId, itemId])).rows;
  const receipts = async (a: SeedRefs, itemId: string) => (await admin.query(`SELECT * FROM decision_receipts WHERE account_id = $1 AND work_item_id = $2 ORDER BY created_at`, [a.accountId, itemId])).rows;
  const call = (a: SeedRefs, itemId: string, extra: object = {}) => createEnvelopeAsk(receiptPool)({ accountId: a.accountId, workItemId: itemId, runUsd: 0.411, ...extra } as never);

  it("no rules: the ask is raised exactly as before, with version 0 and no receipt", async () => {
    const a = await seedAccount(admin, randomUUID());
    const s = await setup(a);
    expect(await call(a, s.itemId)).toBe("raised");
    const rows = await asks(a, s.itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rule_set_version: 0, state: "open", proposed: "raise_limit" });
    expect(await receipts(a, s.itemId)).toHaveLength(0);
    expect(await memory(a, s.itemId)).toMatchObject([{ ask_id: rows[0].id, receipt_id: null }]);
  });

  it("a deny rule: no ask, one memory row with a receipt (policy, rule id, version), the item stays paused; a second denial writes nothing; a raise asks again", async () => {
    const a = await seedAccount(admin, randomUUID());
    await writeRules(a, null, [{ id: "other", outcome: "approve", when: { op: "equals", field: "/facts/repo", value: "no/such" } }]);
    const v = await writeRules(a, null, DENY_ALL);
    const s = await setup(a);
    expect(await call(a, s.itemId)).toBe("denied_by_rule");
    expect(await asks(a, s.itemId)).toHaveLength(0);
    const rc = await receipts(a, s.itemId);
    expect(rc).toHaveLength(1);
    expect(rc[0]).toMatchObject({ actor: "policy", chosen: "deny", rule_id: "stop-asking", rule_set_version: v, decision_type: "spend_past_envelope", run_id: s.runId });
    expect(await memory(a, s.itemId)).toMatchObject([{ ask_id: null, receipt_id: rc[0].id, envelope_version: 1 }]);
    // paused, not cancelled
    expect((await admin.query(`SELECT stage, halted_at FROM work_items WHERE id = $1`, [s.itemId])).rows[0]).toMatchObject({ stage: "spec_ready", halted_at: null });
    // a second denial under the same envelope version evaluates nothing and writes nothing
    for (let i = 0; i < 3; i += 1) expect(await call(a, s.itemId)).toBe("already_asked");
    expect(await receipts(a, s.itemId)).toHaveLength(1);
    expect(await memory(a, s.itemId)).toHaveLength(1);
    // the person raises the envelope: a new version is a new question, evaluated again
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 1.6, 2, $3)`, [s.envelopeId, a.accountId, a.userId]);
    expect(await call(a, s.itemId)).toBe("denied_by_rule");
    expect(await receipts(a, s.itemId)).toHaveLength(2);
    // with the rule removed (an empty new version), the next version asks as usual
    await writeRules(a, null, []);
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, scope, amount_usd, version, created_by) VALUES ($1, $2, 'item', 1.7, 3, $3)`, [s.envelopeId, a.accountId, a.userId]);
    expect(await call(a, s.itemId)).toBe("raised");
  });

  it("a tightening rule is applied (ask stays ask, version recorded); a loosening rule is ignored", async () => {
    const a = await seedAccount(admin, randomUUID());
    const vAsk = await writeRules(a, null, [{ id: "always-ask", outcome: "ask", when: ANY }]);
    const s1 = await setup(a);
    expect(await call(a, s1.itemId)).toBe("raised");
    expect((await asks(a, s1.itemId))[0].rule_set_version).toBe(vAsk);
    const b = await seedAccount(admin, randomUUID());
    const vApprove = await writeRules(b, null, [{ id: "approve-all", outcome: "approve", when: ANY }]);
    const s2 = await setup(b);
    expect(await call(b, s2.itemId)).toBe("raised");
    const rows = await asks(b, s2.itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0].rule_set_version).toBe(vApprove);
    expect(await receipts(b, s2.itemId)).toHaveLength(0);
  });

  it("a rule set that cannot be trusted (invalid, over budget) asks and never denies", async () => {
    const a = await seedAccount(admin, randomUUID());
    // a stored set that the current validator refuses: written raw, past the writer's validation
    await admin.query(
      `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by) VALUES ($1, NULL, 1, '{"rules":[{"id":"bad","outcome":"deny","when":{"op":"nope"}}]}'::jsonb, 1, encode(sha256(convert_to('{"rules":[{"id":"bad","outcome":"deny","when":{"op":"nope"}}]}'::jsonb::text, 'UTF8')), 'hex'), $2)`,
      [a.accountId, a.userId],
    );
    const s = await setup(a);
    expect(await call(a, s.itemId)).toBe("raised");
    expect((await asks(a, s.itemId))[0].rule_set_version).toBe(1);
  });

  it("the facts equal the ask's own figures to the cent: spent 1.234, limit 1.50, next run 0.411 give 1.24, 1.5, 0.42, 1.65", async () => {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    const all = (fields: [string, unknown][]) => ({ op: "all", of: fields.map(([f, value]) => ({ op: "equals", field: `/facts/${f}`, value })) });
    await writeRules(a, null, [{ id: "exact-facts", outcome: "deny", when: all([["spent_usd", 1.24], ["limit_usd", 1.5], ["next_run_usd", 0.42], ["proposed_limit_usd", 1.65], ["repo", "acme/widgets"]]) }]);
    const s = await setup(a);
    expect(await call(a, s.itemId)).toBe("denied_by_rule");
    const request = await writeRulesAndCheckRequest(a);
    expect(request).toBe("denied_by_rule");
  });

  // a platform ask has the fixed request: a rule on the tool, server and instance matches; one on arguments never does
  async function writeRulesAndCheckRequest(a: SeedRefs): Promise<string> {
    const b = await seedAccount(admin, randomUUID());
    await writeRules(b, null, [
      { id: "on-args", outcome: "deny", when: { op: "exists", field: "/request/arguments/anything" } },
      { id: "on-platform", outcome: "deny", when: { op: "all", of: [{ op: "equals", field: "/request/tool", value: "spend_past_envelope" }, { op: "equals", field: "/request/server", value: "platform" }, { op: "equals", field: "/instance/name", value: "platform" }] } },
    ]);
    const s = await setup(b);
    expect(await call(b, s.itemId)).toBe("denied_by_rule");
    expect((await receipts(b, s.itemId))[0].rule_id).toBe("on-platform");
    void a;
    return "denied_by_rule";
  }

  it("rules are resolved repo first, then the account's, from the item's own row; a forged repo id from the caller is ignored", async () => {
    const a = await seedAccount(admin, randomUUID());
    const repoB = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 2, 'team')`, [repoB, a.accountId, a.installationId]);
    await writeRules(a, null, DENY_ALL); // the account denies everywhere
    const vRepo = await writeRules(a, a.repoId, [{ id: "approve-here", outcome: "approve", when: ANY }]); // repo A overrides the account
    // item in repo A uses A's set (an approve, so it asks), not the account's deny
    const inA = await setup(a);
    expect(await call(a, inA.itemId)).toBe("raised");
    expect((await asks(a, inA.itemId))[0].rule_set_version).toBe(vRepo);
    // item in repo B has no repo set: the account set (deny) applies
    const inB = await setup(a, { repoId: repoB });
    expect(await call(a, inB.itemId)).toBe("denied_by_rule");
    // item with no repo: the account set
    const none = await setup(a, { repoId: null });
    expect(await call(a, none.itemId)).toBe("denied_by_rule");
    // a caller that claims repo B for an item in repo A cannot change which set decides
    const forged = await setup(a);
    expect(await call(a, forged.itemId, { repoId: repoB, repo_id: repoB })).toBe("raised");
    expect((await asks(a, forged.itemId))[0].rule_set_version).toBe(vRepo);
  });
});
