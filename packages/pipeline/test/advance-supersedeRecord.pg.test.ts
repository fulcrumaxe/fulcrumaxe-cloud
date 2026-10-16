import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { approveProposal } from "@fx/core/src/plan/approve.js";
import type { ProposalCtx } from "@fx/core/src/plan/proposals.js";
import { triageIssueItem, type IssueTriageInput } from "../src/advance/issueTriage.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#483 S4-e5 [pg]: the supersede proof cannot be forged. Every check runs against the real store as the real roles: the runner login
 * (app_user + agent_run_writer, the only role that may call the definers), a plain app_user connection (the API routes' role) and the
 * test's superuser for fixtures and read-backs only.
 */
const h = pgHarness();
let counter = 9000;

const MIGRATION = fileURLToPath(new URL("../../db/migrations/0851_retire_superseded_work_item.sql", import.meta.url));

async function plainItem(accountId: string, repoId: string, stage = "triaged"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'issue', 'internal', $4)`, [id, accountId, repoId, stage]);
  return id;
}
async function secondRepo(a: SeedRefs): Promise<string> {
  const repo2 = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, execution_mode) VALUES ($1, $2, $3, $4, 'team', 'sandbox')`, [repo2, a.accountId, a.installationId, Math.floor(Math.random() * 1_000_000_000)]);
  return repo2;
}
async function proposalFor(a: SeedRefs, workItemId: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(
    `INSERT INTO proposals (id, account_id, repo_id, dedupe_key, sources, discussion_number, title, provenance, owner_process, state, work_item_id, roadmap_position, decided_at)
     VALUES ($1, $2, $3, $4, '{github_discussion}', 77, 'T', 'external', 'product', 'approved', $5, $6, now())`,
    [id, a.accountId, a.repoId, `gh:discussion:${counter++}`, workItemId, counter++],
  );
  return id;
}
const proposalRow = async (id: string) => (await h.admin.query(`SELECT * FROM proposals WHERE id = $1`, [id])).rows[0];
const stageOf = async (id: string) => (await h.admin.query<{ stage: string }>(`SELECT stage FROM work_items WHERE id = $1`, [id])).rows[0]!.stage;
const records = async (accountId: string) => (await h.admin.query(`SELECT old_work_item_id, root_work_item_id FROM work_item_supersedes WHERE account_id = $1 ORDER BY old_work_item_id`, [accountId])).rows;

