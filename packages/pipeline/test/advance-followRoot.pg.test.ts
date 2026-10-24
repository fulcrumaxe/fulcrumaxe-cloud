import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { approveProposal } from "@fx/core/src/plan/approve.js";
import { listProposals, withdrawApproval, ProposalRefusedError, type ProposalCtx } from "@fx/core/src/plan/proposals.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { triageIssueItem, SUPERSEDED_REF_PREFIX, type IssueTriageInput } from "../src/advance/issueTriage.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#483 S4-e2 [pg]: the proposal follows its root. Real approve, real triage, real stage writer and real list read, over the real
 * store, with the triage run as the runner login (app_user + agent_run_writer, the only role that may call the definer).
 */
const h = pgHarness();
let counter = 5000;

type Backing = "discussion" | "issue";

async function world(backing: Backing = "discussion", category: "feature" | "bug" | "small" = "feature") {
  const a = await seedAccount(h.admin, randomUUID());
  const n = counter++;
  const ctx: ProposalCtx = { pool: h.pureAppUserPool, principal: { accountId: a.accountId, userId: a.userId } };
  const started: string[] = [];
  const proposalId = await newProposal(a, backing, n);
  const approved = await approveProposal(ctx, proposalId, async (workItemId) => void started.push(workItemId));
  const oldId = approved.work_item_id;
  const input = (over: Partial<IssueTriageInput> = {}): IssueTriageInput => ({
    workItemId: oldId,
    title: "From a proposal",
    body: "SUMMARY:\nwhat the person approved",
    category,
    sourceEventId: `proposal:${proposalId}`,
    repoId: a.repoId,
    login: "fx-proposal-approval",
    number: backing === "issue" ? n : null,
    ...over,
  });
  return { a, n, ctx, started, proposalId, oldId, input };
}

async function newProposal(a: SeedRefs, backing: Backing, n: number): Promise<string> {
  const id = randomUUID();
  const issue = backing === "issue";
  await h.admin.query(
    `INSERT INTO proposals (id, account_id, repo_id, dedupe_key, sources, gh_number, discussion_number, title, summary, provenance, owner_process, state)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, 'From a proposal', 'what the person approved', 'external', 'product', 'new')`,
    [id, a.accountId, a.repoId, issue ? `gh:issue:${n}` : `gh:discussion:${n}`, issue ? "{github_issue}" : "{github_discussion}", issue ? n : null, issue ? null : n],
  );
  return id;
}

const proposalRow = async (id: string) => (await h.admin.query(`SELECT * FROM proposals WHERE id = $1`, [id])).rows[0];
const stageOf = async (id: string) => (await h.admin.query<{ stage: string }>(`SELECT stage FROM work_items WHERE id = $1`, [id])).rows[0]!.stage;
const workItemCount = async (accountId: string) => Number((await h.admin.query(`SELECT count(*) AS n FROM work_items WHERE account_id = $1`, [accountId])).rows[0].n);
const inbox = async (ctx: ProposalCtx, repoId: string) => (await listProposals(ctx, { repoId })).proposals;
const without = (row: Record<string, unknown>, ...cols: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !cols.includes(k)));

/** Calls the definer as the runner login, in the tenant, and returns what it answers or the error it raised. */
async function follow(accountId: string, proposalId: string, oldId: string, rootId: string, pool: Pool = h.runWriterPool) {
  return withTenant(pool, accountId, async (c) => (await c.query<{ proposal_follow_root: boolean }>(`SELECT proposal_follow_root($1::uuid, $2::uuid, $3::uuid)`, [proposalId, oldId, rootId])).rows[0]!.proposal_follow_root);
}

