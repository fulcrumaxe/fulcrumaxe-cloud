import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { queueDiscoveries } from "@fx/db/src/discoveryRuns.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { runDiscovery, runQueuedDiscoveries, withdrawDisconnectedProposals, type DiscoveryRunDeps, type PreviewHint } from "@fx/core/src/discovery/run.js";
import { ENGINE_LOOP_MARKER } from "@fx/core/src/plan/executeImport.js";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import type { GithubWebhookDbDeps, GithubWebhookPayload } from "../src/eventMapper.js";
import { handleGithubWebhookEventForApp } from "../src/webhookGate.js";
import { completeInstall } from "../src/installCallback.js";
import { installationDiscoveryRef } from "../src/installDiscovery.js";
import { pagedListing, strictGithubFetch } from "./helpers/strictGithub.js";
import { ALLOWED_GRAPHQL_DOCUMENTS, DISCOVERY_DISCUSSIONS_QUERY, DISCUSSION_COMMENTS_QUERY } from "../src/planQueries.js";
import { createPlanReadClient } from "../src/planReadClient.js";
import { listRecentOpenItems } from "../src/discoveryReaders.js";
import { createPlanSourceFactory } from "../src/planSource.js";
import { newFakeState, startPlanGithub, type FakeDiscussion, type FakeItem, type PlanGithub } from "./helpers/planGithubFake.js";

/**
 * D#483 S4-c against real Postgres, with the real read-only GitHub client talking to the strict GitHub fake over real TLS
 * (helpers/planGithubFake.ts): the install and payment discovery. Each criterion has a test that goes red when its rule is taken away.
 */
const hour = (n: number): string => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();
const creds = (pem: string) => () => ({ appId: "123", privateKeyPem: pem, webhookSecret: "unused-unused-unused-unused-unused" });