/** Everything the definers could touch in one account, as comparable data. */
async function snapshot(accountId: string) {
  const items = await h.admin.query(`SELECT id, stage, updated_at, halted_at FROM work_items WHERE account_id = $1 ORDER BY id`, [accountId]);
  const transitions = await h.admin.query(`SELECT work_item_id, from_stage, to_stage, source_ref FROM work_item_transitions WHERE account_id = $1 ORDER BY work_item_id, to_stage, source_ref`, [accountId]);
  const recs = await h.admin.query(`SELECT old_work_item_id, root_work_item_id FROM work_item_supersedes WHERE account_id = $1 ORDER BY old_work_item_id`, [accountId]);
  const events = await h.admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1`, [accountId]);
  return { items: items.rows, transitions: transitions.rows, recs: recs.rows, events: events.rows[0].n };
}

/** Calls the retire definer as the runner login, in the tenant. */
async function retire(accountId: string, oldId: string, rootId: string, pool: Pool = h.runWriterPool) {
  return withTenant(pool, accountId, async (c) => (await c.query<{ r: string }>(`SELECT retire_superseded_work_item($1::uuid, $2::uuid) AS r`, [oldId, rootId])).rows[0]!.r);
}
async function follow(accountId: string, proposalId: string, oldId: string, rootId: string, pool: Pool = h.runWriterPool) {
  return withTenant(pool, accountId, async (c) => (await c.query<{ r: boolean }>(`SELECT proposal_follow_root($1::uuid, $2::uuid, $3::uuid) AS r`, [proposalId, oldId, rootId])).rows[0]!.r);
}

/** An approved proposal on a triaged old item, and a root in the same repo. */
async function setup() {
  const a = await seedAccount(h.admin, randomUUID());
  const root = await plainItem(a.accountId, a.repoId);
  const old = await plainItem(a.accountId, a.repoId);
  const proposalId = await proposalFor(a, old);
  return { a, root, old, proposalId };
}

describe("S4e5-1: triage, retire and repoint work end to end through the definer [pg]", () => {
  it.each(["discussion", "issue"] as const)("%s-backed: the old item is closed, the record names the root, the proposal link is on the root, one stage event and one history row", async (backing) => {
    const a = await seedAccount(h.admin, randomUUID());
    const n = counter++;
    const ctx: ProposalCtx = { pool: h.pureAppUserPool, principal: { accountId: a.accountId, userId: a.userId } };
    const proposalId = randomUUID();
    const issue = backing === "issue";
    await h.admin.query(
      `INSERT INTO proposals (id, account_id, repo_id, dedupe_key, sources, gh_number, discussion_number, title, summary, provenance, owner_process, state)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, 'From a proposal', 'what the person approved', 'external', 'product', 'new')`,
      [proposalId, a.accountId, a.repoId, issue ? `gh:issue:${n}` : `gh:discussion:${n}`, issue ? "{github_issue}" : "{github_discussion}", issue ? n : null, issue ? null : n],
    );
    const approved = await approveProposal(ctx, proposalId, async () => undefined);
    const oldId = approved.work_item_id;
    const input: IssueTriageInput = { workItemId: oldId, title: "From a proposal", body: "SUMMARY:\nx", category: "feature", sourceEventId: `proposal:${proposalId}`, repoId: a.repoId, login: "fx-proposal-approval", number: issue ? n : null };
    const out = await triageIssueItem(h.runWriterPool, a.accountId, input);
    expect(out.status).toBe("triaged");
    const root = out.workItemId!;
    expect(root).not.toBe(oldId);

    expect(await stageOf(oldId)).toBe("closed");
    expect(await records(a.accountId)).toEqual([{ old_work_item_id: oldId, root_work_item_id: root }]);
    expect((await proposalRow(proposalId)).work_item_id).toBe(root);
    const t = await h.admin.query(`SELECT from_stage, to_stage, source, source_ref FROM work_item_transitions WHERE work_item_id = $1`, [oldId]);
    expect(t.rows).toEqual([{ from_stage: "triaged", to_stage: "closed", source: "control_plane", source_ref: `superseded:${root}` }]);
    const ev = await h.admin.query(`SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'work_item.stage_changed' AND subject_id = $2`, [a.accountId, oldId]);
    expect(ev.rows.map((r) => r.payload)).toEqual([{ workItemId: oldId, fromStage: "triaged", toStage: "closed" }]);

    // A replay changes nothing: the pair is recorded, the item is closed, the link is on the root.
    const before = await snapshot(a.accountId);
    expect((await triageIssueItem(h.runWriterPool, a.accountId, input)).workItemId).toBe(root);
    expect(await snapshot(a.accountId)).toEqual(before);
  });

  it("a halted old item is left exactly as it is: nothing closed, no record, no link move", async () => {
    const s = await setup();
    await h.admin.query(`UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1`, [s.old, randomUUID()]);
    const before = await snapshot(s.a.accountId);
    expect(await retire(s.a.accountId, s.old, s.root)).toBe("halted");
    expect(await snapshot(s.a.accountId)).toEqual(before);
    expect(await stageOf(s.old)).toBe("triaged");
  });
});

describe("S4e5-2: the forged supersede ref cannot move a proposal [pg]", () => {
  it("as app_user, a `superseded:<root>` history row on an open item (and even a forged close) is not accepted by proposal_follow_root, and nothing changes", async () => {
    const s = await setup();
    // The attack surface is real: app_user can append this row to its own tenant's history.
    await withTenant(h.pureAppUserPool, s.a.accountId, (c) =>
      c.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', $3)`, [s.a.accountId, s.old, `superseded:${s.root}`]),
    );
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM work_item_transitions WHERE work_item_id = $1 AND source_ref = $2`, [s.old, `superseded:${s.root}`])).rows[0].n).toBe(1);

    // On the open item: refused.
    const open = { proposal: await proposalRow(s.proposalId), snap: await snapshot(s.a.accountId) };
    await expect(follow(s.a.accountId, s.proposalId, s.old, s.root)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.proposalId)).toEqual(open.proposal);
    expect(await snapshot(s.a.accountId)).toEqual(open.snap);
    expect(await stageOf(s.old)).toBe("triaged");

    // With the item also closed by app_user (it holds UPDATE on the stage): still refused, because there is no record.
    await withTenant(h.pureAppUserPool, s.a.accountId, (c) => c.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [s.old]));
    const closed = { proposal: await proposalRow(s.proposalId), snap: await snapshot(s.a.accountId) };
    await expect(follow(s.a.accountId, s.proposalId, s.old, s.root)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.proposalId)).toEqual(closed.proposal);
    expect(await snapshot(s.a.accountId)).toEqual(closed.snap);
    expect((await proposalRow(s.proposalId)).work_item_id).toBe(s.old);
  });

  it("the same forgery on an item in the other repo, or with a root from the other repo, is refused too", async () => {
    const s = await setup();
    const repo2 = await secondRepo(s.a);
    const foreign = await plainItem(s.a.accountId, repo2);
    await withTenant(h.pureAppUserPool, s.a.accountId, (c) =>
      c.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', $3)`, [s.a.accountId, s.old, `superseded:${foreign}`]),
    );
    await h.admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [s.old]);
    const before = await proposalRow(s.proposalId);
    await expect(follow(s.a.accountId, s.proposalId, s.old, foreign)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.proposalId)).toEqual(before);
  });

  it("a legitimate retire, then the repoint, works and is the only path that does", async () => {
    const s = await setup();
    expect(await retire(s.a.accountId, s.old, s.root)).toBe("retired");
    expect(await follow(s.a.accountId, s.proposalId, s.old, s.root)).toBe(true);
    expect((await proposalRow(s.proposalId)).work_item_id).toBe(s.root);
  });
});

