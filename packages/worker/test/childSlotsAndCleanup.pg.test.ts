import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { plannedFixture, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { InstallationTokenCache, createInstallationHttp, type AccessTokenRequester, type RunnerGitTicketSigner } from "@fx/github";
import { httpsRoundTrip, startStrictGithubServer, type LocalTlsServer } from "../../github/test/helpers/localTlsServer.js";
import type { GhReply, GhRequest } from "../../github/test/helpers/strictGithub.js";
import { reconcileHolder, type PrStateOpen } from "../src/prSlotReconcile.js";
import { sweepBranchCleanups } from "../src/branchCleanup.js";

/**
 * [pg] D#483 S5-b2c-3, acceptance 14 and 15: a planned PR child's slot and its branch cleanup, on the real schema as the real roles, over the real installation client and the strict
 * GitHub fetch (User-Agent, Authorization, API version). The GitHub below is a local TLS server (the shared strict rules first, then) that answers ONLY the shapes the code under test may send, and fails the test on any other request:
 *
 *   GET    /repos/:owner/:repo/pulls?head=<owner>:<branch>&state=all     (the slot read)
 *   GET    /repos/:owner/:repo                                           (the cleanup client's repository read)
 *   GET    /repos/:owner/:repo/git/ref/heads/<branch>                    (the recorded-head guard)
 *   DELETE /repos/:owner/:repo/git/refs/heads/<branch>                   (the one delete)
 *
 * A ref is answered 404 when missing and a second delete 422 (already deleted), as GitHub does. The installation client puts the branch in the path as it is (the slashes of
 * `fx/41-api` are part of the ref name); the percent-encoded single segment is the runner-local fence's form (localOnlyGithub), which the cleanup tests below do not use. Not faked
 * faithfully: rate limits, and the exact wording of every error.
 */
describe("a planned PR child's slot and branch cleanup [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let appKeyPem: string;
  let signer: RunnerGitTicketSigner;
  const HEAD = "a".repeat(40);
  const MOVED = "b".repeat(40);
  const PARENT_NUMBER = 41;
  const unexpected: string[] = [];

  interface FakePull { number: number; branch: string; state: "open" | "closed"; merged_at: string | null; closed_at: string | null }
  const gh = { pulls: [] as FakePull[], refs: new Map<string, string>(), calls: [] as string[] };
  const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
  /** The route of the strict TLS server: it applies the shared strict rules (User-Agent, Authorization, API version) first, then answers only the four shapes above. */
  const route = (req: GhRequest): GhReply => {
    const method = req.method;
    const line = `${method} ${req.path}${req.query ? `?${req.query}` : ""}`;
    gh.calls.push(line);
    if (method === "DELETE" && req.path === "/installation/token") return { status: 204, headers: {}, body: "" };
    const list = /^\/repos\/acme\/widgets\/pulls$/.exec(req.path);
    if (method === "GET" && list) {
      const head = new URLSearchParams(req.query ?? "").get("head") ?? "";
      const rows = gh.pulls.filter((p) => `acme:${p.branch}` === head).map((p) => ({
        number: p.number, state: p.state, closed_at: p.closed_at, merged_at: p.merged_at,
        head: { ref: p.branch, sha: "c".repeat(40), repo: { full_name: "acme/widgets" } }, base: { ref: "main", sha: "d".repeat(40), repo: { full_name: "acme/widgets" } },
      }));
      return json(200, rows);
    }
    if (method === "GET" && req.path === "/repos/acme/widgets") return json(200, { full_name: "acme/widgets", default_branch: "main" });
    const ref = /^\/repos\/acme\/widgets\/git\/(ref|refs)\/heads\/(.+)$/.exec(req.path);
    if (ref && method === "GET" && ref[1] === "ref") return gh.refs.has(ref[2]!) ? json(200, { ref: `refs/heads/${ref[2]}`, object: { sha: gh.refs.get(ref[2]!), type: "commit" } }) : json(404, { message: "Not Found" });
    if (ref && method === "DELETE" && ref[1] === "refs") {
      if (!gh.refs.has(ref[2]!)) return json(422, { message: "Reference does not exist" });
      gh.refs.delete(ref[2]!);
      return { status: 204, headers: {}, body: "" };
    }
    unexpected.push(line);
    return json(404, { message: "Not Found" });
  };
  let server: LocalTlsServer;
  /** The client's fetch goes through Node's real connection path to the local TLS server: the certificate and the host name are checked, `autoSelectFamily` is on, the `lookup` is called with `{ all: true }`. */
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
  const requester: AccessTokenRequester = async (p) => ({ token: "ghs_childtest1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions }, repositories: p.repositories ?? [] });
  const openClient = () =>
    createInstallationHttp({
      resolveInstallation: async () => ({ installationId: 42, appKind: "team" }),
      appCredentials: () => ({ appId: "12345", privateKeyPem: appKeyPem, webhookSecret: "unused" }),
      requester,
      cache: new InstallationTokenCache(),
      fetchImpl,
    });
  const openRead: PrStateOpen = async (_mode, target) => openClient()("read", target);

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    server = await startStrictGithubServer(route);
    appKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
    signer = { keyId: "ticket-key-1", privateKey: generateKeyPairSync("ed25519").privateKey };
  });
  afterAll(async () => {
    expect(unexpected).toEqual([]);
    await server.close();
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(async () => {
    // The sweeps list across accounts: what earlier cases left in a pull-request or final stage is moved out so each case sees only its own.
    await admin.query("UPDATE work_items SET stage = 'needs_human' WHERE stage IN ('pr_opened', 'changes_requested', 'review_passed')");
    await admin.query("UPDATE work_items SET stage = 'in_progress' WHERE stage IN ('merged', 'closed_unmerged', 'closed') AND id IN (SELECT work_item_id FROM plane_pushes)");
    gh.pulls.length = 0;
    gh.refs.clear();
    gh.calls.length = 0;
  });

  async function family(): Promise<PlannedFixture> {
    const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [f.t.repoId]);
    await admin.query("UPDATE work_items SET gh_number = $2, stage = 'pr_opened' WHERE id = $1", [f.parent, PARENT_NUMBER]);
    return f;
  }
  const enter = (f: PlannedFixture, id: string) =>
    admin.query("INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', 'pr_opened', '2026-10-01T00:00:00Z', 'control_plane', $3)", [f.t.accountId, id, `seed:${randomUUID()}`]);
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;
  /** A child at a pull-request stage, its build recorded the branch it used (the sandbox build's `child.binding`). */
  async function openChild(f: PlannedFixture, key: string): Promise<string> {
    const child = f.kids[key]!;
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [child]);
    await enter(f, child);
    const run = (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, execution_mode, spec_version_id) VALUES ($1, $2, 'executor', 'production', 'succeeded', 'sandbox', $3) RETURNING id`, [f.t.accountId, child, f.specV1])).rows[0]!.id;
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'child.binding', $3::jsonb)`, [f.t.accountId, run, JSON.stringify({ branch: `fx/${PARENT_NUMBER}-${key}` })]);
    return child;
  }

  describe("S5b2c3-14: slots", () => {
    it("a parent with its own open PR and two children with open PRs reads as three occupied slots, each on its own item; closing one child's PR frees only that child's slot", async () => {
      const f = await family();
      await enter(f, f.parent);
      const api = await openChild(f, "api");
      const ui = await openChild(f, "ui");
      gh.pulls.push({ number: 5, branch: "fx/issue-41", state: "open", merged_at: null, closed_at: null });
      gh.pulls.push({ number: 6, branch: "fx/41-api", state: "open", merged_at: null, closed_at: null });
      gh.pulls.push({ number: 7, branch: "fx/41-ui", state: "open", merged_at: null, closed_at: null });
      const held = async () => (await admin.query<{ id: string }>("SELECT id FROM work_items WHERE account_id = $1 AND stage = ANY($2::text[]) ORDER BY id", [f.t.accountId, ["pr_opened", "changes_requested", "review_passed"]])).rows.map((r) => r.id).sort();
      expect(await held()).toEqual([f.parent, api, ui].sort());
      for (const id of [f.parent, api, ui]) expect(await reconcileHolder(writerPool, openRead, f.t.accountId, id)).toBe("open");
      // each item asked for its own branch, never another's
      expect(gh.calls.map((c) => decodeURIComponent(c.split("head=")[1]!.split("&")[0]!)).sort()).toEqual(["acme:fx/41-api", "acme:fx/41-ui", "acme:fx/issue-41"]);
      // the child's PR closes: only that child moves, and only its slot frees
      gh.pulls.find((p) => p.number === 6)!.state = "closed";
      gh.pulls.find((p) => p.number === 6)!.closed_at = "2026-10-10T09:00:00Z";
      await admin.query("UPDATE pr_slot_reconciles SET checked_at = now() - interval '1 hour' WHERE account_id = $1", [f.t.accountId]);
      expect(await reconcileHolder(writerPool, openRead, f.t.accountId, api)).toBe("closed_unmerged");
      expect(await stageOf(api)).toBe("closed_unmerged");
      expect(await stageOf(ui)).toBe("pr_opened");
      expect(await stageOf(f.parent)).toBe("pr_opened");
      expect(await held()).toEqual([f.parent, ui].sort());
    });

    it("a merged child PR moves only the child to merged; the parent stays open", async () => {
      const f = await family();
      await enter(f, f.parent);
      const api = await openChild(f, "api");
      gh.pulls.push({ number: 6, branch: "fx/41-api", state: "closed", merged_at: "2026-10-11T08:00:00Z", closed_at: "2026-10-11T08:00:00Z" });
      expect(await reconcileHolder(writerPool, openRead, f.t.accountId, api)).toBe("merged");
      expect(await stageOf(api)).toBe("merged");
      expect(await stageOf(f.parent)).toBe("pr_opened");
      expect(gh.calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
    });

    it("an orphan child with a recorded binding is still read on its recorded branch; one without a record is left as it is, and nothing is asked of GitHub", async () => {
      const f = await family();
      const api = await openChild(f, "api");
      const ui = f.kids.ui!;
      await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [ui]);
      await enter(f, ui);
      await admin.query("DELETE FROM work_items WHERE id = $1", [f.parent]);
      gh.pulls.push({ number: 6, branch: "fx/41-api", state: "closed", merged_at: "2026-10-11T08:00:00Z", closed_at: "2026-10-11T08:00:00Z" });
      expect(await reconcileHolder(writerPool, openRead, f.t.accountId, api)).toBe("merged");
      gh.calls.length = 0;
      expect(await reconcileHolder(writerPool, openRead, f.t.accountId, ui)).toBe("no_pull_request");
      expect(gh.calls).toEqual([]);
    });
  });

  describe("S5b2c3-15: cleanup", () => {
    const sweep = () => sweepBranchCleanups({ pool: writerPool, signer, github: openClient(), now: () => Date.parse("2026-10-22T12:00:00Z"), log: () => undefined });
    /** The child is paired (it has its own push row) and its sandbox build's publish run recorded the private head. */
    async function pairedChild(f: PlannedFixture, key: string, stage: string): Promise<string> {
      const child = f.kids[key]!;
      await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['docs/ops/']) ON CONFLICT (repo_id) DO NOTHING", [f.t.repoId, f.t.accountId]);
      await withTenant(appPool, f.t.accountId, (c) => stampPlanePush(c, { accountId: f.t.accountId, workItemId: child, repoId: f.t.repoId }));
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, envelope) VALUES ($1, $2, $3, 'plane_publish', 'production', 'succeeded', 'sandbox', $4, $5::jsonb)`,
        [randomUUID(), f.t.accountId, child, f.t.repoId, JSON.stringify({ publish: { attempt_no: 1, outcome: "pr_opened", private_head: HEAD } })]);
      const run = (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, execution_mode, spec_version_id) VALUES ($1, $2, 'executor', 'production', 'succeeded', 'sandbox', $3) RETURNING id`, [f.t.accountId, child, f.specV1])).rows[0]!.id;
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'child.binding', $3::jsonb)`, [f.t.accountId, run, JSON.stringify({ branch: `fx/${PARENT_NUMBER}-${key}` })]);
      await admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [child, stage]);
      return child;
    }
    const deletes = () => gh.calls.filter((c) => c.startsWith("DELETE /repos"));
    const refsOf = () => [...gh.refs.keys()].sort();

    it("after the child's own PR merged, exactly one DELETE of refs/heads/fx/<parent#>-<key> is made under the recorded-sha guard; the parent's fx/issue-<n> and a sibling's branch get none", async () => {
      const f = await family();
      const api = await pairedChild(f, "api", "pr_opened");
      gh.refs.set("fx/41-api", HEAD);
      gh.refs.set("fx/issue-41", HEAD);
      gh.refs.set("fx/41-ui", HEAD);
      // a child whose PR is still open gets no DELETE
      expect(await sweep()).toMatchObject({ listed: 0, deleted: 0 });
      expect(deletes()).toEqual([]);
      await admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [api]);
      expect(await sweep()).toMatchObject({ listed: 1, deleted: 1, left: 0, recorded: 1, failed: 0 });
      expect(deletes()).toEqual(["DELETE /repos/acme/widgets/git/refs/heads/fx/41-api"]);
      expect(refsOf()).toEqual(["fx/41-ui", "fx/issue-41"]);
      expect((await admin.query("SELECT outcomes FROM branch_cleanups WHERE work_item_id = $1", [api])).rows[0].outcomes).toEqual([{ branch: "fx/41-api", outcome: "deleted" }]);
      // a replay deletes nothing twice
      gh.calls.length = 0;
      expect(await sweep()).toMatchObject({ listed: 0 });
      expect(deletes()).toEqual([]);
    });

    it("a PR closed unmerged is cleaned the same way", async () => {
      const f = await family();
      await pairedChild(f, "docs", "closed_unmerged");
      gh.refs.set("fx/41-docs", HEAD);
      expect(await sweep()).toMatchObject({ listed: 1, deleted: 1 });
      expect(refsOf()).toEqual([]);
    });

    it("a moved head (the sha differs) is not deleted", async () => {
      const f = await family();
      const api = await pairedChild(f, "api", "merged");
      gh.refs.set("fx/41-api", MOVED);
      expect(await sweep()).toMatchObject({ listed: 1, deleted: 0, left: 1, recorded: 1 });
      expect(deletes()).toEqual([]);
      expect((await admin.query("SELECT outcomes FROM branch_cleanups WHERE work_item_id = $1", [api])).rows[0].outcomes).toEqual([{ branch: "fx/41-api", outcome: "head_changed" }]);
    });

    it("an orphan with a recorded binding is still cleaned after its PR merged; one with no record deletes nothing", async () => {
      const f = await family();
      const api = await pairedChild(f, "api", "merged");
      const ui = f.kids.ui!;
      await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['docs/ops/']) ON CONFLICT (repo_id) DO NOTHING", [f.t.repoId, f.t.accountId]);
      await withTenant(appPool, f.t.accountId, (c) => stampPlanePush(c, { accountId: f.t.accountId, workItemId: ui, repoId: f.t.repoId }));
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, envelope) VALUES ($1, $2, $3, 'plane_publish', 'production', 'succeeded', 'sandbox', $4, $5::jsonb)`,
        [randomUUID(), f.t.accountId, ui, f.t.repoId, JSON.stringify({ publish: { attempt_no: 1, outcome: "pr_opened", private_head: HEAD } })]);
      await admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [ui]);
      await admin.query("DELETE FROM work_items WHERE id = $1", [f.parent]);
      gh.refs.set("fx/41-api", HEAD);
      gh.refs.set("fx/41-ui", HEAD);
      await sweep();
      expect(deletes()).toEqual(["DELETE /repos/acme/widgets/git/refs/heads/fx/41-api"]);
      expect(refsOf()).toEqual(["fx/41-ui"]);
      expect(api).not.toBe(ui);
    });
  });
});
