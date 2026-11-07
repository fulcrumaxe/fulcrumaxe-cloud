import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEQUEUE_PULL_REQUEST_DOCUMENT, ENABLE_AUTO_MERGE_DOCUMENT, ENQUEUE_PULL_REQUEST_DOCUMENT, InstallationTokenCache, MERGE_QUEUE_ENTRY_DOCUMENT, MERGE_QUEUE_READ_DOCUMENT, createInstallationHttp, type AccessTokenRequester } from "@fx/github";
import { LocalOnlyGithubError, type GithubClient } from "@fx/runner-cloud";
import { readPublicPullRequest, runMergeGateForItem } from "@fx/pipeline";
import { clearMergeQueueModeCache, type GitHubHttp } from "../../pipeline/src/build/githubMergePort.js";
import { createPool } from "@fx/db/src/pool.js";
import { strictGithubFetch } from "../../github/test/helpers/strictGithub.js";
import { discussingItem } from "../../pipeline/test/plan/helpers/panelFixtures.js";
import { seedAccount, seedRepo } from "../../pipeline/test/build/helpers/seed.js";
import { fakeGitHubLocal } from "../../pipeline/test/review/helpers/fakeGitHubLocal.js";
import { fakeGitHubRest, freshRepo, type FakeRepoState } from "../../pipeline/test/review/helpers/fakeGitHubRest.js";

/**
 * [pg] The merge gate of a PAIRED item run end to end through the REAL GitHub installation client (`createInstallationHttp`, `merge_gate` kind, the token
 * minter, every path and method rule it keeps) over the strict GitHub fetch (User-Agent, Accept, API version, bearer token), on top of the strict GitHub
 * fakes the pipeline's own gate tests use. The pipeline's tests hand the gate the fakes directly, which skips the client's own refusals; this file does not,
 * so every call the gate makes is proven to be one the production client sends.
 *
 * Two shapes, both opened the way apps/web opens them (advanceReview.ts and github/localOnlyHttp.ts):
 *  - a hosted pair: both repositories' plain `merge_gate` clients. The public content check, the ordering read and the queue read all go through.
 *  - a `runner_local` pair: each client opened with `allowGraphql` and put behind runner-cloud's `localOnlyGithub` fence (the code repository's without A10),
 *    the fence in front of the real client, as `fenceInstallationHttp` builds it.
 *
 * Not faked faithfully: GitHub's own answers to a compare of odd ref names, rate limits, and whether the App's installation covers the code repository.
 */
const BOT_LOGIN = "fulcrumaxe-app[bot]";
const BOT_TRUST = { botLogins: async () => [BOT_LOGIN], allowlist: () => null };
const HEAD = "a".repeat(40);
const PUB_HEAD = "c".repeat(40);
const PUB_PR = 12;
const BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";
const green = { name: "build", status: "completed", conclusion: "success" };
const QUEUE_DOCUMENTS = { read: MERGE_QUEUE_READ_DOCUMENT, enqueue: ENQUEUE_PULL_REQUEST_DOCUMENT, autoMerge: ENABLE_AUTO_MERGE_DOCUMENT, dequeue: DEQUEUE_PULL_REQUEST_DOCUMENT, entry: MERGE_QUEUE_ENTRY_DOCUMENT };

let adminPool: Pool;
let admin: PoolClient;
let writerPool: Pool;
let appKeyPem: string;
beforeAll(async () => {
  adminPool = createPool(process.env.WORKER_DATABASE_URL!);
  admin = await adminPool.connect();
  writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  appKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
});
afterAll(async () => {
  admin.release();
  await adminPool.end();
  await writerPool.end();
});
beforeEach(() => clearMergeQueueModeCache());

/** What the real client refused (its error reason, method and path) and every request that reached the fake GitHub. */
interface Trace {
  refused: string[];
  sent: string[];
}

