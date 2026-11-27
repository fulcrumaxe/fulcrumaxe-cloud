import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureErrorReporter, type ErrorClass } from "@fx/telemetry";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { RunPullRequestError, mergeTwinPr, type SetupInstallPort } from "../src/index.js";
import { harness, type Harness } from "./helpers.js";

const PUB_HEAD = "a".repeat(40);
const MOVED = "c".repeat(40);

/**
 * [pg] D#845 ON-27d4c: Merge on a private twin's card, against real Postgres rows and a fake App port that holds to what GitHub does for the merge (one squash at exactly the head it is given, else 409 "changed"; 405 "blocked").
 * Merge is the publish pull request only. Its number and repository are the twin's own rows': the call has no way to name either.
 */
describe("merge a twin's open publish pull request [pg]", () => {
  let h: Harness;
  const reported: ErrorClass[] = [];
  beforeAll(async () => {
    h = await harness();
    configureErrorReporter({ service: "app", write: () => undefined, sink: { record: (e) => void reported.push(e) } });
  });
  afterAll(async () => {
    configureErrorReporter({ service: "app" });
    await h.close();
  });
  afterEach(() => {
    reported.length = 0;
  });

  interface Rig { who: SeedRefs; publicId: string; privateId: string; twinId: string; member: string; admin: string }
  async function addUser(accountId: string, role: string): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, id, role]);
    return id;
  }
  async function rig(o: { state?: string; publishPr?: number | null; publishHead?: string | null } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const publicGh = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const privateId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', 'widgets-private')", [privateId, who.accountId, who.installationId, publicGh + 1]);
    const twinId = randomUUID();
    await h.admin.query(
      `INSERT INTO repo_twins (id, account_id, public_repo_id, private_repo_id, private_name, private_gh_repo_id, created_by, state, removed_at, publish_pr, publish_head, sync_pr)
       VALUES ($1, $2, $3, $4, 'widgets-private', $5, $6, $7, CASE WHEN $7 = 'removed' THEN now() END, $8, $9, 52)`,
      [twinId, who.accountId, who.repoId, privateId, publicGh + 1, who.userId, o.state ?? "ready", o.publishPr === undefined ? 41 : o.publishPr, o.publishHead === undefined ? PUB_HEAD : o.publishHead],
    );
    return { who, publicId: who.repoId, privateId, twinId, member: await addUser(who.accountId, "member"), admin: await addUser(who.accountId, "admin") };
  }

  type Pr = { state: "OPEN" | "CLOSED" | "MERGED"; merged: boolean; headSha: string } | null;
  type Repo = { id: string; owner: string; name: string };
  interface Calls { reads: Array<{ repo: Repo; number: number }>; merges: Array<{ repo: Repo; number: number; sha: string }> }
  /** The App port: `pr` is what GitHub shows now; a merge at any other head is "changed", and `merge` can force "blocked" or a throw. `onMerge` runs just before GitHub answers (a test's seam for what happens meanwhile). */
  function port(pr: Pr, o: { merge?: "blocked" | "throw-retryable"; onMerge?: () => Promise<void> } = {}): { port: SetupInstallPort; calls: Calls } {
    const calls: Calls = { reads: [], merges: [] };
    const p = {
      async installPullRequest(i: { repo: Repo; number: number }) {
        calls.reads.push(i);
        return pr === null ? null : { ...pr, mergedByApp: false, files: [], totalCount: 0, complete: true };
      },
      async mergeInstall(i: { repo: Repo; number: number; sha: string }) {
        calls.merges.push(i);
        if (o.merge === "throw-retryable") throw new RunPullRequestError("unavailable", 503);
        if (o.merge === "blocked") return "blocked";
        await o.onMerge?.();
        return pr !== null && i.sha === pr.headSha ? "merged" : "changed";
      },
    } as unknown as SetupInstallPort;
    return { port: p, calls };
  }
  const OPEN = (headSha: string): Pr => ({ state: "OPEN", merged: false, headSha });
  const run = (r: Rig, setupInstall: SetupInstallPort | undefined, userId = r.who.userId, twinId = r.twinId) => mergeTwinPr({ appUserPool: h.deps().appUserPool, setupInstall }, { accountId: r.who.accountId, userId }, twinId);
  const audit = async (r: Rig) => (await h.admin.query<{ actor: string; payload: unknown }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'twin.merged' ORDER BY created_at, id", [r.who.accountId])).rows;

  it("merges the publish pull request on the PUBLIC repository, the number from the twin's row, at the head GitHub shows", async () => {
    const r = await rig();
    const { port: p, calls } = port(OPEN(PUB_HEAD));
    expect(await run(r, p)).toEqual({ result: "merged", pr: 41 });
    expect(calls.merges).toEqual([{ repo: { id: r.publicId, owner: "acme", name: "widgets" }, number: 41, sha: PUB_HEAD }]);
    expect(reported).toEqual([]);
  });

  it("a branch that moved after the cloud looked is pr_changed and nothing is merged", async () => {
    const r = await rig();
    const { port: p, calls } = port(OPEN(MOVED));
    expect(await run(r, p)).toEqual({ result: "pr_changed" });
    expect(calls.merges).toEqual([]);
    expect(await audit(r)).toEqual([]);
  });

  it("no recorded head is pr_changed too: Merge never merges unpinned, at whatever head GitHub shows", async () => {
    const r = await rig({ publishHead: null });
    const { port: p, calls } = port(OPEN(PUB_HEAD));
    expect(await run(r, p)).toEqual({ result: "pr_changed" });
    expect(calls.merges).toEqual([]);
    expect(await audit(r)).toEqual([]);
  });

  it("a closed pull request, a missing one, and a merge GitHub says changed under us are pr_changed; one GitHub will not merge yet is pr_blocked; one already merged is already, with no merge call", async () => {
    const r = await rig();
    const closed = port({ state: "CLOSED", merged: false, headSha: PUB_HEAD });
    expect(await run(r, closed.port)).toEqual({ result: "pr_changed" });
    expect(closed.calls.merges).toEqual([]);
    expect(await run(r, port(null).port)).toEqual({ result: "pr_changed" });
    const raced = port(OPEN(PUB_HEAD));
    raced.port.mergeInstall = async () => "changed";
    expect(await run(r, raced.port)).toEqual({ result: "pr_changed" });
    expect(await run(r, port(OPEN(PUB_HEAD), { merge: "blocked" }).port)).toEqual({ result: "pr_blocked" });
    const done = port({ state: "MERGED", merged: true, headSha: PUB_HEAD });
    expect(await run(r, done.port)).toEqual({ result: "already", pr: 41 });
    expect(done.calls.merges).toEqual([]);
    expect(await audit(r)).toEqual([]);
  });

  it("no pull request recorded is no_open_pr; a twin that is seeding, refused, failed or removed is twin_state; neither reaches GitHub", async () => {
    const none = await rig({ publishPr: null, publishHead: null });
    const { port: p, calls } = port(OPEN(PUB_HEAD));
    expect(await run(none, p)).toEqual({ result: "no_open_pr" });
    for (const state of ["seeding", "refused", "failed", "removed"]) {
      const r = await rig({ state });
      expect(await run(r, p)).toEqual({ result: "twin_state", state });
    }
    expect(calls.reads).toEqual([]);
    expect(calls.merges).toEqual([]);
    for (const state of ["ready", "paused", "conflict"]) {
      const r = await rig({ state });
      expect(await run(r, port(OPEN(PUB_HEAD)).port)).toEqual({ result: "merged", pr: 41 });
    }
  });

  it("only an owner or admin: a member is refused (42501) before GitHub is asked, another account's twin and an id that is no uuid are not_found", async () => {
    const r = await rig();
    const other = await rig();
    const { port: p, calls } = port(OPEN(PUB_HEAD));
    await expect(run(r, p, r.member)).rejects.toMatchObject({ code: "42501" });
    expect(await run(r, p, r.who.userId, other.twinId)).toEqual({ result: "not_found" });
    expect(await run(r, p, r.who.userId, "not-a-uuid")).toEqual({ result: "not_found" });
    expect(await run(r, p, r.who.userId, `${r.twinId}; drop`)).toEqual({ result: "not_found" });
    expect(calls.reads).toEqual([]);
    expect(calls.merges).toEqual([]);
  });

  it("a GitHub that cannot be asked, or no App port at all, is github_unavailable and nothing is merged", async () => {
    const r = await rig();
    expect(await run(r, port(OPEN(PUB_HEAD), { merge: "throw-retryable" }).port)).toEqual({ result: "github_unavailable" });
    expect(await run(r, undefined)).toEqual({ result: "github_unavailable" });
  });

  it("a merge this call made writes one twin.merged audit row for the person (twin, pr, number only); already, changed, blocked, closed, a refusal and an unreachable GitHub write none", async () => {
    const r = await rig();
    await run(r, port({ state: "MERGED", merged: true, headSha: PUB_HEAD }).port);
    await run(r, port(OPEN(PUB_HEAD), { merge: "blocked" }).port);
    await run(r, port(OPEN(MOVED)).port);
    await run(r, port({ state: "CLOSED", merged: false, headSha: PUB_HEAD }).port);
    await run(r, port(OPEN(PUB_HEAD), { merge: "throw-retryable" }).port);
    await expect(run(r, port(OPEN(PUB_HEAD)).port, r.member)).rejects.toMatchObject({ code: "42501" });
    expect(await audit(r)).toEqual([]);
    expect(await run(r, port(OPEN(PUB_HEAD)).port, r.admin)).toEqual({ result: "merged", pr: 41 });
    expect(await audit(r)).toEqual([{ actor: r.admin, payload: { twin_id: r.twinId, pr: "publish", number: 41 } }]);
    expect(reported).toEqual([]);
  });

  it("GitHub merged but the audit write THROWS: the answer is still merged, one twin.merge_audit_failed class is reported (no text), and no row exists", async () => {
    const r = await rig();
    // while GitHub merges, the person loses their role, so the definer refuses (42501) at the audit write
    const { port: p } = port(OPEN(PUB_HEAD), { onMerge: async () => void (await h.admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [r.who.accountId, r.admin])) });
    expect(await run(r, p, r.admin)).toEqual({ result: "merged", pr: 41 });
    expect(reported).toEqual([{ service: "app", route: "/", stage: "twin.merge_audit_failed", code: "twin_merge_audit_failed" }]);
    expect(await audit(r)).toEqual([]);
  });

  it("GitHub merged but the audit write answers something but ok (the twin was refused meanwhile): still merged, one class reported, no row", async () => {
    const r = await rig();
    const { port: p } = port(OPEN(PUB_HEAD), { onMerge: async () => void (await h.admin.query("UPDATE repo_twins SET state = 'refused' WHERE id = $1", [r.twinId])) });
    expect(await run(r, p)).toEqual({ result: "merged", pr: 41 });
    expect(reported).toEqual([{ service: "app", route: "/", stage: "twin.merge_audit_failed", code: "twin_merge_audit_failed" }]);
    expect(await audit(r)).toEqual([]);
  });
});
