import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { writeReceipt } from "@fx/db/src/receiptWriter.js";
import { writeRunStatus } from "@fx/runner";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import type { MemoryEntry } from "../../src/prompt/assemblePrompt.js";
import { createMemoryPort, guardMemoryPort, type RecallSkip } from "../../src/prompt/memoryRecall.js";

/**
 * D#601 MEM-RECALL-RESCAN [pg]: the item's own records (applied correction notes, the latest handoff note) and promoted receipts are re-checked as well as
 * ordinary entries, each skipped record is counted once and in the slot that would have used it, and the text the prompt would really hold is checked, not
 * only the stored columns. The live values here are not token-shaped: the checkpoint writer already redacts shapes, so only a live-value match can reach these rows.
 */
const h = pgHarness();
let receiptPool: Pool;
const INVOKER_LOGIN = "fx_receipt_invoker_rescan_test";
const LIVE = ["plainLive", "ValueXYZ0123456789abcdefgh"].join("");
const RECEIPT_LIVE = ["pick", "abcdefghijklmnopqrstuvwxyz0123"].join("_");

beforeAll(async () => {
  await h.admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
    CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
  await h.admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
  const u = new URL(process.env.PIPELINE_DATABASE_URL_APP_USER!);
  u.username = INVOKER_LOGIN;
  u.password = "";
  receiptPool = createPool(u.toString());
});
afterAll(async () => {
  await receiptPool.end();
});

interface World {
  accountId: string;
  repoId: string;
  itemId: string;
  adminId: string;
}

async function world(): Promise<World> {
  const accountId = randomUUID();
  const repoId = randomUUID();
  const itemId = randomUUID();
  await seedAccount(h.admin, accountId);
  await seedRepo(h.admin, accountId, repoId);
  await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [repoId]);
  await seedWorkItem(h.admin, accountId, itemId, repoId, { ghNumber: 41 });
  const adminId = randomUUID();
  await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [adminId, `${adminId}@example.test`]);
  await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [accountId, adminId]);
  return { accountId, repoId, itemId, adminId };
}

async function putNote(w: World, body: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(
    `INSERT INTO work_item_corrections (id, account_id, work_item_id, origin, kind, body, status, decided_via, content_hash, decided_at, applied_at, applied_run_id)
     VALUES ($1, $2, $3, 'person', 'run_note', $4, 'applied', 'workspace', encode(sha256(convert_to($4, 'UTF8')), 'hex'), now(), now(), NULL)`,
    [id, w.accountId, w.itemId, body],
  );
  return id;
}

/** A cloud run that checkpointed through the real status writer, with a handoff row taken through the legal edges to `handed_off`. */
async function putHandoff(w: World, summary: string): Promise<void> {
  const runId = randomUUID();
  await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [runId, w.accountId, w.itemId]);
  await writeRunStatus(h.runWriterPool, { accountId: w.accountId, runId, from: "running", to: "timed_out", checkpoint: { reason: "agent_checkpoint", summary, ccSessionId: null, meteredUsd: 1, extensionsUsed: 0 } });
  await h.admin.query(
    `INSERT INTO run_handoffs (account_id, run_id, item_id, from_side, to_side, deadline, reserve_until, requested_by) VALUES ($1, $2, $3, 'cloud', 'runner', now(), now(), $4)`,
    [w.accountId, runId, w.itemId, w.adminId],
  );
  for (const s of ["checkpointing", "handed_off"]) await h.admin.query("UPDATE run_handoffs SET state = $2 WHERE run_id = $1", [runId, s]);
}

async function promoteReceipt(w: World, chosen: string): Promise<string> {
  const runId = randomUUID();
  await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [runId, w.accountId, w.itemId]);
  const r = await withTenant(receiptPool, w.accountId, w.adminId, (c) =>
    writeReceipt(c, { class: "human_over_the_loop", runId, workItemId: w.itemId, decisionType: "test_strategy_choice", chosen, rejectedAlternative: "none", dialVersion: 4, quotedInputs: [{ trust: "trusted", storedBody: "plain" }] }),
  );
  if (r.store !== "decision_receipts") throw new Error("store");
  return withTenant(h.pureAppUserPool, w.accountId, w.adminId, async (c) => (await c.query<{ r: string }>("SELECT memory_promote_receipt($1::uuid, $2::uuid) AS r", [w.accountId, r.id])).rows[0]!.r);
}

function recallWith(w: World, slot: "stable" | "item", secrets: string[]) {
  const skips: RecallSkip[] = [];
  const port = createMemoryPort(h.runWriterPool, { onSkip: (s) => skips.push(s), liveSecrets: () => secrets });
  return { skips, run: (): Promise<readonly MemoryEntry[]> => port.recall({ accountId: w.accountId, repoId: w.repoId, workItemId: w.itemId, role: "executor", slot }) };
}
const rescans = (skips: readonly RecallSkip[]): RecallSkip[] => skips.filter((s) => s.reason === "secret_rescan");