describe("S4e5-3: the record and the retire call are closed to every role but the runner login's [pg]", () => {
  it("no direct write to the record by app_user or the runner login, and no call to the definer by app_user", async () => {
    const s = await setup();
    expect(await retire(s.a.accountId, s.old, s.root)).toBe("retired");
    const other = await plainItem(s.a.accountId, s.a.repoId);
    const base = await snapshot(s.a.accountId);
    for (const [name, pool] of [["app_user", h.pureAppUserPool], ["runner login", h.runWriterPool]] as const) {
      await expect(withTenant(pool, s.a.accountId, (c) => c.query(`INSERT INTO work_item_supersedes (account_id, old_work_item_id, root_work_item_id) VALUES ($1, $2, $3)`, [s.a.accountId, other, s.root])), `${name} insert`).rejects.toMatchObject({ code: "42501" });
      await expect(withTenant(pool, s.a.accountId, (c) => c.query(`UPDATE work_item_supersedes SET root_work_item_id = $2 WHERE old_work_item_id = $1`, [s.old, other])), `${name} update`).rejects.toMatchObject({ code: "42501" });
      await expect(withTenant(pool, s.a.accountId, (c) => c.query(`DELETE FROM work_item_supersedes WHERE old_work_item_id = $1`, [s.old])), `${name} delete`).rejects.toMatchObject({ code: "42501" });
    }
    await expect(retire(s.a.accountId, other, s.root, h.pureAppUserPool)).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot(s.a.accountId)).toEqual(base);
  });

  it("by catalog: no role but the definer's owner holds a write privilege on the record, and EXECUTE is held by agent_run_writer, the owner and the runner login only", async () => {
    const roles = (await h.admin.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' AND NOT rolsuper AND rolname NOT IN ('fx_migrator', 'neon_superuser')`)).rows.map((r) => r.rolname);
    expect(roles).toEqual(expect.arrayContaining(["app_user", "platform_ops", "agent_run_writer", "proposal_follower", "work_item_retirer"]));
    const writers: string[] = [];
    for (const role of roles) {
      for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const table = (await h.admin.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'work_item_supersedes', $2) AS ok`, [role, priv])).rows[0]!.ok;
        const col = priv === "INSERT" || priv === "UPDATE" ? (await h.admin.query<{ ok: boolean }>(`SELECT has_any_column_privilege($1, 'work_item_supersedes', $2) AS ok`, [role, priv])).rows[0]!.ok : false;
        if (table || col) writers.push(`${role}:${priv}`);
      }
    }
    // The runner login is a member of app_user and agent_run_writer; neither of those holds a write, so it inherits none.
    expect(writers.sort()).toEqual(["work_item_retirer:INSERT"]);

    const members = (await h.admin.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE pg_has_role(oid, 'agent_run_writer', 'MEMBER') AND rolname <> 'agent_run_writer' AND NOT rolsuper`)).rows.map((r) => r.rolname);
    expect(members).toEqual(["fx_run_writer_test"]);
    const holders: string[] = [];
    for (const role of roles) {
      const ok = (await h.admin.query<{ ok: boolean }>(`SELECT has_function_privilege($1, 'retire_superseded_work_item(uuid,uuid)'::regprocedure, 'EXECUTE') AS ok`, [role])).rows[0]!.ok;
      if (ok) holders.push(role);
    }
    expect(holders.filter((r) => !members.includes(r)).sort()).toEqual(["agent_run_writer", "work_item_retirer"]);
    expect((await h.admin.query(`SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'retire_superseded_work_item(uuid,uuid)'::regprocedure AND a.grantee = 0`)).rowCount).toBe(0);
    expect((await h.admin.query(`SELECT pg_has_role('app_user', 'agent_run_writer', 'USAGE') AS m`)).rows[0].m).toBe(false);
  });

  it("the record has row security forced; the definer is SECURITY DEFINER with a fixed search_path", async () => {
    const c = (await h.admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'work_item_supersedes'::regclass`)).rows[0];
    expect(c).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const f = (await h.admin.query(`SELECT prosecdef, proconfig, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = 'retire_superseded_work_item(uuid,uuid)'::regprocedure`)).rows[0];
    expect(f).toEqual({ prosecdef: true, proconfig: ["search_path=pg_catalog, public, pg_temp"], owner: "work_item_retirer" });
  });
});

describe("S4e5-4: the retire definer refuses what it must and a replay is a no-op [pg]", () => {
  it("a root in another repo", async () => {
    const s = await setup();
    const root2 = await plainItem(s.a.accountId, await secondRepo(s.a));
    const before = await snapshot(s.a.accountId);
    await expect(retire(s.a.accountId, s.old, root2)).rejects.toThrow("root_mismatch");
    expect(await snapshot(s.a.accountId)).toEqual(before);
  });

  it("a root in another account", async () => {
    const s = await setup();
    const b = await seedAccount(h.admin, randomUUID());
    const foreign = await plainItem(b.accountId, b.repoId);
    const before = await snapshot(s.a.accountId);
    const beforeB = await snapshot(b.accountId);
    await expect(retire(s.a.accountId, s.old, foreign)).rejects.toThrow("root_mismatch");
    expect(await snapshot(s.a.accountId)).toEqual(before);
    expect(await snapshot(b.accountId)).toEqual(beforeB);
  });

  it("an old item in another account is not found, and the old item equal to the root is an invalid argument", async () => {
    const s = await setup();
    const b = await seedAccount(h.admin, randomUUID());
    const before = await snapshot(s.a.accountId);
    await expect(retire(b.accountId, s.old, s.root)).rejects.toMatchObject({ code: "P0002" });
    await expect(retire(s.a.accountId, s.old, s.old)).rejects.toMatchObject({ code: "22023" });
    await expect(withTenant(h.runWriterPool, s.a.accountId, (c) => c.query(`SELECT retire_superseded_work_item(NULL, $1::uuid)`, [s.root]))).rejects.toMatchObject({ code: "22023" });
    await expect(h.runWriterPool.query(`SELECT retire_superseded_work_item($1::uuid, $2::uuid)`, [s.old, s.root])).rejects.toMatchObject({ code: "42501" });
    expect(await snapshot(s.a.accountId)).toEqual(before);
  });

  it("an old item already superseded by a different root", async () => {
    const s = await setup();
    const rootB = await plainItem(s.a.accountId, s.a.repoId);
    expect(await retire(s.a.accountId, s.old, s.root)).toBe("retired");
    const before = await snapshot(s.a.accountId);
    await expect(retire(s.a.accountId, s.old, rootB)).rejects.toThrow("superseded_by_other");
    expect(await snapshot(s.a.accountId)).toEqual(before);
    expect(await records(s.a.accountId)).toEqual([{ old_work_item_id: s.old, root_work_item_id: s.root }]);
  });

  it("an old item that is not at triaged (and not recorded) is not retirable", async () => {
    const s = await setup();
    await h.admin.query(`UPDATE work_items SET stage = 'discussing' WHERE id = $1`, [s.old]);
    const before = await snapshot(s.a.accountId);
    await expect(retire(s.a.accountId, s.old, s.root)).rejects.toThrow("old_not_retirable");
    expect(await snapshot(s.a.accountId)).toEqual(before);
  });

  it("a replay with the same pair is a no-op", async () => {
    const s = await setup();
    expect(await retire(s.a.accountId, s.old, s.root)).toBe("retired");
    const after = await snapshot(s.a.accountId);
    expect(await retire(s.a.accountId, s.old, s.root)).toBe("already");
    expect(await snapshot(s.a.accountId)).toEqual(after);
  });

  it("a forged history row with the exact key does not break the retire: the row stands and the record is written", async () => {
    const s = await setup();
    await withTenant(h.pureAppUserPool, s.a.accountId, (c) =>
      c.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', $3)`, [s.a.accountId, s.old, `superseded:${s.root}`]),
    );
    expect(await retire(s.a.accountId, s.old, s.root)).toBe("retired");
    expect(await stageOf(s.old)).toBe("closed");
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM work_item_transitions WHERE work_item_id = $1`, [s.old])).rows[0].n).toBe(1);
    expect(await records(s.a.accountId)).toEqual([{ old_work_item_id: s.old, root_work_item_id: s.root }]);
  });
});

describe("S4e5-5: the backfill gives a record to a legitimate earlier supersede and to nothing else [pg]", () => {
  /** The migration's own backfill statement, run as written. */
  const backfill = (() => {
    const text = readFileSync(MIGRATION, "utf8");
    const at = text.indexOf("INSERT INTO work_item_supersedes (account_id, old_work_item_id, root_work_item_id)\nSELECT DISTINCT ON");
    expect(at).toBeGreaterThan(0);
    return text.slice(at);
  })();

  async function legacyClosed(accountId: string, repoId: string, ref: string, stage = "closed"): Promise<string> {
    const id = await plainItem(accountId, repoId, stage);
    await h.admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', $3)`, [accountId, id, ref]);
    return id;
  }

  it("a legitimate legacy supersede is repointable after the backfill; forged and malformed ones get no record", async () => {
    const s = await setup();
    const b = await seedAccount(h.admin, randomUUID());
    const repo2 = await secondRepo(s.a);
    const rootOtherRepo = await plainItem(s.a.accountId, repo2);
    const rootOtherAccount = await plainItem(b.accountId, b.repoId);

    const legit = await legacyClosed(s.a.accountId, s.a.repoId, `superseded:${s.root}`);
    const otherRepo = await legacyClosed(s.a.accountId, s.a.repoId, `superseded:${rootOtherRepo}`);
    const otherAccount = await legacyClosed(s.a.accountId, s.a.repoId, `superseded:${rootOtherAccount}`);
    const notClosed = await legacyClosed(s.a.accountId, s.a.repoId, `superseded:${s.root}`, "triaged");
    const nothing = await legacyClosed(s.a.accountId, s.a.repoId, `superseded:${randomUUID()}`);
    const malformed = await legacyClosed(s.a.accountId, s.a.repoId, "superseded:not-a-uuid");
    const selfRef = await legacyClosed(s.a.accountId, s.a.repoId, "superseded:placeholder");
    await h.admin.query(`UPDATE work_item_transitions SET source_ref = $2 WHERE work_item_id = $1`, [selfRef, `superseded:${selfRef}`]);
    const otherAccountsItem = await legacyClosed(b.accountId, b.repoId, `superseded:${s.root}`);
    const noRepo = await plainItem(s.a.accountId, s.a.repoId, "closed");
    await h.admin.query(`UPDATE work_items SET repo_id = NULL WHERE id = $1`, [noRepo]);
    await h.admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', $3)`, [s.a.accountId, noRepo, `superseded:${s.root}`]);
    expect(await records(s.a.accountId)).toEqual([]);

    await h.admin.query(backfill);
    expect(await records(s.a.accountId)).toEqual([{ old_work_item_id: legit, root_work_item_id: s.root }]);
    expect(await records(b.accountId)).toEqual([]);
    for (const id of [otherRepo, otherAccount, notClosed, nothing, malformed, selfRef, otherAccountsItem, noRepo]) {
      expect((await h.admin.query(`SELECT 1 FROM work_item_supersedes WHERE old_work_item_id = $1`, [id])).rowCount, id).toBe(0);
    }
    // Running it again changes nothing.
    await h.admin.query(backfill);
    expect(await records(s.a.accountId)).toEqual([{ old_work_item_id: legit, root_work_item_id: s.root }]);

    // The legitimate one is repointable now; the forged ones are not.
    const proposalId = await proposalFor(s.a, legit);
    expect(await follow(s.a.accountId, proposalId, legit, s.root)).toBe(true);
    const forgedProposal = await proposalFor(s.a, otherRepo);
    await expect(follow(s.a.accountId, forgedProposal, otherRepo, rootOtherRepo)).rejects.toThrow("old_not_superseded");
    const openProposal = await proposalFor(s.a, notClosed);
    await expect(follow(s.a.accountId, openProposal, notClosed, s.root)).rejects.toThrow("old_not_superseded");
  });
});