/** A retired item the way triage leaves it: made at `triaged` and retired through the real definer, which closes it and writes the record. */
async function retiredItem(a: SeedRefs, repoId: string, root: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'issue', 'internal')`, [id, a.accountId, repoId]);
  await withTenant(h.runWriterPool, a.accountId, (c) => c.query(`SELECT retire_superseded_work_item($1::uuid, $2::uuid)`, [id, root]));
  return id;
}
/** A closed item with the history row triage would leave and a record written by the test's superuser: the shape the definer itself refuses to make (a root in another repo). */
async function forgedRetired(a: SeedRefs, repoId: string, root: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'issue', 'internal')`, [id, a.accountId, repoId]);
  await withTenant(h.runWriterPool, a.accountId, (c) => recordStage(c, { workItemId: id, toStage: "closed", at: new Date(), source: "control_plane", sourceRef: `${SUPERSEDED_REF_PREFIX}${root}` }));
  await h.admin.query(`INSERT INTO work_item_supersedes (account_id, old_work_item_id, root_work_item_id) VALUES ($1, $2, $3)`, [a.accountId, id, root]);
  return id;
}
async function plainItem(accountId: string, repoId: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'issue', 'internal')`, [id, accountId, repoId]);
  return id;
}

describe("S4-e2: the proposal follows its root after triage [pg]", () => {
  it.each<Backing>(["discussion", "issue"])("S4e2-1 / S4e2-4 (%s-backed): the link is on the root, the old item is retired as superseded, and the Inbox shows the root's stage", async (backing) => {
    const w = await world(backing);
    const before = await proposalRow(w.proposalId);
    expect(before.work_item_id).toBe(w.oldId);
    const out = await triageIssueItem(h.runWriterPool, w.a.accountId, w.input());
    expect(out).toMatchObject({ status: "triaged", stage: "discussing" });
    const root = out.workItemId!;
    expect(root).not.toBe(w.oldId);

    const after = await proposalRow(w.proposalId);
    expect(after.work_item_id).toBe(root);
    expect(await stageOf(w.oldId)).toBe("closed");
    const t = await h.admin.query(`SELECT source_ref FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'closed'`, [w.oldId]);
    expect(t.rows).toEqual([{ source_ref: `${SUPERSEDED_REF_PREFIX}${root}` }]);

    const rows = await inbox(w.ctx, w.a.repoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: w.proposalId, state: "approved", work_item_id: root, work_item_stage: "discussing" });
    expect(rows[0]!.work_item_stage).not.toBe("closed");

    // S4e2-8: nothing else about the proposal moved, and an external proposal is still external on its root.
    expect(without(after, "work_item_id", "updated_at")).toEqual(without(before, "work_item_id", "updated_at"));
    expect(after.provenance).toBe("external");
    expect(after.owner_process).toBe("product");
    expect(after.roadmap_position).toBe(before.roadmap_position);
  });

  it("S4e2-2: moving the root to a later stage moves the Inbox row on the next read, and nothing is stored on the proposal", async () => {
    const w = await world("discussion");
    const root = (await triageIssueItem(h.runWriterPool, w.a.accountId, w.input())).workItemId!;
    const stored = await proposalRow(w.proposalId);
    await withTenant(h.runWriterPool, w.a.accountId, (c) => recordStage(c, { workItemId: root, toStage: "spec_ready", at: new Date(), source: "control_plane", sourceRef: "test:s4e2-2" }));
    expect((await inbox(w.ctx, w.a.repoId))[0]).toMatchObject({ work_item_id: root, work_item_stage: "spec_ready" });
    expect(await proposalRow(w.proposalId)).toEqual(stored);
  });

  it.each<Backing>(["discussion", "issue"])("S4e2-3 / S4e2-4 (%s-backed): approving again after triage answers the same proposal and the root, creates no work item, and files the start for a root still at Triaged", async (backing) => {
    const w = await world(backing, "bug");
    expect(w.started).toEqual([w.oldId]);
    const root = (await triageIssueItem(h.runWriterPool, w.a.accountId, w.input())).workItemId!;
    expect(await stageOf(root)).toBe("triaged");
    const items = await workItemCount(w.a.accountId);
    const again = await approveProposal(w.ctx, w.proposalId, async (id) => void w.started.push(id));
    expect(again.proposal.id).toBe(w.proposalId);
    expect(again.work_item_id).toBe(root);
    expect(again.proposal.work_item_id).toBe(root);
    expect(await workItemCount(w.a.accountId)).toBe(items);
    // The root is idle at Triaged with no run, so the start is filed for the ROOT (the retired item is never started again).
    expect(again.started).toBe(true);
    expect(w.started).toEqual([w.oldId, root]);
  });

  it("S4e2-5: a crash after the retire and before the repoint is finished by a replay: the link moves, one root, no second work item", async () => {
    const w = await world("discussion");
    const crashing = new Proxy(h.runWriterPool, {
      get(target, key) {
        if (key === "connect") {
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(c, k) {
                if (k === "query") {
                  return (sql: unknown, ...rest: unknown[]) => {
                    if (typeof sql === "string" && sql.includes("proposal_follow_root")) throw new Error("injected crash before the repoint");
                    return (c.query as (...a: unknown[]) => unknown)(sql, ...rest);
                  };
                }
                const v = (c as unknown as Record<PropertyKey, unknown>)[k];
                return typeof v === "function" ? v.bind(c) : v;
              },
            });
          };
        }
        const v = (target as unknown as Record<PropertyKey, unknown>)[key];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Pool;
    await expect(triageIssueItem(crashing, w.a.accountId, w.input())).rejects.toThrow("injected crash");
    // The state the crash leaves: the retire is done, the link is not.
    expect(await stageOf(w.oldId)).toBe("closed");
    expect((await proposalRow(w.proposalId)).work_item_id).toBe(w.oldId);
    const items = await workItemCount(w.a.accountId);

    const out = await triageIssueItem(h.runWriterPool, w.a.accountId, w.input());
    expect(out.status).toBe("triaged");
    const root = out.workItemId!;
    expect((await proposalRow(w.proposalId)).work_item_id).toBe(root);
    // S4-e5: the in-between state (retired, record written, link not moved) is on the record, and the replay leaves exactly that one record.
    expect((await h.admin.query(`SELECT root_work_item_id FROM work_item_supersedes WHERE old_work_item_id = $1`, [w.oldId])).rows).toEqual([{ root_work_item_id: root }]);
    expect(await workItemCount(w.a.accountId)).toBe(items);
    // The seed's own sample item is not part of this flow: the open items the flow made are exactly the root.
    const roots = await h.admin.query(`SELECT id FROM work_items WHERE account_id = $1 AND stage <> 'closed' AND id <> $2`, [w.a.accountId, w.a.workItemId]);
    expect(roots.rows.map((r) => r.id)).toEqual([root]);

    // And a further replay, after the move, changes nothing.
    const stored = await proposalRow(w.proposalId);
    expect((await triageIssueItem(h.runWriterPool, w.a.accountId, w.input())).workItemId).toBe(root);
    expect(await proposalRow(w.proposalId)).toEqual(stored);
  });

  it("a webhook-only item (no proposal behind it) is retired as before and nothing is repointed", async () => {
    const a = await seedAccount(h.admin, randomUUID());
    const n = counter++;
    const old = randomUUID();
    await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance) VALUES ($1, $2, $3, 'issue', $4, 'internal')`, [old, a.accountId, a.repoId, n]);
    const out = await triageIssueItem(h.runWriterPool, a.accountId, { workItemId: old, title: "T", body: "B", category: "feature", sourceEventId: `gh-issue:${a.repoId}:${n}`, repoId: a.repoId, login: "owner-1", number: n });
    expect(out.status).toBe("triaged");
    expect(await stageOf(old)).toBe("closed");
  });

  it("S4e2-9: withdrawing while the root is at Triaged with no run reverts the proposal to new and closes the ROOT, not the retired item", async () => {
    const w = await world("discussion", "bug");
    const root = (await triageIssueItem(h.runWriterPool, w.a.accountId, w.input())).workItemId!;
    const oldTransitions = (await h.admin.query(`SELECT count(*)::int AS n FROM work_item_transitions WHERE work_item_id = $1`, [w.oldId])).rows[0].n;
    const p = await withdrawApproval(w.ctx, w.proposalId);
    expect(p.state).toBe("new");
    expect(p.work_item_id).toBeNull();
    expect(await stageOf(root)).toBe("closed");
    const t = await h.admin.query(`SELECT source_ref FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'closed'`, [root]);
    expect(t.rows).toEqual([{ source_ref: `withdraw:${w.proposalId}` }]);
    // The retired item is not touched again.
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM work_item_transitions WHERE work_item_id = $1`, [w.oldId])).rows[0].n).toBe(oldTransitions);
  });

  it("S4e2-9: once the root has a run, withdrawing is refused work_started and the proposal stays approved on the root", async () => {
    const w = await world("discussion", "bug");
    const root = (await triageIssueItem(h.runWriterPool, w.a.accountId, w.input())).workItemId!;
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'project-manager', 'production', 'running')`, [randomUUID(), w.a.accountId, root]);
    await expect(withdrawApproval(w.ctx, w.proposalId)).rejects.toMatchObject({ code: "work_started" });
    await expect(withdrawApproval(w.ctx, w.proposalId)).rejects.toBeInstanceOf(ProposalRefusedError);
    const p = await proposalRow(w.proposalId);
    expect(p).toMatchObject({ state: "approved", work_item_id: root });
    expect(await stageOf(root)).toBe("triaged");
  });
});

