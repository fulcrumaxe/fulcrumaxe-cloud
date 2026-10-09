import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { LOCAL_AUTO_MERGE_COPY_SHA256, setExecutionMode } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

/**
 * D#6 M1G-a [pg]: the operator's human-merge-only lock on the local-review opt-in. For a listed repo, turning the opt-in on
 * answers 409 `human_merge_only` and writes nothing (no opt-in row, no audit row); turning it off is always allowed; an
 * unlisted repo behaves as before (the existing executionMode tests cover that unedited).
 */
const ENV = "FX_HUMAN_MERGE_ONLY_REPO_IDS";
const saved = process.env[ENV];
const NAME = "Acme/widgets";

describe("the opt-in under the human-merge-only lock [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  async function repo(f: F2Fixture): Promise<{ id: string; ghRepoId: number }> {
    const id = randomUUID();
    const ghRepoId = Math.floor(Math.random() * 1e9) + 1;
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'Acme', 'widgets', 'runner_local')", [id, f.accountId, ghRepoId]);
    return { id, ghRepoId };
  }
  const call = (f: F2Fixture, userId: string, repoId: string, body: unknown) =>
    respond(() => setExecutionMode(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId }, repoId, body));
  const optedIn = async (id: string) => (await h.admin.query("SELECT 1 FROM repo_local_review_optins WHERE repo_id = $1", [id])).rowCount === 1;
  const audits = async (f: F2Fixture) => (await h.admin.query("SELECT action FROM audit_log WHERE account_id = $1 AND action LIKE 'repo.%'", [f.accountId])).rows.map((r) => r.action as string);
  const code = (res: { body: unknown }) => (res.body as { error: { code: string } }).error.code;
  const ON = (name: unknown = NAME, sha: unknown = LOCAL_AUTO_MERGE_COPY_SHA256) => ({ auto_merge: true, confirm_repo: name, copy_sha256: sha });

  it("a listed repo: 409 human_merge_only, no opt-in row and no audit row, even with the right name and wording hash", async () => {
    const f = await seedF2(h.admin);
    const { id, ghRepoId } = await repo(f);
    process.env[ENV] = `5,${ghRepoId}`;
    const res = await call(f, f.o1, id, ON());
    expect(res.status).toBe(409);
    expect(code(res)).toBe("human_merge_only");
    expect(await optedIn(id)).toBe(false);
    expect(await audits(f)).toEqual([]);
  });

  it("the lock is reported before the typed name and the wording hash", async () => {
    const f = await seedF2(h.admin);
    const { id, ghRepoId } = await repo(f);
    process.env[ENV] = String(ghRepoId);
    expect(code(await call(f, f.o1, id, ON("nope", "stale")))).toBe("human_merge_only");
  });

  it("a member is still refused with 403, not told about the lock", async () => {
    const f = await seedF2(h.admin);
    const { id, ghRepoId } = await repo(f);
    process.env[ENV] = String(ghRepoId);
    expect((await call(f, f.m1, id, ON())).status).toBe(403);
  });

  it("an unlisted repo can still turn it on, and the lock being lifted again lets a listed one", async () => {
    const f = await seedF2(h.admin);
    const { id, ghRepoId } = await repo(f);
    process.env[ENV] = String(ghRepoId + 1);
    expect(await call(f, f.o1, id, ON())).toMatchObject({ status: 200, body: { auto_merge: true } });
    expect(await optedIn(id)).toBe(true);
  });

  it("turning it off is always allowed, for a listed repo with an opt-in written before the lock", async () => {
    const f = await seedF2(h.admin);
    const { id, ghRepoId } = await repo(f);
    expect(await call(f, f.o1, id, ON())).toMatchObject({ status: 200 });
    process.env[ENV] = String(ghRepoId);
    expect(await call(f, f.o1, id, { auto_merge: false })).toMatchObject({ status: 200, body: { auto_merge: false } });
    expect(await optedIn(id)).toBe(false);
  });

  it("a malformed value locks every repo (fail closed)", async () => {
    for (const bad of ["abc", "1,,2", " 1", "-1"]) {
      const f = await seedF2(h.admin);
      const { id } = await repo(f);
      process.env[ENV] = bad;
      const res = await call(f, f.o1, id, ON());
      expect(res.status, bad).toBe(409);
      expect(code(res)).toBe("human_merge_only");
      expect(await optedIn(id)).toBe(false);
    }
  });
});
