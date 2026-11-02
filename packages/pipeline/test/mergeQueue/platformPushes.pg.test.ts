import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createPlatformPushReader, type MergeQueueEntry } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { startQueueRepo, type QueueRepo } from "./helpers/queueRepo.js";
import { seedRepo } from "../build/helpers/seed.js";

/** D#519 MQ4-b0: the production proof reader over real Postgres as app_user (row security on), reading the rows migration 0956's definer writes. */
const sha = (c: string) => c.repeat(40);
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("createPlatformPushReader [pg]", () => {
  const db = pgHarness();
  const start = async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    return r;
  };
  const entryOf = (r: QueueRepo) => ({ accountId: r.accountId, repoId: r.repoId }) as MergeQueueEntry;
  const record = (r: QueueRepo, o: { old?: string | null; new: string; start?: string | null; run?: string }) =>
    db.admin.query(
      `INSERT INTO platform_ref_pushes (account_id, repo_id, run_id, runtime, ref, old_sha, new_sha, start_sha) VALUES ($1, $2, $3, 'production', 'refs/heads/fx/issue-7', $4, $5, $6)`,
      [r.accountId, r.repoId, o.run ?? randomUUID(), o.old ?? null, o.new, o.start ?? null],
    );
  function reader(login: () => Promise<string> = async () => "fulcrumaxe-app[bot]") {
    const tenants: string[] = [];
    const logins: string[] = [];
    const read = createPlatformPushReader({
      inTenant: <T>(accountId: string, fn: (c: PoolClient) => Promise<T>) => (tenants.push(accountId), withTenant(db.pureAppUserPool, accountId, fn)),
      appLogin: async (repoId) => (logins.push(repoId), login()),
    });
    return { read, tenants, logins };
  }

  it("the empty-sha probe answers readable with no query and no login read", async () => {
    const r = await start();
    const h = reader();
    expect(await h.read(entryOf(r), [])).toEqual({ appLogin: null, pushes: [] });
    expect(h.tenants).toEqual([]);
    expect(h.logins).toEqual([]);
  });

  it("answers the records of the entry's repository whose new tip is one of the shas, with the app login", async () => {
    const r = await start();
    const run = randomUUID();
    await record(r, { new: sha("1"), start: sha("9"), run });
    await record(r, { old: sha("1"), new: sha("2"), run });
    await record(r, { old: sha("2"), new: sha("3"), run });
    const h = reader();
    const out = await h.read(entryOf(r), [sha("1"), sha("2"), "not-a-sha"]);
    expect(out!.appLogin).toBe("fulcrumaxe-app[bot]");
    expect([...out!.pushes].sort((a, b) => a.newSha.localeCompare(b.newSha))).toEqual([
      { oldSha: null, newSha: sha("1"), startSha: sha("9"), runId: run },
      { oldSha: sha("1"), newSha: sha("2"), startSha: null, runId: run },
    ]);
    expect(h.tenants).toEqual([r.accountId]);
  });

  it("never answers another tenant's records, even for the same sha", async () => {
    const r = await start();
    const sibling = await start();
    await record(sibling, { new: sha("4") });
    const h = reader();
    expect((await h.read(entryOf(r), [sha("4")]))!.pushes).toEqual([]);
    // The sibling tenant's own read sees its row: the filter, not a missing row, is what kept it out above.
    expect((await h.read(entryOf(sibling), [sha("4")]))!.pushes).toHaveLength(1);
  });

  it("never answers another repository's records of the same account, even for the same sha", async () => {
    const r = await start();
    const otherRepoId = randomUUID();
    await seedRepo(db.admin, r.accountId, otherRepoId);
    const other = { ...r, repoId: otherRepoId } as QueueRepo;
    await record(other, { new: sha("6") });
    const h = reader();
    expect((await h.read(entryOf(r), [sha("6")]))!.pushes).toEqual([]);
    expect((await h.read(entryOf(other), [sha("6")]))!.pushes).toHaveLength(1);
  });

  it("a login that cannot be read is null (only records count then), never a failed read", async () => {
    const r = await start();
    await record(r, { new: sha("5") });
    const h = reader(async () => {
      throw new Error("no installation");
    });
    expect(await h.read(entryOf(r), [sha("5")])).toMatchObject({ appLogin: null, pushes: [{ newSha: sha("5") }] });
  });
});