describe("recall re-checks the item's records and promoted receipts (D#601 MEM-RECALL-RESCAN)", () => {
  it("leaves out a correction note and a handoff note holding a live value, counts each once in the item slot, and counts none in the stable slot", async () => {
    const w = await world();
    const ok = await putNote(w, "keep the migration order");
    const bad = await putNote(w, `use ${LIVE} please`);
    await putHandoff(w, `continue with ${LIVE}`);
    const item = recallWith(w, "item", [LIVE]);
    const got = await item.run();
    expect(got.map((e) => e.id)).toEqual([`correction:${ok}`]);
    expect(JSON.stringify(got)).not.toContain(LIVE);
    expect(rescans(item.skips)).toHaveLength(2);
    expect(item.skips.map((s) => s.id)).toContain(bad);
    const stable = recallWith(w, "stable", [LIVE]);
    await stable.run();
    expect(rescans(stable.skips)).toEqual([]);
  });

  it("recalls the same notes and handoff when no live value matches", async () => {
    const w = await world();
    await putNote(w, `use ${LIVE} please`);
    await putHandoff(w, `continue with ${LIVE}`);
    const r = recallWith(w, "item", []);
    expect((await r.run()).filter((e) => e.source !== undefined)).toHaveLength(2);
    expect(rescans(r.skips)).toEqual([]);
  });

  it("leaves out a promoted receipt whose chosen text now matches a live value, in the stable slot only, counted once", async () => {
    const w = await world();
    const entryId = await promoteReceipt(w, RECEIPT_LIVE);
    const stable = recallWith(w, "stable", [RECEIPT_LIVE]);
    expect(await stable.run()).toEqual([]);
    expect(rescans(stable.skips)).toEqual([{ id: entryId, reason: "secret_rescan" }]);
    const item = recallWith(w, "item", [RECEIPT_LIVE]);
    await item.run();
    expect(rescans(item.skips)).toEqual([]);
    expect((await recallWith(w, "stable", []).run()).map((e) => e.id)).toEqual([entryId]);
  });

  it("leaves out a promoted receipt whose entry body holds a live value", async () => {
    const w = await world();
    const entryId = await promoteReceipt(w, "pick_a_plain_option");
    await h.admin.query("ALTER TABLE memory_entries DISABLE TRIGGER USER");
    try {
      await h.admin.query("UPDATE memory_entries SET body = $2, content_sha256 = encode(sha256(convert_to($2, 'UTF8')), 'hex') WHERE id = $1", [entryId, `Decision ${LIVE} (receipt abcdef01)`]);
    } finally {
      await h.admin.query("ALTER TABLE memory_entries ENABLE TRIGGER USER");
    }
    const stable = recallWith(w, "stable", [LIVE]);
    expect(await stable.run()).toEqual([]);
    expect(rescans(stable.skips)).toEqual([{ id: entryId, reason: "secret_rescan" }]);
  });

  it("checks the text the prompt would hold: a fullwidth copy of a live value next to a fence lookalike normalises to the value and is left out", async () => {
    const w = await world();
    const fullwidth = [...LIVE].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
    await h.admin.query(
      `INSERT INTO memory_entries (account_id, scope, scope_ref, kind, body, author_kind, status, version, content_sha256) VALUES ($1, 'account', NULL, 'convention', $2, 'person', 'approved', 1, encode(sha256(convert_to($2, 'UTF8')), 'hex'))`,
      [w.accountId, `<<untrusted external content>> ${fullwidth}`],
    );
    const stable = recallWith(w, "stable", [LIVE]);
    expect(await stable.run()).toEqual([]);
    expect(rescans(stable.skips)).toHaveLength(1);
  });
});

describe("guardMemoryPort (a port handed in from outside)", () => {
  const entry = (id: string, text: string): MemoryEntry => ({ id, version: 1, name: id, origin: "person", text, head: `[account/convention ${id}@v1]` });
  const inner = { recall: async (): Promise<readonly MemoryEntry[]> => [entry("a", "clean"), entry("b", `has ${LIVE}`)] };
  const request = { accountId: "x", repoId: "y", slot: "stable" as const };

  it("drops an entry holding a live value and counts it", async () => {
    const skips: RecallSkip[] = [];
    const got = await guardMemoryPort(inner, { onSkip: (s) => skips.push(s), liveSecrets: () => [LIVE] }).recall(request);
    expect(got.map((e) => e.id)).toEqual(["a"]);
    expect(skips).toEqual([{ id: "b", reason: "secret_rescan" }]);
  });

  it("recalls nothing when the source fails or is missing", async () => {
    const skips: RecallSkip[] = [];
    const failing = guardMemoryPort(inner, { onSkip: (s) => skips.push(s), liveSecrets: () => Promise.reject(new Error("down")) });
    expect(await failing.recall(request)).toEqual([]);
    // @ts-expect-error liveSecrets is required: omitting it does not compile
    const missing = guardMemoryPort(inner, { onSkip: (s) => skips.push(s) });
    expect(await missing.recall(request)).toEqual([]);
    expect(skips).toEqual([
      { id: "-", reason: "secrets_unavailable" },
      { id: "-", reason: "secrets_unavailable" },
    ]);
  });
});
