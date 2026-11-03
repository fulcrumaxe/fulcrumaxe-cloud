import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { PUBLIC_BRANCH_MOVED, readPlanePush, recordUpdatedHead } from "@fx/core/src/repos/planePushRecord.js";
import { advanceActionFor } from "@fx/core/src/work-items/advance.js";
import { REPUBLISH_BRANCH_MOVED } from "@fx/core/src/work-items/baseSync.js";
import { readReviewHold } from "@fx/core/src/work-items/reviewHold.js";
import { keepBranch, releaseBranch, replaceBranch } from "@fx/core/src/setup-requests/branchPushedAnswer.js";
import { statusSentence } from "@fx/core/src/setup-requests/copy.js";
import { listSetupRequests } from "@fx/core/src/setup-requests/store.js";
import { checkPublicBranch, raiseAfterLeaseFailure } from "../src/fixRoundHeads.js";
import { recordRepublishRefusal } from "../src/fixRoundBase.js";

/**
 * [pg] D#598 P1g-3a: a person's Replace (and Keep), taken from the request the platform really raised, through the next fix round, to the lease push
 * on a REAL bare git remote. The earlier update tests set the authorization column directly; here the answer functions write it, the round-start check reads it,
 * and the push is `git push --force-with-lease` against the head the person was shown, so a push after the confirmation is refused by the remote itself.
 * (The product's own transport is covered by pipeline/test/build/planePushRoute.test.ts; what this adds is the chain around it.)
 */