describe("install and payment discovery (D#483 S4-c)", () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;
  let pem: string;
  let gh: PlanGithub | undefined;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });
  afterEach(async () => {
    await gh?.close();
    gh = undefined;
  });

  /** A seeded account (it already holds a work item and an agent run) with its one repository named acme/widgets. */
  async function tenant(opts: { active?: boolean } = {}): Promise<SeedRefs> {
    const r = await seedAccount(admin, randomUUID());
    await admin.query(`UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1`, [r.repoId]);
    if (opts.active === false) await admin.query(`UPDATE accounts SET stripe_customer_id = NULL WHERE id = $1`, [r.accountId]);
    return r;
  }
  const activate = (r: SeedRefs) => admin.query(`UPDATE accounts SET stripe_customer_id = $2 WHERE id = $1`, [r.accountId, `cus_${randomUUID()}`]);

  async function github(items: FakeItem[], discussions: FakeDiscussion[] = [], files: Record<string, string> = {}, over = {}) {
    gh = await startPlanGithub(newFakeState({ items, discussions, files: new Map(Object.entries(files)), ...over }));
    const factory = createPlanSourceFactory({
      resolveInstallation: async () => ({ installationId: 777, appKind: "team" }),
      appCredentials: creds(pem),
      requester: gh.requester,
      fetchImpl: gh.fetch,
    });
    return factory;
  }
  const depsFor = (r: SeedRefs, factory: Awaited<ReturnType<typeof github>>, previewHints?: (repoId: string) => Promise<PreviewHint[]>): DiscoveryRunDeps => ({
    pool: appUserPool,
    accountId: r.accountId,
    openSource: (t) => factory(t),
    ...(previewHints ? { previewHints } : {}),
  });
  const queue = (r: SeedRefs, trigger: "installation_created" | "repos_added" | "activation", ref: string) =>
    queueDiscoveries(appUserPool, r.accountId, { kind: "account" }, trigger, ref);

  const issue = (n: number, extra: Partial<FakeItem> = {}): FakeItem => ({ number: n, title: `Issue ${n}`, body: `body ${n}`, state: "open", updatedAt: hour(n), ...extra });
  const pull = (n: number): FakeItem => ({ number: n, title: `PR ${n}`, body: null, state: "open", pull: { merged_at: null }, updatedAt: hour(n) });
  const discussion = (n: number, at: number, extra: Partial<FakeDiscussion> = {}): FakeDiscussion => ({ number: n, title: `Discussion ${n}`, body: `Talk ${n}`, closed: false, comments: [], updatedAt: hour(at), ...extra });

  const proposals = async (r: SeedRefs) =>
    (await admin.query(`SELECT dedupe_key, sources, state, verification, provenance, owner_process, category_hint, estimate_usd::float AS estimate FROM proposals WHERE account_id = $1 ORDER BY dedupe_key`, [r.accountId])).rows as Array<{
      dedupe_key: string;
      sources: string[];
      state: string;
      verification: string;
      provenance: string;
      owner_process: string;
      category_hint: string | null;
      estimate: number | null;
    }>;
  const counts = async (r: SeedRefs) => {
    const one = async (t: string) => (await admin.query(`SELECT count(*)::int n FROM ${t} WHERE account_id = $1`, [r.accountId])).rows[0].n as number;
    return { work_items: await one("work_items"), agent_runs: await one("agent_runs"), run_action_requests: await one("run_action_requests") };
  };
  const runRows = async (r: SeedRefs) => (await admin.query(`SELECT trigger, trigger_ref, state, skip_reason, counts FROM discovery_runs WHERE account_id = $1 ORDER BY created_at, trigger_ref`, [r.accountId])).rows;

  it("S4c-1: 60 open issues, 5 Discussions and 3 open pull requests give the 50 most recently updated, none a pull request, and no work", async () => {
    const r = await tenant();
    const items = [...Array.from({ length: 60 }, (_, i) => issue(i + 1)), pull(61), pull(62), pull(63), issue(200, { state: "closed", updatedAt: hour(500) })];
    // Four Discussions sit among the issues; the fifth is older than every issue; a closed one is newer than all of them.
    const discussions = [discussion(101, 20), discussion(102, 30), discussion(103, 40), discussion(104, 50), discussion(105, -10), discussion(106, 600, { closed: true })];
    const factory = await github(items, discussions);
    const before = await counts(r);
    expect(before.work_items).toBeGreaterThan(0);
    expect(before.agent_runs).toBeGreaterThan(0);

    await queue(r, "activation", "sub_1");
    const [out] = await runQueuedDiscoveries(depsFor(r, factory));
    expect(out).toMatchObject({ state: "succeeded", imported: 50 });

    const rows = await proposals(r);
    // 65 open items (60 issues + 5 Discussions) older to newer: Discussion 105, then issues 1..14 are the 15 oldest, so they are the ones cut.
    const expected = [...Array.from({ length: 46 }, (_, i) => `gh:issue:${i + 15}`), "gh:discussion:101", "gh:discussion:102", "gh:discussion:103", "gh:discussion:104"].sort();
    expect(rows.map((p) => p.dedupe_key)).toEqual(expected);
    expect(rows.some((p) => ["gh:issue:61", "gh:issue:62", "gh:issue:63", "gh:issue:200", "gh:discussion:106"].includes(p.dedupe_key))).toBe(false);
    expect(rows.every((p) => p.verification === "pending" && p.state === "new" && p.provenance === "external" && p.owner_process === "product")).toBe(true);
    expect(rows.filter((p) => p.dedupe_key.startsWith("gh:discussion")).every((p) => p.sources.join() === "github_discussion")).toBe(true);
    // A.S4-1: the counts of work items and of runs are unchanged.
    expect(await counts(r)).toEqual(before);
    expect(await runRows(r)).toMatchObject([{ trigger: "activation", trigger_ref: "sub_1", state: "succeeded", counts: { imported: 50, with_preview: 0, owner_process: "product" } }]);
  });

  it("S4-b2b: a discovery that wrote proposals marks the claim verifier's sweep pending, after the commit; one that wrote nothing does not", async () => {
    const markers = new Map<string, number>();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
    try {
      const r = await tenant();
      const factory = await github([issue(1), issue(2)]);
      await queue(r, "activation", "sub_wake");
      const [out] = await runQueuedDiscoveries(depsFor(r, factory));
      expect(out).toMatchObject({ state: "succeeded", imported: 2 });
      // The rows are committed by the time the marker is there.
      expect((await proposals(r)).length).toBe(2);
      expect([...markers.keys()]).toContain("pending:proposal-verify-sweep");

      // A skipped run (no subscription: the free preview) writes nothing and marks nothing.
      markers.clear();
      const free = await tenant({ active: false });
      await queue(free, "activation", "sub_free");
      const [skipped] = await runQueuedDiscoveries(depsFor(free, factory));
      expect(skipped).toMatchObject({ state: "skipped" });
      expect([...markers.keys()]).not.toContain("pending:proposal-verify-sweep");
    } finally {
      setPendingHooks(null);
    }
  });

  it("reads issues with state=open, sort=updated, direction=desc, follows the Link header past a page of pull requests, and sends only allowlisted GraphQL", async () => {
    const r = await tenant();
    // 120 pull requests are the most recently updated; 3 issues are older. The first page (100) holds no issue at all.
    const items = [...Array.from({ length: 120 }, (_, i) => pull(1000 + i)), issue(1), issue(2), issue(3)];
    const factory = await github(items, [discussion(7, 2)]);
    const src = factory({ repoId: r.repoId, owner: "acme", name: "widgets" });
    const { items: got } = await src.recentOpen();
    expect(got.map((i) => `${i.kind}:${i.number}`)).toEqual(["issue:3", "discussion:7", "issue:2", "issue:1"]);
    const sent = gh!.server.seen.filter((s) => s.path.startsWith("/repos/acme/widgets/issues"));
    expect(sent.length).toBe(2);
    for (const s of sent) expect(s.query ?? "").toMatch(/state=open/);
    for (const s of sent) expect(s.query ?? "").toMatch(/sort=updated/);
    for (const s of sent) expect(s.query ?? "").toMatch(/direction=desc/);
    expect(ALLOWED_GRAPHQL_DOCUMENTS.has(DISCOVERY_DISCUSSIONS_QUERY)).toBe(true);
    expect(gh!.server.seen.some((s) => s.path.startsWith("/graphql") && s.body?.includes("DiscoveryRecentDiscussions"))).toBe(true);
  });

  it("isMinimized: GitHub's schema has it on a Discussion's comments only, so the Discussion read never asks for it, the comments read still does, and the fake refuses it on a Discussion", async () => {
    expect(DISCOVERY_DISCUSSIONS_QUERY).not.toMatch(/isMinimized/);
    expect(DISCUSSION_COMMENTS_QUERY).toMatch(/isMinimized/);
    const bad = DISCOVERY_DISCUSSIONS_QUERY.replace("closed\n        updatedAt", "closed\n        isMinimized\n        updatedAt");
    expect(bad).not.toBe(DISCOVERY_DISCUSSIONS_QUERY);
    const factory = await github([], [discussion(1, 1)]);
    // The client refuses a document that is not an allowlisted constant before a token is minted; the fake's own schema check is
    // reached by asking it directly with the token the client minted for a real read.
    const g = gh!;
    await factory({ repoId: randomUUID(), owner: "acme", name: "widgets" }).recentOpen();
    const mint = { token: g.mints[0]!.token };
    const res = await g.fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${mint.token}`, "user-agent": "t", accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify({ query: bad, variables: { owner: "acme", name: "widgets", first: 50 } }),
    });
    const body = (await res.json()) as { errors?: Array<{ message: string }> };
    expect(body.errors?.[0]?.message).toMatch(/isMinimized.*doesn't exist on type 'Discussion'/);
    // And the allowlisted constant itself is accepted.
    const ok = await g.fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${mint.token}`, "user-agent": "t", accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify({ query: DISCOVERY_DISCUSSIONS_QUERY, variables: { owner: "acme", name: "widgets", first: 50 } }),
    });
    expect(((await ok.json()) as { errors?: unknown }).errors).toBeUndefined();
  });

  it("the client refuses a Discussion read that is not an allowlisted document, before any token is minted", async () => {
    await github([], []);
    const open = createPlanReadClient({ resolveInstallation: async () => ({ installationId: 777, appKind: "team" }), appCredentials: creds(pem), requester: gh!.requester, fetchImpl: gh!.fetch });
    const client = open({ repoId: randomUUID(), owner: "acme", name: "widgets" });
    await expect(client.graphqlDocument(DISCOVERY_DISCUSSIONS_QUERY.replace("closed", "closed\n        isMinimized"), { owner: "acme", name: "widgets", first: 50 })).rejects.toMatchObject({ code: "request_refused" });
    expect(gh!.mints.length).toBe(0);
    await expect(listRecentOpenItems(client, { owner: "acme", name: "widgets" })).resolves.toMatchObject({ items: [] });
  });

  it("Discussions switched off still gives the issues", async () => {
    const r = await tenant();
    const factory = await github([issue(1), issue(2)], [], {}, { discussionsEnabled: false });
    await queue(r, "activation", "sub_off");
    const [out] = await runQueuedDiscoveries(depsFor(r, factory));
    expect(out).toMatchObject({ state: "succeeded", imported: 2 });
  });

  it("S4c-2: queuing the same trigger twice gives one discovery, and a rerun writes no duplicate rows", async () => {
    const r = await tenant();
    const factory = await github([issue(1), issue(2)], [discussion(9, 1)]);
    expect((await queue(r, "installation_created", "delivery-1")).length).toBe(1);
    expect(await queue(r, "installation_created", "delivery-1")).toEqual([]);
    // Another trigger, or the same trigger from another delivery, is its own discovery.
    expect((await queue(r, "installation_created", "delivery-2")).length).toBe(1);
    expect((await queue(r, "repos_added", "delivery-1")).length).toBe(1);
    expect((await queue(r, "activation", "sub_1")).length).toBe(1);
    expect(await queue(r, "activation", "sub_1")).toEqual([]);
    expect(await runRows(r)).toHaveLength(4);
    const outs = await runQueuedDiscoveries(depsFor(r, factory));
    expect(outs.map((o) => o.state)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(await proposals(r)).toHaveLength(3);
    // A second sweep finds nothing queued.
    expect(await runQueuedDiscoveries(depsFor(r, factory))).toEqual([]);
    // A finished run cannot be run again.
    const [first] = await runRows(r);
    expect(first.state).toBe("succeeded");
    const id = (await admin.query(`SELECT id FROM discovery_runs WHERE account_id = $1 LIMIT 1`, [r.accountId])).rows[0].id as string;
    expect(await runDiscovery(depsFor(r, factory), id)).toEqual({ state: "not_queued" });
  });

  it("the database refuses what the key and the guard are for: a second row for the same key, a run that starts finished, a finished run changed", async () => {
    const r = await tenant();
    await queue(r, "activation", "sub_k");
    await expect(admin.query(`INSERT INTO discovery_runs (account_id, repo_id, trigger, trigger_ref) VALUES ($1, $2, 'activation', 'sub_k')`, [r.accountId, r.repoId])).rejects.toMatchObject({ code: "23505" });
    await expect(admin.query(`INSERT INTO discovery_runs (account_id, repo_id, trigger, trigger_ref, state, finished_at) VALUES ($1, $2, 'activation', 'sub_z', 'succeeded', now())`, [r.accountId, r.repoId])).rejects.toMatchObject({ code: "23514" });
    await expect(admin.query(`INSERT INTO discovery_runs (account_id, repo_id, trigger, trigger_ref) VALUES ($1, $2, 'weekly', 'x')`, [r.accountId, r.repoId])).rejects.toMatchObject({ code: "23514" });
    await admin.query(`UPDATE discovery_runs SET state = 'skipped', skip_reason = 'discovery_off', finished_at = now() WHERE account_id = $1`, [r.accountId]);
    await expect(admin.query(`UPDATE discovery_runs SET state = 'running' WHERE account_id = $1`, [r.accountId])).rejects.toMatchObject({ code: "23514" });
  });

  it("another account reads none of the queue, and app_user cannot delete a run", async () => {
    const a = await tenant();
    const b = await tenant();
    await queue(a, "activation", "sub_a");
    const seenByB = await (async () => {
      const c = await appUserPool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [b.accountId]);
        const n = (await c.query(`SELECT count(*)::int n FROM discovery_runs`)).rows[0].n as number;
        await expect(c.query(`DELETE FROM discovery_runs`)).rejects.toMatchObject({ code: "42501" });
        return n;
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    })();
    expect(seenByB).toBe(0);
  });

  describe("each trigger queues one discovery per product repository", () => {
    const deps = (extra: Partial<GithubWebhookDbDeps> = {}): GithubWebhookDbDeps => ({ appUserPool, platformOpsPool, ...extra });
    async function second(r: SeedRefs, ghRepoId: number, product = "team", attached = true) {
      await admin.query(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'acme', $5)`, [r.accountId, attached ? r.installationId : null, ghRepoId, product, `r${ghRepoId}`]);
    }
    const ghInstall = async (r: SeedRefs) => Number((await admin.query(`SELECT gh_installation_id FROM installations WHERE id = $1`, [r.installationId])).rows[0].gh_installation_id);
    const ghRepo = async (r: SeedRefs) => Number((await admin.query(`SELECT gh_repo_id FROM repos WHERE id = $1`, [r.repoId])).rows[0].gh_repo_id);

    it("installation created: one per repository the delivery lists; a replay of the delivery queues nothing", async () => {
      const r = await tenant();
      await second(r, 41_001);
      await second(r, 41_002, "team_readonly");
      await second(r, 41_003, "team", false);
      const payload = { action: "created", installation: { id: await ghInstall(r), account: { login: "acme" } }, repositories: [{ id: await ghRepo(r), name: "widgets" }, { id: 41_001, name: "r41001" }, { id: 41_002, name: "r41002" }] } as unknown as GithubWebhookPayload;
      const queued = vi.fn(async () => undefined);
      const delivery = randomUUID();
      const res = await handleGithubWebhookEventForApp(deps({ onDiscoveryQueued: queued }), "installation", payload, delivery, "team");
      expect(res.handled).toBe(true);
      const rows = await runRows(r);
      expect(rows).toHaveLength(2);
      expect(rows.every((x) => x.trigger === "installation_created" && x.trigger_ref === installationDiscoveryRef((payload as unknown as { installation: { id: number } }).installation.id) && x.state === "queued")).toBe(true);
      expect(queued).toHaveBeenCalledTimes(1);
      await handleGithubWebhookEventForApp(deps({ onDiscoveryQueued: queued }), "installation", payload, delivery, "team");
      expect(await runRows(r)).toHaveLength(2);
      expect(queued).toHaveBeenCalledTimes(1);
    });

    describe("installation created, in either order with the install callback", () => {
      const INSTALLER = 6161;
      let nextGh = 9_700_000;
      const env = { GITHUB_APP_TEAM_CLIENT_ID: "i", GITHUB_APP_TEAM_CLIENT_SECRET: "s" };

      /** A paid account whose installation is not claimed yet: no installations row and no repos rows, as before the callback runs. */
      async function unclaimed() {
        const accountId = randomUUID();
        const userId = randomUUID();
        const ghId = ++nextGh;
        await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
        await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
        await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
        await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team', $2)`, [ghId, INSTALLER]);
        return { accountId, userId, ghId, repoIds: [51_000 + (ghId % 1000) * 2, 51_001 + (ghId % 1000) * 2] };
      }
      /** The install callback, with a repo sync that writes the repositories the way the real sync does (after the claim). */
      const callback = (u: Awaited<ReturnType<typeof unclaimed>>, syncRepos = true) =>
        completeInstall(
          {
            platformOpsPool,
            appUserPool,
            recheck: async () => true,
            appCredentials: () => ({ appId: "7", privateKeyPem: "", webhookSecret: "" }),
            env,
            fetchImpl: strictGithubFetch((async (url: string | URL | Request) =>
              String(url).includes("/login/oauth/")
                ? Response.json({ access_token: "ghu_x" })
                : String(url) === "https://api.github.com/user"
                  ? Response.json({ id: INSTALLER })
                  : pagedListing("installations", [{ id: u.ghId, app_id: 7 }], String(url))) as unknown as typeof fetch),
            ...(syncRepos
              ? {
                  syncRepos: async (installationId: string) => {
                    for (const id of u.repoIds) {
                      await admin.query(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', $4)`, [u.accountId, installationId, id, `r${id}`]);
                    }
                  },
                }
              : {}),
          },
          { kind: "team", accountId: u.accountId, userId: u.userId, installationId: String(u.ghId), code: "c0de" },
        );
      const delivery = (u: Awaited<ReturnType<typeof unclaimed>>, id = randomUUID()) =>
        handleGithubWebhookEventForApp(
          deps(),
          "installation",
          { action: "created", installation: { id: u.ghId, account: { login: "acme" } }, repositories: u.repoIds.map((rid) => ({ id: rid, name: `r${rid}` })) } as unknown as GithubWebhookPayload,
          id,
          "team",
        );
      const perRepo = async (u: Awaited<ReturnType<typeof unclaimed>>) =>
        (await admin.query(`SELECT d.trigger, d.trigger_ref, r.gh_repo_id::int AS gh FROM discovery_runs d JOIN repos r ON r.id = d.repo_id WHERE d.account_id = $1 ORDER BY r.gh_repo_id`, [u.accountId])).rows;

      it("delivery first (no installation and no repositories yet): it queues nothing, and the callback queues one run per repository after its sync", async () => {
        const u = await unclaimed();
        await delivery(u);
        expect(await perRepo(u)).toEqual([]);
        expect(await callback(u)).toBe("ok");
        expect(await perRepo(u)).toEqual(u.repoIds.map((gh) => ({ trigger: "installation_created", trigger_ref: installationDiscoveryRef(u.ghId), gh })));
        // The delivery's retry (a fresh delivery id, same installation) adds nothing.
        await delivery(u, randomUUID());
        expect(await perRepo(u)).toHaveLength(u.repoIds.length);
      });

      it("callback first, then the delivery: exactly one run per repository", async () => {
        const u = await unclaimed();
        expect(await callback(u)).toBe("ok");
        expect(await perRepo(u)).toHaveLength(u.repoIds.length);
        await delivery(u);
        await delivery(u, randomUUID());
        expect(await perRepo(u)).toEqual(u.repoIds.map((gh) => ({ trigger: "installation_created", trigger_ref: installationDiscoveryRef(u.ghId), gh })));
      });

      it("a callback whose sync is not wired queues nothing and still answers ok (the delivery or a later trigger discovers)", async () => {
        const u = await unclaimed();
        expect(await callback(u, false)).toBe("ok");
        expect(await perRepo(u)).toEqual([]);
      });
    });

    it("installation_repositories added: only the added repositories; removed or unrelated deliveries queue nothing", async () => {
      const r = await tenant();
      await second(r, 42_001);
      const base = { installation: { id: await ghInstall(r) } };
      const delivery = randomUUID();
      await handleGithubWebhookEventForApp(deps(), "installation_repositories", { ...base, action: "added", repositories_added: [{ id: 42_001 }] } as unknown as GithubWebhookPayload, delivery, "team");
      expect((await runRows(r)).map((x) => [x.trigger, x.trigger_ref])).toEqual([["repos_added", delivery]]);
      expect(await admin.query(`SELECT repo_id FROM discovery_runs WHERE account_id = $1`, [r.accountId]).then((q) => q.rows[0].repo_id)).not.toBe(r.repoId);
      await handleGithubWebhookEventForApp(deps(), "installation_repositories", { ...base, action: "removed", repositories_removed: [{ id: 42_001 }] } as unknown as GithubWebhookPayload, randomUUID(), "team");
      await handleGithubWebhookEventForApp(deps(), "installation_repositories", { ...base, action: "added", repositories_added: [{ id: 42_001 }] } as unknown as GithubWebhookPayload, delivery, "team");
      expect(await runRows(r)).toHaveLength(1);
      // The read-only app's delivery is inert, so the free preview's repositories queue nothing.
      await handleGithubWebhookEventForApp(deps(), "installation_repositories", { ...base, action: "added", repositories_added: [{ id: 42_001 }] } as unknown as GithubWebhookPayload, randomUUID(), "team_readonly");
      expect(await runRows(r)).toHaveLength(1);
    });

    it("a queue that fails never fails the delivery", async () => {
      const r = await tenant();
      const warn = vi.fn();
      const payload = { action: "added", installation: { id: await ghInstall(r) }, repositories_added: [{ id: await ghRepo(r) }] } as unknown as GithubWebhookPayload;
      const res = await handleGithubWebhookEventForApp(deps({ warn, onDiscoveryQueued: async () => Promise.reject(new Error("runner down")) }), "installation_repositories", payload, randomUUID(), "team");
      expect(res.handled).toBe(true);
      expect(warn).toHaveBeenCalledWith("github webhook: queuing discovery failed");
    });
  });

  it("an account that is not on the free preview but is not active (paused, past due, cancelled) skips with account_not_active, not free_preview, and reads nothing", async () => {
    const r = await tenant();
    await admin.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [r.accountId]);
    expect((await admin.query(`SELECT status FROM accounts WHERE id = $1`, [r.accountId])).rows[0].status).toBe("paused");
    const factory = await github([issue(1)]);
    await queue(r, "activation", "sub_paused");
    expect(await runQueuedDiscoveries(depsFor(r, factory))).toEqual([{ state: "skipped", reason: "account_not_active" }]);
    expect(gh!.server.seen.filter((s) => s.path.startsWith("/repos/"))).toEqual([]);
    expect(await runRows(r)).toMatchObject([{ state: "skipped", skip_reason: "account_not_active" }]);
  });

  it("S4c-3: a repo on the free preview gets no discovery until activation; then its preview issues appear with the Preview source, category hint and estimate", async () => {
    const r = await tenant({ active: false });
    const factory = await github([issue(1), issue(2), issue(3)], [discussion(9, 1)]);
    const hints = vi.fn(async (): Promise<PreviewHint[]> => [{ number: 2, category: "bug", expectedUsd: 1.5 }, { number: 999, category: "feature", expectedUsd: 4 }]);
    const before = await counts(r);

    await queue(r, "installation_created", "d-1");
    expect((await runQueuedDiscoveries(depsFor(r, factory, hints))).map((o) => o)).toEqual([{ state: "skipped", reason: "free_preview" }]);
    expect(await proposals(r)).toEqual([]);
    expect(gh!.server.seen.filter((s) => s.path.startsWith("/repos/"))).toEqual([]);
    expect(hints).not.toHaveBeenCalled();
    expect(await runRows(r)).toMatchObject([{ trigger: "installation_created", state: "skipped", skip_reason: "free_preview" }]);

    await activate(r);
    await queue(r, "activation", "sub_paid");
    const [out] = await runQueuedDiscoveries(depsFor(r, factory, hints));
    expect(out).toMatchObject({ state: "succeeded", imported: 4, withPreview: 1 });
    const rows = await proposals(r);
    expect(rows.map((p) => p.dedupe_key)).toEqual(["gh:discussion:9", "gh:issue:1", "gh:issue:2", "gh:issue:3"]);
    const two = rows.find((p) => p.dedupe_key === "gh:issue:2")!;
    expect(two).toMatchObject({ sources: ["github_issue", "preview"], category_hint: "bug", estimate: 1.5 });
    expect(rows.filter((p) => p.sources.includes("preview"))).toHaveLength(1); // 999 is outside the window and is not imported
    expect(await counts(r)).toEqual(before);
  });

  it("a rerun keeps the preview source once and a person's decision as it was", async () => {
    const r = await tenant();
    const factory = await github([issue(1), issue(2)]);
    const hints = async (): Promise<PreviewHint[]> => [{ number: 1, category: "small", expectedUsd: 0.5 }];
    await queue(r, "activation", "s1");
    await runQueuedDiscoveries(depsFor(r, factory, hints));
    await admin.query(`UPDATE proposals SET state = 'rejected', decided_at = now() WHERE account_id = $1 AND dedupe_key = 'gh:issue:2'`, [r.accountId]);
    await queue(r, "repos_added", "d2");
    await runQueuedDiscoveries(depsFor(r, factory, hints));
    const rows = await proposals(r);
    expect(rows.find((p) => p.dedupe_key === "gh:issue:1")!.sources).toEqual(["github_issue", "preview"]);
    expect(rows.find((p) => p.dedupe_key === "gh:issue:2")!.state).toBe("rejected");
  });

  it("a repo with the engine loop gets internal_loop rows (shown, never product), and still no work item", async () => {
    const r = await tenant();
    const factory = await github([issue(1)], [discussion(2, 1)], { [ENGINE_LOOP_MARKER]: "{}" });
    const before = await counts(r);
    await queue(r, "activation", "s");
    expect((await runQueuedDiscoveries(depsFor(r, factory)))[0]).toMatchObject({ state: "succeeded", owner: "internal_loop" });
    expect((await proposals(r)).every((p) => p.owner_process === "internal_loop")).toBe(true);
    // The data itself refuses to approve one: an approval needs a product-owned item.
    await expect(admin.query(`UPDATE proposals SET state = 'approved', roadmap_position = 1, decided_at = now() WHERE account_id = $1`, [r.accountId])).rejects.toMatchObject({ code: "23514" });
    expect(await counts(r)).toEqual(before);
  });

  it("a repo whose discovery is switched off is skipped with its reason", async () => {
    const r = await tenant();
    await admin.query(`INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'off', 1, $3)`, [r.accountId, r.repoId, r.userId]);
    const factory = await github([issue(1)]);
    await queue(r, "activation", "s");
    expect(await runQueuedDiscoveries(depsFor(r, factory))).toEqual([{ state: "skipped", reason: "discovery_off" }]);
    expect(await proposals(r)).toEqual([]);
  });

  it("a GitHub failure fails the run with a code and writes no proposal", async () => {
    const r = await tenant();
    const factory = await github([issue(1)], [], {}, { faults: { issuesStatus: 500 } });
    await queue(r, "activation", "s");
    expect(await runQueuedDiscoveries(depsFor(r, factory))).toEqual([{ state: "failed", code: "github_unavailable" }]);
    expect(await proposals(r)).toEqual([]);
    expect(await runRows(r)).toMatchObject([{ state: "failed", skip_reason: "github_unavailable" }]);
  });

  it("S4c-4: removing the repo from the installation withdraws its new rows at the next sweep; approved and rejected rows stay; reconnecting brings new rows back", async () => {
    const r = await tenant();
    const factory = await github([issue(1), issue(2), issue(3), issue(4)]);
    await queue(r, "installation_created", "d1");
    await runQueuedDiscoveries(depsFor(r, factory));
    await admin.query(`UPDATE proposals SET state = 'rejected', decided_at = now(), reject_note = 'no' WHERE account_id = $1 AND dedupe_key = 'gh:issue:2'`, [r.accountId]);
    await admin.query(`UPDATE proposals SET state = 'approved', decided_at = now(), roadmap_position = 1 WHERE account_id = $1 AND dedupe_key = 'gh:issue:3'`, [r.accountId]);
    const states = async () => Object.fromEntries((await proposals(r)).map((p) => [p.dedupe_key, p.state]));
    expect(await states()).toEqual({ "gh:issue:1": "new", "gh:issue:2": "rejected", "gh:issue:3": "approved", "gh:issue:4": "new" });
    const before = await counts(r);

    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [r.repoId]);
    // Nothing happens until the sweep.
    expect(await states()).toMatchObject({ "gh:issue:1": "new" });
    expect(await withdrawDisconnectedProposals(appUserPool, r.accountId)).toBe(2);
    expect(await states()).toEqual({ "gh:issue:1": "withdrawn", "gh:issue:2": "rejected", "gh:issue:3": "approved", "gh:issue:4": "withdrawn" });
    // Withdrawn is a state, never a deletion.
    expect(await proposals(r)).toHaveLength(4);
    // A second sweep changes nothing, and a disconnected repo is not discovered.
    expect(await withdrawDisconnectedProposals(appUserPool, r.accountId)).toBe(0);
    expect(await queue(r, "repos_added", "d-gone")).toEqual([]);

    // Queued while connected, then disconnected before it ran: the run skips with its reason and reads nothing.
    await admin.query(`UPDATE repos SET installation_id = $2 WHERE id = $1`, [r.repoId, r.installationId]);
    await queue(r, "repos_added", "d-race");
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [r.repoId]);
    expect((await runQueuedDiscoveries(depsFor(r, factory)))[0]).toEqual({ state: "skipped", reason: "repo_not_connected" });
    await admin.query(`UPDATE repos SET installation_id = $2 WHERE id = $1`, [r.repoId, r.installationId]);
    await queue(r, "repos_added", "d-back");
    await runQueuedDiscoveries(depsFor(r, factory));
    expect(await states()).toEqual({ "gh:issue:1": "new", "gh:issue:2": "rejected", "gh:issue:3": "approved", "gh:issue:4": "new" });
    expect(await counts(r)).toEqual(before);
  });

  it("the sweep touches only repositories of its own account", async () => {
    const a = await tenant();
    const b = await tenant();
    const factory = await github([issue(1)]);
    await queue(b, "activation", "sb");
    await runQueuedDiscoveries(depsFor(b, factory));
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [a.repoId]);
    expect(await withdrawDisconnectedProposals(appUserPool, a.accountId)).toBe(0);
    expect((await proposals(b)).map((p) => p.state)).toEqual(["new"]);
  });

  it("the import role the writes run as has no way to start work", async () => {
    const r = await tenant();
    const c = await appUserPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.account_id', $1, true)`, [r.accountId]);
      await c.query("SET LOCAL ROLE plan_importer");
      await expect(c.query(`INSERT INTO work_items (account_id, repo_id, kind, provenance) VALUES ($1, $2, 'feature', 'internal')`, [r.accountId, r.repoId])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
