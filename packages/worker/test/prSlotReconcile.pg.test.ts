import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { InstallationTokenCache, applyMappedEvent, createInstallationHttp, type AccessTokenRequester } from "@fx/github";
import { takeBuildSlot } from "@fx/pipeline";
import { strictGithubFetch } from "../../github/test/helpers/strictGithub.js";
import { createAdvanceModule, type AdvanceModuleDeps } from "../src/advance.js";
import { PR_RECONCILE_EVERY_SECONDS, reconcileHolder, sweepPrSlotHolders, type PrStateOpen } from "../src/prSlotReconcile.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] D#598: an item in a pull-request stage whose pull request was closed or merged on GitHub without the webhook. Real Postgres as the real roles (the
 * worker's run-writer login, the 0894 definer for the sweep's list, every read and write under the item's own tenant), the real slot claim
 * (`takeBuildSlot`, the one-build-per-repository clamp) and the real `read` installation client over the strict GitHub fetch (User-Agent, Authorization,
 * API version, the GET-only rule of a `read` client). The in-memory GitHub answers `GET /repos/{o}/{r}/pulls` the way the real API does: `state` must be
 * open, closed or all (422 otherwise), `head` is `owner:branch`, `per_page` is capped at 100, closed pull requests carry `closed_at` and, when merged,
 * `merged_at`, and every item carries a title and body this code must never need. Anything but a GET is answered 403 as for a read-only token, and the
 * tests assert none is ever sent. Not faked faithfully: GitHub's rate limits and the exact sort of a listing (newest first here, as GitHub does by default).
 */
