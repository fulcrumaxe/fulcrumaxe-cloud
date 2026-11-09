import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { saveVerifySettings } from "@fx/core/src/verify/rows.js";
import type { CommitFacts, CommitRelation } from "@fx/core/src/verify/qualify.js";
import { createVerifyStageSweep, INTAKE_HOST_TRIES, INTAKE_PER_PASS, READINESS_CAP_MINUTES, type HealthRead, type VerifyHostPort, type VerifyStageCounts, type VerifyTarget } from "../src/verifyStage.js";

/**
 * [pg] D#749 V3a: the verify stage's sweep against a real Postgres, as the runner login, through the real lister and under each account's own tenant. The host (GitHub) and the
 * deployed app are strict fakes: the host refuses what GitHub refuses (a sha that is not 40 or 64 lowercase hex, a pull request number that is not a positive integer, a repository
 * without an owner and name) and answers null for a commit it does not have; the app's reader is handed exactly the base URL the settings name. Time is the database's own: a
 * deadline or a finish time is moved with the table's guard switched off for the test, never waited for.
 */
const A_SHA = "a".repeat(40);
const BASE_URL = "https://app.example";
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha = (c: string): string => c.repeat(40);

class FakeHost implements VerifyHostPort {
  merges = new Map<string, string>();
  commits = new Map<string, CommitFacts>();
  relations = new Map<string, CommitRelation>();
  failMerge = new Set<string>();
  throwOnCommit = false;
  calls: string[] = [];
  /** The target of every call, in order: what the host was told about the repository's planes. */
  targets: VerifyTarget[] = [];
  private target(t: VerifyTarget): void {
    if (!t.owner || !t.name || !t.repoId) throw new Error("host: a repository needs an owner and a name");
    if (t.codeRepo != null && (!t.codeRepo.owner || !t.codeRepo.name)) throw new Error("host: a code repository needs an owner and a name");
    this.targets.push(t);
  }
  async mergeCommit(t: VerifyTarget, pr: number): Promise<string | null> {
    this.target(t);
    if (!Number.isInteger(pr) || pr < 1) throw new Error("host: pull request number must be a positive integer");
    this.calls.push(`merge:${pr}`);
    if (this.failMerge.has(t.repoId)) throw new Error("host: unavailable");
    return this.merges.get(`${t.repoId}#${pr}`) ?? null;
  }
  async commit(t: VerifyTarget, s: string): Promise<CommitFacts | null> {
    this.target(t);
    if (!SHA_RE.test(s)) throw new Error("host: not a commit id");
    this.calls.push(`commit:${s.slice(0, 4)}`);
    if (this.throwOnCommit) throw new Error("host: unavailable");
    return this.commits.get(s) ?? null;
  }
  async relation(t: VerifyTarget, base: string, head: string): Promise<CommitRelation> {
    this.target(t);
    if (!SHA_RE.test(base) || !SHA_RE.test(head)) throw new Error("host: not a commit id");
    this.calls.push(`relation:${base.slice(0, 4)}:${head.slice(0, 4)}`);
    return this.relations.get(`${base}:${head}`) ?? "unknown";
  }
}

