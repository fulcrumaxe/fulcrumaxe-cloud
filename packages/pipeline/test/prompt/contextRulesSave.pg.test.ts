import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContextRuleError, listContextRules, removeContextRule } from "@fx/core/src/context/contextRules.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { nextGhInstallationId } from "@fx/db/test/helpers/seed.js";
import { CONTEXT_RULES_LOCK_CLASS_SQL, saveContextRule, type PinTreeSource } from "../../src/prompt/contextRulesSave.js";
import { ROLE_CONTEXT_DEFAULTS } from "../../src/prompt/contextBudget.js";

const HEAD = "a".repeat(40);
type Entry = { path: string; type: "blob" | "tree" | "commit"; size?: number };

/** A GitHub that counts its calls and answers in the trees API's shape: a blob carries `size`, a tree does not, and a big listing says `truncated`. */
class FakeTrees implements PinTreeSource {
  calls = { head: 0, tree: 0 };
  head: string | null = HEAD;
  truncated = false;
  tree_: Entry[] | null = [];
  fail = false;
  async headSha() {
    this.calls.head++;
    if (this.fail) throw new Error("repoTreeSource: status_500 token=ghs_secret acme/widgets");
    return this.head;
  }
  async tree(sha: string) {
    this.calls.tree++;
    expect(sha).toBe(HEAD);
    return this.tree_ === null ? null : { truncated: this.truncated, entries: this.tree_ };
  }
}