describe("S4e5-6 / S4e5-7: the two consistency clauses of proposal_follow_root [pg]", () => {
  it("S4e5-6: an old item that is not in stage closed is refused (stage moved back, or the record names an open item)", async () => {
    const s = await setup();
    expect(await retire(s.a.accountId, s.old, s.root)).toBe("retired");
    // The record and the closing transition both exist; only the stage is moved back.
    await h.admin.query(`UPDATE work_items SET stage = 'triaged' WHERE id = $1`, [s.old]);
    const before = await proposalRow(s.proposalId);
    await expect(follow(s.a.accountId, s.proposalId, s.old, s.root)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.proposalId)).toEqual(before);

    // A record naming an open item that was never closed, with a closing transition row present.
    const open = await plainItem(s.a.accountId, s.a.repoId);
    await h.admin.query(`INSERT INTO work_item_supersedes (account_id, old_work_item_id, root_work_item_id) VALUES ($1, $2, $3)`, [s.a.accountId, open, s.root]);
    await h.admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', 'x:open')`, [s.a.accountId, open]);
    await h.admin.query(`UPDATE proposals SET work_item_id = $2 WHERE id = $1`, [s.proposalId, open]);
    const staged = await proposalRow(s.proposalId);
    await expect(follow(s.a.accountId, s.proposalId, open, s.root)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.proposalId)).toEqual(staged);
  });

  it("S4e5-7: an item in stage closed whose closing transition has another to_stage, or none, is refused", async () => {
    const s = await setup();
    // Stage closed and record present; the only history row is a move to closed_unmerged (not a move to closed).
    const wrongTo = await plainItem(s.a.accountId, s.a.repoId, "closed");
    await h.admin.query(`INSERT INTO work_item_supersedes (account_id, old_work_item_id, root_work_item_id) VALUES ($1, $2, $3)`, [s.a.accountId, wrongTo, s.root]);
    await h.admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed_unmerged', now(), 'control_plane', $3)`, [s.a.accountId, wrongTo, `superseded:${s.root}`]);
    await h.admin.query(`UPDATE proposals SET work_item_id = $2 WHERE id = $1`, [s.proposalId, wrongTo]);
    const staged = await proposalRow(s.proposalId);
    await expect(follow(s.a.accountId, s.proposalId, wrongTo, s.root)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.proposalId)).toEqual(staged);

    // Stage closed and record present, with no history row at all.
    const none = await plainItem(s.a.accountId, s.a.repoId, "closed");
    await h.admin.query(`INSERT INTO work_item_supersedes (account_id, old_work_item_id, root_work_item_id) VALUES ($1, $2, $3)`, [s.a.accountId, none, s.root]);
    await h.admin.query(`UPDATE proposals SET work_item_id = $2 WHERE id = $1`, [s.proposalId, none]);
    const staged2 = await proposalRow(s.proposalId);
    await expect(follow(s.a.accountId, s.proposalId, none, s.root)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.proposalId)).toEqual(staged2);
  });
});

describe("S4e5-8: a record naming one root does not let the proposal follow another [pg]", () => {
  it("record names root A; following root B is refused, following A works", async () => {
    const s = await setup();
    const rootB = await plainItem(s.a.accountId, s.a.repoId);
    expect(await retire(s.a.accountId, s.old, s.root)).toBe("retired");
    const before = await proposalRow(s.proposalId);
    await expect(follow(s.a.accountId, s.proposalId, s.old, rootB)).rejects.toThrow("old_not_superseded");
    expect(await proposalRow(s.proposalId)).toEqual(before);
    expect(await follow(s.a.accountId, s.proposalId, s.old, s.root)).toBe(true);
    expect((await proposalRow(s.proposalId)).work_item_id).toBe(s.root);
  });
});