describe("the verify stage sweep [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let host: FakeHost;
  let healthUrls: string[];
  let healthAnswer: HealthRead;
  let readyCalls: Array<{ rowId: string; deployedCommit: string }>;

  const sweep = () =>
    createVerifyStageSweep({
      pool: writerPool,
      host,
      health: async (url) => {
        healthUrls.push(url);
        return healthAnswer;
      },
      ready: async (i) => void readyCalls.push({ rowId: i.row.id, deployedCommit: i.deployedCommit }),
    })();
  const tenant = <T>(who: SeedRefs, fn: (c: PoolClient) => Promise<T>) => withTenant(writerPool, who.accountId, fn);

  /** The test's hand on the intake boundary: the trigger that stamps `enabled_since` is switched off for one statement (it ignores any value a writer supplies). */
  async function forceSince(repoId: string, expr: string): Promise<void> {
    await admin.query("ALTER TABLE verify_settings DISABLE TRIGGER verify_settings_stamp_enabled_since");
    try {
      await admin.query(`UPDATE verify_settings SET enabled_since = ${expr} WHERE repo_id = $1`, [repoId]);
    } finally {
      await admin.query("ALTER TABLE verify_settings ENABLE TRIGGER verify_settings_stamp_enabled_since");
    }
  }
  async function newRepo(who: SeedRefs, settings: { enabled?: boolean; sinceAfterMerge?: boolean; codeRepo?: string } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', $5)`, [id, who.accountId, who.installationId, Math.floor(Math.random() * 1e9) + 10, `widgets-${id.slice(0, 8)}`]);
    await admin.query(`INSERT INTO verify_settings (repo_id, account_id, enabled, base_url, eligibility) VALUES ($1, $2, $3, $4, 'all')`, [id, who.accountId, settings.enabled ?? true, BASE_URL]);
    if (settings.enabled !== false) await forceSince(id, settings.sinceAfterMerge ? "now() + interval '10 minutes'" : "now() - interval '1 hour'");
    if (settings.codeRepo !== undefined) await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, $4)`, [id, who.accountId, settings.codeRepo, ["private/**"]]);
    return id;
  }
  /** A merged item with the facts a product merge leaves: the transition to merged and the gate's `merged_by_gate` fact naming the pull request. */
  async function mergedItem(who: SeedRefs, repoId: string, pr: number, o: { byProduct?: boolean; mergeSha?: string } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'merged')`, [id, who.accountId, repoId]);
    await admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'review_passed', 'merged', now(), 'webhook', $3)`, [who.accountId, id, `d-${id}`]);
    if (o.byProduct !== false) {
      await admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'merged_by_gate', 'merged', $3, $4, 'k')`, [who.accountId, id, sha("1"), pr]);
    }
    if (o.mergeSha !== undefined) host.merges.set(`${repoId}#${pr}`, o.mergeSha);
    return id;
  }
  const rowsOf = async (repoId: string) => (await admin.query(`SELECT id, status, merge_sha, reason_code, deploy_by_order, pr_number FROM verify_rows WHERE repo_id = $1 ORDER BY created_at, id`, [repoId])).rows;
  const ordersOf = async (repoId: string) => (await admin.query(`SELECT id, state, merge_sha, verify_row_id FROM verify_deploy_orders WHERE repo_id = $1 ORDER BY created_at, id`, [repoId])).rows;
  /** The test's hand on the order table: the guard is switched off for one statement (it forbids moving a deadline or a finished order). */
  async function forceOrder(orderId: string, set: string): Promise<void> {
    await admin.query("ALTER TABLE verify_deploy_orders DISABLE TRIGGER verify_deploy_orders_guard");
    try {
      await admin.query(`UPDATE verify_deploy_orders SET ${set} WHERE id = $1`, [orderId]);
    } finally {
      await admin.query("ALTER TABLE verify_deploy_orders ENABLE TRIGGER verify_deploy_orders_guard");
    }
  }
  const succeed = (orderId: string, finishedAgo = "0 minutes") => forceOrder(orderId, `state = 'succeeded', exit_code = 0, finished_at = now() - interval '${finishedAgo}'`);
  /** A verified-qualifying world: one product-merged item, its row deployed by an order that succeeded. Returns what a test needs. */
  async function deployed(who: SeedRefs, o: { finishedAgo?: string; mergeSha?: string } = {}) {
    const repo = await newRepo(who);
    const mergeSha = o.mergeSha ?? sha("c");
    await mergedItem(who, repo, 7, { mergeSha });
    await sweep();
    const order = (await ordersOf(repo))[0]!;
    await succeed(order.id, o.finishedAgo);
    return { repo, mergeSha, orderId: order.id as string, row: (await rowsOf(repo))[0]! };
  }
  const SYNC = (hex: string) => `Sync private main with code-plane/main (${hex})`;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await writerPool.end();
  });
  beforeEach(async () => {
    // Every case starts with verification off everywhere (the real lister then names only what the case switches on) and nothing open.
    await admin.query("UPDATE verify_settings SET enabled = false");
    host = new FakeHost();
    healthUrls = [];
    healthAnswer = { kind: "ok", commit: null };
    readyCalls = [];
  });

  describe("off by default and intake", () => {
    it("with verification off nothing is listed, opened, ordered or read, even with a merged item waiting", async () => {
      const repo = await newRepo(a, { enabled: false });
      await mergedItem(a, repo, 5, { mergeSha: sha("a") });
      const counts = await sweep();
      expect(counts).toMatchObject({ listed: 0, opened: 0, ordered: 0, active: 0 });
      expect(host.calls).toEqual([]);
      expect(healthUrls).toEqual([]);
      expect(await rowsOf(repo)).toEqual([]);
      expect(await ordersOf(repo)).toEqual([]);
    });

    it("a merged item the product merged enters verify under V1's rules: one row, journeys written, the merge commit from the host, the deploy started by an order", async () => {
      const repo = await newRepo(a);
      const item = await mergedItem(a, repo, 7, { mergeSha: sha("b") });
      const counts = await sweep();
      expect(counts).toMatchObject({ opened: 1, ordered: 1, active: 1 });
      const [row] = await rowsOf(repo);
      expect(row).toMatchObject({ status: "deploying", merge_sha: sha("b"), pr_number: 7, deploy_by_order: true });
      const journeys = (await admin.query(`SELECT journeys, work_item_id FROM verify_rows WHERE id = $1`, [row.id])).rows[0];
      expect(journeys.work_item_id).toBe(item);
      expect(Array.isArray(journeys.journeys)).toBe(true);
      expect(await ordersOf(repo)).toEqual([{ id: expect.any(String), state: "pending", merge_sha: sha("b"), verify_row_id: row.id }]);
    });

    it("a replay of the pass makes no second row, no second batch and no second order", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 7, { mergeSha: sha("b") });
      await sweep();
      const again = await sweep();
      await sweep();
      expect(again).toMatchObject({ opened: 0, ordered: 0, waiting: 1 });
      expect(await rowsOf(repo)).toHaveLength(1);
      expect(await ordersOf(repo)).toHaveLength(1);
      expect((await admin.query(`SELECT 1 FROM verify_batches WHERE repo_id = $1`, [repo])).rowCount).toBe(1);
    });

    it("an item a person merged (no gate fact), one that merged before verification was switched on, and a merge the host cannot name yet are not opened; the last is tried again", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 1, { byProduct: false, mergeSha: sha("1") });
      expect((await sweep()).opened).toBe(0);
      const late = await newRepo(a, { sinceAfterMerge: true });
      await mergedItem(a, late, 2, { mergeSha: sha("2") });
      expect((await sweep()).opened).toBe(0);
      expect(await rowsOf(late)).toEqual([]);
      const pending = await newRepo(a);
      await mergedItem(a, pending, 3);
      const first = await sweep();
      expect(first).toMatchObject({ opened: 0, no_merge_commit: 1 });
      host.merges.set(`${pending}#3`, sha("3"));
      expect((await sweep()).opened).toBe(1);
    });

    it("a host that answers with something that is not a commit id opens nothing", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 4, { mergeSha: "HEAD" });
      const counts = await sweep();
      expect(counts).toMatchObject({ opened: 0, no_merge_commit: 1 });
      expect(await rowsOf(repo)).toEqual([]);
    });
  });

  describe("one deploy at a time, one order per batch", () => {
    it("two merges that arrive together open two rows but only the older one is deployed; the next starts when the first has finished", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 10, { mergeSha: sha("d") });
      await new Promise((r) => setTimeout(r, 5));
      await mergedItem(a, repo, 11, { mergeSha: sha("e") });
      const counts = await sweep();
      expect(counts).toMatchObject({ opened: 2, ordered: 1, active: 1 });
      expect((await rowsOf(repo)).map((r) => r.status)).toEqual(["deploying", "pending"]);
      expect(await ordersOf(repo)).toHaveLength(1);
      // The first ends (its order failed); the second now gets its own order.
      await forceOrder((await ordersOf(repo))[0]!.id, "state = 'failed', failure_code = 'timeout', finished_at = now()");
      await sweep();
      expect((await rowsOf(repo)).map((r) => r.status)).toEqual(["unverified", "deploying"]);
      expect(await ordersOf(repo)).toHaveLength(2);
    });

    it("is tenant scoped: each account's repository is read and ordered under its own tenant, and a pass over both mixes nothing", async () => {
      const ra = await newRepo(a);
      const rb = await newRepo(b);
      await mergedItem(a, ra, 20, { mergeSha: sha("a") });
      await mergedItem(b, rb, 20, { mergeSha: sha("b") });
      await sweep();
      expect((await ordersOf(ra)).map((o) => o.merge_sha)).toEqual([sha("a")]);
      expect((await ordersOf(rb)).map((o) => o.merge_sha)).toEqual([sha("b")]);
      expect((await tenant(a, (c) => c.query(`SELECT repo_id FROM verify_rows`))).rows.every((r) => r.repo_id !== rb)).toBe(true);
      expect((await tenant(b, (c) => c.query(`SELECT repo_id FROM verify_rows`))).rows.every((r) => r.repo_id !== ra)).toBe(true);
    });

    it("a repository that fails never holds up the next one, and the failure is counted", async () => {
      const bad = await newRepo(a);
      const good = await newRepo(b);
      await mergedItem(a, bad, 1, { mergeSha: sha("1") });
      await mergedItem(b, good, 1, { mergeSha: sha("2") });
      host.failMerge.add(bad);
      const counts = await sweep();
      expect(counts.failed).toBe(1);
      expect(await ordersOf(good)).toHaveLength(1);
      expect(await rowsOf(bad)).toEqual([]);
    });

    it("another pass holding the sweep's lock makes this one a no-op that says so", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 1, { mergeSha: sha("1") });
      const holder = await adminPool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('fx:verify_stage_sweep', 0))");
        expect(await sweep()).toMatchObject({ idle: "busy", listed: 0, opened: 0 });
        expect(await rowsOf(repo)).toEqual([]);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      expect((await sweep()).opened).toBe(1);
    });

    it("a row that is already running belongs to the tester: the pass leaves it and starts nothing behind it", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 1, { mergeSha: sha("1") });
      await sweep();
      const row = (await rowsOf(repo))[0]!;
      await admin.query(`UPDATE verify_rows SET status = 'running', method = 'chrome_runner', deployed_commit = $2, started_at = now() WHERE id = $1`, [row.id, sha("1")]);
      await mergedItem(a, repo, 2, { mergeSha: sha("2") });
      const counts = await sweep();
      expect(counts).toMatchObject({ opened: 1, ordered: 0, waiting: 1 });
      expect((await rowsOf(repo)).map((r) => r.status)).toEqual(["running", "pending"]);
    });
  });

  describe("a deploy that does not happen stops the row with a plain reason", () => {
    it("an order no runner took before its deadline lapses, and the row ends unverified deploy_failed", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 1, { mergeSha: sha("1") });
      await sweep();
      const order = (await ordersOf(repo))[0]!;
      expect(await sweep()).toMatchObject({ waiting: 1 });
      await forceOrder(order.id, "deadline_at = now() - interval '1 minute'");
      const counts = await sweep();
      expect(counts).toMatchObject({ unverified: 1, active: 0 });
      expect((await rowsOf(repo))[0]).toMatchObject({ status: "unverified", reason_code: "deploy_failed" });
      expect((await ordersOf(repo))[0]!.state).toBe("expired");
      expect((await sweep()).active).toBe(0);
    });

    it("an order a runner claimed and then vanished from lapses the same way, but one with a live lease past its deadline is left to finish", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 1, { mergeSha: sha("1") });
      await sweep();
      const order = (await ordersOf(repo))[0]!;
      const runnerId = await insertRunner(admin, a.accountId, a.userId);
      await forceOrder(order.id, `state = 'claimed', runner_id = '${runnerId}', lease_generation = 1, attempts = 1, lease_expires_at = now() + interval '5 minutes', deadline_at = now() - interval '1 minute'`);
      expect(await sweep()).toMatchObject({ waiting: 1, unverified: 0 });
      expect((await rowsOf(repo))[0]!.status).toBe("deploying");
      await forceOrder(order.id, "lease_expires_at = now() - interval '1 minute'");
      expect(await sweep()).toMatchObject({ unverified: 1 });
      expect((await rowsOf(repo))[0]).toMatchObject({ status: "unverified", reason_code: "deploy_failed" });
    });

    it("an order the runner reported failed, and one that was called off, end the row deploy_failed", async () => {
      for (const set of ["state = 'failed', failure_code = 'exit_nonzero', exit_code = 2, output_tail = 'boom', finished_at = now()", "state = 'cancelled', finished_at = now()"]) {
        const repo = await newRepo(a);
        await mergedItem(a, repo, 1, { mergeSha: sha("1") });
        await sweep();
        await forceOrder((await ordersOf(repo))[0]!.id, set);
        await sweep();
        expect((await rowsOf(repo))[0], set).toMatchObject({ status: "unverified", reason_code: "deploy_failed" });
        expect(readyCalls).toEqual([]);
      }
    });
  });

  describe("readiness: the app must report a commit that qualifies", () => {
    it("the merge commit itself is ready: the next stage is handed the row and the commit, and the health read used exactly the settings' base URL", async () => {
      const w = await deployed(a);
      healthAnswer = { kind: "ok", commit: w.mergeSha };
      const counts = await sweep();
      expect(counts).toMatchObject({ ready: 1, unverified: 0 });
      expect(readyCalls).toEqual([{ rowId: w.row.id, deployedCommit: w.mergeSha }]);
      expect(healthUrls).toEqual([BASE_URL]);
      expect(host.calls.filter((c) => c.startsWith("commit"))).toEqual([]);
    });

    it("a genuine sync commit whose second parent IS the merge commit is ready on ONE host call (the commit): the relation is asked only when the ids differ", async () => {
      const w = await deployed(a);
      const deployedSha = sha("5");
      host.commits.set(deployedSha, { parents: [sha("9"), w.mergeSha], message: SYNC(w.mergeSha.slice(0, 12)) });
      healthAnswer = { kind: "ok", commit: deployedSha };
      host.calls = [];
      expect((await sweep()).ready).toBe(1);
      expect(host.calls).toEqual([`commit:${deployedSha.slice(0, 4)}`]);
      expect(readyCalls.map((c) => c.rowId)).toEqual([w.row.id]);
    });

    it("a genuine sync commit naming a descendant of the merge commit is ready; the relation is read from the host, never from the message, and only because the ids differ", async () => {
      const later = await deployed(b, { mergeSha: sha("c") });
      const deployedSha = sha("5");
      const newer = sha("7");
      host.commits.set(deployedSha, { parents: [sha("9"), newer], message: SYNC("7".repeat(12)) });
      host.relations.set(`${later.mergeSha}:${newer}`, "ahead");
      healthAnswer = { kind: "ok", commit: deployedSha };
      host.calls = [];
      expect((await sweep()).ready).toBe(1);
      expect(host.calls).toEqual([`commit:${deployedSha.slice(0, 4)}`, `relation:${later.mergeSha.slice(0, 4)}:${newer.slice(0, 4)}`]);
      expect(readyCalls.map((c) => c.rowId)).toEqual([later.row.id]);
    });

    it("a second parent that shares only the 12 hex the message names is a different commit: it is not accepted on the prefix, the host is asked how they relate, and only ahead qualifies", async () => {
      const w = await deployed(a);
      const deployedSha = sha("5");
      const colliding = w.mergeSha.slice(0, 12) + "f".repeat(28);
      host.commits.set(deployedSha, { parents: [sha("9"), colliding], message: SYNC(w.mergeSha.slice(0, 12)) });
      healthAnswer = { kind: "ok", commit: deployedSha };
      for (const relation of ["unknown", "identical", "diverged", "behind"] as const) {
        host.relations.set(`${w.mergeSha}:${colliding}`, relation);
        host.calls = [];
        expect(await sweep(), relation).toMatchObject({ ready: 0, waiting: 1 });
        expect(host.calls, relation).toEqual([`commit:${deployedSha.slice(0, 4)}`, `relation:${w.mergeSha.slice(0, 4)}:${colliding.slice(0, 4)}`]);
      }
      expect(readyCalls).toEqual([]);
      host.relations.set(`${w.mergeSha}:${colliding}`, "ahead");
      expect((await sweep()).ready).toBe(1);
    });

    it("a commit that only looks like a sync commit is never trusted: a copied message on a one-parent commit, a second parent that is not the commit the message names, three parents, and a relation the host calls diverged", async () => {
      const w = await deployed(a, { finishedAgo: "1 minute" });
      const d = sha("5");
      healthAnswer = { kind: "ok", commit: d };
      const msg = SYNC(w.mergeSha.slice(0, 12));
      const forged: CommitFacts[] = [
        { parents: [sha("9")], message: msg },
        { parents: [sha("9"), sha("8")], message: msg },
        { parents: [sha("9"), w.mergeSha, sha("8")], message: msg },
        { parents: [sha("8"), sha("8")], message: msg },
      ];
      for (const facts of forged) {
        host.commits.set(d, facts);
        const counts = await sweep();
        expect(counts, JSON.stringify(facts.parents)).toMatchObject({ ready: 0, waiting: 1 });
      }
      host.commits.set(d, { parents: [sha("9"), sha("6")], message: SYNC("6".repeat(12)) });
      host.relations.set(`${w.mergeSha}:${sha("6")}`, "diverged");
      expect(await sweep()).toMatchObject({ ready: 0, waiting: 1 });
      expect(readyCalls).toEqual([]);
    });

    it("a commit the host does not have, and a host that cannot answer, keep waiting; the cap then ends the row commit_not_deployed", async () => {
      const w = await deployed(a);
      healthAnswer = { kind: "ok", commit: sha("5") };
      expect(await sweep()).toMatchObject({ waiting: 1, ready: 0 });
      host.throwOnCommit = true;
      expect(await sweep()).toMatchObject({ waiting: 1, ready: 0, failed: 0 });
      await forceOrder(w.orderId, `finished_at = now() - interval '${READINESS_CAP_MINUTES + 1} minutes'`);
      expect(await sweep()).toMatchObject({ unverified: 1 });
      expect((await rowsOf(w.repo))[0]).toMatchObject({ status: "unverified", reason_code: "commit_not_deployed" });
    });

    it("an app that answers with no commit keeps waiting, then ends commit_not_deployed; one that never answers ends deployment_unreachable; inside the cap neither ends", async () => {
      const noCommit = await deployed(a);
      healthAnswer = { kind: "ok", commit: null };
      expect(await sweep()).toMatchObject({ waiting: 1, unverified: 0 });
      await forceOrder(noCommit.orderId, `finished_at = now() - interval '${READINESS_CAP_MINUTES + 1} minutes'`);
      await sweep();
      expect((await rowsOf(noCommit.repo))[0]).toMatchObject({ reason_code: "commit_not_deployed" });

      const dead = await deployed(b);
      healthAnswer = { kind: "unreachable" };
      expect(await sweep()).toMatchObject({ waiting: 1, unverified: 0 });
      await forceOrder(dead.orderId, `finished_at = now() - interval '${READINESS_CAP_MINUTES + 1} minutes'`);
      await sweep();
      expect((await rowsOf(dead.repo))[0]).toMatchObject({ status: "unverified", reason_code: "deployment_unreachable" });
    });

    it("with no next stage wired, a qualified row stays deploying and is read again next tick", async () => {
      const w = await deployed(a);
      healthAnswer = { kind: "ok", commit: w.mergeSha };
      const counts = await createVerifyStageSweep({ pool: writerPool, host, health: async () => healthAnswer })();
      expect(counts).toMatchObject({ ready: 1, active: 1 });
      expect((await rowsOf(w.repo))[0]!.status).toBe("deploying");
    });
  });

  describe("the undo path", () => {
    it("switching verification off ends the rows that never started and calls off their orders; the next pass lists nothing and a runner could claim nothing", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 1, { mergeSha: sha("1") });
      await sweep();
      expect((await ordersOf(repo))[0]!.state).toBe("pending");
      const saved = await withTenant(writerPool, a.accountId, a.userId, (c) => saveVerifySettings(c, a.accountId, repo, a.userId, { enabled: false }));
      expect(saved.endedRows).toHaveLength(1);
      expect((await rowsOf(repo))[0]).toMatchObject({ status: "unverified", reason_code: "verify_disabled" });
      expect((await ordersOf(repo))[0]!.state).toBe("cancelled");
      expect(await sweep()).toMatchObject({ listed: 0, active: 0 });
    });

    it("turning it back on starts clean: the merge from while it was off is not verified late, a new merge is", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 1, { mergeSha: sha("1") });
      const off = await withTenant(writerPool, a.accountId, a.userId, (c) => saveVerifySettings(c, a.accountId, repo, a.userId, { enabled: false }));
      expect(off.settings.enabled).toBe(false);
      expect((await admin.query(`SELECT enabled_since FROM verify_settings WHERE repo_id = $1`, [repo])).rows[0]!.enabled_since).toBeNull();
      await mergedItem(a, repo, 2, { mergeSha: sha("2") });
      await new Promise((r) => setTimeout(r, 20));
      await withTenant(writerPool, a.accountId, a.userId, (c) => saveVerifySettings(c, a.accountId, repo, a.userId, { enabled: true }));
      await new Promise((r) => setTimeout(r, 20));
      await mergedItem(a, repo, 3, { mergeSha: sha("3") });
      await sweep();
      expect((await rowsOf(repo)).map((r) => r.pr_number)).toEqual([3]);
    });
  });

  describe("the intake boundary is when verification was switched on, not when it was last saved", () => {
    const sinceOf = async (repo: string) => (await admin.query<{ s: Date | null; u: Date }>(`SELECT enabled_since AS s, updated_at AS u FROM verify_settings WHERE repo_id = $1`, [repo])).rows[0]!;

    it("a save while enabled (editing standing journeys, the label, or saving the form again) does not drop a merge that was waiting for its commit, and leaves the stamp alone", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 1);
      expect(await sweep()).toMatchObject({ opened: 0, no_merge_commit: 1 });
      const before = await sinceOf(repo);
      await new Promise((r) => setTimeout(r, 20));
      for (const patch of [{ standingJourneys: [{ id: "sign_in", text: "A person can sign in." }] }, { testAccountLabel: "tester" }, {}]) {
        await withTenant(writerPool, a.accountId, a.userId, (c) => saveVerifySettings(c, a.accountId, repo, a.userId, patch));
      }
      const after = await sinceOf(repo);
      expect(after.u.getTime()).toBeGreaterThan(before.u.getTime());
      expect(after.s!.getTime()).toBe(before.s!.getTime());
      host.merges.set(`${repo}#1`, sha("1"));
      expect(await sweep()).toMatchObject({ opened: 1 });
      expect((await rowsOf(repo)).map((r) => r.pr_number)).toEqual([1]);
    });

    it("the stamp moves on the off -> on move alone: an insert that is enabled stamps, off clears, on again re-stamps, another save keeps it", async () => {
      const repo = await newRepo(a, { enabled: false });
      expect((await sinceOf(repo)).s).toBeNull();
      await admin.query(`UPDATE verify_settings SET enabled = true WHERE repo_id = $1`, [repo]);
      const first = (await sinceOf(repo)).s;
      expect(first).not.toBeNull();
      await new Promise((r) => setTimeout(r, 20));
      await admin.query(`UPDATE verify_settings SET base_url = 'https://other.example', updated_at = now() WHERE repo_id = $1`, [repo]);
      expect((await sinceOf(repo)).s!.getTime()).toBe(first!.getTime());
      await admin.query(`UPDATE verify_settings SET enabled = false WHERE repo_id = $1`, [repo]);
      expect((await sinceOf(repo)).s).toBeNull();
      await new Promise((r) => setTimeout(r, 20));
      await admin.query(`UPDATE verify_settings SET enabled = true WHERE repo_id = $1`, [repo]);
      expect((await sinceOf(repo)).s!.getTime()).toBeGreaterThan(first!.getTime());
    });

    it("no writer can move the boundary: a stamp supplied on an update is replaced", async () => {
      const repo = await newRepo(a, { enabled: false });
      await admin.query(`UPDATE verify_settings SET enabled = true, enabled_since = now() - interval '10 days' WHERE repo_id = $1`, [repo]);
      expect(Date.now() - (await sinceOf(repo)).s!.getTime()).toBeLessThan(60_000);
      await admin.query(`UPDATE verify_settings SET enabled_since = now() - interval '10 days' WHERE repo_id = $1`, [repo]);
      expect(Date.now() - (await sinceOf(repo)).s!.getTime()).toBeLessThan(60_000);
    });

    it("the 24 hour lookback still holds: a merge older than that, when verification was switched on long ago, is not opened", async () => {
      const repo = await newRepo(a);
      await forceSince(repo, "now() - interval '3 days'");
      const old = await mergedItem(a, repo, 1, { mergeSha: sha("1") });
      await admin.query(`UPDATE work_item_transitions SET at = now() - interval '25 hours', created_at = now() - interval '25 hours' WHERE work_item_id = $1`, [old]);
      await mergedItem(a, repo, 2, { mergeSha: sha("2") });
      await sweep();
      expect((await rowsOf(repo)).map((r) => r.pr_number)).toEqual([2]);
    });
  });

  describe("a merge the host never names does not block the ones behind it", () => {
    it(`merges the host cannot name are asked ${INTAKE_HOST_TRIES} times, passed over with a count, and the merges behind them are still taken (up to ${INTAKE_PER_PASS})`, async () => {
      const repo = await newRepo(a);
      const unnamed = INTAKE_PER_PASS + 1;
      for (let pr = 1; pr <= unnamed; pr++) {
        await mergedItem(a, repo, pr);
        await new Promise((r) => setTimeout(r, 3));
      }
      for (let pr = 100; pr < 100 + INTAKE_PER_PASS + 2; pr++) {
        await mergedItem(a, repo, pr, { mergeSha: pr.toString(16).padStart(2, "0").repeat(20) });
        await new Promise((r) => setTimeout(r, 3));
      }
      const counts = await sweep();
      expect(counts).toMatchObject({ opened: INTAKE_PER_PASS, no_merge_commit: unnamed, failed: 0 });
      expect((await rowsOf(repo)).map((r) => r.pr_number)).toEqual([100, 101, 102, 103, 104]);
      for (let pr = 1; pr <= unnamed; pr++) expect(host.calls.filter((c) => c === `merge:${pr}`), `merge ${pr}`).toHaveLength(INTAKE_HOST_TRIES);
      // The unnamed ones are tried again next tick, and are taken once the host names them.
      host.merges.set(`${repo}#1`, "1".repeat(40));
      await sweep();
      expect((await rowsOf(repo)).map((r) => r.pr_number)).toContain(1);
    });

    it("a host that names the commit on the second ask is taken in the same pass", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 1);
      let asks = 0;
      const original = host.mergeCommit.bind(host);
      host.mergeCommit = async (t, pr) => {
        asks += 1;
        if (asks === 2) host.merges.set(`${repo}#1`, sha("1"));
        return original(t, pr);
      };
      expect(await sweep()).toMatchObject({ opened: 1, no_merge_commit: 0 });
      expect(asks).toBe(2);
    });
  });

  describe("the two planes: the stage tells the host which repository holds what", () => {
    it("a paired repository's target carries the code repository on every host read; a single-plane repository's carries none", async () => {
      const paired = await newRepo(a, { codeRepo: "acme/widgets-public" });
      const single = await newRepo(b);
      await mergedItem(a, paired, 1, { mergeSha: sha("1") });
      await mergedItem(b, single, 1, { mergeSha: sha("2") });
      await sweep();
      await succeed((await ordersOf(paired))[0]!.id);
      await succeed((await ordersOf(single))[0]!.id);
      healthAnswer = { kind: "ok", commit: sha("5") };
      host.commits.set(sha("5"), { parents: [sha("9"), "1".repeat(12) + "a".repeat(28)], message: SYNC("1".repeat(12)) });
      host.targets = [];
      await sweep();
      const forPaired = host.targets.filter((t) => t.repoId === paired);
      const forSingle = host.targets.filter((t) => t.repoId === single);
      expect(forPaired.length).toBeGreaterThanOrEqual(2);
      expect(forPaired.every((t) => t.codeRepo?.owner === "acme" && t.codeRepo.name === "widgets-public" && t.owner === "acme")).toBe(true);
      expect(forSingle.length).toBeGreaterThanOrEqual(1);
      expect(forSingle.every((t) => t.codeRepo == null)).toBe(true);
    });

    it("the intake's merge-commit read carries the code repository too, and a repository paired later is read as paired (derived from the row, never stamped)", async () => {
      const repo = await newRepo(a);
      await mergedItem(a, repo, 1);
      await sweep();
      expect(host.targets.length).toBeGreaterThan(0);
      expect(host.targets.every((t) => t.codeRepo == null)).toBe(true);
      await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', '{private/**}')`, [repo, a.accountId]);
      host.targets = [];
      await sweep();
      expect(host.targets.length).toBeGreaterThan(0);
      expect(host.targets.every((t) => t.codeRepo?.name === "widgets-public")).toBe(true);
    });
  });

  it("counts are the whole of what the pass reports: no commit, URL or page text", async () => {
    const repo = await newRepo(a);
    await mergedItem(a, repo, 1, { mergeSha: sha("1") });
    const counts: VerifyStageCounts = await sweep();
    expect(Object.keys(counts).sort()).toEqual(["active", "failed", "listed", "no_merge_commit", "opened", "ordered", "ready", "unverified", "waiting"]);
    expect(JSON.stringify(counts)).not.toContain(A_SHA);
  });
});
