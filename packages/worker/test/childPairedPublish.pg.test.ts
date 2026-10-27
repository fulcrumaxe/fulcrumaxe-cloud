import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { plannedFixture, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { InstallationTokenCache, createHostedPlanePush, createInstallationHttp, createPlanePushApi, type AccessTokenRequester } from "@fx/github";
import { createFakeSandbox, recordChildCodePullRequest, type AgentRuntime, type NetworkPolicyRule, type PlanePublishLine } from "@fx/runner";
import { pullRequestBody, type RunPullRequestPort, type RunPullRequestText } from "@fx/runner-cloud";
import { phaseLine } from "../../runner/src/planePublish/protocol.js";
import { httpsRoundTrip, startStrictGithubServer, type LocalTlsServer } from "../../github/test/helpers/localTlsServer.js";
import { ghError, type GhReply, type GhRequest } from "../../github/test/helpers/strictGithub.js";
import { FIX_BASE_EVENT } from "../src/fixRoundBase.js";
import { childTextRefused, createPlanePublish, type PlanePublishDeps } from "../src/planePublish.js";
import { reconcileHolder, type PrStateOpen } from "../src/prSlotReconcile.js";

/**
 * [pg] D#483 S5-b2c-4, acceptance 2, 4 and 7 (and the publish half of 3): a planned PR child's change to its paired PUBLIC repository, on the real schema as the real roles.
 *
 * The GitHub below is a local TLS server (the shared strict rules first: User-Agent, API version, Authorization, App JWT) that answers ONLY the exact shapes the code under test may send, and fails
 * the test on any other request or on any request that names the parent's `fx/issue-41`. Both sides of the pair are reached through it, over Node's real connection path (certificate and host name
 * checked, `autoSelectFamily` on, `lookup` called with `{ all: true }`): the private repository's branch reads through the real installation client, and the public repository's `verifyPushed`,
 * `verifyPullRequest` through the real hosted push adapter.
 *
 *   private (acme/widgets):         GET /repos/acme/widgets/git/ref/heads/<branch>        (the private head and the default branch's tip)
 *   public  (acme/widgets-public):  GET /repos/acme/widgets-public/installation, GET .../git/ref/heads/<fx/p-id>, GET .../git/commits/<sha>, GET .../compare/main...<tip>, GET .../pulls/<n>
 *
 * Not faked faithfully: GitHub's rate limits, the exact wording of its errors, and the private repository's pull request API (the draft is opened through the same `RunPullRequestPort` seam the
 * runner's `done` uses, recorded here; its own HTTP contract is exercised in packages/runner-cloud). The sandbox is the runner package's strict fake.
 */
describe("a planned PR child's paired publish [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let appKeyPem: string;
  let server: LocalTlsServer;
  const PARENT_NUMBER = 41;
  const BASE = "a".repeat(40);
  const PRIVATE_HEAD = "b".repeat(40);
  const DEFAULT_TIP = "9".repeat(40);
  const HEAD = "c".repeat(40);
  const TIP = "d".repeat(40);
  const NEW_HEAD = "1".repeat(40);
  const NEW_TIP = "2".repeat(40);
  const FIX_BASE = "f".repeat(40);
  const POLICY: NetworkPolicyRule[] = [{ host: "gh-proxy.fixture.test", purpose: "github_proxy" }];
  const noRuntime = { start: async () => undefined, stop: async () => undefined, resume: async () => undefined } as unknown as AgentRuntime;
  const unexpected: string[] = [];
  const say = (...lines: PlanePublishLine[]) => ({ exitCode: 0, stdout: lines.map((l) => phaseLine(l)).join("\n") + "\n" });

  /** What GitHub holds for the test; the public branch's name is the push row's, set when a case knows it. */
  const world = { publicBranch: "", publicHead: HEAD, publicParents: [TIP], prHeadRepo: "acme/widgets-public", prOpen: true, merged: false };
  const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });

  const route = (req: GhRequest): GhReply => {
    const line = `${req.method} ${req.path}${req.query ? `?${req.query}` : ""}`;
    if (req.method === "DELETE" && req.path === "/installation/token") return { status: 204, headers: {}, body: "" };
    if (/issue-41/.test(line)) unexpected.push(`parent's branch asked: ${line}`);
    if (req.path === "/repos/acme/widgets-public/installation") return json(200, { id: 42 });
    // the private repository: the child's own branch and the default branch
    if (req.method === "GET" && req.path === "/repos/acme/widgets/git/ref/heads/fx/41-api") return json(200, { object: { sha: PRIVATE_HEAD } });
    if (req.method === "GET" && req.path === "/repos/acme/widgets/git/ref/heads/main") return json(200, { object: { sha: DEFAULT_TIP } });
    // the public repository
    if (req.method === "GET" && world.publicBranch !== "" && req.path === `/repos/acme/widgets-public/git/ref/heads/${world.publicBranch}`) return json(200, { object: { sha: world.publicHead } });
    if (req.method === "GET" && req.path === `/repos/acme/widgets-public/git/commits/${world.publicHead}`) return json(200, { sha: world.publicHead, parents: world.publicParents.map((sha) => ({ sha })) });
    if (req.method === "GET" && /^\/repos\/acme\/widgets-public\/compare\/main\.\.\.[0-9a-f]{40}$/.test(req.path)) return json(200, { status: "behind" });
    // the stage follower's read of the public pull request (the merge order's step "the item's stage follows the public pull request")
    if (req.method === "GET" && req.path === "/repos/acme/widgets-public/pulls" && world.publicBranch !== "" && new URLSearchParams(req.query ?? "").get("head") === `acme:${world.publicBranch}` && new URLSearchParams(req.query ?? "").get("state") === "all") {
      const head = { ref: world.publicBranch, sha: world.publicHead, repo: { full_name: "acme/widgets-public" } };
      const at = world.merged ? new Date(Date.now() - 30_000).toISOString() : null;
      return json(200, [{ number: 9, state: world.merged ? "closed" : "open", closed_at: at, merged_at: at, head, base: { ref: "main", sha: TIP, repo: { full_name: "acme/widgets-public" } } }]);
    }
    if (req.method === "GET" && req.path === "/repos/acme/widgets-public/pulls/9") {
      return json(200, { number: 9, state: world.prOpen ? "open" : "closed", merged: false, html_url: "https://github.com/acme/widgets-public/pull/9", head: { ref: world.publicBranch, repo: { full_name: world.prHeadRepo } }, base: { ref: "main" } });
    }
    unexpected.push(line);
    return ghError(404, "Not Found");
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const r = await httpsRoundTrip(
      {
        host: "api.github.com", port: server.port, path: url.pathname + url.search, method: init?.method ?? "GET", headers: { "user-agent": "node", ...(init?.headers as Record<string, string>) }, ca: server.ca, servername: "api.github.com",
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never,
      },
      init?.body as string | undefined,
    );
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  const requester: AccessTokenRequester = async (p) => ({ token: `ghs_child${Math.random().toString(36).slice(2, 8)}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions }, repositories: p.repositories ?? [] });
  const credentials = () => ({ appId: "12345", privateKeyPem: appKeyPem, webhookSecret: "unused" });
  const openPrivate = () =>
    createInstallationHttp({ resolveInstallation: async () => ({ installationId: 42, appKind: "team" }), appCredentials: credentials, requester, cache: new InstallationTokenCache(), fetchImpl });

  let fake: ReturnType<typeof createFakeSandbox>;
  let output: () => { exitCode: number; stdout: string };
  const drafts: Array<{ branch: string; base: string; run: RunPullRequestText }> = [];
  const draftPort: RunPullRequestPort = {
    defaultBranch: async () => "main",
    branchState: async () => ({ exists: true, headOid: PRIVATE_HEAD, aheadBy: 1, defaultBranch: "main" }),
    openDraft: async (i) => (drafts.push({ branch: i.branch, base: i.base, run: i.run }), { number: 5, nodeId: "PR_node", draft: true, reused: false }),
    changedFiles: async () => ({ files: [], totalCount: 0, complete: true }),
    markReady: async () => undefined,
    close: async () => undefined,
  };

  function deps(): PlanePublishDeps {
    const port = fake.port;
    const api = createPlanePushApi({ appCredentials: credentials, requester, cache: new InstallationTokenCache(), fetchImpl });
    const hosted = createHostedPlanePush(api, { ownsInstallation: async (_account, id) => id === 42 });
    const readRef = async (repo: { id: string; owner: string; name: string }, branch: string): Promise<string | null> => {
      const client = await openPrivate()("read", { repoId: repo.id, owner: repo.owner, name: repo.name });
      const res = await client.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/git/ref/heads/${branch}` });
      if (res.status === 404) return null;
      return (res.body as { object: { sha: string } }).object.sha;
    };
    return {
      pool: writerPool,
      port: { ...port, createSandbox: async (o) => (fake.scriptCommand(o.sandboxName, output()), port.createSandbox(o)) } as PlanePublishDeps["port"],
      hook: () => "// the built hook",
      networkPolicy: async () => POLICY,
      identity: () => ({ name: "Fulcrumaxe Bot", email: "bot@example.com" }),
      privateHead: ({ repo, branch }) => readRef(repo, branch),
      privateDefaultHead: ({ repo }) => readRef(repo, "main"),
      hosted: { verifyPushed: hosted.verifyPushed, verifyPullRequest: hosted.verifyPullRequest, openPullRequest: hosted.openPullRequest, branchHead: hosted.branchHead },
      pullRequests: draftPort,
      now: () => 1_000_000,
    };
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    appKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
    server = await startStrictGithubServer(route);
  });
  afterAll(async () => {
    expect(unexpected).toEqual([]);
    await server.close();
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(() => {
    fake = createFakeSandbox(noRuntime);
    drafts.length = 0;
    server.seen.length = 0;
    Object.assign(world, { publicBranch: "", publicHead: HEAD, publicParents: [TIP], prHeadRepo: "acme/widgets-public", prOpen: true, merged: false });
  });

  interface Family { f: PlannedFixture; child: string; sibling: string }
  /** A parent with an approved Spec, two children, a pairing, and the child `api` started: its sandbox build succeeded and recorded its branch; the child's push record is stamped (the parent has none). */
  async function family(footer: string | null = null): Promise<Family & { run: string }> {
    const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [f.t.repoId]);
    await admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [f.parent, PARENT_NUMBER]);
    await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs, pr_footer) VALUES ($1, $2, 'acme/widgets-public', ARRAY['docs/ops/'], $3)`, [f.t.repoId, f.t.accountId, footer]);
    const child = f.kids["api"]!;
    const sibling = f.kids["ui"]!;
    await admin.query("UPDATE work_items SET stage = 'in_progress', envelope_id = (SELECT envelope_id FROM work_items WHERE id = $2), title = 'Add `the` API Closes #1' WHERE id = $1", [child, f.parent]);
    await withTenant(appPool, f.t.accountId, (c) => stampPlanePush(c, { accountId: f.t.accountId, workItemId: child, repoId: f.t.repoId }));
    const run = await executorRun(f, child, "fx/41-api");
    return { f, child, sibling, run };
  }
  async function executorRun(f: PlannedFixture, child: string, branch: string): Promise<string> {
    const run = (await admin.query<{ id: string }>(
      `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, head_sha, spec_version_id) VALUES ($1, $2, 'executor', 'production', 'succeeded', 'sandbox', $3, $4, $5) RETURNING id`,
      [f.t.accountId, child, f.t.repoId, BASE, f.specV1],
    )).rows[0]!.id;
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'child.binding', $3::jsonb)`, [f.t.accountId, run, JSON.stringify({ branch })]);
    return run;
  }
  const pushes = async (f: PlannedFixture) => (await admin.query<{ id: string; work_item_id: string; branch: string; state: string; head_sha: string | null; pr_number: number | null }>("SELECT id, work_item_id, branch, state, head_sha, pr_number FROM plane_pushes WHERE account_id = $1", [f.t.accountId])).rows;
  const bindings = async (f: PlannedFixture) => (await admin.query<{ run_id: string; payload: Record<string, unknown> }>("SELECT run_id, payload FROM run_events WHERE account_id = $1 AND kind = 'child.binding_pr'", [f.t.accountId])).rows;
  const inputOf = () => JSON.parse(fake.state.writtenFiles.filter((w) => w.path.endsWith("input.json")).pop()!.content) as { branch: string; title: string; body: string; privateHead: string; privateBase: string };
  const prOpened = (): PlanePublishLine => ({ phase: "pr_opened", branch: undefined, head_sha: HEAD, tip_sha: TIP, pr_number: 9 });

  it("S5b2c4-2 and 4: the private head lookup and the private draft use fx/<parent#>-<key>; no request names fx/issue-<parent#>; the child has its one push record and the parent none; after the hosted side confirms the pull request, the run holds one code-plane binding, and a second record adds nothing", async () => {
    const k = await family();
    const [row] = await pushes(k.f);
    world.publicBranch = row!.branch;
    output = () => say(prOpened());
    const r = await createPlanePublish(deps()).settlePairedBuild({ accountId: k.f.t.accountId, executorRunId: k.run });
    expect(r).toEqual({ privatePullRequest: "opened", publish: { kind: "published", state: "pr_opened", attemptNo: 1 } });

    // the strict GitHub saw the child's branch (and the default branch), never the parent's
    const paths = server.seen.map((s) => `${s.method} ${s.path}`);
    expect(paths).toContain("GET /repos/acme/widgets/git/ref/heads/fx/41-api");
    expect(paths.some((p) => p.includes("issue-41"))).toBe(false);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ branch: "fx/41-api", base: "main" });
    // the hook was given the child's private head and the push row's public branch, never a name the agent chose
    expect(inputOf()).toMatchObject({ privateHead: PRIVATE_HEAD, privateBase: BASE, branch: row!.branch });
    // one record for the child, none for the parent or the sibling
    const all = await pushes(k.f);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ work_item_id: k.child, state: "pr_opened", pr_number: 9, head_sha: HEAD });

    // the binding: exactly one, on the child's executor run, from the code plane
    expect(await bindings(k.f)).toEqual([{ run_id: k.run, payload: { branch: row!.branch, prNumber: 9, plane: "code", codeRepo: "acme/widgets-public" } }]);
    expect(await withTenant(writerPool, k.f.t.accountId, (c) => recordChildCodePullRequest(c, k.f.t.accountId, k.run, { branch: row!.branch, prNumber: 9, codeRepo: "acme/widgets-public" }))).toBe(false);
    expect(await withTenant(writerPool, k.f.t.accountId, (c) => recordChildCodePullRequest(c, k.f.t.accountId, k.run, { branch: row!.branch, prNumber: 77, codeRepo: "acme/other" }))).toBe(false);
    expect(await bindings(k.f)).toHaveLength(1);
  });

  it("S5b2c4-3 (publish half): the public body carries no #<number> (the parent's is a private-repo number), and the private draft's text names the parent and no closing keyword; the title reaches both only cleaned; a footer that would close the parent is left off with child_closing_keyword", async () => {
    const k = await family("Closes #{issue_number}");
    const [row] = await pushes(k.f);
    world.publicBranch = row!.branch;
    output = () => say(prOpened());
    await createPlanePublish(deps()).settlePairedBuild({ accountId: k.f.t.accountId, executorRunId: k.run });

    const input = inputOf();
    expect(input.body).not.toMatch(/(?:^|[^\w])#\d/); // no #<parent> on the public plane
    expect(input.body).not.toMatch(/closes|fixes|resolves/i);
    expect(input.title).toBe("this planned PR"); // the stored title reads as a closing keyword
    // the private draft: text from our rows, the parent's number, never the child's own
    const text = drafts[0]!.run;
    expect(text).toMatchObject({ issueNumber: null, parentIssueNumber: PARENT_NUMBER });
    const body = pullRequestBody(text);
    expect(body).toContain("Refs #41");
    expect(body).not.toMatch(/(closes|fixes|resolves) #/i);
    expect(text.workItemTitle).toBe("this planned PR");
    // the run says why the footer is not there
    const notice = await admin.query<{ payload: { reason: string } }>("SELECT payload FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = 'plane.pr_footer_skipped'", [k.f.t.accountId, k.run]);
    expect(notice.rows.map((n) => n.payload)).toEqual([{ reason: "child_issue_placeholder" }]);

    // every other footer with the placeholder is left off too (the parent's number means nothing on the public plane); one without it renders as written
    for (const footer of ["Part of D#{issue_number}", "Closes GH-{issue_number}", "See https://github.com/acme/widgets-public/issues/{issue_number}"]) {
      const kx = await family(footer);
      world.publicBranch = (await pushes(kx.f))[0]!.branch;
      await createPlanePublish(deps()).settlePairedBuild({ accountId: kx.f.t.accountId, executorRunId: kx.run });
      expect(inputOf().body).not.toMatch(/part of|closes|see |gh-|(?:^|[^\w])#\d/i);
    }
    const k2 = await family("Part of the Acme roadmap");
    world.publicBranch = (await pushes(k2.f))[0]!.branch;
    await createPlanePublish(deps()).settlePairedBuild({ accountId: k2.f.t.accountId, executorRunId: k2.run });
    expect(inputOf().body).toContain("Part of the Acme roadmap");
    // the final text guard: a footer stored outside the save-time check never makes it refuse (it is left off first), and a literal closing one is left off
    expect(childTextRefused("t", "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", "Closes GH-{issue_number}", { issueNumber: 41, isChild: true })).toBe(false);
    expect(childTextRefused("t", "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e", "Fixes https://github.com/a/b/issues/3", { issueNumber: 41, isChild: true })).toBe(false);
  });

  it("'Open the pull request again' for a child whose parent was deleted is refused with the resolver's code BEFORE any attempt row exists", async () => {
    const k = await family();
    const [row] = await pushes(k.f);
    await admin.query("UPDATE plane_pushes SET state = 'pushed_pr_not_opened', head_sha = $2, tip_sha = $3 WHERE id = $1", [row!.id, HEAD, TIP]);
    // no recorded branch (so `observe` falls back to the live parent) and no parent: the resolver refuses
    await admin.query("DELETE FROM run_events WHERE account_id = $1 AND kind = 'child.binding'", [k.f.t.accountId]);
    await admin.query("DELETE FROM work_items WHERE id = $1", [k.f.parent]);
    const r = await createPlanePublish(deps()).openPublicPullRequest({ accountId: k.f.t.accountId, workItemId: k.child });
    expect(r).toEqual({ kind: "refused", code: "child_orphaned", attemptNo: null });
    expect((await admin.query("SELECT 1 FROM plane_push_attempts WHERE account_id = $1", [k.f.t.accountId])).rowCount).toBe(0);
  });

  it("S5b2c4-7: a paired fix round republishes ONE new commit to the child's own public branch; the parent's public branch is neither read nor moved", async () => {
    const k = await family();
    const [row] = await pushes(k.f);
    world.publicBranch = row!.branch;
    await admin.query("UPDATE plane_pushes SET state = 'pr_opened', head_sha = $2, tip_sha = $3, pr_number = 9, pr_url = 'https://github.com/acme/widgets-public/pull/9' WHERE id = $1", [row!.id, HEAD, TIP]);
    // the round's run: a continuation of the child's branch, carrying the base the cloud signed (the fix round's create transaction writes it)
    const round = await executorRun(k.f, k.child, "fx/41-api");
    await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 2, $3, $4)", [k.f.t.accountId, round, FIX_BASE_EVENT, JSON.stringify({ base_sha: FIX_BASE, branch: "fx/41-api" })]);
    world.publicHead = NEW_HEAD;
    world.publicParents = [NEW_TIP];
    output = () => say({ phase: "updated", head_sha: NEW_HEAD, tip_sha: NEW_TIP });
    const r = await createPlanePublish(deps()).settlePairedBuild({ accountId: k.f.t.accountId, executorRunId: round });
    expect(r).toEqual({ privatePullRequest: "skipped", publish: { kind: "updated", attemptNo: 1 } });

    expect(inputOf()).toMatchObject({ branch: row!.branch, privateBase: FIX_BASE, privateHead: PRIVATE_HEAD });
    const after = await pushes(k.f);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: row!.id, work_item_id: k.child, state: "pr_opened", head_sha: NEW_HEAD, pr_number: 9 });
    // every public read was on the child's own branch; the parent has no public branch to read
    const publicRefs = server.seen.filter((s) => s.path.startsWith("/repos/acme/widgets-public/git/ref/heads/")).map((s) => s.path.split("/git/ref/heads/")[1]);
    expect(publicRefs.length).toBeGreaterThan(0);
    expect(new Set(publicRefs)).toEqual(new Set([row!.branch]));
    // no second pull request, no new binding
    expect(drafts).toHaveLength(0);
    expect(await bindings(k.f)).toHaveLength(0);
  });

  it("S5b2c4-9: after the public pull request merges, the stage follower (the merge order's last step) moves ONLY the child to merged: it reads the child's own public branch, and the parent stays open with no push record", async () => {
    const k = await family();
    const [row] = await pushes(k.f);
    world.publicBranch = row!.branch;
    output = () => say(prOpened());
    await createPlanePublish(deps()).settlePairedBuild({ accountId: k.f.t.accountId, executorRunId: k.run });
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = ANY($1::uuid[])", [[k.child, k.f.parent]]);
    await admin.query("INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', 'pr_opened', '2026-10-01T00:00:00Z', 'control_plane', $3), ($1, $4, 'in_progress', 'pr_opened', '2026-10-01T00:00:00Z', 'control_plane', $5)", [k.f.t.accountId, k.child, `seed:${randomUUID()}`, k.f.parent, `seed:${randomUUID()}`]);
    const open: PrStateOpen = async (_mode, target) => openPrivate()("read", target);
    server.seen.length = 0;
    // still open on GitHub: nothing moves
    expect(await reconcileHolder(writerPool, open, k.f.t.accountId, k.child)).toBe("open");
    await admin.query("UPDATE pr_slot_reconciles SET checked_at = now() - interval '1 hour' WHERE account_id = $1", [k.f.t.accountId]);
    world.merged = true;
    expect(await reconcileHolder(writerPool, open, k.f.t.accountId, k.child)).toBe("merged");
    const stage = async (id: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;
    expect(await stage(k.child)).toBe("merged");
    expect(await stage(k.f.parent)).toBe("pr_opened");
    expect(await stage(k.sibling)).not.toBe("merged");
    // every read was of the child's public branch in the public repository
    const reads = server.seen.filter((s) => s.path === "/repos/acme/widgets-public/pulls").map((s) => new URLSearchParams(s.query ?? "").get("head"));
    expect(new Set(reads)).toEqual(new Set([`acme:${row!.branch}`]));
    expect((await pushes(k.f)).map((p) => p.work_item_id)).toEqual([k.child]);
  });

  it("a child whose parent was deleted is refused with the resolver's code on its push record (not bad_input), and nothing is started", async () => {
    const k = await family();
    const [row] = await pushes(k.f);
    world.publicBranch = row!.branch;
    await admin.query("DELETE FROM work_items WHERE id = $1", [k.f.parent]);
    output = () => say(prOpened());
    const r = await createPlanePublish(deps()).publishPairedChange({ accountId: k.f.t.accountId, executorRunId: k.run });
    expect(r).toEqual({ kind: "refused", code: "child_orphaned", attemptNo: null });
    expect(fake.state.created).toHaveLength(0);
    expect((await pushes(k.f))[0]).toMatchObject({ state: "refused" });
    expect((await admin.query("SELECT code FROM plane_pushes WHERE id = $1", [row!.id])).rows[0]!.code).toBe("child_orphaned");
  });
});
