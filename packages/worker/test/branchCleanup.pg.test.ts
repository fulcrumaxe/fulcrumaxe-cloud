import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { InstallationTokenCache, createInstallationHttp, type AccessTokenRequester, type RunnerGitTicketSigner } from "@fx/github";
import { strictGithubFetch } from "../../github/test/helpers/strictGithub.js";
import { sweepBranchCleanups, type BranchCleanupCounts } from "../src/branchCleanup.js";

/**
 * [pg] D#598 P1f-5d: the branch cleanup sweep against a real Postgres as the real roles (the sweep runs on the run-writer login, the list is the 0886
 * definer, every read and write is under the item's own tenant) and the real GitHub client over the strict GitHub fetch (User-Agent, Authorization forms,
 * the path and method the client allows). The in-memory GitHub answers the way the real API does: ref read 200 or 404, delete 204, 404, or 422 for a ref
 * that cannot be deleted. Real TLS through Node's connect path is covered where the client itself is (packages/github/test/branchDeleteToken.test.ts).
 */
describe("branch cleanup sweep [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let signer: RunnerGitTicketSigner;
  let appKeyPem: string;
  const logs: string[] = [];
  const HEAD = "a".repeat(40);
  const MOVED = "b".repeat(40);
  const OTHER_RUN = randomUUID();

  /** acme/widgets and acme/gadgets: branch -> head. `calls` is every request the client sent. */
  const gh = { refs: new Map<string, string>(), protectedRefs: new Set<string>(), calls: [] as string[], down: false, stuck: null as RegExp | null, noInstall: false, repoGone: false };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const inner = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    gh.calls.push(`${method} ${url.pathname}`);
    if (gh.down) return json(503, { message: "Service Unavailable", documentation_url: "https://docs.github.com/rest", status: "503" });
    if (method === "DELETE" && url.pathname === "/installation/token") return new Response(null, { status: 204 });
    const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/git\/(refs?)\/heads\/(.+))?$/.exec(url.pathname);
    if (!m) return json(404, { message: "Not Found" });
    const [, owner, name, kind, branch] = m;
    if (!kind && gh.repoGone) return json(404, { message: "Not Found" });
    if (branch && gh.stuck?.test(branch)) return json(503, { message: "Service Unavailable", documentation_url: "https://docs.github.com/rest", status: "503" });
    if (!kind) return json(200, { full_name: `${owner}/${name}`, default_branch: "main" });
    const key = `${owner}/${name}/${branch}`;
    if (method === "GET") return gh.refs.has(key) ? json(200, { ref: `refs/heads/${branch}`, object: { sha: gh.refs.get(key), type: "commit" } }) : json(404, { message: "Not Found" });
    if (!gh.refs.has(key)) return json(422, { message: "Reference does not exist" });
    if (gh.protectedRefs.has(key)) return json(422, { message: "Cannot delete protected branch" });
    gh.refs.delete(key);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const requester: AccessTokenRequester = async (p) => ({ token: "ghs_cleanup1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions }, repositories: p.repositories ?? [] });
  const open = () =>
    createInstallationHttp({
      resolveInstallation: async () => (gh.noInstall ? null : { installationId: 42, appKind: "team" }),
      appCredentials: () => ({ appId: "12345", privateKeyPem: appKeyPem, webhookSecret: "unused" }),
      requester,
      cache: new InstallationTokenCache(),
      fetchImpl: strictGithubFetch(inner),
    });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    appKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
    signer = { keyId: "ticket-key-1", privateKey: generateKeyPairSync("ed25519").privateKey };
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  const sweep = (over: { signer?: RunnerGitTicketSigner | null } = {}): Promise<BranchCleanupCounts> =>
    sweepBranchCleanups({ pool: writerPool, signer: over.signer === undefined ? signer : over.signer, github: open(), now: () => Date.parse("2026-10-22T12:00:00Z"), log: (l) => void logs.push(l) });
  const rowOf = async (t: SeedRefs) => (await admin.query<{ state: string; attempts: number }>("SELECT state, attempts FROM branch_cleanups WHERE work_item_id = $1 ORDER BY created_at", [t.workItemId])).rows;
  /** Makes every waiting retry due now (the backoff is real time; the database clock is not faked). */
  const dueNow = () => admin.query("UPDATE branch_cleanups SET next_attempt_at = now() - interval '1 second' WHERE state = 'retrying'");
  /** A move into a final stage, as recordStage writes it. */
  let ref = 0;
  const closeMove = (t: SeedRefs, to: string) =>
    admin.query("INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', $3, now(), 'control_plane', $4)", [t.accountId, t.workItemId, to, `sweep:${++ref}:${randomUUID()}`]);
  const cleanup = async (t: SeedRefs) => (await admin.query<{ outcomes: Array<{ branch: string; outcome: string }> }>("SELECT outcomes FROM branch_cleanups WHERE work_item_id = $1 ORDER BY created_at", [t.workItemId])).rows.at(-1)?.outcomes;

  async function setItem(t: SeedRefs, number: number, stage: string, paired = true) {
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [t.repoId]);
    await admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [t.workItemId, number]);
    await admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [t.workItemId, stage]);
    if (paired) {
      await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['docs/ops/']) ON CONFLICT (repo_id) DO NOTHING", [t.repoId, t.accountId]);
      await withTenant(appPool, t.accountId, (c) => stampPlanePush(c, { accountId: t.accountId, workItemId: t.workItemId, repoId: t.repoId }));
    }
  }
  /** The sandbox build's record: the publish run's envelope. */
  async function publishRun(t: SeedRefs, privateHead: string) {
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, envelope) VALUES ($1, $2, $3, 'plane_publish', 'production', 'succeeded', 'sandbox', $4, $5::jsonb)`,
      [randomUUID(), t.accountId, t.workItemId, t.repoId, JSON.stringify({ publish: { attempt_no: 1, outcome: "pr_opened", private_head: privateHead } })],
    );
  }
  /** The runner's record: the `run.status_changed` row of a run's `done`, with the head the cloud read from GitHub. */
  async function runnerRun(t: SeedRefs, branch: (runId: string) => string, headOid: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 'runner_local', $4)`, [id, t.accountId, t.workItemId, t.repoId]);
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [
      t.accountId, id, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: 3, branch: branch(id), headOid }),
    ]);
    return id;
  }

  beforeEach(async () => {
    // The list is across accounts: whatever earlier cases left behind is marked done so each case sees only its own items.
    await admin.query("UPDATE work_items SET stage = 'in_progress' WHERE stage IN ('merged', 'closed_unmerged', 'closed') AND id IN (SELECT work_item_id FROM plane_pushes)");
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    gh.refs.clear();
    gh.protectedRefs.clear();
    gh.calls.length = 0;
    gh.down = false;
    gh.stuck = null;
    gh.noInstall = false;
    gh.repoGone = false;
    logs.length = 0;
  });

  it("acceptance 1 and 6 (sandbox): an item moved to merged with a matching head has fx/issue-<n> deleted; the second pass lists nothing and calls nothing", async () => {
    await setItem(A, 41, "in_progress");
    await publishRun(A, HEAD);
    gh.refs.set("acme/widgets/fx/issue-41", HEAD);
    gh.refs.set("acme/widgets/main", MOVED);
    expect(await sweep()).toMatchObject({ configured: true, listed: 0, deleted: 0, nextDueAt: null });
    await admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [A.workItemId]);
    const first = await sweep();
    expect(first).toMatchObject({ listed: 1, deleted: 1, left: 0, recorded: 1, failed: 0 });
    expect([...gh.refs.keys()]).toEqual(["acme/widgets/main"]);
    expect(await cleanup(A)).toEqual([{ branch: "fx/issue-41", outcome: "deleted" }]);
    gh.calls.length = 0;
    expect(await sweep()).toMatchObject({ listed: 0, deleted: 0, recorded: 0, nextDueAt: null });
    expect(gh.calls).toEqual([]);
  });

  it("acceptance 6 (runner): a run branch fx/<run>-g<n> and the item's own fx/issue-<n> a run continued are both deleted, each at the head the cloud recorded for its run", async () => {
    await setItem(A, 43, "closed_unmerged");
    const first = await runnerRun(A, (id) => `fx/${id}-g1`, HEAD);
    const second = await runnerRun(A, () => "fx/issue-43", MOVED);
    gh.refs.set(`acme/widgets/fx/${first}-g1`, HEAD);
    gh.refs.set("acme/widgets/fx/issue-43", MOVED);
    expect(await sweep()).toMatchObject({ listed: 1, deleted: 2, left: 0, recorded: 1 });
    expect(gh.refs.size).toBe(0);
    expect((await cleanup(A))!.map((o) => o.outcome)).toEqual(["deleted", "deleted"]);
    expect(second).not.toBe(first);
  });

  it("acceptance 2: a head that differs from the recorded sha leaves the branch and records the reason on the item; a later pass does not touch it", async () => {
    await setItem(A, 44, "merged");
    await publishRun(A, HEAD);
    gh.refs.set("acme/widgets/fx/issue-44", MOVED);
    expect(await sweep()).toMatchObject({ listed: 1, deleted: 0, left: 1, recorded: 1 });
    expect(gh.refs.get("acme/widgets/fx/issue-44")).toBe(MOVED);
    expect(await cleanup(A)).toEqual([{ branch: "fx/issue-44", outcome: "head_changed" }]);
    gh.calls.length = 0;
    expect(await sweep()).toMatchObject({ listed: 0 });
    expect(gh.calls).toEqual([]);
  });

  it("a protected branch is left and recorded, never forced; a branch that is already gone counts as deleted", async () => {
    await setItem(A, 45, "closed");
    const run = await runnerRun(A, (id) => `fx/${id}-g1`, HEAD);
    await publishRun(A, HEAD);
    gh.refs.set(`acme/widgets/fx/${run}-g1`, HEAD);
    gh.protectedRefs.add(`acme/widgets/fx/${run}-g1`);
    expect(await sweep()).toMatchObject({ listed: 1, deleted: 0, left: 2, recorded: 1 });
    expect(await cleanup(A)).toEqual(expect.arrayContaining([{ branch: "fx/issue-45", outcome: "already_gone" }, { branch: `fx/${run}-g1`, outcome: "protected" }]));
    expect(gh.refs.has(`acme/widgets/fx/${run}-g1`)).toBe(true);
  });

  it("only the two shapes, and only for the run or item that recorded them: a recorded main, another run's branch and another item's number are never deleted", async () => {
    await setItem(A, 46, "merged");
    await runnerRun(A, () => "main", HEAD);
    await runnerRun(A, () => `fx/${OTHER_RUN}-g1`, HEAD);
    await runnerRun(A, () => "fx/issue-99", HEAD);
    for (const b of ["main", `fx/${OTHER_RUN}-g1`, "fx/issue-99"]) gh.refs.set(`acme/widgets/${b}`, HEAD);
    expect(await sweep()).toMatchObject({ listed: 1, deleted: 0, left: 0, recorded: 1 });
    expect(gh.refs.size).toBe(3);
    expect(await cleanup(A)).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it("an item GitHub could not be asked about is recorded as retrying with a backoff and listed again only when due; the next pass finishes it", async () => {
    await setItem(A, 47, "merged");
    await publishRun(A, HEAD);
    gh.refs.set("acme/widgets/fx/issue-47", HEAD);
    gh.down = true;
    const down = await sweep();
    expect(down).toMatchObject({ listed: 1, deleted: 0, recorded: 0, failed: 1 });
    expect(down.nextDueAt).toBe(Date.parse("2026-10-22T12:00:00Z") + 15 * 60_000);
    expect(await rowOf(A)).toEqual([{ state: "retrying", attempts: 1 }]);
    expect(logs.join("\n")).toContain('"branch_cleanup.failed"');
    expect(logs.join("\n")).not.toContain("acme");
    gh.down = false;
    // Backing off: not listed yet.
    expect(await sweep()).toMatchObject({ listed: 0 });
    await dueNow();
    expect(await sweep()).toMatchObject({ listed: 1, deleted: 1, recorded: 1, failed: 0 });
    expect(await rowOf(A)).toEqual([{ state: "final", attempts: 2 }]);
  });

  it("the fifth failed attempt is final (gave_up) and the item is not listed again", async () => {
    await setItem(A, 51, "merged");
    await publishRun(A, HEAD);
    gh.refs.set("acme/widgets/fx/issue-51", HEAD);
    gh.down = true;
    for (let n = 1; n <= 5; n++) {
      expect(await sweep()).toMatchObject({ listed: 1, failed: 1 });
      await dueNow();
    }
    expect(await rowOf(A)).toEqual([{ state: "final", attempts: 5 }]);
    expect(await cleanup(A)).toEqual([{ branch: "fx/issue-51", outcome: "gave_up" }]);
    expect(await sweep()).toMatchObject({ listed: 0 });
    expect(gh.refs.has("acme/widgets/fx/issue-51")).toBe(true);
  });

  it("a partial failure keeps what was reached: the branch deleted on the first pass is still `deleted` after the retry, not `already_gone`", async () => {
    await setItem(A, 52, "merged");
    const run = await runnerRun(A, (id) => `fx/${id}-g1`, HEAD);
    await publishRun(A, HEAD);
    gh.refs.set("acme/widgets/fx/issue-52", HEAD);
    gh.refs.set(`acme/widgets/fx/${run}-g1`, HEAD);
    gh.stuck = /^fx\/[0-9a-f-]{36}-g1$/;
    expect(await sweep()).toMatchObject({ deleted: 1, failed: 1 });
    expect(gh.refs.has("acme/widgets/fx/issue-52")).toBe(false);
    gh.stuck = null;
    await dueNow();
    expect(await sweep()).toMatchObject({ listed: 1, deleted: 1, recorded: 1 });
    expect((await cleanup(A))!.sort((x, y) => x.branch.localeCompare(y.branch))).toEqual([{ branch: `fx/${run}-g1`, outcome: "deleted" }, { branch: "fx/issue-52", outcome: "deleted" }].sort((x, y) => x.branch.localeCompare(y.branch)));
  });

  it("permanent failures are final at once: an installation that is gone (no_installation) and a repository that is gone (repo_gone)", async () => {
    await setItem(A, 53, "merged");
    await publishRun(A, HEAD);
    gh.noInstall = true;
    expect(await sweep()).toMatchObject({ listed: 1, recorded: 1, failed: 0 });
    expect(await cleanup(A)).toEqual([{ branch: "fx/issue-53", outcome: "no_installation" }]);
    expect(await sweep()).toMatchObject({ listed: 0 });
    gh.noInstall = false;
    await setItem(B, 54, "merged");
    await publishRun(B, HEAD);
    gh.repoGone = true;
    expect(await sweep()).toMatchObject({ listed: 1, recorded: 1, failed: 0 });
    expect(await cleanup(B)).toEqual([{ branch: "fx/issue-54", outcome: "repo_gone" }]);
  });

  it("stuck items cannot starve the account: 11 items that keep failing and one healthy later item in the same account, the healthy one is cleaned on the second pass", async () => {
    await setItem(A, 9000, "in_progress");
    const items: string[] = [];
    for (let n = 1; n <= 11; n++) {
      const id = randomUUID();
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4)", [id, A.accountId, A.repoId, 9000 + n]);
      await admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [id]);
      await admin.query("INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, 'acme/widgets-public', $4)", [A.accountId, id, A.repoId, "a".repeat(64)]);
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, envelope) VALUES ($1, $2, $3, 'plane_publish', 'production', 'succeeded', 'sandbox', $4, $5::jsonb)`,
        [randomUUID(), A.accountId, id, A.repoId, JSON.stringify({ publish: { private_head: HEAD } })],
      );
      gh.refs.set(`acme/widgets/fx/issue-${9000 + n}`, HEAD);
      items.push(id);
    }
    // The healthy item is the newest of the account.
    await admin.query("UPDATE work_items SET gh_number = 77, stage = 'merged', updated_at = now() + interval '1 hour' WHERE id = $1", [A.workItemId]);
    await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['docs/ops/']) ON CONFLICT (repo_id) DO NOTHING", [A.repoId, A.accountId]);
    await withTenant(appPool, A.accountId, (c) => stampPlanePush(c, { accountId: A.accountId, workItemId: A.workItemId, repoId: A.repoId }));
    await publishRun(A, HEAD);
    gh.refs.set("acme/widgets/fx/issue-77", HEAD);
    gh.stuck = /^fx\/issue-90\d\d$/;
    const first = await sweep();
    expect(first).toMatchObject({ listed: 10, failed: 10, deleted: 0 });
    expect(gh.refs.has("acme/widgets/fx/issue-77")).toBe(true);
    // The ten that failed are backing off, so the 11th stuck item and the healthy one now fill the window.
    const second = await sweep();
    expect(second).toMatchObject({ listed: 2, deleted: 1, failed: 1 });
    expect(gh.refs.has("acme/widgets/fx/issue-77")).toBe(false);
    expect(await cleanup(A)).toEqual([{ branch: "fx/issue-77", outcome: "deleted" }]);
    expect(items).toHaveLength(11);
  });

  it("reopen then close again: the first close's row does not hide the second; close, sweep, reopen, a new push record, close, sweep deletes the new branch", async () => {
    await setItem(A, 60, "merged");
    await closeMove(A, "merged");
    await publishRun(A, HEAD);
    gh.refs.set("acme/widgets/fx/issue-60", HEAD);
    expect(await sweep()).toMatchObject({ listed: 1, deleted: 1, recorded: 1 });
    expect(await sweep()).toMatchObject({ listed: 0 });
    // Reopened (legal move: closed_unmerged to in_progress, or closed to triaged), pushed a new branch with a new run, closed again.
    await admin.query("UPDATE work_items SET stage = 'in_progress' WHERE id = $1", [A.workItemId]);
    expect(await sweep()).toMatchObject({ listed: 0 });
    const run = await runnerRun(A, (id) => `fx/${id}-g1`, MOVED);
    gh.refs.set(`acme/widgets/fx/${run}-g1`, MOVED);
    await admin.query("UPDATE work_items SET stage = 'closed_unmerged' WHERE id = $1", [A.workItemId]);
    await closeMove(A, "closed_unmerged");
    expect(await sweep()).toMatchObject({ listed: 1, deleted: 1, recorded: 1 });
    expect(gh.refs.has(`acme/widgets/fx/${run}-g1`)).toBe(false);
    expect(await rowOf(A)).toEqual([{ state: "final", attempts: 1 }, { state: "final", attempts: 1 }]);
    expect(await sweep()).toMatchObject({ listed: 0 });
  });

  it("works across tenants one item at a time, and an unpaired item or one still open is left alone", async () => {
    await setItem(A, 48, "merged");
    await publishRun(A, HEAD);
    await setItem(B, 48, "closed");
    await publishRun(B, HEAD);
    gh.refs.set("acme/widgets/fx/issue-48", HEAD);
    const unpaired = await seedAccount(admin, randomUUID());
    await setItem(unpaired, 49, "merged", false);
    await publishRun(unpaired, HEAD);
    expect(await sweep()).toMatchObject({ listed: 2, recorded: 2, failed: 0 });
    // Both accounts' items name acme/widgets#48 in this fixture, so the branch goes once and the other finds it gone.
    expect([await cleanup(A), await cleanup(B)].map((o) => o?.[0]?.outcome).sort()).toEqual(["already_gone", "deleted"]);
    expect(await cleanup(unpaired)).toBeUndefined();
  });

  it("with no signing key the pass lists nothing, calls nothing and records nothing; the items stay for when it is set", async () => {
    await setItem(A, 50, "merged");
    await publishRun(A, HEAD);
    gh.refs.set("acme/widgets/fx/issue-50", HEAD);
    expect(await sweep({ signer: null })).toEqual({ configured: false, listed: 0, deleted: 0, left: 0, recorded: 0, failed: 0, nextDueAt: null });
    expect(gh.calls).toEqual([]);
    expect(await cleanup(A)).toBeUndefined();
    expect(await sweep()).toMatchObject({ listed: 1, deleted: 1 });
  });
});