describe("Replace and Keep, from the raised request to the lease push on a bare remote [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appUser: Pool;
  const dirs: string[] = [];
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appUser = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appUser]) await p.end();
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();

  /** A paired item whose pull request is open: the push row, a bare remote holding the platform's commit on the row's branch, and a work clone to make more commits. */
  async function scene(stage: string) {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [a.workItemId, stage]);
    await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3)", [a.repoId, a.accountId, ["private/**"]]);
    const root = mkdtempSync(join(tmpdir(), "fx-replace-"));
    dirs.push(root);
    const bare = join(root, "remote.git");
    const work = join(root, "work");
    mkdirSync(work);
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, "base.txt"), "base\n");
    git(work, "add", "base.txt");
    git(work, "commit", "-q", "-m", "public main");
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "-q", "origin", "main");
    const mainTip = git(work, "rev-parse", "HEAD");
    const { rows } = await admin.query<{ id: string; branch: string }>(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state)
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, 7, 'https://github.com/acme/widgets-public/pull/7', 'pr_opened') RETURNING id, branch`,
      [a.accountId, a.workItemId, a.repoId, "f".repeat(64), mainTip, mainTip],
    );
    const branch = rows[0]!.branch;
    const commit = (name: string, base: string, text: string): string => {
      git(work, "checkout", "-q", "--detach", base);
      writeFileSync(join(work, `${name}.txt`), text);
      git(work, "add", `${name}.txt`);
      git(work, "commit", "-q", "-m", name);
      return git(work, "rev-parse", "HEAD");
    };
    // The platform's own push: one commit on the public tip, on the row's branch.
    const platform = commit("platform", mainTip, "the item\n");
    git(work, "push", "-q", "origin", `${platform}:refs/heads/${branch}`);
    await admin.query("UPDATE plane_pushes SET head_sha = $2 WHERE id = $1", [rows[0]!.id, platform]);
    const head = () => {
      try {
        return git(bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
      } catch {
        return null;
      }
    };
    const ports = { publicHead: async () => head() };
    /** A person pushes on top of whatever is there. */
    const personPushes = (name: string): string => {
      const sha = commit(name, head()!, `theirs ${name}\n`);
      git(work, "push", "-q", "origin", `${sha}:refs/heads/${branch}`);
      return sha;
    };
    /** The round's publish: ONE commit on the public tip, pushed with the lease on the head the record says to replace (what the push route does). Throws when the remote refuses. */
    const leasePush = (lease: string): string => {
      const next = commit("round", mainTip, "the item, updated\n");
      git(work, "push", "-q", `--force-with-lease=refs/heads/${branch}:${lease}`, "origin", `${next}:refs/heads/${branch}`);
      return next;
    };
    return { a, ports, platform, mainTip, head, personPushes, leasePush, pushId: rows[0]!.id };
  }
  type Scene = Awaited<ReturnType<typeof scene>>;

  const who = (s: Scene) => ({ accountId: s.a.accountId, workItemId: s.a.workItemId });
  const check = (s: Scene) => checkPublicBranch(writerPool, s.ports, who(s));
  const row = (s: Scene) => withTenant(writerPool, s.a.accountId, (c) => readPlanePush(c, s.a.accountId, s.a.workItemId));
  const openRequest = async (s: Scene) => (await admin.query<{ id: string; seen_head: string }>("SELECT id, seen_head FROM setup_requests WHERE work_item_id = $1 AND kind = 'branch_pushed_by_person' AND state = 'open'", [s.a.workItemId])).rows;
  const personArgs = (s: Scene, id: string) => ({ accountId: s.a.accountId, userId: s.a.userId, id });
  const actionAt = async (s: Scene, stage: string) =>
    advanceActionFor({ stage, discussion_id: randomUUID(), kind: "feature", has_spec: true, no_verdict_hold: stage === "needs_human" ? await withTenant(writerPool, s.a.accountId, (c: PoolClient) => readReviewHold(c, s.a.workItemId)) : false });

  it("raised at round start, stage changes_requested: Replace resumes the review, the next round passes the start check and its lease push replaces their commit; the authorization is then spent", async () => {
    const s = await scene("changes_requested");
    const theirs = s.personPushes("one");
    expect(await check(s)).toBe(PUBLIC_BRANCH_MOVED);
    const [req] = await openRequest(s);
    expect(req!.seen_head).toBe(theirs);
    await replaceBranch({ pool: appUser }, { ...personArgs(s, req!.id), shownHead: theirs });
    expect(await actionAt(s, "changes_requested")).toEqual({ ok: true, action: "review" });
    expect(await check(s)).toBeNull();
    const authorized = (await row(s))!.replaceAuthorizedHead!;
    expect(authorized).toBe(theirs);
    const next = s.leasePush(authorized);
    expect(s.head()).toBe(next);
    await withTenant(writerPool, s.a.accountId, (c) => recordUpdatedHead(c, { accountId: s.a.accountId, id: s.pushId, headSha: next, tipSha: s.mainTip, sourceHead: null }));
    expect(await row(s)).toMatchObject({ state: "pr_opened", headSha: next, replaceAuthorizedHead: null });
    expect(await check(s)).toBeNull();
    expect(await openRequest(s)).toEqual([]);
  });

  it("a push after the confirmation: the start check asks again and, if it were skipped, the remote refuses the lease and keeps the newer commit", async () => {
    const s = await scene("changes_requested");
    const first = s.personPushes("one");
    await check(s);
    const [req] = await openRequest(s);
    await replaceBranch({ pool: appUser }, { ...personArgs(s, req!.id), shownHead: first });
    const second = s.personPushes("two");
    expect(() => s.leasePush(first)).toThrow();
    expect(s.head()).toBe(second);
    expect(await check(s)).toBe(PUBLIC_BRANCH_MOVED);
    expect(await openRequest(s)).toMatchObject([{ seen_head: second }]);
    expect((await row(s))!.replaceAuthorizedHead).toBeNull();
  });

  it("Keep after Replace, before the round: the authorization is gone, the round start passes without reading the branch, and the platform has no public copy to update", async () => {
    const s = await scene("changes_requested");
    const theirs = s.personPushes("one");
    await check(s);
    const [req] = await openRequest(s);
    await replaceBranch({ pool: appUser }, { ...personArgs(s, req!.id), shownHead: theirs });
    const kept = await keepBranch({ pool: appUser }, personArgs(s, req!.id));
    expect(kept.changed).toBe(true);
    expect(await row(s)).toMatchObject({ state: "managed_by_person", replaceAuthorizedHead: null });
    let reads = 0;
    expect(await checkPublicBranch(writerPool, { publicHead: async () => (reads++, s.head()) }, who(s))).toBeNull();
    expect(reads).toBe(0);
    expect(s.head()).toBe(theirs);
  });

  it("Keep while a round already holds the lease on their head: the push still lands, the update is recorded with the new head, the managed line says their commit was replaced, and the undo asks nobody", async () => {
    const s = await scene("changes_requested");
    const theirs = s.personPushes("one");
    await check(s);
    const [req] = await openRequest(s);
    await replaceBranch({ pool: appUser }, { ...personArgs(s, req!.id), shownHead: theirs });
    // The round starts: the start check passes and the lease is taken on the head the person was shown.
    expect(await check(s)).toBeNull();
    const lease = (await row(s))!.replaceAuthorizedHead!;
    // Keep arrives while the round runs; the round does not look again and its push succeeds against the lease.
    await keepBranch({ pool: appUser }, personArgs(s, req!.id));
    const next = s.leasePush(lease);
    expect(s.head()).toBe(next);
    const landed = await withTenant(writerPool, s.a.accountId, (c) => recordUpdatedHead(c, { accountId: s.a.accountId, id: s.pushId, headSha: next, tipSha: s.mainTip, sourceHead: null }));
    expect(landed).not.toBeNull();
    // Keep's managed state stands; the record holds the head that is really on the branch.
    expect(await row(s)).toMatchObject({ state: "managed_by_person", headSha: next });
    expect((await row(s))!.managedByPersonAt).not.toBeNull();
    const listed = await withTenant(appUser, s.a.accountId, (c) => listSetupRequests(c, { state: "needs_you" }));
    const [line] = listed.requests;
    expect(line).toMatchObject({ id: req!.id, branchManaged: true });
    const said = statusSentence(line!, { checksAvailable: false })!;
    expect(said).toContain("before your Keep was seen");
    expect(said).toContain(theirs.slice(0, 7));
    expect(said).toContain(next.slice(0, 7));
    expect(said).toContain("pull request");
    expect(line!.reason).not.toContain("Nothing was overwritten");
    // The undo: the branch is where the record says it is, so nobody is asked and the cloud's own commit is not called theirs.
    expect(await releaseBranch({ pool: appUser }, { accountId: s.a.accountId, userId: s.a.userId, workItemId: s.a.workItemId })).toBe(true);
    expect(await check(s)).toBeNull();
    expect(await openRequest(s)).toEqual([]);
    expect(await row(s)).toMatchObject({ state: "pr_opened", headSha: next, keptHead: null, keptReplacedAt: null });
  });

  describe("raised by a lease failure, so the item is at Needs a person", () => {
    /** The round finished, its update was refused at the push (the lease failed): the refusal moves the item to Needs a person and the request is raised from the branch as it is. */
    async function leaseFailure() {
      const s = await scene("changes_requested");
      const theirs = s.personPushes("one");
      await withTenant(writerPool, s.a.accountId, (c) => recordRepublishRefusal(c, who(s), { code: REPUBLISH_BRANCH_MOVED, prNumber: null, moveToNeedsPerson: true, attempt: randomUUID() }));
      await raiseAfterLeaseFailure(writerPool, s.ports.publicHead, who(s));
      const [req] = await openRequest(s);
      expect(req!.seen_head).toBe(theirs);
      expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [s.a.workItemId])).rows[0].stage).toBe("needs_human");
      return { s, theirs, req: req! };
    }

    it("Replace authorizes the head shown and the round start would pass (the data side of the answer works on this path)", async () => {
      const { s, theirs, req } = await leaseFailure();
      await replaceBranch({ pool: appUser }, { ...personArgs(s, req.id), shownHead: theirs });
      expect(await check(s)).toBeNull();
      expect((await row(s))!.replaceAuthorizedHead).toBe(theirs);
    });

    // KNOWN GAP, tracked as its own work: the answer restarts the item with `advance_work_item`, which at Needs a person resolves to `rebuild`, and `rebuildPhase`
    // stops `rebuild_pr_open` while the pull request is open. Nothing starts a fix round, so no update publishes. These two expect the intended behaviour (the refused
    // fix round is resumed: action `review`) and are `fails` until the stage machine is changed; when it is, they will start passing and must be turned on.
    it.fails("Replace resumes the fix round that was refused, not a rebuild", async () => {
      const { s, theirs, req } = await leaseFailure();
      await replaceBranch({ pool: appUser }, { ...personArgs(s, req.id), shownHead: theirs });
      expect(await actionAt(s, "needs_human")).toEqual({ ok: true, action: "review" });
    });

    it.fails("Keep resumes the same way", async () => {
      const { s, req } = await leaseFailure();
      await keepBranch({ pool: appUser }, personArgs(s, req.id));
      expect(await actionAt(s, "needs_human")).toEqual({ ok: true, action: "review" });
    });
  });
});
