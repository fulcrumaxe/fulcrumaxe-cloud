import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "@fx/db/src/migrate.js";
import { queueDiscoveries } from "@fx/db/src/discoveryRuns.js";
import { provisionEphemeralPostgres, type EphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";
import { createRunWriterTestLogin, runWriterUrlFrom } from "@fx/db/test/support/run-writer-login.js";
import { guardedPools } from "@fx/db/test/support/pool-teardown.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createPlanSourceFactory } from "@fx/github";
import { parsePreviewResult } from "@fx/pipeline";
import { markWorkPending, runGatedTick, setPendingHooks } from "@fx/core/src/pendingWork.js";
import { newFakeState, startPlanGithub, type FakeItem, type PlanGithub } from "../../github/test/helpers/planGithubFake.js";
import { createDiscoveryDrain, DRAIN_LIST_LIMIT } from "../src/discoveryDrain.js";
import { createPreviewHints } from "../src/previewHints.js";
import type { PendingStore } from "@fx/core/src/pendingWork.js";
/** What a delivery that queued discoveries does (the webhook handler sets this marker; its own test is apps/web/app/api/github/webhook/handler.test.ts). */
const markDiscoveryDrainPending = (): Promise<void> => markWorkPending("proposal-verify-sweep");

/**
 * [pg] D#483 S4-c2: the install and payment discovery queue is drained by the REAL cron handler, behind the REAL no-database gate, over real Postgres as
 * the real runner login (a member of app_user and agent_run_writer), with the real read-only GitHub client talking to the strict GitHub fake over TLS.
 * Only the verifier and auto-start passes are stubbed (they are not what is under test).
 */
const SECRET = "test-cron-secret";
const clock = { value: Math.floor(Date.now() / 3_600_000) * 3_600_000 };
/** An in-memory pending-work store (the marker the cron gate reads); values round-trip as numbers, no TTL needed inside one test. */
const storeOver = (m: Map<string, number>): PendingStore => ({
  get: async (key) => m.get(key) ?? null,
  set: async (key, value) => void m.set(key, value),
  delete: async (key) => void m.delete(key),
});
const hour = (n: number): string => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();
const issue = (n: number): FakeItem => ({ number: n, title: `Issue ${n}`, body: `body ${n}`, state: "open", updatedAt: hour(n) });

describe("the install and payment discovery drain in the proposal-verify tick [pg]", () => {
  let pg: EphemeralPostgres;
  const pools = guardedPools();
  let admin: Pool;
  let seedClient: PoolClient;
  let appUser: Pool;
  let runner: Pool;
  let gh: PlanGithub | undefined;
  let region: Map<string, number>;
  let pem: string;
  let holdHead: Promise<void> | null = null;
  let stubs: { verifier: number };

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: "fx_web_discovery_drain_test", tmpPrefix: "fx-web-disc-drain-" });
    admin = pools.create(pg.url);
    await runMigrations(admin);
    seedClient = await admin.connect();
    await createRunWriterTestLogin(pg.url);
    appUser = pools.create(pg.appUserUrl);
    runner = pools.create(runWriterUrlFrom(pg.appUserUrl));
    pem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
  }, 180_000);
  afterAll(async () => {
    seedClient?.release();
    await pools.stop(() => pg?.cleanup());
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.value);
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.spyOn(console, "log").mockImplementation(() => {});
    region = new Map();
    setPendingHooks({ store: storeOver(region) });
    holdHead = null;
    stubs = { verifier: 0 };
  });
  afterEach(async () => {
    await gh?.close();
    gh = undefined;
    setPendingHooks(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function tenant(opts: { active?: boolean } = {}): Promise<SeedRefs> {
    const r = await seedAccount(seedClient, randomUUID());
    await admin.query(`UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1`, [r.repoId]);
    if (opts.active === false) await admin.query(`UPDATE accounts SET stripe_customer_id = NULL WHERE id = $1`, [r.accountId]);
    return r;
  }
  async function github(items: FakeItem[]) {
    gh = await startPlanGithub(newFakeState({ items, discussions: [], files: new Map() }));
    const factory = createPlanSourceFactory({ resolveInstallation: async () => ({ installationId: 777, appKind: "team" }), appCredentials: () => ({ appId: "123", privateKeyPem: pem, webhookSecret: "unused-unused-unused-unused-unused" }), requester: gh.requester, fetchImpl: gh.fetch });
    return factory;
  }
  /** The drain over the runner login. The head read can be held, to keep a pass open with its lock taken. */
  function drainOver(factory: Awaited<ReturnType<typeof github>>) {
    return createDiscoveryDrain({
      pool: runner,
      openSource: (t) => {
        const source = factory(t);
        return { ...source, head: async () => (holdHead ? (await holdHead, source.head()) : source.head()) };
      },
      previewHints: createPreviewHints(runner, parsePreviewResult),
    });
  }
  /** One cron tick as the handler runs it: behind the real pending-work gate, the discovery pass first, then the (stubbed) verifier pass. The handler itself is apps/web's (its cases: apps/web/app/api/cron/proposal-verify-sweep/handler.test.ts). */
  const tick = async (drain: ReturnType<typeof drainOver>): Promise<Record<string, unknown>> => {
    const ran = await runGatedTick(
      "proposal-verify-sweep",
      async () => {
        const discovery = await drain();
        stubs.verifier += 1;
        return { result: { configured: true, discovery }, workFound: discovery.more, nextDueAt: null };
      },
      () => {},
      () => clock.value,
    );
    return ran === null ? { skipped: true } : (ran.result as Record<string, unknown>);
  };
  const proposals = async (r: SeedRefs) => (await admin.query(`SELECT dedupe_key, state, sources, category_hint, estimate_usd::float AS estimate FROM proposals WHERE account_id = $1 ORDER BY dedupe_key`, [r.accountId])).rows as Array<{ dedupe_key: string; state: string; sources: string[]; category_hint: string | null; estimate: number | null }>;
  const counts = async (r: SeedRefs) => {
    const one = async (t: string) => (await admin.query(`SELECT count(*)::int n FROM ${t} WHERE account_id = $1`, [r.accountId])).rows[0].n as number;
    return { work_items: await one("work_items"), agent_runs: await one("agent_runs"), run_action_requests: await one("run_action_requests") };
  };
  const runStates = async (r: SeedRefs) => (await admin.query(`SELECT trigger, state, skip_reason FROM discovery_runs WHERE account_id = $1 ORDER BY created_at`, [r.accountId])).rows;

  it("C25-c2-1: an installation_created run queued by queueDiscoveries is succeeded after one tick; the repo has its proposals and no work item or agent run was made", async () => {
    const r = await tenant();
    const factory = await github([issue(1), issue(2), issue(3)]);
    const before = await counts(r);
    expect(await queueDiscoveries(appUser, r.accountId, { kind: "account" }, "installation_created", "inst-1")).toHaveLength(1);
    // The delivery that queued it marks the tick; without a marker the tick would wait for its backstop.
    await markDiscoveryDrainPending();
    const out = await tick(drainOver(factory));
    expect(out).toMatchObject({ configured: true, discovery: { accounts: 1, succeeded: 1, failed: 0, errors: 0 } });
    expect(await runStates(r)).toEqual([{ trigger: "installation_created", state: "succeeded", skip_reason: null }]);
    expect((await proposals(r)).map((p) => p.dedupe_key)).toEqual(["gh:issue:1", "gh:issue:2", "gh:issue:3"]);
    expect(await counts(r)).toEqual(before);
  });

  it("C25-c2-2 (S4c-4): a repo whose installation was removed has its new proposals withdrawn after one tick, with no queued run; approved and rejected rows stay", async () => {
    const r = await tenant();
    const factory = await github([issue(1), issue(2), issue(3)]);
    await queueDiscoveries(appUser, r.accountId, { kind: "account" }, "installation_created", "inst-2");
    await markDiscoveryDrainPending();
    await tick(drainOver(factory));
    await admin.query(`UPDATE proposals SET state = 'rejected', decided_at = now(), reject_note = 'no' WHERE account_id = $1 AND dedupe_key = 'gh:issue:2'`, [r.accountId]);
    await admin.query(`UPDATE proposals SET state = 'approved', decided_at = now(), roadmap_position = 1 WHERE account_id = $1 AND dedupe_key = 'gh:issue:3'`, [r.accountId]);
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [r.repoId]);
    expect((await admin.query(`SELECT count(*)::int n FROM discovery_runs WHERE account_id = $1 AND state = 'queued'`, [r.accountId])).rows[0].n).toBe(0);
    await markDiscoveryDrainPending();
    expect(await tick(drainOver(factory))).toMatchObject({ discovery: { accounts: 1 } });
    expect(Object.fromEntries((await proposals(r)).map((p) => [p.dedupe_key, p.state]))).toEqual({ "gh:issue:1": "withdrawn", "gh:issue:2": "rejected", "gh:issue:3": "approved" });
    // Withdrawn rows leave the list: the next marked tick finds nothing for this account.
    await markDiscoveryDrainPending();
    expect(await tick(drainOver(factory))).toMatchObject({ discovery: { accounts: 0 } });
  });

  it("C25-c2-3 (S4c-3): an activation run for an account with a finished preview writes the preview's issues with the preview source, its hint and its estimate", async () => {
    const r = await tenant();
    const factory = await github([issue(1), issue(2), issue(3)]);
    const preview = { issues: [{ number: 2, title: "Issue 2", category: "bug", expected_model_usd: 1.5 }, { number: 999, title: "Gone", category: "feature", expected_model_usd: 4 }], sample_spec: { issue_number: 2, body: "spec" } };
    await admin.query(`INSERT INTO onboarding_previews (id, account_id, installation_id, repo_id, gh_user_id, run_action_id, gh_installation_id, gh_owner) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [randomUUID(), r.accountId, r.installationId, r.repoId, 1_000_000 + Math.floor(Math.random() * 1e6), randomUUID(), 4_000_000 + Math.floor(Math.random() * 1e6), "acme"]);
    await admin.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE account_id = $1`, [r.accountId, r.runId]);
    await admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = $2::jsonb WHERE id = $1`, [r.runId, JSON.stringify(preview)]);
    await queueDiscoveries(appUser, r.accountId, { kind: "account" }, "activation", "sub_1");
    await markDiscoveryDrainPending();
    await tick(drainOver(factory));
    const rows = await proposals(r);
    expect(rows.find((p) => p.dedupe_key === "gh:issue:2")).toMatchObject({ sources: ["github_issue", "preview"], category_hint: "bug", estimate: 1.5 });
    expect(rows.filter((p) => p.sources.includes("preview"))).toHaveLength(1);
    // An envelope that fails the preview's own checks gives no hints and still imports the issues.
    await admin.query(`UPDATE agent_runs SET envelope = '{"issues":"x"}'::jsonb WHERE id = $1`, [r.runId]);
    await queueDiscoveries(appUser, r.accountId, { kind: "account" }, "activation", "sub_2");
    await markDiscoveryDrainPending();
    expect(await tick(drainOver(factory))).toMatchObject({ discovery: { succeeded: 1 } });
  });

  it("C25-c2-4: two overlapping ticks: the second drains nothing (the lock) and no run is processed twice", async () => {
    const r = await tenant();
    const factory = await github([issue(1)]);
    await queueDiscoveries(appUser, r.accountId, { kind: "account" }, "installation_created", "inst-4");
    let release!: () => void;
    holdHead = new Promise<void>((res) => (release = res));
    const drain = drainOver(factory);
    await markDiscoveryDrainPending();
    const first = tick(drain);
    // Wait until the first pass has claimed the run, then run a second pass against the held lock.
    for (let i = 0; i < 200 && (await runStates(r))[0]?.state !== "running"; i++) await new Promise((res) => setTimeout(res, 25));
    expect((await runStates(r))[0]!.state).toBe("running");
    expect(await drain()).toMatchObject({ idle: "busy", accounts: 0, succeeded: 0 });
    release();
    expect(await first).toMatchObject({ discovery: { accounts: 1, succeeded: 1 } });
    expect((await runStates(r)).map((s) => s.state)).toEqual(["succeeded"]);
    expect(gh!.server.seen.filter((s) => s.path.includes("/issues")).length).toBeGreaterThan(0);
  });

  it("the pass budget is checked between the runs of one account: the rest stay queued and the tick is told there is more", async () => {
    const r = await tenant();
    const factory = await github([issue(1)]);
    for (const ref of ["inst-a", "inst-b", "inst-c"]) await queueDiscoveries(appUser, r.accountId, { kind: "account" }, "installation_created", ref);
    // Each run's GitHub read takes 25 s of the (fake) clock, so the 20 s budget is spent after the first run.
    let t = clock.value;
    const drain = createDiscoveryDrain({
      pool: runner,
      now: () => t,
      openSource: (target) => {
        const source = factory(target);
        return { ...source, head: async () => ((t += 25_000), source.head()) };
      },
    });
    expect(await drain()).toMatchObject({ accounts: 1, succeeded: 1, errors: 0, more: true });
    expect((await runStates(r)).map((s) => s.state).sort()).toEqual(["queued", "queued", "succeeded"]);
    // The next pass takes the account again and, with a fresh budget, one more run.
    expect(await drain()).toMatchObject({ accounts: 1, succeeded: 1, more: true });
    expect((await runStates(r)).map((s) => s.state).sort()).toEqual(["queued", "succeeded", "succeeded"]);
  });

  it("a pass whose account throws still completes the other account's runs, and counts the error", async () => {
    // Runs the earlier cases left queued belong to other accounts and would be drained too.
    await admin.query(`UPDATE discovery_runs SET state = 'skipped', skip_reason = 'discovery_off', finished_at = now() WHERE state = 'queued'`);
    const bad = await tenant();
    const good = await tenant();
    const factory = await github([issue(1)]);
    await queueDiscoveries(appUser, bad.accountId, { kind: "account" }, "installation_created", "inst-bad");
    await queueDiscoveries(appUser, good.accountId, { kind: "account" }, "installation_created", "inst-good");
    const hints = createPreviewHints(runner, parsePreviewResult);
    const drain = createDiscoveryDrain({
      pool: runner,
      openSource: (t) => factory(t),
      previewHints: (accountId) => {
        if (accountId === bad.accountId) throw new Error("hints unavailable");
        return hints(accountId);
      },
    });
    expect(await drain()).toMatchObject({ accounts: 2, succeeded: 1, errors: 1 });
    expect((await runStates(good)).map((s) => s.state)).toEqual(["succeeded"]);
    expect((await runStates(bad)).map((s) => s.state)).toEqual(["queued"]);
  });

  it("a full page from the lister sets more", async () => {
    const lister = { query: async () => ({ rows: Array.from({ length: DRAIN_LIST_LIMIT }, () => ({ account_id: randomUUID() })) }), connect: async () => runner.connect() } as unknown as Pool;
    const out = await createDiscoveryDrain({ pool: lister, openSource: () => ({}) as never })();
    expect(out.more).toBe(true);
  });

  it("C25-c2-6:a delivery that queued discoveries sets the pending-work marker for proposal-verify-sweep", async () => {
    expect(region.has("pending:proposal-verify-sweep")).toBe(false);
    await markDiscoveryDrainPending();
    await new Promise((res) => setTimeout(res, 20));
    expect(region.has("pending:proposal-verify-sweep")).toBe(true);
    await markWorkPending("reconcile");
  });
});
