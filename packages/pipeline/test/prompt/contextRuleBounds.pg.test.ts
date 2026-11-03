import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { readContextBudgetBytes } from "@fx/core/src/context/contextBudget.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo } from "../build/helpers/seed.js";
import { nextGhInstallationId } from "@fx/db/test/helpers/seed.js";
import { CONTEXT_RULES_LOCK_CLASS_SQL, boundTransaction, saveContextRule, type ContextRuleTimeouts, type PinTreeSource } from "../../src/prompt/contextRulesSave.js";
import { readContextBudget, writeContextBudget } from "../../src/prompt/contextBudgetSetting.js";
import { MEMORY_SLOT_DEFAULT_BYTES } from "../../src/prompt/assemblePrompt.js";
import { readMemorySlotBytes, setMemorySlotBytes } from "../../src/prompt/memorySlotSetting.js";

const HEAD = "a".repeat(40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tree reader whose answers can be held back, as a slow or stuck GitHub would. */
class SlowTrees implements PinTreeSource {
  calls = 0;
  delayMs = 0;
  hang = false;
  onRead: (() => Promise<void>) | null = null;
  async headSha() {
    this.calls++;
    await this.onRead?.();
    if (this.hang) await new Promise(() => undefined);
    await sleep(this.delayMs);
    return HEAD;
  }
  async tree() {
    return { truncated: false, entries: [{ path: "a.md", type: "blob" as const, size: 10 }] };
  }
}

/** [pg] D#600 CX-9a: the bounds on the write transaction (C7 criterion 5, R-C8-5) and the budget row's lifecycle (R-C8-2). Real Postgres, row security forced. */
describe("context rule write bounds and the budget row [pg]", () => {
  const h = pgHarness();
  async function world() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const owner = randomUUID();
    const member = randomUUID();
    await seedAccount(h.admin, accountId);
    await seedRepo(h.admin, accountId, repoId);
    const inst = randomUUID();
    await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')", [inst, accountId, nextGhInstallationId()]);
    await h.admin.query("UPDATE repos SET installation_id = $1, gh_owner = 'acme', gh_name = 'widgets' WHERE id = $2", [inst, repoId]);
    for (const [id, role] of [[owner, "owner"], [member, "member"]] as const) {
      await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
      await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, id, role]);
    }
    const trees = new SlowTrees();
    const timeouts: ContextRuleTimeouts = { lockMs: 400, githubMs: 1500, idleMs: 3000 };
    const deps = { pool: h.pureAppUserPool, openTree: async () => trees, timeouts };
    return { accountId, repoId, owner, member, trees, deps, who: { accountId, userId: owner }, memberWho: { accountId, userId: member }, repo: { scope: "repo" as const, repoId } };
  }
  const rules = async (repoId: string) => (await h.admin.query("SELECT kind, path FROM context_rules WHERE repo_id = $1", [repoId])).rows;
  const settings = async (repoId: string) => (await h.admin.query("SELECT memory_slot_bytes, context_budget_bytes FROM repo_context_settings WHERE repo_id = $1", [repoId])).rows;
  const audit = async (accountId: string) => (await h.admin.query("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'context_budget.changed' ORDER BY created_at, id", [accountId])).rows;

  async function holdLock(repoId: string, body: () => Promise<void>) {
    const holder = await h.adminPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(${CONTEXT_RULES_LOCK_CLASS_SQL}, hashtext($1::text))`, [repoId]);
      await body();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }

  it("the write transaction carries both timeouts, local to it: lock_timeout and a short idle limit", async () => {
    const w = await world();
    await withTenant(h.pureAppUserPool, w.accountId, w.owner, async (client) => {
      await boundTransaction(client, { lockMs: 5000, githubMs: 20000, idleMs: 10000 });
      const { rows } = await client.query("SELECT current_setting('lock_timeout') AS l, current_setting('idle_in_transaction_session_timeout') AS i");
      expect(rows[0]).toEqual({ l: "5s", i: "10s" });
    });
    const after = await h.pureAppUserPool.query("SELECT current_setting('lock_timeout') AS l, current_setting('idle_in_transaction_session_timeout') AS i");
    expect(after.rows[0]).not.toEqual({ l: "5s", i: "10s" });
  });

  it("criterion 5: with the repository lock held in another session, a pin save and an exclude save fail with context_rules_busy, fast, and write nothing", async () => {
    const w = await world();
    await holdLock(w.repoId, async () => {
      for (const kind of ["pin", "exclude"] as const) {
        const started = Date.now();
        await expect(saveContextRule(w.deps, w.who, w.repo, kind, "a.md")).rejects.toMatchObject({ name: "ContextRuleError", code: "context_rules_busy" });
        expect(Date.now() - started).toBeLessThan(5000);
      }
    });
    expect(await rules(w.repoId)).toEqual([]);
    await saveContextRule(w.deps, w.who, w.repo, "pin", "a.md"); // the lock is gone with the holder: the same save now goes through
    expect(await rules(w.repoId)).toEqual([{ kind: "pin", path: "a.md" }]);
  });

  it("F2: no tenant connection is held while the tree is read: a one-connection pool serves another query during the read, and nothing is idle in a transaction", async () => {
    const w = await world();
    const { createPool } = await import("@fx/db/src/pool.js");
    const single = createPool(process.env.PIPELINE_DATABASE_URL_APP_USER!, { max: 1 });
    try {
      const during: unknown[] = [];
      w.trees.onRead = async () => {
        // With a connection held across the read this would wait on the pool's only connection and lose the race.
        const served = await Promise.race([withTenant(single, w.accountId, w.owner, (c) => c.query("SELECT 1 AS one")).then(() => true), sleep(1000).then(() => false)]);
        const idle = await h.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE state LIKE 'idle in transaction%' AND datname = current_database()");
        during.push(served, idle.rows[0].n);
      };
      await saveContextRule({ ...w.deps, pool: single }, w.who, w.repo, "pin", "a.md");
      expect(during).toEqual([true, 0]);
      expect(await rules(w.repoId)).toEqual([{ kind: "pin", path: "a.md" }]);
    } finally {
      await single.end();
    }
  });

  it("F2: a refusal that comes before the tree read (a member on repo scope) leaves nothing behind, and the rolled-back first step leaves no audit row", async () => {
    const w = await world();
    await expect(saveContextRule(w.deps, w.memberWho, w.repo, "pin", "a.md")).rejects.toMatchObject({ code: "42501" });
    expect(w.trees.calls).toBe(0);
    expect(await rules(w.repoId)).toEqual([]);
    await saveContextRule(w.deps, w.who, w.repo, "pin", "a.md");
    const audit = await h.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action LIKE 'context_rule.%'", [w.accountId]);
    expect(audit.rows[0].n).toBe(1);
  });

  it("F3: a path starting with ~ is invalid_path in the library check and in the definer; a tilde later in the path is ordinary", async () => {
    const w = await world();
    for (const kind of ["pin", "exclude"] as const) {
      for (const path of ["~foo", "~", "~/x"]) await expect(saveContextRule(w.deps, w.who, w.repo, kind, path), `${kind} ${path}`).rejects.toMatchObject({ code: "invalid_path" });
    }
    await expect(withTenant(h.pureAppUserPool, w.accountId, w.owner, (c) => c.query("SELECT context_rule_save('repo', $1::uuid, NULL, 'exclude', '~foo')", [w.repoId]))).rejects.toMatchObject({ code: "22023", message: "invalid_path" });
    await saveContextRule(w.deps, w.who, w.repo, "exclude", "a/~b");
    expect(await rules(w.repoId)).toEqual([{ kind: "exclude", path: "a/~b" }]);
  });

  it("R-C8-5: a GitHub call that never answers is cut at the cap with tree_unavailable; nothing is written and the connection pool still serves", async () => {
    const w = await world();
    w.trees.hang = true;
    const started = Date.now();
    await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "a.md")).rejects.toMatchObject({ code: "tree_unavailable" });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await rules(w.repoId)).toEqual([]);
    w.trees.hang = false;
    await saveContextRule(w.deps, w.who, w.repo, "exclude", "x/**");
    expect(await rules(w.repoId)).toEqual([{ kind: "exclude", path: "x/**" }]);
  });

  it("R-C8-2: a budget on a repo with no memory slot makes a row holding only the budget; the slot reads as the default", async () => {
    const w = await world();
    const done = await writeContextBudget(w.deps, w.who, w.repoId, 50_000);
    expect(done).toMatchObject({ changed: true, contextBudgetBytes: 50_000, pinsStatus: "fit" });
    expect(w.trees.calls).toBe(0); // no pins, no GitHub call
    expect(await settings(w.repoId)).toEqual([{ memory_slot_bytes: null, context_budget_bytes: 50_000 }]);
    expect(await readMemorySlotBytes(h.pureAppUserPool, w.accountId, w.repoId)).toBe(MEMORY_SLOT_DEFAULT_BYTES);
    expect(await readContextBudgetBytes(h.pureAppUserPool, w.accountId, w.repoId)).toBe(50_000);
    expect((await readContextBudget(w.deps, w.who, w.repoId)).effectiveByRole.executor).toBe(50_000);
  });

  it("R-C8-2: resetting either value nulls that value and drops the row only when both are NULL; the other value survives", async () => {
    const w = await world();
    await setMemorySlotBytes(h.pureAppUserPool, w.who, w.repoId, 2048);
    await writeContextBudget(w.deps, w.who, w.repoId, 8192);
    expect(await settings(w.repoId)).toEqual([{ memory_slot_bytes: 2048, context_budget_bytes: 8192 }]);
    await setMemorySlotBytes(h.pureAppUserPool, w.who, w.repoId, null); // reset the slot: the budget stays
    expect(await settings(w.repoId)).toEqual([{ memory_slot_bytes: null, context_budget_bytes: 8192 }]);
    expect(await readMemorySlotBytes(h.pureAppUserPool, w.accountId, w.repoId)).toBe(MEMORY_SLOT_DEFAULT_BYTES);
    await setMemorySlotBytes(h.pureAppUserPool, w.who, w.repoId, 4096);
    await writeContextBudget(w.deps, w.who, w.repoId, null); // reset the budget: the slot stays
    expect(await settings(w.repoId)).toEqual([{ memory_slot_bytes: 4096, context_budget_bytes: null }]);
    await setMemorySlotBytes(h.pureAppUserPool, w.who, w.repoId, null); // both NULL now: the row goes
    expect(await settings(w.repoId)).toEqual([]);
    await setMemorySlotBytes(h.pureAppUserPool, w.who, w.repoId, null); // resetting nothing is fine
    expect((await audit(w.accountId)).map((r) => [r.payload.from, r.payload.to])).toEqual([[null, 8192], [8192, null]]);
  });

  it("R-C8-2: the table refuses a row with neither value", async () => {
    const w = await world();
    await expect(h.admin.query("INSERT INTO repo_context_settings (account_id, repo_id, updated_by) VALUES ($1, $2, $3)", [w.accountId, w.repoId, w.owner])).rejects.toMatchObject({ code: "23514" });
    await writeContextBudget(w.deps, w.who, w.repoId, 8192);
    await expect(h.admin.query("UPDATE repo_context_settings SET context_budget_bytes = NULL WHERE repo_id = $1", [w.repoId])).rejects.toMatchObject({ code: "23514" });
  });

  it("the budget write refuses a member (42501), another account's repository (P0002) and a size out of range (invalid_message); none leaves a row or an audit row", async () => {
    const w = await world();
    const other = await world();
    await expect(writeContextBudget(w.deps, w.memberWho, w.repoId, 8192)).rejects.toMatchObject({ code: "42501" });
    await expect(writeContextBudget(other.deps, other.who, w.repoId, 8192)).rejects.toMatchObject({ code: "P0002" });
    for (const bad of [4095, 2_097_153]) await expect(writeContextBudget(w.deps, w.who, w.repoId, bad)).rejects.toMatchObject({ code: "22023", message: "invalid_message" });
    expect(await settings(w.repoId)).toEqual([]);
    expect(await audit(w.accountId)).toEqual([]);
    await expect(readContextBudget(w.deps, other.who, w.repoId)).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("an app_user session cannot write the budget column directly; only the definer can", async () => {
    const w = await world();
    await writeContextBudget(w.deps, w.who, w.repoId, 8192);
    await expect(withTenant(h.pureAppUserPool, w.accountId, w.owner, (c) => c.query("UPDATE repo_context_settings SET context_budget_bytes = 4096 WHERE repo_id = $1", [w.repoId]))).rejects.toMatchObject({ code: "42501" });
    expect(await settings(w.repoId)).toEqual([{ memory_slot_bytes: null, context_budget_bytes: 8192 }]);
  });
});