describe("S4-e2: proposal_follow_root refuses what it must [pg]", () => {
  /** An approved proposal linked to `old`, a retired item whose ref names `root`, and a root in the same repo. */
  async function setup() {
    const a = await seedAccount(h.admin, randomUUID());
    const root = await plainItem(a.accountId, a.repoId);
    const old = await retiredItem(a, a.repoId, root);
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO proposals (id, account_id, repo_id, dedupe_key, sources, discussion_number, title, provenance, owner_process, state, work_item_id, roadmap_position, decided_at)
       VALUES ($1, $2, $3, $4, '{github_discussion}', 77, 'T', 'external', 'product', 'approved', $5, 1, now())`,
      [id, a.accountId, a.repoId, `gh:discussion:${counter++}`, old],
    );
    return { a, root, old, id };
  }

  it("moves the link for a good call, returns true, and a repeat is a no-op that returns false", async () => {
    const s = await setup();
    const before = await proposalRow(s.id);
    expect(await follow(s.a.accountId, s.id, s.old, s.root)).toBe(true);
    const after = await proposalRow(s.id);
    expect(after.work_item_id).toBe(s.root);
    expect(without(after, "work_item_id", "updated_at")).toEqual(without(before, "work_item_id", "updated_at"));
    expect(await follow(s.a.accountId, s.id, s.old, s.root)).toBe(false);
    expect(await proposalRow(s.id)).toEqual(after);
  });

  it("S4e2-6: an old id that is not the proposal's current link is refused, and the row is unchanged", async () => {
    const s = await setup();
    const other = await retiredItem(s.a, s.a.repoId, s.root);
    const before = await proposalRow(s.id);
    await expect(follow(s.a.accountId, s.id, other, s.root)).rejects.toThrow("not_current_link");
    expect(await proposalRow(s.id)).toEqual(before);
  });

  it("S4e2-6: an old item not closed with a superseded ref that NAMES THIS ROOT is refused (open item, other ref, other root)", async () => {
    const s = await setup();
    const before = await proposalRow(s.id);
    // A closed item whose ref names a different root, linked as the proposal's current item.
    const otherRoot = await plainItem(s.a.accountId, s.a.repoId);
    const namesOther = await retiredItem(s.a, s.a.repoId, otherRoot);
    await h.admin.query(`UPDATE proposals SET work_item_id = $2 WHERE id = $1`, [s.id, namesOther]);
    const staged = await proposalRow(s.id);
    await expect(follow(s.a.accountId, s.id, namesOther, s.root)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.id)).toEqual(staged);
    // An item that is still open.
    const open = await plainItem(s.a.accountId, s.a.repoId);
    await h.admin.query(`UPDATE proposals SET work_item_id = $2 WHERE id = $1`, [s.id, open]);
    const staged2 = await proposalRow(s.id);
    await expect(follow(s.a.accountId, s.id, open, s.root)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.id)).toEqual(staged2);
    // A closed item whose close was not a supersede at all.
    const plainClosed = await plainItem(s.a.accountId, s.a.repoId);
    await withTenant(h.runWriterPool, s.a.accountId, (c) => recordStage(c, { workItemId: plainClosed, toStage: "closed", at: new Date(), source: "control_plane", sourceRef: "withdraw:x" }));
    await h.admin.query(`UPDATE proposals SET work_item_id = $2 WHERE id = $1`, [s.id, plainClosed]);
    const staged3 = await proposalRow(s.id);
    await expect(follow(s.a.accountId, s.id, plainClosed, s.root)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.id)).toEqual(staged3);
    expect(before.work_item_id).toBe(s.old);
  });

  it("S4e2-6: a root in another repo is refused, and the row is unchanged", async () => {
    const s = await setup();
    const repo2 = randomUUID();
    await h.admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, execution_mode) VALUES ($1, $2, $3, $4, 'team', 'sandbox')`, [repo2, s.a.accountId, s.a.installationId, Math.floor(Math.random() * 1_000_000_000)]);
    const root2 = await plainItem(s.a.accountId, repo2);
    const old2 = await forgedRetired(s.a, s.a.repoId, root2);
    await h.admin.query(`UPDATE proposals SET work_item_id = $2 WHERE id = $1`, [s.id, old2]);
    const before = await proposalRow(s.id);
    await expect(follow(s.a.accountId, s.id, old2, root2)).rejects.toThrow("root_mismatch");
    expect(await proposalRow(s.id)).toEqual(before);
  });

  it("S4e2-6: a root in another account is refused, and the row is unchanged", async () => {
    const s = await setup();
    const b = await seedAccount(h.admin, randomUUID());
    const foreignRoot = await plainItem(b.accountId, b.repoId);
    // No record can name a root in another account (the record's foreign key is per account), so the only thing left to present is the old
    // free-text ref, which proposal_follow_root no longer reads: refused as not superseded, and the row is unchanged.
    const old2 = await plainItem(s.a.accountId, s.a.repoId);
    await withTenant(h.runWriterPool, s.a.accountId, (c) => recordStage(c, { workItemId: old2, toStage: "closed", at: new Date(), source: "control_plane", sourceRef: `${SUPERSEDED_REF_PREFIX}${foreignRoot}` }));
    await expect(h.admin.query(`INSERT INTO work_item_supersedes (account_id, old_work_item_id, root_work_item_id) VALUES ($1, $2, $3)`, [s.a.accountId, old2, foreignRoot])).rejects.toMatchObject({ code: "23503" });
    const fresh = await plainItem(s.a.accountId, s.a.repoId);
    await expect(withTenant(h.runWriterPool, s.a.accountId, (c) => c.query(`SELECT retire_superseded_work_item($1::uuid, $2::uuid)`, [fresh, foreignRoot]))).rejects.toThrow("root_mismatch");
    await h.admin.query(`UPDATE proposals SET work_item_id = $2 WHERE id = $1`, [s.id, old2]);
    const before = await proposalRow(s.id);
    await expect(follow(s.a.accountId, s.id, old2, foreignRoot)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.id)).toEqual(before);
  });

  it("S4e2-6: a proposal that is not approved is refused, and the row is unchanged", async () => {
    const s = await setup();
    await h.admin.query(`UPDATE proposals SET state = 'rejected', roadmap_position = NULL, decided_at = now(), work_item_id = $2 WHERE id = $1`, [s.id, s.old]);
    const before = await proposalRow(s.id);
    await expect(follow(s.a.accountId, s.id, s.old, s.root)).rejects.toThrow("not_approved");
    expect(await proposalRow(s.id)).toEqual(before);
  });

  it("another account's proposal is not found, a missing tenant is refused, and bad arguments are rejected", async () => {
    const s = await setup();
    const b = await seedAccount(h.admin, randomUUID());
    await expect(follow(b.accountId, s.id, s.old, s.root)).rejects.toMatchObject({ code: "P0002" });
    await expect(h.runWriterPool.query(`SELECT proposal_follow_root($1::uuid, $2::uuid, $3::uuid)`, [s.id, s.old, s.root])).rejects.toMatchObject({ code: "42501" });
    await expect(follow(s.a.accountId, s.id, s.old, s.old)).rejects.toMatchObject({ code: "22023" });
    await expect(withTenant(h.runWriterPool, s.a.accountId, (c) => c.query(`SELECT proposal_follow_root(NULL, $1::uuid, $2::uuid)`, [s.old, s.root]))).rejects.toMatchObject({ code: "22023" });
    expect((await proposalRow(s.id)).work_item_id).toBe(s.old);
  });

  it("S4e2-7: app_user cannot call the definer or update the link directly; neither can any role but the runner login's agent_run_writer", async () => {
    const s = await setup();
    // app_user alone (the API routes' connection).
    await expect(follow(s.a.accountId, s.id, s.old, s.root, h.pureAppUserPool)).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(h.pureAppUserPool, s.a.accountId, (c) => c.query(`UPDATE proposals SET work_item_id = $2 WHERE id = $1`, [s.id, s.root]))).rejects.toMatchObject({ code: "42501" });
    // The runner login (app_user + agent_run_writer) has the call but not a direct write.
    await expect(withTenant(h.runWriterPool, s.a.accountId, (c) => c.query(`UPDATE proposals SET work_item_id = $2 WHERE id = $1`, [s.id, s.root]))).rejects.toMatchObject({ code: "42501" });
    expect((await proposalRow(s.id)).work_item_id).toBe(s.old);

    // Every other role: no EXECUTE on the function, no UPDATE on the link by any route but the definers' owner roles.
    const fn = "proposal_follow_root(uuid,uuid,uuid)";
    const roles = (await h.admin.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND NOT rolsuper AND rolname NOT IN ('fx_migrator', 'neon_superuser')`)).rows.map((r) => r.rolname);
    expect(roles).toEqual(expect.arrayContaining(["app_user", "platform_ops", "plan_importer", "agent_run_writer", "proposal_follower"]));
    const holders = [];
    for (const role of roles) {
      const ok = (await h.admin.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [role, fn])).rows[0]!.ok;
      if (ok) holders.push(role);
    }
    // agent_run_writer itself, the owner, and the test's runner login (a member of agent_run_writer, as the production one is): nobody else.
    const members = (await h.admin.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE pg_has_role(oid, 'agent_run_writer', 'MEMBER') AND rolname <> 'agent_run_writer' AND NOT rolsuper`)).rows.map((r) => r.rolname);
    expect(members).toEqual(["fx_run_writer_test"]);
    expect(holders.filter((r) => !members.includes(r)).sort()).toEqual(["agent_run_writer", "proposal_follower"]);
    // The session users that are members of agent_run_writer are exactly the runner login: app_user is not one.
    expect((await h.admin.query(`SELECT pg_has_role('app_user', 'agent_run_writer', 'USAGE') AS m`)).rows[0].m).toBe(false);
    // Update on the link: only the three roles that already wrote it for the approval definers or this one.
    const updaters = [];
    for (const role of roles) {
      const ok = (await h.admin.query<{ ok: boolean }>(`SELECT has_column_privilege($1, 'proposals', 'work_item_id', 'UPDATE') AS ok`, [role])).rows[0]!.ok;
      if (ok) updaters.push(role);
    }
    // dial_start_definer (0901) sets the link only inside approve_proposal_by_dial, under its same-transaction receipt checks.
    expect(updaters.sort()).toEqual(["dial_start_definer", "platform_ops", "proposal_follower"]);
  });

  it("S4e2-7: through the definer's own role, state, provenance, owner_process and roadmap_position cannot be written at all", async () => {
    for (const col of ["state", "provenance", "owner_process", "roadmap_position", "decided_at", "title", "summary", "repo_id", "account_id"]) {
      const ok = (await h.admin.query<{ ok: boolean }>(`SELECT has_column_privilege('proposal_follower', 'proposals', $1, 'UPDATE') AS ok`, [col])).rows[0]!.ok;
      expect(ok, col).toBe(false);
    }
    for (const col of ["work_item_id", "updated_at"]) {
      expect((await h.admin.query<{ ok: boolean }>(`SELECT has_column_privilege('proposal_follower', 'proposals', $1, 'UPDATE') AS ok`, [col])).rows[0]!.ok, col).toBe(true);
    }
  });
});