/** [pg] D#600 CX-5a acceptance 4 and the save path around it: the budget check, fail-closed behaviours, the read API and the undo. Real Postgres, row security forced. */
describe("saveContextRule [pg]", () => {
  const h = pgHarness();
  async function world(opts: { installed?: boolean; budget?: number | null } = {}) {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    const owner = randomUUID();
    const member = randomUUID();
    await seedAccount(h.admin, accountId);
    await seedRepo(h.admin, accountId, repoId);
    const inst = randomUUID();
    if (opts.installed !== false) {
      await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')", [inst, accountId, nextGhInstallationId()]);
      await h.admin.query("UPDATE repos SET installation_id = $1 WHERE id = $2", [inst, repoId]);
    }
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [repoId]);
    await seedWorkItem(h.admin, accountId, workItemId, repoId);
    for (const [id, role] of [[owner, "owner"], [member, "member"]] as const) {
      await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
      await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, id, role]);
    }
    if (opts.budget !== undefined && opts.budget !== null) {
      await h.admin.query("INSERT INTO repo_context_settings (account_id, repo_id, memory_slot_bytes, updated_by, context_budget_bytes) VALUES ($1, $2, 2048, $3, $4)", [accountId, repoId, owner, opts.budget]);
    }
    const trees = new FakeTrees();
    const deps = { pool: h.pureAppUserPool, openTree: async () => trees };
    return { accountId, repoId, workItemId, owner, member, trees, deps, who: { accountId, userId: owner }, repo: { scope: "repo" as const, repoId }, item: { scope: "item" as const, workItemId } };
  }
  const stored = async (w: { repoId: string }) => (await h.admin.query("SELECT kind, path FROM context_rules WHERE repo_id = $1 ORDER BY path", [w.repoId])).rows;

  it("acceptance 4: a pin set over the budget is refused with pins_exceed_budget and no rule is written; a set exactly at the budget is accepted", async () => {
    const w = await world({ budget: 5000 });
    w.trees.tree_ = [{ path: "a.md", type: "blob", size: 3000 }, { path: "b.md", type: "blob", size: 2001 }, { path: "c.md", type: "blob", size: 2000 }];
    await saveContextRule(w.deps, w.who, w.repo, "pin", "a.md");
    await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "b.md")).rejects.toMatchObject({ name: "ContextRuleError", code: "pins_exceed_budget" });
    expect(await stored(w)).toEqual([{ kind: "pin", path: "a.md" }]);
    await saveContextRule(w.deps, w.who, w.repo, "pin", "c.md"); // 3000 + 2000 = 5000, the budget exactly
    expect(await stored(w)).toEqual([{ kind: "pin", path: "a.md" }, { kind: "pin", path: "c.md" }]);
    await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "b.md")).rejects.toBeInstanceOf(ContextRuleError);
    expect((await stored(w)).length).toBe(2);
  });

  it("with no stored budget the executor's role default applies; an item pin counts the repo's pins too", async () => {
    const w = await world();
    const big = ROLE_CONTEXT_DEFAULTS.executor;
    w.trees.tree_ = [{ path: "repo.md", type: "blob", size: big - 10 }, { path: "item.md", type: "blob", size: 11 }, { path: "item2.md", type: "blob", size: 10 }];
    await saveContextRule(w.deps, w.who, w.repo, "pin", "repo.md");
    await expect(saveContextRule(w.deps, { accountId: w.accountId, userId: w.member }, w.item, "pin", "item.md")).rejects.toMatchObject({ code: "pins_exceed_budget" });
    await saveContextRule(w.deps, { accountId: w.accountId, userId: w.member }, w.item, "pin", "item2.md");
    expect((await h.admin.query("SELECT path FROM context_rules WHERE work_item_id = $1", [w.workItemId])).rows).toEqual([{ path: "item2.md" }]);
  });

  it("a repo pin is measured against every item that has item rules (both directions): item pin 4000 then repo pin 3000 over 5000 is refused with no row; 1000 is accepted", async () => {
    const w = await world({ budget: 5000 });
    const memberWho = { accountId: w.accountId, userId: w.member };
    w.trees.tree_ = [{ path: "item.md", type: "blob", size: 4000 }, { path: "repo3.md", type: "blob", size: 3000 }, { path: "repo1.md", type: "blob", size: 1000 }];
    await saveContextRule(w.deps, memberWho, w.item, "pin", "item.md");
    await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "repo3.md")).rejects.toMatchObject({ code: "pins_exceed_budget" });
    expect(await stored(w)).toEqual([]);
    await saveContextRule(w.deps, w.who, w.repo, "pin", "repo1.md"); // 4000 + 1000 = 5000 in the item's set
    expect(await stored(w)).toEqual([{ kind: "pin", path: "repo1.md" }]);
    // An item rule on the same path overrides the repo pin, so that item does not carry it.
    const other = await world({ budget: 5000 });
    other.trees.tree_ = [{ path: "item.md", type: "blob", size: 4000 }, { path: "repo3.md", type: "blob", size: 3000 }];
    await saveContextRule(other.deps, { accountId: other.accountId, userId: other.member }, other.item, "pin", "item.md");
    await saveContextRule(other.deps, { accountId: other.accountId, userId: other.member }, other.item, "exclude", "repo3.md");
    await saveContextRule(other.deps, other.who, other.repo, "pin", "repo3.md");
    expect(await stored(other)).toEqual([{ kind: "pin", path: "repo3.md" }]);
  });

  it("concurrent saves are serialised per repository: two 3000-byte pins against 5000 leave exactly one row and one refusal", async () => {
    const w = await world({ budget: 5000 });
    w.trees.tree_ = [{ path: "a.md", type: "blob", size: 3000 }, { path: "b.md", type: "blob", size: 3000 }];
    // Both saves have written their own row and fetched the tree before either reads the rule set.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tree = w.trees.tree.bind(w.trees);
    w.trees.tree = async (sha: string) => {
      const t = await tree(sha);
      if (++arrived === 2) release();
      await gate;
      return t;
    };
    const results = await Promise.allSettled([saveContextRule(w.deps, w.who, w.repo, "pin", "a.md"), saveContextRule(w.deps, w.who, w.repo, "pin", "b.md")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: "pins_exceed_budget" });
    expect((await stored(w)).length).toBe(1);
  });

  it("the measurement waits on the per-repository advisory lock, and a lock on another repository does not block it", async () => {
    const w = await world();
    const elsewhere = await world();
    w.trees.tree_ = [{ path: "a.md", type: "blob", size: 1 }];
    const holder = await h.adminPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(${CONTEXT_RULES_LOCK_CLASS_SQL}, hashtext($1::text))`, [elsewhere.repoId]);
      await saveContextRule(w.deps, w.who, w.repo, "pin", "a.md"); // another repository's lock is not in the way
      await holder.query("COMMIT");
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(${CONTEXT_RULES_LOCK_CLASS_SQL}, hashtext($1::text))`, [w.repoId]);
      let done = false;
      const pending = saveContextRule(w.deps, w.who, w.repo, "pin", "a.md").then(() => (done = true));
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        waiting = (await h.admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0].n;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting).toBe(1);
      expect(done).toBe(false);
      await holder.query("COMMIT");
      await pending;
      expect(done).toBe(true);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });

  it("an item rule overrides the repo rule for the same path, and removing it falls back to the repo rule", async () => {
    const w = await world();
    w.trees.tree_ = [{ path: "x.md", type: "blob", size: 1 }];
    const repoRule = await saveContextRule(w.deps, w.who, w.repo, "pin", "x.md");
    await saveContextRule(w.deps, w.who, w.repo, "exclude", "vendor/**");
    const itemRule = await saveContextRule(w.deps, { accountId: w.accountId, userId: w.member }, w.item, "exclude", "x.md");
    const forItem = () => listContextRules(h.pureAppUserPool, w.who, { workItemId: w.workItemId });
    expect((await forItem()).map((r) => [r.scope, r.kind, r.path])).toEqual([["repo", "exclude", "vendor/**"], ["item", "exclude", "x.md"]]);
    expect((await listContextRules(h.pureAppUserPool, w.who, { repoId: w.repoId })).map((r) => [r.kind, r.path])).toEqual([["exclude", "vendor/**"], ["pin", "x.md"]]);
    await removeContextRule(h.pureAppUserPool, { accountId: w.accountId, userId: w.member }, itemRule.id);
    expect((await forItem()).map((r) => [r.scope, r.kind, r.path])).toEqual([["repo", "exclude", "vendor/**"], ["repo", "pin", "x.md"]]);
    await expect(removeContextRule(h.pureAppUserPool, { accountId: w.accountId, userId: w.member }, repoRule.id)).rejects.toMatchObject({ code: "42501" });
    await removeContextRule(h.pureAppUserPool, w.who, repoRule.id);
    expect((await forItem()).map((r) => r.path)).toEqual(["vendor/**"]);
  });

  it("fails closed: a truncated tree, no installation, no head, no tree and a GitHub error each refuse the pin with a clear code and write nothing", async () => {
    const w = await world();
    w.trees.tree_ = [{ path: "a.md", type: "blob", size: 1 }];
    w.trees.truncated = true;
    await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "a.md")).rejects.toMatchObject({ code: "tree_truncated" });
    w.trees.truncated = false;
    w.trees.head = null;
    await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "a.md")).rejects.toMatchObject({ code: "tree_unavailable" });
    w.trees.head = HEAD;
    w.trees.tree_ = null;
    await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "a.md")).rejects.toMatchObject({ code: "tree_unavailable" });
    w.trees.tree_ = [];
    w.trees.fail = true;
    const err = await saveContextRule(w.deps, w.who, w.repo, "pin", "a.md").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "tree_unavailable", message: "tree_unavailable" });
    expect(JSON.stringify(err)).not.toContain("ghs_");
    const deps = { ...w.deps, openTree: async () => { throw new Error("installationHttp: no_installation"); } };
    await expect(saveContextRule(deps, w.who, w.repo, "pin", "a.md")).rejects.toMatchObject({ code: "tree_unavailable" });
    const bare = await world({ installed: false });
    await expect(saveContextRule(bare.deps, bare.who, bare.repo, "pin", "a.md")).rejects.toMatchObject({ code: "repo_not_connected" });
    expect(bare.trees.calls).toEqual({ head: 0, tree: 0 });
    expect(await stored(w)).toEqual([]);
    expect(await stored(bare)).toEqual([]);
  });

  it("a pin whose path is not a file in the tree counts 0 bytes and never blocks; an exclude makes no GitHub call", async () => {
    const w = await world({ budget: 4096 });
    w.trees.tree_ = [{ path: "docs", type: "tree" }, { path: "sub", type: "commit" }, { path: "real.md", type: "blob", size: 4096 }];
    await saveContextRule(w.deps, w.who, w.repo, "pin", "gone.md");
    await saveContextRule(w.deps, w.who, w.repo, "pin", "docs");
    await saveContextRule(w.deps, w.who, w.repo, "pin", "sub");
    await saveContextRule(w.deps, w.who, w.repo, "pin", "real.md");
    const callsBefore = { ...w.trees.calls };
    await saveContextRule(w.deps, w.who, w.repo, "exclude", "secret/**");
    expect(w.trees.calls).toEqual(callsBefore);
    expect((await stored(w)).length).toBe(5);
  });

  it("refusals come before GitHub is asked: a bad path, a member on repo scope, another account's repo", async () => {
    const w = await world();
    const other = await world();
    await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "../x")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "src/*.ts")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(saveContextRule(w.deps, { accountId: w.accountId, userId: w.member }, w.repo, "pin", "a.md")).rejects.toMatchObject({ code: "42501" });
    await expect(saveContextRule(w.deps, other.who, { scope: "repo", repoId: w.repoId }, "pin", "a.md")).rejects.toMatchObject({ code: "P0002" });
    await expect(saveContextRule(w.deps, other.who, { scope: "item", workItemId: w.workItemId }, "exclude", "a.md")).rejects.toMatchObject({ code: "P0002" });
    expect(w.trees.calls).toEqual({ head: 0, tree: 0 });
    expect(other.trees.calls).toEqual({ head: 0, tree: 0 });
    expect(await stored(w)).toEqual([]);
  });

  it("the read API is tenant scoped: another account lists nothing for this repo or item", async () => {
    const a = await world();
    const b = await world();
    await saveContextRule(a.deps, a.who, a.repo, "exclude", "a-secret");
    await saveContextRule(a.deps, a.who, a.item, "exclude", "a-item-secret");
    expect((await listContextRules(h.pureAppUserPool, a.who, { repoId: a.repoId })).map((r) => r.path)).toEqual(["a-secret"]);
    expect((await listContextRules(h.pureAppUserPool, a.who, { workItemId: a.workItemId })).map((r) => r.path)).toEqual(["a-item-secret", "a-secret"]);
    expect(await listContextRules(h.pureAppUserPool, b.who, { repoId: a.repoId })).toEqual([]);
    expect(await listContextRules(h.pureAppUserPool, b.who, { workItemId: a.workItemId })).toEqual([]);
  });

  describe("audit history (CX-5a2)", () => {
    const auditRows = async (accountId: string) =>
      (await h.admin.query("SELECT action, actor, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'context_rule.%' ORDER BY created_at, id", [accountId])).rows;

    it("a save, a pin-to-exclude replacement and a removal each write one row through the library calls; a pin refused for the budget writes none", async () => {
      const w = await world({ budget: 5000 });
      w.trees.tree_ = [{ path: "a.md", type: "blob", size: 3000 }, { path: "b.md", type: "blob", size: 3000 }];
      const { id } = await saveContextRule(w.deps, w.who, w.repo, "pin", "a.md");
      await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "b.md")).rejects.toMatchObject({ code: "pins_exceed_budget" });
      expect((await auditRows(w.accountId)).map((r) => r.action)).toEqual(["context_rule.saved"]);

      await saveContextRule(w.deps, w.who, w.repo, "exclude", "a.md");
      await removeContextRule(h.pureAppUserPool, w.who, id);
      const rows = await auditRows(w.accountId);
      expect(rows.map((r) => r.action)).toEqual(["context_rule.saved", "context_rule.replaced", "context_rule.removed"]);
      expect(rows.every((r) => r.actor === w.owner)).toBe(true);
      expect(rows.map((r) => [r.payload.old_kind, r.payload.new_kind])).toEqual([[null, "pin"], ["pin", "exclude"], ["exclude", null]]);
      expect(await stored(w)).toEqual([]);
    });

    it("a refused pin leaves no audit row for the pin and no rule: no tree, truncated tree and a GitHub error", async () => {
      const w = await world({ budget: 5000 });
      w.trees.truncated = true;
      await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "a.md")).rejects.toMatchObject({ code: "tree_truncated" });
      w.trees.truncated = false;
      w.trees.fail = true;
      await expect(saveContextRule(w.deps, w.who, w.repo, "pin", "a.md")).rejects.toMatchObject({ code: "tree_unavailable" });
      expect(await auditRows(w.accountId)).toEqual([]);
      expect(await stored(w)).toEqual([]);
    });

    it("another account reads none of this account's rule history", async () => {
      const a = await world();
      const b = await world();
      await saveContextRule(a.deps, a.who, a.repo, "exclude", "x/**");
      const seen = await h.pureAppUserPool.connect();
      try {
        await seen.query("BEGIN");
        await seen.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [b.accountId, b.owner]);
        expect((await seen.query("SELECT 1 FROM audit_log WHERE action LIKE 'context_rule.%'")).rows).toEqual([]);
        await seen.query("ROLLBACK");
      } finally {
        seen.release();
      }
      expect((await auditRows(a.accountId)).length).toBe(1);
    });
  });
});