/** The production `merge_gate` client for one repository, whose transport is `answer` behind the strict GitHub fetch. */
function realClient(owner: string, name: string, answer: (req: { method: string; path: string; query?: Record<string, string>; accept?: string; body?: unknown }) => Promise<{ status: number; body: unknown }>, trace: Trace, opts: { allowGraphql?: boolean } = {}) {
  const requester: AccessTokenRequester = async (p) => ({ token: "fake-install-token-gate", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions } as Record<string, string>, repositories: p.repositories ?? [] });
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 42, appKind: "team" }),
    appCredentials: () => ({ appId: "12345", privateKeyPem: appKeyPem, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl: strictGithubFetch((async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      trace.sent.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const out = await answer({ method: init?.method ?? "GET", path: url.pathname, ...(Object.keys(query).length > 0 ? { query } : {}), ...(headers.accept ? { accept: headers.accept } : {}), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch),
  });
  const opened = open("merge_gate", { repoId: randomUUID(), owner, name, ...(opts.allowGraphql ? { allowGraphql: true } : {}) });
  return {
    async request(req: { method: string; path: string; query?: Readonly<Record<string, string | number>>; body?: unknown }) {
      try {
        return await (await opened).request({ method: req.method as "GET", path: req.path, ...(req.query !== undefined ? { query: req.query } : {}), ...(req.body !== undefined ? { body: req.body } : {}) });
      } catch (err) {
        trace.refused.push(`${(err as { reason?: string }).reason ?? (err as Error).name} ${req.method} ${req.path}`);
        throw err;
      }
    },
  };
}

/** A hosted repository: the real client over the REST fake. */
function hostedHttp(s: FakeRepoState, trace: Trace): GitHubHttp {
  const fake = fakeGitHubRest(s);
  return realClient(s.owner, s.name, (r) => fake.request({ method: r.method as "GET", path: r.path, ...(r.query ? { query: r.query } : {}), ...(r.body !== undefined ? { body: r.body } : {}) }), trace) as GitHubHttp;
}

/** A runner_local repository: the fence (runner-cloud's `localOnlyGithub`) in front of the real client (GraphQL allowed, as `openForRepo` opens it), over the strict local-only fake. */
function fencedLocal(s: FakeRepoState & { runBranch?: string }, trace: Trace, opts: { exclude?: readonly string[] } = {}) {
  return fakeGitHubLocal(s, {
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
    transport: (inner: GithubClient): GithubClient => ({
      request: (req) =>
        realClient(s.owner, s.name, (r) => inner.request({ method: r.method, path: r.path, ...(r.query ? { query: r.query } : {}), headers: { accept: r.accept ?? "" }, ...(r.body !== undefined ? { body: r.body } : {}) }), trace, { allowGraphql: true }).request(req),
    }),
  });
}

async function world(o: { local: boolean; pub?: Partial<FakeRepoState> }) {
  const accountId = randomUUID();
  const repoId = randomUUID();
  await seedAccount(admin, accountId);
  await seedRepo(admin, accountId, repoId);
  const mode = o.local ? "runner_local" : "sandbox";
  await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = $2, settings = $3::jsonb WHERE id = $1", [repoId, mode, JSON.stringify({ autoMerge: true })]);
  const ghRepoId = Number((await admin.query("SELECT gh_repo_id FROM repos WHERE id = $1", [repoId])).rows[0].gh_repo_id);
  const { workItemId } = await discussingItem(writerPool, accountId, { title: "Add a footer", body: "Show the year in the footer.", category: "feature", repoId });
  await admin.query("UPDATE work_items SET gh_number = 7, repo_id = $2, stage = 'pr_opened', provenance = 'internal' WHERE id = $1", [workItemId, repoId]);
  const body = "1. The footer shows the year.";
  await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')", [accountId, workItemId, body, createHash("sha256").update(body).digest("hex")]);
  const file = (filename: string) => ({ filename, status: "modified", sha: "f".repeat(40), changes: 1, ...(o.local ? {} : { patch: "@@ -1 +1 @@\n+x" }) });
  const priv = freshRepo({ ghId: ghRepoId, headSha: HEAD, draft: o.local, checks: { [HEAD]: [green] }, protectedWithoutChecks: true, runBranch: BRANCH, files: [file("src/ui/button.tsx")] });
  if (o.local) {
    const userId = randomUUID();
    await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@fixture.test`]);
    await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [accountId, userId]);
    const runnerId = randomUUID();
    const k = randomUUID().replace(/-/g, "").padEnd(43, "k");
    await admin.query("INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, $4::jsonb, $5, 'subscription')", [runnerId, accountId, userId, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: k }), k]);
    const executor = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, runner_id) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 'runner_local', $4)", [executor, accountId, workItemId, runnerId]);
    await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)", [accountId, executor, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: priv.prNumber, branch: BRANCH })]);
    for (const role of ["code-reviewer", "acceptance-tester", "security-reviewer"]) {
      await admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode, runner_id) VALUES ($1, $2, $3, 'runner', 'succeeded', '{\"verdict\":\"pass\"}'::jsonb, $4, 'runner_local', $5)", [accountId, workItemId, role, HEAD, runnerId]);
    }
  } else {
    for (const role of ["code-reviewer", "acceptance-tester"]) {
      await admin.query("INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode) VALUES ($1, $2, $3, 'production', 'succeeded', '{\"verdict\":\"pass\"}'::jsonb, $4, 'sandbox')", [accountId, workItemId, role, HEAD]);
    }
  }
  await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['.autonomous-team/**'])", [repoId, accountId]);
  await admin.query(
    `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, head_sha, tip_sha, pr_number, pr_url, source_head)
     VALUES ($1, $2, $3, 'acme/widgets-public', $4, 'pr_opened', $5, $5, $6, 'https://github.com/acme/widgets-public/pull/12', $7)`,
    [accountId, workItemId, repoId, "a".repeat(64), PUB_HEAD, PUB_PR, HEAD],
  );
  const pubBranch = String((await admin.query("SELECT branch FROM plane_pushes WHERE work_item_id = $1", [workItemId])).rows[0].branch);
  const pub = freshRepo({ owner: "acme", name: "widgets-public", prNumber: PUB_PR, isPublic: true, authorLogin: BOT_LOGIN, headSha: PUB_HEAD, checks: { [PUB_HEAD]: [green] }, protectedWithoutChecks: true, runBranch: pubBranch, files: [file("src/ui/button.tsx")], ghId: 8123456, ...o.pub });
  return { accountId, workItemId, repoId, priv, pub };
}

describe("the merge gate of a paired item, through the real installation client [pg]", () => {
  it("hosted pair: every call is one the client sends (the public content check's compares included), and the public pull request merges", async () => {
    const w = await world({ local: false, pub: { mergeQueue: { exists: false, mutations: [] } } });
    const trace: Trace = { refused: [], sent: [] };
    const out = await runMergeGateForItem(
      { pool: writerPool, authorTrust: BOT_TRUST, http: hostedHttp(w.priv, trace), queueDocuments: QUEUE_DOCUMENTS, publicPlane: { open: async () => hostedHttp(w.pub, trace), read: readPublicPullRequest(writerPool) } },
      { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
    );
    expect(trace.refused).toEqual([]);
    expect(out).toMatchObject({ outcome: "merged", headSha: PUB_HEAD, reasons: [], status: "posted" });
    expect(w.pub.merges).toEqual([{ sha: PUB_HEAD, method: "squash" }]);
    expect(w.priv.merges).toEqual([]);
    // The compares that staging's gate could not send (D#6 SR-1): the merge base of each head, and the public change set's patches.
    expect(trace.sent).toEqual(expect.arrayContaining([`GET /repos/acme/widgets-public/compare/main...${PUB_HEAD}`, `GET /repos/acme/widgets/compare/main...${HEAD}`, "PUT /repos/acme/widgets-public/pulls/12/merge"]));
    expect(trace.sent.some((s) => /^GET \/repos\/acme\/widgets-public\/compare\/[0-9a-f]{40}\.\.\.c{40}$/.test(s))).toBe(true);
  });

  it("hosted pair behind the code repository's merge queue: enqueued through the pinned document, nothing refused", async () => {
    const w = await world({ local: false, pub: { mergeQueue: { exists: true, mutations: [] }, rulesetRules: [{ type: "merge_queue", enforcement: "active" }] } });
    const trace: Trace = { refused: [], sent: [] };
    const out = await runMergeGateForItem(
      { pool: writerPool, authorTrust: BOT_TRUST, http: hostedHttp(w.priv, trace), queueDocuments: QUEUE_DOCUMENTS, publicPlane: { open: async () => hostedHttp(w.pub, trace), read: readPublicPullRequest(writerPool) } },
      { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
    );
    expect(trace.refused).toEqual([]);
    expect(out).toMatchObject({ outcome: "merge_enqueued" });
    expect(w.pub.mergeQueue!.mutations.map((m) => m.kind)).toEqual(["enqueue"]);
    expect(w.pub.merges).toEqual([]);
  });

  it("runner_local pair: the fence in front of the real client; every call is allowed by both, and the merge is handed to the runner", async () => {
    const w = await world({ local: true });
    const trace: Trace = { refused: [], sent: [] };
    const priv = fencedLocal(w.priv, trace);
    const pub = fencedLocal(w.pub, trace, { exclude: ["A10"] });
    const handed: string[] = [];
    const out = await runMergeGateForItem(
      {
        pool: writerPool,
        authorTrust: BOT_TRUST,
        http: priv.http,
        localReviewOptIn: { enabled: async () => true },
        queueDocuments: QUEUE_DOCUMENTS,
        publicPlane: { open: async () => pub.http, read: readPublicPullRequest(writerPool) },
        mergeDelegate: async ({ sha }) => (handed.push(sha), { delegated: true }),
      },
      { accountId: w.accountId, workItemId: w.workItemId, prNumber: w.priv.prNumber },
    );
    expect({ refused: trace.refused, fence: [...priv.refused, ...pub.refused], fake: [...priv.denied, ...pub.denied] }).toEqual({ refused: [], fence: [], fake: [] });
    expect(out).toMatchObject({ outcome: "merge_delegated", headSha: PUB_HEAD, reasons: [] });
    expect(handed).toEqual([PUB_HEAD]);
    expect([...w.pub.merges, ...w.priv.merges]).toEqual([]);
    expect(pub.calls.map((c) => c.label)).toEqual(expect.arrayContaining(["A2", "A3", "A7", "A8", "A9 CommitChecks", "A11", "A12"]));
  });

  it("runner_local: the merge gate's compare is still refused by the fence before the real client sees it", async () => {
    const w = await world({ local: true });
    const trace: Trace = { refused: [], sent: [] };
    const pub = fencedLocal(w.pub, trace, { exclude: ["A10"] });
    for (const path of [`/repos/acme/widgets-public/compare/main...${PUB_HEAD}`, `/repos/acme/widgets-public/compare/${HEAD}...${PUB_HEAD}`]) {
      await expect(pub.http.request({ method: "GET", path, query: { per_page: 1 } })).rejects.toBeInstanceOf(LocalOnlyGithubError);
    }
    expect(trace.sent).toEqual([]);
    expect(pub.calls).toEqual([]);
  });
});