describe("stale pull-request slot reconcile [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let appKeyPem: string;
  const logs: string[] = [];

  interface FakePull {
    repo: string;
    number: number;
    branch: string;
    state: "open" | "closed";
    merged_at: string | null;
    closed_at: string | null;
  }
  const gh = { pulls: [] as FakePull[], calls: [] as string[], down: false };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  const inner = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    gh.calls.push(`${method} ${url.pathname}${url.search}`);
    if (gh.down) return json(503, { message: "Service Unavailable", documentation_url: "https://docs.github.com/rest", status: "503" });
    if (method !== "GET") return json(403, { message: "Resource not accessible by integration", documentation_url: "https://docs.github.com/rest", status: "403" });
    const m = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (!m) return json(404, { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" });
    const full = `${m[1]}/${m[2]}`;
    const state = url.searchParams.get("state") ?? "open";
    if (!["open", "closed", "all"].includes(state)) return json(422, { message: "Validation Failed", errors: [{ resource: "Search", field: "state", code: "invalid" }], documentation_url: "https://docs.github.com/rest", status: "422" });
    const perPage = Math.min(Number(url.searchParams.get("per_page") ?? "30") || 30, 100);
    const head = url.searchParams.get("head");
    const [headOwner, headRef] = head && head.includes(":") ? [head.slice(0, head.indexOf(":")), head.slice(head.indexOf(":") + 1)] : [null, null];
    const rows = gh.pulls
      .filter((p) => p.repo === full && (state === "all" || p.state === state) && (headOwner === null || (p.repo.split("/")[0] === headOwner && p.branch === headRef)))
      .sort((a, b) => b.number - a.number)
      .slice(0, perPage)
      .map((p) => ({
        url: `https://api.github.com/repos/${full}/pulls/${p.number}`,
        id: 1000 + p.number,
        number: p.number,
        state: p.state,
        title: "A title from the author",
        body: "Closes #41 and some text the platform must not need",
        user: { login: "someone" },
        created_at: "2026-10-01T00:00:00Z",
        closed_at: p.closed_at,
        merged_at: p.merged_at,
        head: { ref: p.branch, sha: "c".repeat(40), repo: { full_name: full } },
        base: { ref: "main", sha: "d".repeat(40), repo: { full_name: full } },
      }));
    return json(200, rows);
  }) as unknown as typeof fetch;

  const requester: AccessTokenRequester = async (p) => ({ token: "ghs_prstate1", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...p.permissions }, repositories: p.repositories ?? [] });
  const openKinds: string[] = [];
  const open: PrStateOpen = async (_mode, target) => {
    const opener = createInstallationHttp({
      resolveInstallation: async () => ({ installationId: 42, appKind: "team" }),
      appCredentials: () => ({ appId: "12345", privateKeyPem: appKeyPem, webhookSecret: "unused" }),
      requester,
      cache: new InstallationTokenCache(),
      fetchImpl: strictGithubFetch(inner),
    });
    openKinds.push("read");
    return opener("read", target);
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    appKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  let A: SeedRefs;
  beforeEach(async () => {
    // The sweep's list is across accounts: items earlier cases left in a pull-request stage are moved out so each case sees only its own.
    await admin.query("UPDATE work_items SET stage = 'needs_human' WHERE stage IN ('pr_opened', 'changes_requested', 'review_passed')");
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    gh.pulls.length = 0;
    gh.calls.length = 0;
    gh.down = false;
    logs.length = 0;
    openKinds.length = 0;
  });

  const SEED_ENTRY = "seed-entered";
  let nextNumber = 41;
  /** An item at `stage`; one in a pull-request stage also has the move that put it there (from in_progress, at `enteredAt`), as every real one does. */
  async function item(a: SeedRefs, stage: string, repoId = a.repoId, enteredAt = "2026-10-01T00:00:00Z"): Promise<{ id: string; number: number }> {
    const id = randomUUID();
    const number = nextNumber++;
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', $4, $5)", [id, a.accountId, repoId, stage, number]);
    if (["pr_opened", "changes_requested", "review_passed"].includes(stage)) await enter(a, id, "pr_opened", enteredAt);
    return { id, number };
  }
  /** A recorded move into a pull-request stage from outside them. */
  const enter = (a: SeedRefs, id: string, toStage: string, at: string) =>
    admin.query("INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', $3, $4, 'control_plane', $5)", [a.accountId, id, toStage, at, `${SEED_ENTRY}:${randomUUID()}`]);
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;
  const movesOf = async (id: string) =>
    (await admin.query<{ from_stage: string; to_stage: string; source: string; source_ref: string; at: Date }>("SELECT from_stage, to_stage, source, source_ref, at FROM work_item_transitions WHERE work_item_id = $1 AND source_ref NOT LIKE $2 ORDER BY created_at, id", [id, `${SEED_ENTRY}:%`])).rows;
  const writes = () => gh.calls.filter((c) => !c.startsWith("GET "));

  /** The advance module with a build step that takes a real build slot (the one-per-repository clamp) and moves the item to in_progress. */
  function advance(over: Partial<AdvanceModuleDeps> = {}) {
    const deps: AdvanceModuleDeps = {
      starter: { start: async () => ({ runId: randomUUID() }) },
      resolveRunSeat: vi.fn(async () => ({ ok: false, reason: "unused" }) as unknown as SeatResult),
      startAdvance: async () => undefined,
      triage: null,
      build: (async (pool: Pool, accountId: string, workItemId: string) => {
        const claim = await takeBuildSlot(pool, accountId, workItemId, (client) => recordStage(client, { workItemId, toStage: "in_progress", at: new Date(), source: "control_plane", sourceRef: `slot-test:${randomUUID()}` }));
        return claim.granted ? { status: "started", runId: randomUUID() } : { status: "refused", reason: claim.reason };
      }) as never,
      prState: open,
      ...over,
    };
    return createAdvanceModule(writerPool, deps);
  }
  const who = (a: SeedRefs, workItemId: string) => ({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 });

  it("a holder whose pull request was closed is moved to closed_unmerged as the webhook would, the slot frees, and the waiting item starts", async () => {
    const holder = await item(A, "pr_opened");
    const waiter = await item(A, "spec_ready");
    gh.pulls.push({ repo: "acme/widgets", number: 7, branch: `fx/issue-${holder.number}`, state: "closed", merged_at: null, closed_at: "2026-10-10T09:00:00Z" });
    const out = await advance().advanceBuild(who(A, waiter.id), randomUUID());
    expect(out.status).toBe("started");
    expect(await stageOf(holder.id)).toBe("closed_unmerged");
    expect(await stageOf(waiter.id)).toBe("in_progress");
    expect(await movesOf(holder.id)).toEqual([{ from_stage: "pr_opened", to_stage: "closed_unmerged", source: "webhook", source_ref: "pr_reconcile:7", at: new Date("2026-10-10T09:00:00Z") }]);
    // The same live event the webhook's move writes (recordStage), for the board.
    const events = await admin.query("SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'work_item.stage_changed' AND payload->>'workItemId' = $2", [A.accountId, holder.id]);
    expect(events.rows.map((r) => r.payload)).toEqual([{ workItemId: holder.id, fromStage: "pr_opened", toStage: "closed_unmerged" }]);
    // One read, the list call by the item's branch, through the read-only client; nothing written to GitHub.
    expect(gh.calls).toEqual([`GET /repos/acme/widgets/pulls?state=all&head=acme%3Afx%2Fissue-${holder.number}&per_page=30`]);
    expect(writes()).toEqual([]);
    expect(openKinds).toEqual(["read"]);
  });

  it("a merged pull request moves the holder to merged (the periodic sweep), at the merge time", async () => {
    const holder = await item(A, "review_passed");
    gh.pulls.push({ repo: "acme/widgets", number: 9, branch: `fx/issue-${holder.number}`, state: "closed", merged_at: "2026-10-11T08:00:00Z", closed_at: "2026-10-11T08:00:00Z" });
    const counts = await sweepPrSlotHolders({ pool: writerPool, openClient: open, log: (l) => void logs.push(l) });
    expect(counts).toEqual({ listed: 1, moved: 1, unchanged: 0, failed: 0 });
    expect(await stageOf(holder.id)).toBe("merged");
    expect(await movesOf(holder.id)).toEqual([{ from_stage: "review_passed", to_stage: "merged", source: "webhook", source_ref: "pr_reconcile:9", at: new Date("2026-10-11T08:00:00Z") }]);
    // The next pass inside the window lists nothing and asks GitHub nothing.
    gh.calls.length = 0;
    expect(await sweepPrSlotHolders({ pool: writerPool, openClient: open })).toEqual({ listed: 0, moved: 0, unchanged: 0, failed: 0 });
    expect(gh.calls).toEqual([]);
  });

  it("an open pull request leaves the holder where it is, the waiter keeps waiting, and the holder is read at most once in the window", async () => {
    const holder = await item(A, "changes_requested");
    const waiter = await item(A, "spec_ready");
    // An older closed pull request on the same branch does not count while a newer one is open.
    gh.pulls.push({ repo: "acme/widgets", number: 3, branch: `fx/issue-${holder.number}`, state: "closed", merged_at: null, closed_at: "2026-10-01T00:00:00Z" });
    gh.pulls.push({ repo: "acme/widgets", number: 4, branch: `fx/issue-${holder.number}`, state: "open", merged_at: null, closed_at: null });
    const m = advance();
    expect(await m.advanceBuild(who(A, waiter.id), randomUUID())).toEqual({ status: "refused", reason: "one_build_per_repo_until_d598" });
    expect(await m.advanceBuild(who(A, waiter.id), randomUUID())).toEqual({ status: "refused", reason: "one_build_per_repo_until_d598" });
    expect(await stageOf(holder.id)).toBe("changes_requested");
    expect(await movesOf(holder.id)).toEqual([]);
    expect(gh.calls).toHaveLength(1);
    // Past the window it is asked again.
    await admin.query("UPDATE pr_slot_reconciles SET checked_at = now() - make_interval(secs => $2::int) WHERE work_item_id = $1", [holder.id, PR_RECONCILE_EVERY_SECONDS + 1]);
    expect(await reconcileHolder(writerPool, open, A.accountId, holder.id)).toBe("open");
    expect(gh.calls).toHaveLength(2);
  });

  it("GitHub that cannot be read changes nothing: the holder keeps its stage and slot, no move is recorded, the waiter waits", async () => {
    const holder = await item(A, "pr_opened");
    const waiter = await item(A, "spec_ready");
    gh.pulls.push({ repo: "acme/widgets", number: 7, branch: `fx/issue-${holder.number}`, state: "closed", merged_at: null, closed_at: "2026-10-10T09:00:00Z" });
    gh.down = true;
    expect(await advance().advanceBuild(who(A, waiter.id), randomUUID())).toEqual({ status: "refused", reason: "one_build_per_repo_until_d598" });
    expect(await stageOf(holder.id)).toBe("pr_opened");
    expect(await stageOf(waiter.id)).toBe("spec_ready");
    expect(await movesOf(holder.id)).toEqual([]);
    // A client that cannot even be opened is the same.
    await admin.query("UPDATE pr_slot_reconciles SET checked_at = now() - interval '1 hour' WHERE work_item_id = $1", [holder.id]);
    expect(await reconcileHolder(writerPool, async () => { throw new Error("no installation"); }, A.accountId, holder.id)).toBe("github_unavailable");
    // A body of the wrong shape is no answer either.
    await admin.query("UPDATE pr_slot_reconciles SET checked_at = now() - interval '1 hour' WHERE work_item_id = $1", [holder.id]);
    expect(await reconcileHolder(writerPool, async () => ({ request: async () => ({ status: 200, body: { message: "not a list" } }) }), A.accountId, holder.id)).toBe("malformed");
    expect(await stageOf(holder.id)).toBe("pr_opened");
    expect(await movesOf(holder.id)).toEqual([]);
  });

  it("the webhook's close arriving after the reconcile is a no-op (closed and merged), and a reconcile after the webhook moved the item records nothing", async () => {
    const closed = await item(A, "pr_opened");
    const merged = await item(A, "pr_opened");
    gh.pulls.push({ repo: "acme/widgets", number: 7, branch: `fx/issue-${closed.number}`, state: "closed", merged_at: null, closed_at: "2026-10-10T09:00:00Z" });
    gh.pulls.push({ repo: "acme/widgets", number: 8, branch: `fx/issue-${merged.number}`, state: "closed", merged_at: "2026-10-10T10:00:00Z", closed_at: "2026-10-10T10:00:00Z" });
    expect(await reconcileHolder(writerPool, open, A.accountId, closed.id)).toBe("closed_unmerged");
    expect(await reconcileHolder(writerPool, open, A.accountId, merged.id)).toBe("merged");
    const installationId = (await admin.query<{ id: string }>("SELECT id FROM installations WHERE account_id = $1 LIMIT 1", [A.accountId])).rows[0]?.id ?? randomUUID();
    const ctx = { accountId: A.accountId, installationId, repoId: A.repoId, repo: { accountId: A.accountId, repoId: A.repoId, ghRepoId: 1, fullName: "acme/widgets" }, deliveryId: randomUUID() };
    const late = (number: number, issue: number, toStage: "merged" | "closed_unmerged") =>
      withTenant(appPool, A.accountId, (c) => applyMappedEvent(c, { ...ctx, deliveryId: randomUUID() }, { kind: "transition_pr", toStage, at: new Date("2026-10-10T09:00:00Z"), prNumber: number, linkedIssueNumber: issue, trust: "trusted", isFork: false }));
    expect(await late(7, closed.number, "closed_unmerged")).toEqual({ applied: "transitioned", workItemId: closed.id, recorded: false });
    expect(await late(8, merged.number, "merged")).toEqual({ applied: "transitioned", workItemId: merged.id, recorded: false });
    expect((await movesOf(closed.id)).map((x) => x.to_stage)).toEqual(["closed_unmerged"]);
    expect((await movesOf(merged.id)).map((x) => x.to_stage)).toEqual(["merged"]);
    // The other order: the webhook first, then a reconcile finds the item out of a pull-request stage and reads nothing.
    const first = await item(A, "pr_opened");
    await withTenant(appPool, A.accountId, (c) => applyMappedEvent(c, ctx, { kind: "transition_pr", toStage: "closed_unmerged", at: new Date("2026-10-10T09:00:00Z"), prNumber: 12, linkedIssueNumber: first.number, trust: "trusted", isFork: false }));
    gh.calls.length = 0;
    expect(await reconcileHolder(writerPool, open, A.accountId, first.id)).toBe("not_held");
    expect(gh.calls).toEqual([]);
    expect((await movesOf(first.id)).map((x) => x.source)).toEqual(["webhook"]);
  });

  it("an older closed pull request on the item's branch does not close an item whose current pull request is another one", async () => {
    // The item entered its pull-request stage on 15 Oct (a body-linked pull request on another branch is the one in force); fx/issue-n holds only a pull request closed on 10 Oct.
    const holder = await item(A, "pr_opened", A.repoId, "2026-10-15T00:00:00Z");
    gh.pulls.push({ repo: "acme/widgets", number: 7, branch: `fx/issue-${holder.number}`, state: "closed", merged_at: null, closed_at: "2026-10-10T09:00:00Z" });
    expect(await reconcileHolder(writerPool, open, A.accountId, holder.id)).toBe("older_pull_request");
    expect(await stageOf(holder.id)).toBe("pr_opened");
    expect(await movesOf(holder.id)).toEqual([]);
    // One closed after the entry does decide.
    await admin.query("UPDATE pr_slot_reconciles SET checked_at = now() - interval '1 hour' WHERE work_item_id = $1", [holder.id]);
    gh.pulls.push({ repo: "acme/widgets", number: 8, branch: `fx/issue-${holder.number}`, state: "closed", merged_at: null, closed_at: "2026-10-16T09:00:00Z" });
    expect(await reconcileHolder(writerPool, open, A.accountId, holder.id)).toBe("closed_unmerged");
    // An item with no recorded entry into a pull-request stage has no pull request that can be shown to be the one in force.
    const unknown = await item(A, "needs_human");
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [unknown.id]);
    gh.pulls.push({ repo: "acme/widgets", number: 9, branch: `fx/issue-${unknown.number}`, state: "closed", merged_at: null, closed_at: "2026-10-16T09:00:00Z" });
    expect(await reconcileHolder(writerPool, open, A.accountId, unknown.id)).toBe("no_pull_request");
    expect(await stageOf(unknown.id)).toBe("pr_opened");
  });

  it("the locked re-read refuses when the pull request in force changed after GitHub was read (the item re-entered a pull-request stage)", async () => {
    const holder = await item(A, "pr_opened");
    gh.pulls.push({ repo: "acme/widgets", number: 7, branch: `fx/issue-${holder.number}`, state: "closed", merged_at: null, closed_at: "2026-10-10T09:00:00Z" });
    const hooked: PrStateOpen = async (mode, target) => {
      const http = await open(mode, target);
      return {
        request: async (req) => {
          const res = await http.request(req);
          // While the answer is on its way, the item went round again: out of the stage and back in, with a new pull request.
          await admin.query("UPDATE work_items SET stage = 'needs_human' WHERE id = $1", [holder.id]);
          await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [holder.id]);
          await enter(A, holder.id, "pr_opened", "2026-10-20T00:00:00Z");
          return res;
        },
      };
    };
    expect(await reconcileHolder(writerPool, hooked, A.accountId, holder.id)).toBe("not_held");
    expect(await stageOf(holder.id)).toBe("pr_opened");
    expect(await movesOf(holder.id)).toEqual([]);
  });

  it("is tenant-scoped: a waiter checks only its own account's holders, and the sweep moves each item under its own tenant", async () => {
    const B = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [B.repoId]);
    const other = await item(B, "pr_opened");
    const holder = await item(A, "pr_opened");
    const waiter = await item(A, "spec_ready");
    gh.pulls.push({ repo: "acme/widgets", number: 21, branch: `fx/issue-${other.number}`, state: "closed", merged_at: null, closed_at: "2026-10-10T09:00:00Z" });
    gh.pulls.push({ repo: "acme/widgets", number: 22, branch: `fx/issue-${holder.number}`, state: "open", merged_at: null, closed_at: null });
    expect((await advance().advanceBuild(who(A, waiter.id), randomUUID())).status).toBe("refused");
    expect(await stageOf(other.id)).toBe("pr_opened");
    expect(gh.calls.every((c) => c.includes(`fx%2Fissue-${holder.number}`))).toBe(true);
    const counts = await sweepPrSlotHolders({ pool: writerPool, openClient: open });
    expect(counts).toMatchObject({ listed: 1, moved: 1 });
    expect(await stageOf(other.id)).toBe("closed_unmerged");
    expect((await admin.query("SELECT account_id FROM pr_slot_reconciles WHERE work_item_id = $1", [other.id])).rows).toEqual([{ account_id: B.accountId }]);
  });

  it("a runner run's pull request is read by the number and branch its done recorded, never by the issue's branch", async () => {
    await admin.query("UPDATE repos SET execution_mode = 'runner_verified' WHERE id = $1", [A.repoId]);
    const holder = await item(A, "pr_opened");
    const runId = randomUUID();
    const branch = `fx/${runId}-g1`;
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 'runner_verified', $4)", [runId, A.accountId, holder.id, A.repoId]);
    await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)", [A.accountId, runId, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber: 31, branch })]);
    gh.pulls.push({ repo: "acme/widgets", number: 30, branch, state: "open", merged_at: null, closed_at: null });
    gh.pulls.push({ repo: "acme/widgets", number: 31, branch, state: "closed", merged_at: "2026-10-12T00:00:00Z", closed_at: "2026-10-12T00:00:00Z" });
    gh.pulls.push({ repo: "acme/widgets", number: 32, branch: `fx/issue-${holder.number}`, state: "open", merged_at: null, closed_at: null });
    expect(await reconcileHolder(writerPool, open, A.accountId, holder.id)).toBe("merged");
    expect(gh.calls).toEqual([`GET /repos/acme/widgets/pulls?state=all&head=acme%3A${encodeURIComponent(branch)}&per_page=30`]);
  });

  describe("a repository paired with a public code repository", () => {
    /** Pairs A's repo with acme/widgets-public and gives the item the push record the platform keeps (the public branch fx/p-<id>, the public pull request). */
    async function paired(a: SeedRefs, itemId: string, prNumber: number | null): Promise<string> {
      await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', ARRAY['.autonomous-team/**']) ON CONFLICT (repo_id) DO NOTHING", [a.repoId, a.accountId]);
      const row = await admin.query<{ branch: string }>(
        `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state${prNumber === null ? "" : ", head_sha, tip_sha, pr_number, pr_url"})
         VALUES ($1, $2, $3, 'acme/widgets-public', $4, ${prNumber === null ? "'building'" : "'pr_opened', $5, $5, $6, $7"}) RETURNING branch`,
        prNumber === null ? [a.accountId, itemId, a.repoId, "a".repeat(64)] : [a.accountId, itemId, a.repoId, "a".repeat(64), "b".repeat(40), prNumber, `https://github.com/acme/widgets-public/pull/${prNumber}`],
      );
      return row.rows[0]!.branch;
    }
    /** The private pull request the runner's done recorded (it stays open for ever): the old read stopped here and answered open. */
    async function runnerPrivate(a: SeedRefs, itemId: string, prNumber: number): Promise<string> {
      await admin.query("UPDATE repos SET execution_mode = 'runner_verified' WHERE id = $1", [a.repoId]);
      const runId = randomUUID();
      const branch = `fx/${runId}-g1`;
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded', 'runner_verified', $4)", [runId, a.accountId, itemId, a.repoId]);
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)", [a.accountId, runId, JSON.stringify({ from: "running", to: "succeeded", viaRunnerDone: true, prNumber, branch })]);
      return branch;
    }
    const publicCall = (branch: string) => `GET /repos/acme/widgets-public/pulls?state=all&head=acme%3A${encodeURIComponent(branch)}&per_page=30`;

    it("a closed public pull request moves the item to closed_unmerged although the runner's private pull request is still open", async () => {
      const holder = await item(A, "changes_requested");
      const privateBranch = await runnerPrivate(A, holder.id, 658);
      const branch = await paired(A, holder.id, 414);
      gh.pulls.push({ repo: "acme/widgets", number: 658, branch: privateBranch, state: "open", merged_at: null, closed_at: null });
      gh.pulls.push({ repo: "acme/widgets-public", number: 414, branch, state: "closed", merged_at: null, closed_at: "2026-10-24T13:23:41Z" });
      expect(await reconcileHolder(writerPool, open, A.accountId, holder.id)).toBe("closed_unmerged");
      expect(await stageOf(holder.id)).toBe("closed_unmerged");
      expect(await movesOf(holder.id)).toEqual([{ from_stage: "changes_requested", to_stage: "closed_unmerged", source: "webhook", source_ref: "pr_reconcile:414", at: new Date("2026-10-24T13:23:41Z") }]);
      // One read-only list call, on the paired repository, by the public branch; the private repository is never asked.
      expect(gh.calls).toEqual([publicCall(branch)]);
      expect(writes()).toEqual([]);
    });

    it("a merged public pull request moves the item to merged", async () => {
      const holder = await item(A, "review_passed");
      const branch = await paired(A, holder.id, 414);
      gh.pulls.push({ repo: "acme/widgets-public", number: 414, branch, state: "closed", merged_at: "2026-10-24T14:00:00Z", closed_at: "2026-10-24T14:00:00Z" });
      expect(await reconcileHolder(writerPool, open, A.accountId, holder.id)).toBe("merged");
      expect(await stageOf(holder.id)).toBe("merged");
    });

    it("an open public pull request leaves the item where it is", async () => {
      const holder = await item(A, "pr_opened");
      const branch = await paired(A, holder.id, 414);
      gh.pulls.push({ repo: "acme/widgets-public", number: 414, branch, state: "open", merged_at: null, closed_at: null });
      expect(await reconcileHolder(writerPool, open, A.accountId, holder.id)).toBe("open");
      expect(await stageOf(holder.id)).toBe("pr_opened");
    });

    it("a same-number merged pull request on the private repository is ignored", async () => {
      const holder = await item(A, "changes_requested");
      const branch = await paired(A, holder.id, 414);
      // The private repository's own #414 is merged, even on a branch of the same name: it is on the wrong repository and is never read.
      gh.pulls.push({ repo: "acme/widgets", number: 414, branch, state: "closed", merged_at: "2026-10-01T00:00:00Z", closed_at: "2026-10-01T00:00:00Z" });
      gh.pulls.push({ repo: "acme/widgets-public", number: 414, branch, state: "open", merged_at: null, closed_at: null });
      expect(await reconcileHolder(writerPool, open, A.accountId, holder.id)).toBe("open");
      expect(await stageOf(holder.id)).toBe("changes_requested");
      expect(gh.calls).toEqual([publicCall(branch)]);
    });

    it("a public pull request of another number on the recorded branch is not the one in force", async () => {
      const holder = await item(A, "changes_requested");
      const branch = await paired(A, holder.id, 414);
      gh.pulls.push({ repo: "acme/widgets-public", number: 415, branch, state: "closed", merged_at: null, closed_at: "2026-10-24T13:23:41Z" });
      expect(await reconcileHolder(writerPool, open, A.accountId, holder.id)).toBe("no_pull_request");
      expect(await stageOf(holder.id)).toBe("changes_requested");
    });

    it("a paired item whose public pull request is not recorded reads nothing (the private pull request is not its pull request)", async () => {
      const holder = await item(A, "changes_requested");
      const privateBranch = await runnerPrivate(A, holder.id, 658);
      await paired(A, holder.id, null);
      gh.pulls.push({ repo: "acme/widgets", number: 658, branch: privateBranch, state: "open", merged_at: null, closed_at: null });
      expect(await reconcileHolder(writerPool, open, A.accountId, holder.id)).toBe("no_pull_request");
      expect(gh.calls).toEqual([]);
    });
  });

  it("the sweep's list is the 0894 definer: run-writer only, ids only, and its window is PR_RECONCILE_EVERY_SECONDS", async () => {
    await expect(appPool.query("SELECT * FROM pr_slot_reconcile_list_due(10)")).rejects.toMatchObject({ code: "42501" });
    const fields = (await writerPool.query("SELECT * FROM pr_slot_reconcile_list_due(10)")).fields.map((f) => f.name);
    expect(fields).toEqual(["account_id", "work_item_id"]);
    const sql = readFileSync(new URL("../../db/migrations/0894_pr_slot_reconcile.sql", import.meta.url), "utf8");
    expect(sql).toContain(`interval '${PR_RECONCILE_EVERY_SECONDS} seconds'`);
  });
});
