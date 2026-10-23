import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { mintProvisioningToken, mintRegistrationCode, setRunnerRepos, type RunnerCloudDeps } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

type Seen = "private" | "public" | "unknown" | "throw";

/**
 * [pg] D#6 runner public guard: a runner is never bound to a repository that is not private. The three routes that bind repos to a runner
 * (a registration code, a provisioning token, a runner's own repo set) read each added repo's visibility live and refuse a public one, or one
 * whose visibility cannot be read, with 409 before anything is written. Real rows, real row security; the visibility port is the only fake.
 */
describe("binding a runner to a repo that is not private [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  async function newRepo(f: F2Fixture): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team', 'acme', $3)", [id, f.accountId, `app-${id.slice(0, 8)}`]);
    return id;
  }
  /** A visibility port answering per repo (default private), recording every read. */
  function port(answers: Record<string, Seen> = {}) {
    const reads: string[] = [];
    const repoVisibility: NonNullable<RunnerCloudDeps["repoVisibility"]> = async (_accountId, repoId) => {
      reads.push(repoId);
      const seen = answers[repoId] ?? "private";
      if (seen === "throw") throw new Error("github down");
      return seen;
    };
    return { reads, repoVisibility };
  }
  const code = (res: { body: unknown }) => (res.body as { error?: { code: string } }).error?.code;
  const codes = async (f: F2Fixture) => (await h.admin.query("SELECT 1 FROM runner_registration_codes WHERE account_id = $1", [f.accountId])).rowCount;
  const tokens = async (f: F2Fixture) => (await h.admin.query("SELECT 1 FROM runner_provisioning_tokens WHERE account_id = $1", [f.accountId])).rowCount;

  const mints = [
    ["a registration code", (deps: RunnerCloudDeps, f: F2Fixture, user: string, repoIds: string[]) => mintRegistrationCode(deps, { accountId: f.accountId, userId: user }, { credential_mode: "subscription", allowed_repo_ids: repoIds }), codes],
    ["a provisioning token", (deps: RunnerCloudDeps, f: F2Fixture, user: string, repoIds: string[]) => mintProvisioningToken(deps, { accountId: f.accountId, userId: user }, { credential_mode: "subscription", allowed_repo_ids: repoIds }), tokens],
  ] as const;

  describe.each(mints)("minting %s", (_label, mint, rows) => {
    it.each([
      ["public", "public_repo"],
      ["unknown", "repo_visibility_unknown"],
      ["throw", "repo_visibility_unknown"],
    ] as const)("one repo that reads as %s among private ones: 409 %s, nothing written", async (seen, want) => {
      const f = await fresh();
      const [ok, bad] = [await newRepo(f), await newRepo(f)];
      const p = port({ [bad]: seen });
      const res = await respond(() => mint(h.deps({ repoVisibility: p.repoVisibility }), f, f.o1, [ok, bad]));
      expect(res.status).toBe(409);
      expect(code(res)).toBe(want);
      expect(await rows(f)).toBe(0);
    });

    it("no visibility port wired: every repo reads as unknown and the mint is refused (fails closed)", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const res = await respond(() => mint(h.deps(), f, f.a1, [repo]));
      expect(res.status).toBe(409);
      expect(code(res)).toBe("repo_visibility_unknown");
      expect(await rows(f)).toBe(0);
    });

    it("only private repos: 201, and each repo was read once", async () => {
      const f = await fresh();
      const [r1, r2] = [await newRepo(f), await newRepo(f)];
      const p = port();
      const res = await respond(() => mint(h.deps({ repoVisibility: p.repoVisibility }), f, f.a1, [r1, r2, r1]));
      expect(res.status).toBe(201);
      expect([...p.reads].sort()).toEqual([r1, r2].sort());
      expect(await rows(f)).toBe(1);
    });

    it("no repos named: nothing to read, the mint goes ahead", async () => {
      const f = await fresh();
      const p = port();
      expect((await respond(() => mint(h.deps({ repoVisibility: p.repoVisibility }), f, f.o1, []))).status).toBe(201);
      expect(p.reads).toEqual([]);
    });

    it("a member (not owner or admin) gets the definer's 403, and GitHub is never asked about the repo", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const p = port({ [repo]: "public" });
      const res = await respond(() => mint(h.deps({ repoVisibility: p.repoVisibility }), f, f.m1, [repo]));
      expect(res.status).toBe(403);
      expect(p.reads).toEqual([]);
    });

    it("another account's repo is the definer's 400 unknown_repo, and GitHub is never asked about it", async () => {
      const f = await fresh();
      const theirs = await newRepo(await fresh());
      const p = port({ [theirs]: "public" });
      const res = await respond(() => mint(h.deps({ repoVisibility: p.repoVisibility }), f, f.o1, [theirs]));
      expect(res.status).toBe(400);
      expect(code(res)).toBe("unknown_repo");
      expect(p.reads).toEqual([]);
    });
  });

  describe("setting a runner's repos", () => {
    const repoIds = async (id: string): Promise<string[]> => (await h.admin.query("SELECT allowed_repo_ids FROM runners WHERE id = $1", [id])).rows[0].allowed_repo_ids;
    const set = (deps: RunnerCloudDeps, f: F2Fixture, user: string, runnerId: string, ids: string[]) => respond(() => setRunnerRepos(deps, { accountId: f.accountId, userId: user }, runnerId, { repo_ids: ids }));

    it.each([
      ["public", "public_repo"],
      ["unknown", "repo_visibility_unknown"],
      ["throw", "repo_visibility_unknown"],
    ] as const)("adding a repo that reads as %s: 409 %s, the runner's set unchanged", async (seen, want) => {
      const f = await fresh();
      const [held, added] = [await newRepo(f), await newRepo(f)];
      const id = await insertRunner(h.admin, f.accountId, f.m1);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, [held]]);
      const p = port({ [added]: seen });
      const res = await set(h.deps({ repoVisibility: p.repoVisibility }), f, f.o1, id, [held, added]);
      expect(res.status).toBe(409);
      expect(code(res)).toBe(want);
      expect(await repoIds(id)).toEqual([held]);
      // Only the repo being added is read; the one the runner already holds is not asked about again here.
      expect(p.reads).toEqual([added]);
    });

    it("narrowing reads nothing: a runner holding a repo that turned public can still be narrowed, by its registrant or an admin", async () => {
      const f = await fresh();
      const [nowPublic, other] = [await newRepo(f), await newRepo(f)];
      const id = await insertRunner(h.admin, f.accountId, f.m1);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, [nowPublic, other]]);
      const p = port({ [nowPublic]: "public" });
      expect(await set(h.deps({ repoVisibility: p.repoVisibility }), f, f.a1, id, [nowPublic])).toMatchObject({ status: 200 });
      expect(await set(h.deps({ repoVisibility: p.repoVisibility }), f, f.m1, id, [])).toMatchObject({ status: 200, body: { repo_ids: [] } });
      expect(p.reads).toEqual([]);
    });

    it("adding a private repo: 200, and only the added repo is read", async () => {
      const f = await fresh();
      const [held, added] = [await newRepo(f), await newRepo(f)];
      const id = await insertRunner(h.admin, f.accountId, f.m1);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, [held]]);
      const p = port();
      expect(await set(h.deps({ repoVisibility: p.repoVisibility }), f, f.o1, id, [held, added])).toMatchObject({ status: 200 });
      expect([...(await repoIds(id))].sort()).toEqual([held, added].sort());
      expect(p.reads).toEqual([added]);
    });

    it("a repo that was private when it was added and is public now cannot be added back after it was taken off", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const id = await insertRunner(h.admin, f.accountId, f.m1);
      const answers: Record<string, Seen> = {};
      const p = port(answers);
      expect(await set(h.deps({ repoVisibility: p.repoVisibility }), f, f.o1, id, [repo])).toMatchObject({ status: 200 });
      expect(await set(h.deps({ repoVisibility: p.repoVisibility }), f, f.o1, id, [])).toMatchObject({ status: 200 });
      answers[repo] = "public";
      const res = await set(h.deps({ repoVisibility: p.repoVisibility }), f, f.o1, id, [repo]);
      expect(res.status).toBe(409);
      expect(code(res)).toBe("public_repo");
      expect(await repoIds(id)).toEqual([]);
    });

    it("another account's runner is the definer's 404, and GitHub is never asked", async () => {
      const f = await fresh();
      const g = await fresh();
      const theirs = await insertRunner(h.admin, g.accountId, g.m1);
      const p = port();
      const repo = await newRepo(f);
      expect(await set(h.deps({ repoVisibility: p.repoVisibility }), f, f.o1, theirs, [repo])).toMatchObject({ status: 404 });
      expect(p.reads).toEqual([]);
    });
  });
});
