import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { PUBLIC_BRANCH_MOVED } from "@fx/core/src/repos/planePushRecord.js";
import { checkPublicBranch } from "../src/fixRoundHeads.js";
import { recordRepublishRefusal } from "../src/fixRoundBase.js";

/**
 * [pg] D#598 P1g-3a: the round-start allowance. A confirmed Replace authorizes exactly one public head; a round that finds the branch exactly there goes on (and takes
 * its lease on it, on both paths: planePush.pg.test.ts and planePublishRepublish.pg.test.ts); anything else spends the authorization and asks again.
 */
describe("fix round start with a confirmed Replace [pg]", { timeout: 60_000 }, () => {
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

  const PUSHED = "d".repeat(40);
  const SHOWN = "b".repeat(40);
  const LATER = "c".repeat(40);

  async function item(authorized: string | null): Promise<SeedRefs> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3)", [a.repoId, a.accountId, ["private/**"]]);
    await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state, replace_authorized_head)
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, 7, 'https://github.com/acme/widgets-public/pull/7', 'pr_opened', $7)`,
      [a.accountId, a.workItemId, a.repoId, "f".repeat(64), PUSHED, "e".repeat(40), authorized],
    );
    return a;
  }
  const authorized = async (a: SeedRefs) => (await admin.query<{ a: string | null }>("SELECT replace_authorized_head AS a FROM plane_pushes WHERE work_item_id = $1", [a.workItemId])).rows[0]!.a;
  const requests = async (a: SeedRefs) =>
    (await admin.query<{ state: string; seen_head: string }>("SELECT state, seen_head FROM setup_requests WHERE work_item_id = $1 AND kind = 'branch_pushed_by_person' ORDER BY created_at", [a.workItemId])).rows;
  const check = (a: SeedRefs, live: string | null) => checkPublicBranch(writerPool, { publicHead: vi.fn(async () => live) }, { accountId: a.accountId, workItemId: a.workItemId });

  it("the branch exactly at the authorized head lets the round go on, and the authorization stays for the lease", async () => {
    const a = await item(SHOWN);
    expect(await check(a, SHOWN)).toBeNull();
    expect(await authorized(a)).toBe(SHOWN);
    expect(await requests(a)).toEqual([]);
  });

  it("without an authorization the same branch is refused and asked about, as before", async () => {
    const a = await item(null);
    expect(await check(a, SHOWN)).toBe(PUBLIC_BRANCH_MOVED);
    expect(await requests(a)).toEqual([{ state: "open", seen_head: SHOWN }]);
  });

  it("a push after the confirmation refuses, spends the authorization and asks again about the head now there", async () => {
    const a = await item(SHOWN);
    expect(await check(a, LATER)).toBe(PUBLIC_BRANCH_MOVED);
    expect(await authorized(a)).toBeNull();
    expect(await requests(a)).toEqual([{ state: "open", seen_head: LATER }]);
    // The old authorization cannot be used for the next round: the branch at the old head is a new question now.
    expect(await check(a, SHOWN)).toBe(PUBLIC_BRANCH_MOVED);
  });

  it("a branch put back where the platform left it spends the authorization and the round goes on as an ordinary update", async () => {
    const a = await item(SHOWN);
    expect(await check(a, PUSHED)).toBeNull();
    expect(await authorized(a)).toBeNull();
  });

  it("a branch that is gone spends the authorization and asks nobody", async () => {
    const a = await item(SHOWN);
    expect(await check(a, null)).toBe(PUBLIC_BRANCH_MOVED);
    expect(await authorized(a)).toBeNull();
    expect(await requests(a)).toEqual([]);
  });

  it("any refused round spends it (the record of a republish refusal clears it)", async () => {
    const a = await item(SHOWN);
    await withTenant(writerPool, a.accountId, (c) =>
      recordRepublishRefusal(c, { accountId: a.accountId, workItemId: a.workItemId }, { code: "republish_failed", prNumber: null, moveToNeedsPerson: false, attempt: randomUUID() }),
    );
    expect(await authorized(a)).toBeNull();
  });
});
