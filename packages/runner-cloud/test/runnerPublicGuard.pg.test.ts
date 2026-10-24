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

    describe.each([
      ["honours the abort signal like the real client (rejects)", true],
      ["ignores the abort signal (never settles)", false],
    ] as const)("a visibility read that hangs and %s", (_label, honoursAbort) => {
      /** A read that never answers on its own; with `honoursAbort` it rejects when its signal fires, as a real fetch does. */
      const hanging = (seenSignals: AbortSignal[]): NonNullable<RunnerCloudDeps["repoVisibility"]> => (_accountId, _repoId, signal) =>
        new Promise((_resolve, reject) => {
          if (signal) seenSignals.push(signal);
          if (honoursAbort) signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });

      it("fails closed within the timeout, and releases the connection and the lock", async () => {
        const f = await fresh();
        const [held, added] = [await newRepo(f), await newRepo(f)];
        const id = await insertRunner(h.admin, f.accountId, f.m1);
        await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, [held]]);
        const signals: AbortSignal[] = [];
        const deps = h.deps({ repoVisibility: hanging(signals), repoVisibilityTimeoutMs: 150 });
        const started = Date.now();
        const res = await set(deps, f, f.o1, id, [held, added]);
        expect(Date.now() - started).toBeLessThan(3000);
        expect(res.status).toBe(409);
        expect(code(res)).toBe("repo_visibility_unknown");
        expect(await repoIds(id)).toEqual([held]);
        expect(signals).toHaveLength(1);
        expect(signals[0]?.aborted).toBe(true);

        // The transaction ended: every pooled connection is back, nobody waits, and the runner's advisory lock is free for the next writer.
        const pool = deps.appUserPool;
        expect(pool.waitingCount).toBe(0);
        expect(pool.idleCount).toBe(pool.totalCount);
        const p = port();
        expect(await set(h.deps({ repoVisibility: p.repoVisibility }), f, f.o1, id, [held, added])).toMatchObject({ status: 200 });
        expect(p.reads).toEqual([added]);
      });

      it("a normal read inside the timeout still passes", async () => {
        const f = await fresh();
        const added = await newRepo(f);
        const id = await insertRunner(h.admin, f.accountId, f.m1);
        const p = port();
        expect(await set(h.deps({ repoVisibility: p.repoVisibility, repoVisibilityTimeoutMs: 5000 }), f, f.o1, id, [added])).toMatchObject({ status: 200 });
        expect(await repoIds(id)).toEqual([added]);
      });
    });

    it("many repos each answering just under the per-read deadline: refused within the total budget, pool idle, no reads while a transaction is open", async () => {
      const f = await fresh();
      const added: string[] = [];
      for (let i = 0; i < 40; i++) added.push(await newRepo(f));
      const id = await insertRunner(h.admin, f.accountId, f.m1);
      const slow: NonNullable<RunnerCloudDeps["repoVisibility"]> = () => new Promise((resolve) => setTimeout(() => resolve("private"), 100));
      const deps = h.deps({ repoVisibility: slow, repoVisibilityTimeoutMs: 150, repoVisibilityTotalTimeoutMs: 400 });
      const started = Date.now();
      const res = await set(deps, f, f.o1, id, added);
      // Sequential would take 40 x 100 ms; eight at a time under a 400 ms budget leaves most unread (unknown).
      expect(Date.now() - started).toBeLessThan(1500);
      expect(res.status).toBe(409);
      expect(code(res)).toBe("repo_visibility_unknown");
      expect(await repoIds(id)).toEqual([]);
      const pool = deps.appUserPool;
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(pool.totalCount);
    });

    it("no visibility read runs while a transaction is open, and a normal multi-repo request passes", async () => {
      const f = await fresh();
      const added: string[] = [];
      for (let i = 0; i < 12; i++) added.push(await newRepo(f));
      const id = await insertRunner(h.admin, f.accountId, f.m1);
      const deps = h.deps();
      let inFlight = 0;
      let maxInFlight = 0;
      let openDuringRead = 0;
      deps.repoVisibility = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Any open transaction of the app pool shows as a checked-out client.
        if (deps.appUserPool.totalCount - deps.appUserPool.idleCount > 0) openDuringRead++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return "private";
      };
      expect(await set(deps, f, f.o1, id, added)).toMatchObject({ status: 200 });
      expect([...(await repoIds(id))].sort()).toEqual([...added].sort());
      expect(openDuringRead).toBe(0);
      expect(maxInFlight).toBeLessThanOrEqual(8);
      expect(maxInFlight).toBeGreaterThan(1);
    });

    it("a repo added to the set between the pre-read and the lock (not pre-read) is refused", async () => {
      const f = await fresh();
      const [held, late] = [await newRepo(f), await newRepo(f)];
      const id = await insertRunner(h.admin, f.accountId, f.m1);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, [held, late]]);
      // The request is [held, late]: both are held at pre-read time, so nothing is read. Then another writer removes `late` before the lock,
      // so under the lock `late` would be an add that was never read: refused. (This is the remove + re-add race, with no read in the transaction.)
      const deps = h.deps();
      let reads = 0;
      deps.repoVisibility = async () => {
        reads++;
        return "private";
      };
      let armed = true;
      const origConnect = deps.appUserPool.connect.bind(deps.appUserPool) as (...a: unknown[]) => Promise<unknown>;
      let connects = 0;
      (deps.appUserPool as unknown as { connect: unknown }).connect = async (...a: unknown[]) => {
        // The second connection is the binding transaction: narrow the set just before it starts.
        if (++connects === 2 && armed) {
          armed = false;
          await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, [held]]);
        }
        return origConnect(...a);
      };
      const res = await set(deps, f, f.o1, id, [held, late]);
      expect(res.status).toBe(409);
      expect(code(res)).toBe("repo_visibility_unknown");
      expect(reads).toBe(0);
      expect(await repoIds(id)).toEqual([held]);
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
