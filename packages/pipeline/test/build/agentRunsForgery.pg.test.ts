import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { runMergeGate, type MergeGateDeps, type MergeGateInput } from "../../src/build/mergeGate.js";
import type { WorkItemTier } from "../../src/build/types.js";
import { FakeGitHub, greenCi } from "./helpers/fakeGitHub.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#2 H09c (correction C37 criterion 2): the four forgeries the #190
 * security review ran on real Postgres. Before 0642 each of them made
 * `runMergeGate` merge. Each is now attempted as a PLAIN app_user (RLS on,
 * tenant set), must fail 42501, must change no row, and must give no merge
 * call. Sources: the #190 reviewers' scratch cases H2a/H2b/H2b2/H2c/H2e
 * and S2b, restated here as permanent table cases.
 */
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const INSUFFICIENT_PRIVILEGE = "42501";

describe("agent_runs forgery cases (H09c) [pg]", () => {
  const db = pgHarness();

  interface World {
    accountId: string;
    repoId: string;
    workItemId: string;
  }

  async function world(): Promise<World> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await db.admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number)
       VALUES ($1, $2, $3, 'feature', 'running', 'internal', 7)`,
      [workItemId, accountId, repoId],
    );
    return { accountId, repoId, workItemId };
  }

  /** A genuine row, as a trusted writer (the superuser fixture stands in for
   * the runner's writer functions). Returns its id. */
  async function genuine(w: World, role: string, verdict: string, sha = HEAD, status = "succeeded"): Promise<string> {
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha)
       VALUES ($1, $2, $3, 'production', $4, $5::jsonb, $6) RETURNING id`,
      [w.accountId, w.workItemId, role, status, JSON.stringify({ verdict }), sha],
    );
    return rows[0]!.id;
  }

  async function snapshot(w: World): Promise<unknown[]> {
    const { rows } = await db.admin.query(
      `SELECT id, role, runtime, status, envelope, head_sha, created_at, work_item_id, account_id
         FROM agent_runs WHERE work_item_id = $1 ORDER BY id`,
      [w.workItemId],
    );
    return rows;
  }

  function github(): FakeGitHub {
    return new FakeGitHub({
      pr: { headSha: HEAD, state: "open", merged: false, draft: false, body: "", labels: [], comments: [] },
      ciBySha: { [HEAD]: greenCi(HEAD) },
    });
  }

  function deps(gh: FakeGitHub): MergeGateDeps {
    return { pool: db.runWriterPool, github: gh, isAutoMergeAllowed: async () => true, requestReviews: async () => {} };
  }

  function input(w: World): MergeGateInput {
    return {
      accountId: w.accountId,
      workItemId: w.workItemId,
      pr: { repoId: w.repoId, prNumber: 7 },
      tier: "small" as WorkItemTier,
      securityDiffTriggerFired: false,
      debaterEnabled: false,
    };
  }

  /** Runs `attempt` as a plain app_user and asserts 42501. */
  async function asPureAppUser(accountId: string, attempt: (c: PoolClient) => Promise<unknown>): Promise<void> {
    await expect(withTenant(db.pureAppUserPool as Pool, accountId, attempt)).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  }

  async function expectNoMerge(w: World): Promise<void> {
    const gh = github();
    const r = await runMergeGate(deps(gh), input(w));
    expect(r.outcome).not.toBe("merged");
    expect(gh.mergeCalls).toEqual([]);
  }

  it("forgery 1: INSERT of passing rows from nothing fails 42501, adds no row, gives no merge", async () => {
    const w = await world();
    const before = await snapshot(w);
    for (const role of ["code-reviewer", "acceptance-tester"]) {
      await asPureAppUser(w.accountId, (c) =>
        c.query(
          `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha)
           VALUES ($1, $2, $3, 'production', 'succeeded', '{"verdict":"pass"}', $4)`,
          [w.accountId, w.workItemId, role, HEAD],
        ),
      );
    }
    // The writer function is not reachable from app_user either.
    await asPureAppUser(w.accountId, (c) =>
      c.query(
        `SELECT agent_run_create($1::uuid, $2::uuid, $3::uuid, NULL, 'code-reviewer', 'production', $4, NULL, NULL, NULL, NULL, jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64))`,
        [randomUUID(), w.accountId, w.workItemId, HEAD],
      ),
    );
    expect(await snapshot(w)).toEqual(before);
    await expectNoMerge(w);
    // Control: the same rows, placed by a trusted fixture (superuser), DO make
    // the gate merge -- so the no-merge above is the refusal's doing, not an
    // empty world's.
    for (const role of ["code-reviewer", "acceptance-tester"]) await genuine(w, role, "pass");
    const gh = github();
    const r = await runMergeGate(deps(gh), input(w));
    expect(r.outcome).toBe("merged");
    expect(gh.mergeCalls).toHaveLength(1);
  });

  it("forgery 2: UPDATE of a genuine needs-fix row's head_sha, status, runtime, envelope and created_at fails 42501 and changes nothing", async () => {
    const w = await world();
    await genuine(w, "code-reviewer", "needs-fix", OLD, "failed");
    await genuine(w, "acceptance-tester", "pass");
    const before = await snapshot(w);
    const sets = [
      `head_sha = '${HEAD}'`,
      `status = 'succeeded'`,
      `runtime = 'production'`,
      `envelope = '{"verdict":"pass"}'`,
      `created_at = now()`,
      `head_sha = '${HEAD}', status = 'succeeded', runtime = 'production', envelope = '{"verdict":"pass"}', created_at = now() + interval '100 years'`,
    ];
    for (const set of sets) {
      await asPureAppUser(w.accountId, (c) =>
        c.query(`UPDATE agent_runs SET ${set} WHERE account_id = $1 AND work_item_id = $2 AND role = 'code-reviewer'`, [
          w.accountId,
          w.workItemId,
        ]),
      );
    }
    expect(await snapshot(w)).toEqual(before);
    await expectNoMerge(w);
  });

  it("forgery 3: a far-future / infinity created_at (INSERT or UPDATE) fails 42501, so a forged pass cannot outrank a later genuine verdict", async () => {
    const w = await world();
    await genuine(w, "code-reviewer", "needs-fix");
    await genuine(w, "acceptance-tester", "pass");
    const before = await snapshot(w);
    for (const value of ["'infinity'", "'9999-12-31'", "now() + interval '100 years'"]) {
      await asPureAppUser(w.accountId, (c) =>
        c.query(
          `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, created_at)
           VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', '{"verdict":"pass"}', $3, ${value})`,
          [w.accountId, w.workItemId, HEAD],
        ),
      );
      await asPureAppUser(w.accountId, (c) =>
        c.query(`UPDATE agent_runs SET created_at = ${value} WHERE account_id = $1 AND work_item_id = $2`, [
          w.accountId,
          w.workItemId,
        ]),
      );
    }
    expect(await snapshot(w)).toEqual(before);
    await expectNoMerge(w);
  });

  it("forgery 4: pointing app.account_id at another tenant and forging rows there fails 42501 (INSERT and UPDATE as plain app_user, in the victim's and in the caller's own tenant context)", async () => {
    const mine = await world();
    const victim = await world();
    await genuine(victim, "code-reviewer", "needs-fix", OLD, "failed");
    await genuine(victim, "acceptance-tester", "pass");
    const before = await snapshot(victim);

    // Same credential, GUC switched to the victim's account -- the tenant
    // context is the only thing separating tenants for app_user.
    await asPureAppUser(victim.accountId, (c) =>
      c.query(
        `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha)
         VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', '{"verdict":"pass"}', $3)`,
        [victim.accountId, victim.workItemId, HEAD],
      ),
    );
    await asPureAppUser(victim.accountId, (c) =>
      c.query(
        `UPDATE agent_runs SET head_sha = $3, status = 'succeeded', envelope = '{"verdict":"pass"}'
          WHERE account_id = $1 AND work_item_id = $2 AND role = 'code-reviewer'`,
        [victim.accountId, victim.workItemId, HEAD],
      ),
    );
    // And under the caller's OWN tenant context, naming the victim's account.
    await asPureAppUser(mine.accountId, (c) =>
      c.query(
        `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha)
         VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', '{"verdict":"pass"}', $3)`,
        [victim.accountId, victim.workItemId, HEAD],
      ),
    );
    expect(await snapshot(victim)).toEqual(before);
    await expectNoMerge(victim);
  });

  it("the writer login (app_user + agent_run_writer) cannot forge through the table either: only the two functions are reachable", async () => {
    const w = await world();
    await genuine(w, "code-reviewer", "needs-fix", OLD, "failed");
    const before = await snapshot(w);
    await expect(
      withTenant(db.runWriterPool, w.accountId, (c) =>
        c.query(`UPDATE agent_runs SET status = 'succeeded', envelope = '{"verdict":"pass"}', head_sha = $2 WHERE work_item_id = $1`, [
          w.workItemId,
          HEAD,
        ]),
      ),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    // Through the function, a terminal row cannot be re-opened or re-written.
    await expect(
      withTenant(db.runWriterPool, w.accountId, (c) =>
        c.query(
          `SELECT agent_run_set_status($1::uuid, (SELECT id FROM agent_runs WHERE work_item_id = $2), 'failed', 'succeeded',
                                       '{"verdict":"pass"}'::jsonb, NULL, NULL, NULL, NULL)`,
          [w.accountId, w.workItemId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await snapshot(w)).toEqual(before);
  });

  // Security review of #205 (M1): platform_ops is the definer's owner AND a
  // LOGIN the web handlers (gh-proxy, webhook, OAuth, v1 API) connect as. It
  // holds direct INSERT/UPDATE grants on agent_runs, and its RLS is bound only
  // to the settable app.account_id, so 0642's write guard is what stops it
  // forging gate-relevant state.
  describe("platform_ops LOGIN (definer owner, web handlers)", () => {
    let po: Pool;
    beforeAll(() => {
      const u = new URL(process.env.PIPELINE_DATABASE_URL_PLATFORM_OPS!);
      po = createPool(u.toString());
    });
    afterAll(async () => {
      await po.end();
    });

    const GUARD = /platform_ops may not/;

    /** A genuine needs-fix code-reviewer verdict, made through the real writer path. */
    async function genuineNeedsFix(w: World): Promise<string> {
      const id = randomUUID();
      await withTenant(db.runWriterPool, w.accountId, async (c) => {
        await c.query(
          `SELECT agent_run_create($1::uuid, $2::uuid, $3::uuid, NULL, 'code-reviewer', 'production', $4, NULL, NULL, NULL, NULL, jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64))`,
          [id, w.accountId, w.workItemId, HEAD],
        );
        await c.query(`SELECT agent_run_set_status($1::uuid, $2::uuid, 'pending', 'running', NULL, NULL, NULL, NULL, NULL)`, [
          w.accountId,
          id,
        ]);
        await c.query(
          `SELECT agent_run_set_status($1::uuid, $2::uuid, 'running', 'succeeded', '{"verdict":"needs-fix"}', NULL, NULL, NULL, NULL)`,
          [w.accountId, id],
        );
      });
      return id;
    }

    /** Runs `attempt` as the platform_ops login with the tenant GUC pointed at `accountId`. */
    async function asPlatformOps(accountId: string, attempt: (c: PoolClient) => Promise<unknown>): Promise<void> {
      await expect(withTenant(po, accountId, attempt)).rejects.toMatchObject({
        code: INSUFFICIENT_PRIVILEGE,
        message: expect.stringMatching(GUARD),
      });
    }

    it("cross-tenant envelope rewrite: needs-fix -> pass is refused, the row is unchanged, the gate does not merge", async () => {
      const victim = await world();
      const id = await genuineNeedsFix(victim);
      const before = await snapshot(victim);
      await asPlatformOps(victim.accountId, (c) =>
        c.query(`UPDATE agent_runs SET envelope = '{"verdict":"pass"}' WHERE id = $1`, [id]),
      );
      expect(await snapshot(victim)).toEqual(before);
      await expectNoMerge(victim);
    });

    it("direct INSERT with status succeeded (then an envelope) is refused, adds no row", async () => {
      const w = await world();
      const before = await snapshot(w);
      for (const role of ["acceptance-tester", "security-reviewer"]) {
        await asPlatformOps(w.accountId, (c) =>
          c.query(
            `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha)
             VALUES ($1, $2, $3, $4, 'production', 'succeeded', $5)`,
            [randomUUID(), w.accountId, w.workItemId, role, HEAD],
          ),
        );
      }
      // Even a 'pending' INSERT is refused: only agent_run_create inserts.
      await asPlatformOps(w.accountId, (c) =>
        c.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha)
           VALUES ($1, $2, $3, 'acceptance-tester', 'production', 'pending', $4)`,
          [randomUUID(), w.accountId, w.workItemId, HEAD],
        ),
      );
      expect(await snapshot(w)).toEqual(before);
    });

    it("status succeeded -> pending -> succeeded is refused at the first hop, and so is any other status change", async () => {
      const w = await world();
      const id = await genuineNeedsFix(w);
      const before = await snapshot(w);
      for (const to of ["pending", "running", "cancelled"]) {
        await asPlatformOps(w.accountId, (c) => c.query(`UPDATE agent_runs SET status = '${to}' WHERE id = $1`, [id]));
      }
      await asPlatformOps(w.accountId, (c) => c.query(`UPDATE agent_runs SET cc_session_id = 'x' WHERE id = $1`, [id]));
      expect(await snapshot(w)).toEqual(before);
    });

    it("end to end: after every platform_ops forgery attempt runMergeGate still returns ready_human_merges and makes no merge call", async () => {
      const w = await world();
      const cr = await genuineNeedsFix(w);
      const gh0 = github();
      expect((await runMergeGate(deps(gh0), input(w))).outcome).not.toBe("merged");

      // The scratch case that merged before the guard: rewrite the needs-fix,
      // then insert and complete the other required roles directly.
      const attempts: Array<(c: PoolClient) => Promise<unknown>> = [
        (c) => c.query(`UPDATE agent_runs SET envelope = '{"verdict":"pass"}' WHERE id = $1`, [cr]),
        ...["acceptance-tester", "security-reviewer"].map(
          (role) => (c: PoolClient) =>
            c.query(
              `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, head_sha)
               VALUES ($1, $2, $3, $4, 'production', 'succeeded', $5)`,
              [randomUUID(), w.accountId, w.workItemId, role, HEAD],
            ),
        ),
      ];
      for (const attempt of attempts) await asPlatformOps(w.accountId, attempt);

      const gh = github();
      const r = await runMergeGate(deps(gh), input(w));
      expect(r.outcome).toBe("ready_human_merges");
      expect(gh.mergeCalls).toEqual([]);
    });
  });
});
