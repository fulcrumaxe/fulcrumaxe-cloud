import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PLANE_MERGE_CLAIM_PATH,
  PLANE_MERGE_LEASE_SECONDS,
  PLANE_MERGE_ORDER_DEADLINE_MINUTES,
  PLANE_MERGE_REPORT_PATH,
  PLANE_MERGE_VERIFY_PATH,
  PlaneMergeClaimReply,
  PlaneMergeReportReply,
  PlaneMergeRetryReply,
  PlaneMergeVerifyReply,
} from "@fulcrumaxe/runner-protocol";
import { pairingDigest } from "@fx/core/src/repos/planePushRecord.js";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import {
  claimRun,
  planeMergeClaimRun,
  planeMergeReportRun,
  planeMergeVerifyRun,
  settleAuthorizedOrder,
  toResponse,
  type PlaneMergeGoResult,
  type PlaneMergePort,
  type PlanePushHostedPort,
  type PublicPullFacts,
  type RunnerCloudDeps,
  type RunnerHttpRequest,
} from "@fx/runner-cloud";
import { createRunnerPlaneMergeStore, type PlaneMergeOrder, type RunnerPlaneMergeStore } from "../src/runnerPlaneMerge.js";
import { ORIGIN, newKey, signed, type TestKey } from "../../runner-cloud/test/helpers.js";

/**
 * [pg] D#6 PUBLIC-MERGE PR2b: the three merge-order routes against the REAL order store (migrations 0910 and 0912), the real runner rows and the real signature
 * check (RFC 9421 with single-use nonces). The stand-ins are the two edges outside this package: the whole merge gate (its own suite is
 * packages/pipeline/test/review/mergeGatePairedLocal.pg.test.ts) and GitHub. The GitHub stand-in keeps the contract of the real one that the routes touch: a
 * credential is minted for the order's own code repository and its own account only (anything else is `app_not_installed`, as the real mint answers), a token
 * is unique per mint, and a revoke is recorded (and can be made to fail).
 *
 * What cannot be faked faithfully, said in the PR: GitHub's own token expiry and scope narrowing (packages/github/test/planePushHosted.test.ts holds the mint
 * contract over a strict local TLS server), the gate's real reads (its own suite), and a runner that really merges (PR3).
 */
describe("plane-merge routes [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let clock = T0;
  let store: RunnerPlaneMergeStore;
  let A: SeedRefs;
  let B: SeedRefs;
  let key: TestKey;
  let runner: string;
  const HEAD = "a".repeat(40);
  const REVIEWED = "b".repeat(40);
  const GLOBS = ["docs/ops/"];
  const CODE_REPO = "acme/widgets-public";
  const minutes = (n: number) => n * 60_000;
  const advance = (ms: number) => (clock += ms);

  // ---- the stand-ins
  const mints: Array<{ repo: string; account: string; kind: string; token: string }> = [];
  const revoked: string[] = [];
  let revokeOk = true;
  let mintError: unknown = null;
  const goCalls: Array<Parameters<PlaneMergePort["goPhase"]>[0]> = [];
  let gate: { next: PlaneMergeGoResult; before?: () => Promise<void>; throwBefore?: unknown; throwAfterDelegate?: unknown } = { next: { kind: "go" } };
  let pull: PublicPullFacts | Error = { open: true, merged: false, headSha: HEAD };
  const recorded: string[] = [];
  let recordResult: "closed" | "left" | "failed" = "closed";
  let recordError: unknown = null;

  const hosted = (): PlanePushHostedPort => ({
    mintToken: async () => {
      throw new Error("the push token is not used by a merge order");
    },
    verifyPushed: async () => false,
    verifyPullRequest: async () => null,
    revokeToken: async (token) => {
      revoked.push(token);
      return revokeOk;
    },
    mintMergeToken: async (codeRepo, accountId, kind) => {
      // The real mint: only the order's own repository, only for the account that owns its installation.
      if (codeRepo !== CODE_REPO || accountId !== A.accountId) throw Object.assign(new Error("app_not_installed"), { code: "app_not_installed" });
      if (mintError) throw mintError;
      const token = `ghs_${kind}_${String(mints.length + 1).padStart(3, "0")}`.padEnd(32, "x");
      mints.push({ repo: codeRepo, account: accountId, kind, token });
      return { token, expiresAt: new Date(clock + 50 * 60_000) };
    },
  });
  const port = (over: Partial<PlaneMergePort> = {}): PlaneMergePort => ({
    store: store as unknown as PlaneMergePort["store"],
    goPhase: async (input) => {
      goCalls.push(input);
      await gate.before?.();
      if (gate.throwBefore) throw gate.throwBefore;
      if (gate.next.kind !== "go") return gate.next;
      const d = await input.delegate();
      if (!d.delegated) return { kind: "blocked", reasons: [d.reason] };
      if (gate.throwAfterDelegate) throw gate.throwAfterDelegate;
      return { kind: "go" };
    },
    readPublicPull: async () => {
      if (pull instanceof Error) throw pull;
      return pull;
    },
    recordMerged: async ({ order }) => {
      if (recordError) throw recordError;
      recorded.push(order.id);
      return { privateCopy: recordResult };
    },
    ...over,
  });
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => ({ appUserPool: appPool, origin: ORIGIN, failRunnerLeases: null, now: () => new Date(clock), planePush: hosted(), planeMerge: port(), ...over });

  const send = (path: string, body: unknown, k: TestKey = key, nonce?: string): RunnerHttpRequest => signed(k, path, body, { created: Math.floor(clock / 1000), ...(nonce ? { nonce } : {}) });
  const claimIt = (d = deps(), k: TestKey = key, nonce?: string) => toResponse(() => planeMergeClaimRun(d, send(PLANE_MERGE_CLAIM_PATH, {}, k, nonce)));
  const verifyIt = (body: Record<string, unknown>, d = deps(), k: TestKey = key, nonce?: string) => toResponse(() => planeMergeVerifyRun(d, send(PLANE_MERGE_VERIFY_PATH, body, k, nonce)));
  const reportIt = (body: Record<string, unknown>, d = deps(), k: TestKey = key, nonce?: string) => toResponse(() => planeMergeReportRun(d, send(PLANE_MERGE_REPORT_PATH, body, k, nonce)));

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    store = createRunnerPlaneMergeStore(appPool, { now: () => clock });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, writerPool]) await p.end();
  });
  beforeEach(async () => {
    clock = T0;
    mints.length = 0;
    revoked.length = 0;
    revokeOk = true;
    mintError = null;
    goCalls.length = 0;
    gate = { next: { kind: "go" } };
    pull = { open: true, merged: false, headSha: HEAD };
    recorded.length = 0;
    recordResult = "closed";
    recordError = null;
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    await admin.query(
      `INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo_id) DO UPDATE SET overlay_globs = EXCLUDED.overlay_globs`,
      [A.repoId, A.accountId, CODE_REPO, GLOBS],
    );
    key = newKey();
    runner = await mkRunner(A, key);
  });

  async function mkRunner(who: SeedRefs, k: TestKey, o: { scope?: string[]; caps?: string[] | null; paused?: boolean; registeredBy?: string } = {}): Promise<string> {
    const id = await insertRunner(admin, who.accountId, o.registeredBy ?? who.userId, { jwk: k.jwk, jkt: k.jkt });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, o.scope ?? [who.repoId]]);
    if (o.caps !== null) await admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, who.accountId, o.caps ?? ["plane_merge_v1"]]);
    if (o.paused) await admin.query("INSERT INTO runner_settings (runner_id, account_id, paused_at, draining) VALUES ($1, $2, now(), false)", [id, who.accountId]);
    return id;
  }
  async function item(who: SeedRefs = A): Promise<string> {
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [itemId, who.accountId, who.repoId]);
    const digest = pairingDigest({ codeRepo: CODE_REPO, overlayGlobs: GLOBS, identifierRulesPath: null, planDataRulesPath: null });
    await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, head_sha, tip_sha, pr_number, pr_url, source_head)
       VALUES ($1, $2, $3, $4, $5, 'pr_opened', $6, $6, 7, 'https://github.com/acme/widgets-public/pull/7', $7)`,
      [who.accountId, itemId, who.repoId, CODE_REPO, digest, HEAD, REVIEWED],
    );
    return itemId;
  }
  async function ordered(): Promise<PlaneMergeOrder> {
    const w = await item();
    const r = await store.placeOrder({ accountId: A.accountId, workItemId: w, expectedPublicHead: HEAD, reviewedHead: REVIEWED });
    if (r.kind !== "placed") throw new Error(`not placed: ${r.kind}`);
    return r.order;
  }
  const row = async (id: string) => (await admin.query("SELECT * FROM plane_merge_orders WHERE id = $1", [id])).rows[0];

  /** An order claimed over the real route: the claim reply, parsed. */
  async function claimed() {
    const order = await ordered();
    const res = await claimIt();
    expect(res.status).toBe(200);
    const reply = PlaneMergeClaimReply.parse(res.body);
    if (!("order_id" in reply)) throw new Error("not claimed");
    expect(reply.order_id).toBe(order.id);
    return { order, reply };
  }
  const attestation = (reply: { order_id: string; lease_generation: number; reviewed_head: string; expected_public_head: string; pairing_digest: string }, over: Record<string, unknown> = {}) => ({
    order_id: reply.order_id,
    lease_generation: reply.lease_generation,
    reviewed_head: reply.reviewed_head,
    public_head: reply.expected_public_head,
    same: true,
    incomplete: false,
    paths: ["src/a.ts"],
    pairing_digest: reply.pairing_digest,
    token_revoked: true,
    ...over,
  });
  type Claimed = Awaited<ReturnType<typeof claimed>>["reply"] & { order_id: string };
  const authorized = async () => {
    const c = await claimed();
    const reply = c.reply as Claimed;
    const res = await verifyIt(attestation(reply));
    expect(res.status).toBe(200);
    return { ...c, reply, go: PlaneMergeVerifyReply.parse(res.body) };
  };
  const reportBody = (reply: { order_id: string; lease_generation: number }, over: Record<string, unknown> = {}) => ({ order_id: reply.order_id, lease_generation: reply.lease_generation, result: "merged", token_revoked: true, ...over });

  describe("plane-merge-claim", () => {
    it("hands the oldest order to an eligible runner with the facts from our rows and ONE read credential for the code repository alone", async () => {
      const { order, reply } = await claimed();
      expect(reply).toMatchObject({
        order_id: order.id,
        lease_generation: 1,
        code_repo: CODE_REPO,
        pr_number: 7,
        expected_public_head: HEAD,
        reviewed_head: REVIEWED,
        pairing_digest: order.pairingDigest,
        private_repo: { id: A.repoId, owner: "acme", name: "widgets" },
        overlay_globs: GLOBS,
      });
      expect((reply as Claimed & { public_branch: string }).public_branch).toBe(`fx/p-${order.planePushId}`);
      expect(mints).toEqual([{ repo: CODE_REPO, account: A.accountId, kind: "read", token: expect.stringMatching(/^ghs_read_/) }]);
      expect((reply as Claimed & { read: { token: string } }).read.token).toBe(mints[0]!.token);
      expect(await row(order.id)).toMatchObject({ state: "claimed", runner_id: runner, lease_generation: 1, attempts: 1, read_token_generation: 1, write_token_issued_at: null });
    });

    it("answers retry_after when nothing waits, and mints nothing", async () => {
      const res = await claimIt();
      expect(res.status).toBe(200);
      expect(PlaneMergeClaimReply.parse(res.body)).toMatchObject({ retry_after: expect.any(Number) });
      expect(mints).toEqual([]);
    });

    it("a replayed request (same nonce) is refused 409 nonce_reused and takes no second order", async () => {
      await ordered();
      await ordered();
      const first = await claimIt(deps(), key, "n".repeat(22));
      expect(first.status).toBe(200);
      const again = await claimIt(deps(), key, "n".repeat(22));
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: { code: "nonce_reused" } });
      expect(mints).toHaveLength(1);
    });

    it("an unsigned request, another key, or a body that is not {} is refused before any order is touched", async () => {
      const order = await ordered();
      const unsigned: RunnerHttpRequest = { method: "POST", headers: {}, body: Buffer.from("{}") };
      expect((await toResponse(() => planeMergeClaimRun(deps(), unsigned))).status).toBe(401);
      expect((await claimIt(deps(), newKey())).status).toBe(401);
      expect((await toResponse(() => planeMergeClaimRun(deps(), send(PLANE_MERGE_CLAIM_PATH, { order_id: order.id })))).status).toBe(400);
      expect((await row(order.id)).state).toBe("pending");
      expect(mints).toEqual([]);
    });

    it("a runner that may not take it (no capability, out of scope, paused, registered by a member, another account's) gets nothing and the order stays pending", async () => {
      const order = await ordered();
      const noCap = newKey();
      await mkRunner(A, noCap, { caps: ["wake_v1"] });
      const noScope = newKey();
      await mkRunner(A, noScope, { scope: [] });
      const paused = newKey();
      await mkRunner(A, paused, { paused: true });
      const foreign = newKey();
      await mkRunner(B, foreign);
      for (const k of [noCap, noScope, paused, foreign]) {
        const res = await claimIt(deps(), k);
        expect(res.status).toBe(200);
        expect(PlaneMergeClaimReply.parse(res.body)).not.toHaveProperty("order_id");
      }
      expect((await row(order.id)).state).toBe("pending");
      expect(mints).toEqual([]);
    });

    it("a mint GitHub refuses leaves the claim standing: 409 app_not_installed, no token, and after the lease the order is offered again", async () => {
      const order = await ordered();
      mintError = Object.assign(new Error("x"), { code: "app_not_installed" });
      const res = await claimIt();
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "app_not_installed" } });
      expect(mints).toEqual([]);
      expect((await row(order.id)).state).toBe("claimed");
      mintError = null;
      advance(PLANE_MERGE_LEASE_SECONDS * 1000 + 1000);
      const again = PlaneMergeClaimReply.parse((await claimIt()).body);
      expect(again).toMatchObject({ order_id: order.id, lease_generation: 2 });
    });

    it("503 not_configured while the merge access is not wired", async () => {
      await ordered();
      expect((await claimIt(deps({ planeMerge: null }))).status).toBe(503);
      expect((await claimIt(deps({ planePush: null }))).status).toBe(503);
      const noMint = hosted();
      delete noMint.mintMergeToken;
      expect((await claimIt(deps({ planePush: noMint }))).status).toBe(503);
    });
  });

  describe("the claim reply's merge_order flag", () => {
    const idle = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 60 }) } as unknown as RunnerCloudDeps["leases"];
    const ask = async (k: TestKey, d: RunnerCloudDeps) => toResponse(() => claimRun(d, send("/api/runner/claim", {}, k)));

    it("is true exactly when the store says an order waits for THIS runner (the same eligibility), and absent otherwise", async () => {
      const order = await ordered();
      const cases: Array<[string, TestKey, boolean]> = [];
      const noCap = newKey();
      await mkRunner(A, noCap, { caps: ["wake_v1"] });
      const paused = newKey();
      await mkRunner(A, paused, { paused: true });
      const noScope = newKey();
      await mkRunner(A, noScope, { scope: [] });
      cases.push(["eligible", key, true], ["no capability", noCap, false], ["paused", paused, false], ["out of scope", noScope, false]);
      for (const [label, k, flag] of cases) {
        const res = await ask(k, deps({ leases: idle }));
        expect(res.status, label).toBe(200);
        expect((res.body as { merge_order?: boolean }).merge_order, label).toBe(flag ? true : undefined);
      }
      // The store's own eligibility agrees with the flag for every runner above.
      expect(await store.hasClaimable({ accountId: A.accountId, runnerId: runner })).toBe(true);
      // Not configured, or no order waiting: no flag.
      const fresh1 = newKey();
      await mkRunner(A, fresh1);
      expect(((await ask(fresh1, deps({ leases: idle, planeMerge: null }))).body as { merge_order?: boolean }).merge_order).toBeUndefined();
      await admin.query("UPDATE plane_merge_orders SET state = 'expired', outcome_code = 'x_code', finished_at = now() WHERE id = $1", [order.id]);
      const fresh2 = newKey();
      await mkRunner(A, fresh2);
      const later = await ask(fresh2, deps({ leases: idle }));
      expect((later.body as { merge_order?: boolean }).merge_order).toBeUndefined();
    });
  });

  describe("plane-merge-verify", () => {
    it("the go: the whole gate runs with the runner's attestation, the grant is written, ONE write credential is minted and handed over for the order's sha", async () => {
      const { order, reply, go } = await authorized();
      expect(go).toMatchObject({ go: true, sha: HEAD });
      expect(mints.map((m) => m.kind)).toEqual(["read", "write"]);
      expect(goCalls).toHaveLength(1);
      expect(goCalls[0]!.attestation).toEqual({ reviewedHead: REVIEWED, publicHead: HEAD, same: true, incomplete: false, paths: ["src/a.ts"] });
      expect(goCalls[0]!.order.id).toBe(order.id);
      expect((go as { token: string }).token).toBe(mints[1]!.token);
      expect(await row(order.id)).toMatchObject({ state: "authorized", write_token_issued_at: expect.any(Date) });
      expect(reply.order_id).toBe(order.id);
    });

    it("a second verify for the same order is 409 already_issued: the gate is not run again and nothing more is minted", async () => {
      const { reply } = await authorized();
      const again = await verifyIt(attestation(reply));
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: { code: "already_issued" } });
      expect(goCalls).toHaveLength(1);
      expect(mints.filter((m) => m.kind === "write")).toHaveLength(1);
    });

    it("two verifies at once: exactly one go, one write credential", async () => {
      const { reply } = await claimed();
      const [a, b] = await Promise.all([verifyIt(attestation(reply as Claimed)), verifyIt(attestation(reply as Claimed))]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(mints.filter((m) => m.kind === "write")).toHaveLength(1);
    });

    it("a replayed signed verify (same nonce) is refused 409 nonce_reused, and the gate runs once", async () => {
      const { reply } = await claimed();
      expect((await verifyIt(attestation(reply as Claimed), deps(), key, "r".repeat(22))).status).toBe(200);
      expect((await verifyIt(attestation(reply as Claimed), deps(), key, "r".repeat(22))).body).toMatchObject({ error: { code: "nonce_reused" } });
      expect(goCalls).toHaveLength(1);
    });

    it("forgery: another runner of the account, a lease generation of an older claim, heads or a digest that are not the order's: refused, no gate, no credential", async () => {
      const { order, reply } = await claimed();
      const r = reply as Claimed;
      const other = newKey();
      await mkRunner(A, other);
      expect((await verifyIt(attestation(r), deps(), other)).body).toMatchObject({ error: { code: "fenced" }, reason: "unknown" });
      expect((await verifyIt(attestation(r, { lease_generation: 9 }))).body).toMatchObject({ error: { code: "fenced" }, reason: "stale_generation" });
      for (const over of [{ reviewed_head: "e".repeat(40) }, { public_head: "e".repeat(40) }, { pairing_digest: "e".repeat(64) }]) {
        const res = await verifyIt(attestation(r, over));
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: { code: "order_mismatch" } });
      }
      // A body with a field the schema does not know (a repository name, say) is not a message.
      expect((await verifyIt({ ...attestation(r), code_repo: "evil/other" })).status).toBe(400);
      expect(goCalls).toEqual([]);
      expect(mints.map((m) => m.kind)).toEqual(["read"]);
      expect((await row(order.id)).state).toBe("claimed");
    });

    it("an order past its deadline, or a lease that ran out, is 409 fenced and nothing runs", async () => {
      const { reply } = await claimed();
      advance(PLANE_MERGE_LEASE_SECONDS * 1000 + 1000);
      const lapsed = await verifyIt(attestation(reply as Claimed));
      expect(lapsed.body).toMatchObject({ reason: "lease_expired" });
      const second = await claimed().catch(() => null);
      void second;
      advance(minutes(PLANE_MERGE_ORDER_DEADLINE_MINUTES));
      const late = await verifyIt(attestation(reply as Claimed));
      expect(late.status).toBe(409);
      expect(goCalls).toEqual([]);
      expect(mints.filter((m) => m.kind === "write")).toEqual([]);
    });

    it("the runner's trust is read again: a runner paused (or revoked) after its claim is 403 runner_not_trusted before the gate, and again right before the grant", async () => {
      const first = await claimed();
      await admin.query("INSERT INTO runner_settings (runner_id, account_id, paused_at, draining) VALUES ($1, $2, now(), false)", [runner, A.accountId]);
      const paused = await verifyIt(attestation(first.reply as Claimed));
      expect(paused.status).toBe(403);
      expect(paused.body).toMatchObject({ error: { code: "runner_not_trusted" } });
      expect(goCalls).toEqual([]);
      // Trust lost while the gate runs: the delegate is never granted.
      await admin.query("DELETE FROM runner_settings WHERE runner_id = $1", [runner]);
      gate.before = async () => {
        await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runner]);
      };
      const during = await verifyIt(attestation(first.reply as Claimed));
      expect(during.status).toBe(403);
      expect(goCalls).toHaveLength(1);
      expect(mints.filter((m) => m.kind === "write")).toEqual([]);
      expect((await row(first.order.id)).write_token_issued_at).toBeNull();
    });

    it("a moved head: the gate says so, the order is superseded, the answer is head_moved, and no credential exists", async () => {
      const { order, reply } = await claimed();
      gate = { next: { kind: "head_moved" } };
      const res = await verifyIt(attestation(reply as Claimed));
      expect(PlaneMergeVerifyReply.parse(res.body)).toEqual({ go: false, head_moved: true });
      expect(await row(order.id)).toMatchObject({ state: "superseded", outcome_code: "public_head_moved" });
      expect(mints.filter((m) => m.kind === "write")).toEqual([]);
    });

    it("a block: the reasons go back, the order ends blocked with the first one, and no credential exists", async () => {
      const { order, reply } = await claimed();
      gate = { next: { kind: "blocked", reasons: ["ci_not_green", "stacked_on_pr_12", "Not A Code", "x".repeat(80)] } };
      const res = await verifyIt(attestation(reply as Claimed));
      expect(PlaneMergeVerifyReply.parse(res.body)).toEqual({ go: false, reasons: ["ci_not_green", "stacked_on_pr_12"] });
      expect(await row(order.id)).toMatchObject({ state: "blocked", outcome_code: "ci_not_green" });
      expect(mints.filter((m) => m.kind === "write")).toEqual([]);
    });

    it("a public pull request that is no longer open, or a gate that refuses, ends the order blocked with a fixed code", async () => {
      const a = await claimed();
      gate = { next: { kind: "pr_not_open" } };
      expect(PlaneMergeVerifyReply.parse((await verifyIt(attestation(a.reply as Claimed))).body)).toEqual({ go: false, reasons: ["public_pr_not_open"] });
      expect(await row(a.order.id)).toMatchObject({ state: "blocked", outcome_code: "public_pr_not_open" });
      const b = await claimed();
      gate = { next: { kind: "refused", reason: "go_not_applicable" } };
      expect(PlaneMergeVerifyReply.parse((await verifyIt(attestation(b.reply as Claimed))).body)).toEqual({ go: false, reasons: ["go_not_applicable"] });
      expect((await row(b.order.id)).state).toBe("blocked");
    });

    it("the runner's content verdict reaches the gate as given (same false, incomplete, the paths)", async () => {
      const { reply } = await claimed();
      gate = { next: { kind: "blocked", reasons: ["public_head_not_reviewed"] } };
      await verifyIt(attestation(reply as Claimed, { same: false, incomplete: true, paths: ["a", "b"] }));
      expect(goCalls[0]!.attestation).toMatchObject({ same: false, incomplete: true, paths: ["a", "b"] });
      // An incomplete check that claims to be the same is not a message at all.
      expect((await verifyIt(attestation(reply as Claimed, { same: true, incomplete: true }))).status).toBe(400);
    });

    it("a mint that fails after the grant ends the order failed, hands over nothing, and says why", async () => {
      const { order, reply } = await claimed();
      const real = hosted();
      const failingWrite: PlanePushHostedPort = { ...real, mintMergeToken: async (repo, acct, kind) => (kind === "write" ? Promise.reject(Object.assign(new Error("x"), { code: "public_unavailable" })) : real.mintMergeToken!(repo, acct, kind)) };
      const res = await verifyIt(attestation(reply as Claimed), deps({ planePush: failingWrite }));
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: { code: "public_unavailable" } });
      expect(await row(order.id)).toMatchObject({ state: "failed", outcome_code: "runner_merge_failed" });
      expect(revoked).toEqual([]);
    });

    it("a reply that cannot be built after the mint revokes the credential and ends the order failed; a revoke that also fails changes nothing else", async () => {
      for (const ok of [true, false]) {
        const { order, reply } = await claimed();
        revokeOk = ok;
        const real = hosted();
        // A token the protocol would not accept in a reply (too short): the reply cannot be built.
        const short: PlanePushHostedPort = { ...real, mintMergeToken: async (repo, acct, kind) => (kind === "write" ? { token: "short", expiresAt: new Date(clock + 1000) } : real.mintMergeToken!(repo, acct, kind)) };
        revoked.length = 0;
        const res = await verifyIt(attestation(reply as Claimed), deps({ planePush: short }));
        expect(res.status).toBe(500);
        expect(revoked).toEqual(["short"]);
        expect(await row(order.id)).toMatchObject({ state: "failed", outcome_code: "runner_merge_failed" });
        expect(JSON.stringify(res.body)).not.toContain("short");
      }
    });

    it("a gate that fails after the credential was minted revokes it and ends the order failed", async () => {
      const { order, reply } = await claimed();
      gate = { next: { kind: "go" }, throwAfterDelegate: new Error("recording failed") };
      const res = await verifyIt(attestation(reply as Claimed));
      expect(res.status).toBe(503);
      const write = mints.find((m) => m.kind === "write")!;
      expect(revoked).toEqual([write.token]);
      expect(await row(order.id)).toMatchObject({ state: "failed", outcome_code: "runner_merge_failed" });
      expect(JSON.stringify(res.body)).not.toContain(write.token);
    });

    it("a gate that cannot read GitHub is 503 public_unavailable: nothing is decided, the lease stands, and the runner may ask again", async () => {
      const { order, reply } = await claimed();
      gate = { next: { kind: "go" }, throwBefore: new Error("GitHub down") };
      const down = await verifyIt(attestation(reply as Claimed));
      expect(down.status).toBe(503);
      expect(down.body).toMatchObject({ error: { code: "public_unavailable" } });
      expect((await row(order.id)).state).toBe("claimed");
      gate = { next: { kind: "go" } };
      expect((await verifyIt(attestation(reply as Claimed))).status).toBe(200);
    });

    it("503 not_configured without the port", async () => {
      const { reply } = await claimed();
      expect((await verifyIt(attestation(reply as Claimed), deps({ planeMerge: null }))).status).toBe(503);
    });
  });

  describe("plane-merge-report", () => {
    it("a merge GitHub confirms (merged_at set, the expected head) ends the order merged and is recorded once; the report only said so", async () => {
      const { order, reply } = await authorized();
      pull = { open: false, merged: true, headSha: HEAD };
      const res = await reportIt(reportBody(reply));
      expect(PlaneMergeReportReply.parse(res.body)).toEqual({ recorded: true });
      expect(await row(order.id)).toMatchObject({ state: "merged", outcome_code: "merged" });
      expect(recorded).toEqual([order.id]);
    });

    it("the runner says merged and GitHub says the pull request is still open: runner_report_mismatch, nothing recorded as merged", async () => {
      const { order, reply } = await authorized();
      pull = { open: true, merged: false, headSha: HEAD };
      expect((await reportIt(reportBody(reply))).status).toBe(200);
      expect(await row(order.id)).toMatchObject({ state: "failed", outcome_code: "runner_report_mismatch" });
      expect(recorded).toEqual([]);
    });

    it("merged, but at another head than the order's: runner_report_mismatch", async () => {
      const { order, reply } = await authorized();
      pull = { open: false, merged: true, headSha: "e".repeat(40) };
      await reportIt(reportBody(reply));
      expect(await row(order.id)).toMatchObject({ state: "failed", outcome_code: "runner_report_mismatch" });
      expect(recorded).toEqual([]);
    });

    it("a refused merge with a head that moved: head_moved (the workflow reviews again), nothing recorded as merged", async () => {
      const { order, reply } = await authorized();
      pull = { open: true, merged: false, headSha: "e".repeat(40) };
      await reportIt(reportBody(reply, { result: "refused", http_status: 409 }));
      expect(await row(order.id)).toMatchObject({ state: "head_moved", outcome_code: "public_head_moved" });
      expect(recorded).toEqual([]);
    });

    it("a refused merge with the same head is merge_call_refused; an aborted run is runner_merge_failed (or its closed code when it names one); a closed pull request is public_pr_not_open", async () => {
      const cases: Array<[Record<string, unknown>, PublicPullFacts, string]> = [
        [{ result: "refused", http_status: 405 }, { open: true, merged: false, headSha: HEAD }, "merge_call_refused"],
        [{ result: "aborted", abort_code: "read_failed" }, { open: true, merged: false, headSha: HEAD }, "runner_merge_failed"],
        [{ result: "aborted", abort_code: "base_retargeted" }, { open: true, merged: false, headSha: HEAD }, "stacked_on_open_pr"],
        [{ result: "aborted", abort_code: "pr_draft" }, { open: true, merged: false, headSha: HEAD }, "pr_draft"],
        [{ result: "refused", http_status: 405 }, { open: false, merged: false, headSha: HEAD }, "public_pr_not_open"],
      ];
      for (const [over, facts, code] of cases) {
        const { order, reply } = await authorized();
        pull = facts;
        await reportIt(reportBody(reply, over));
        expect(await row(order.id), code).toMatchObject({ state: "failed", outcome_code: code });
      }
    });

    it("GitHub cannot be asked: 503 with retry_after, NOTHING recorded, the order still authorized; the same report later succeeds", async () => {
      const { order, reply } = await authorized();
      pull = new Error("GitHub down");
      const down = await reportIt(reportBody(reply));
      expect(down.status).toBe(503);
      expect(PlaneMergeRetryReply.parse(down.body)).toMatchObject({ retry_after: expect.any(Number) });
      expect((await row(order.id)).state).toBe("authorized");
      expect(recorded).toEqual([]);
      pull = { open: false, merged: true, headSha: HEAD };
      expect((await reportIt(reportBody(reply))).status).toBe(200);
      expect((await row(order.id)).state).toBe("merged");
    });

    it("a revoke the runner could not make (token_revoked false) does not change what is recorded", async () => {
      const { order, reply } = await authorized();
      pull = { open: false, merged: true, headSha: HEAD };
      expect((await reportIt(reportBody(reply, { token_revoked: false }))).status).toBe(200);
      expect((await row(order.id)).state).toBe("merged");
    });

    it("the private copy not closed (left, or the close failed) never undoes the recorded merge; a recording that throws leaves the order merged", async () => {
      for (const result of ["left", "failed"] as const) {
        const { order, reply } = await authorized();
        recordResult = result;
        pull = { open: false, merged: true, headSha: HEAD };
        expect((await reportIt(reportBody(reply))).status).toBe(200);
        expect((await row(order.id)).state).toBe("merged");
      }
      const { order, reply } = await authorized();
      recordError = new Error("events table down");
      expect((await reportIt(reportBody(reply))).status).toBe(200);
      expect((await row(order.id)).state).toBe("merged");
    });

    it("replay and forgery: the same nonce, another runner, a stale generation: refused, nothing recorded", async () => {
      const { order, reply } = await authorized();
      pull = { open: false, merged: true, headSha: HEAD };
      const other = newKey();
      await mkRunner(A, other);
      expect((await reportIt(reportBody(reply), deps(), other)).body).toMatchObject({ reason: "unknown" });
      expect((await reportIt(reportBody(reply, { lease_generation: 7 }))).body).toMatchObject({ reason: "stale_generation" });
      expect((await reportIt({ ...reportBody(reply), pr_number: 99 })).status).toBe(400);
      expect((await row(order.id)).state).toBe("authorized");
      expect((await reportIt(reportBody(reply), deps(), key, "q".repeat(22))).status).toBe(200);
      expect((await reportIt(reportBody(reply), deps(), key, "q".repeat(22))).body).toMatchObject({ error: { code: "nonce_reused" } });
      expect(recorded).toEqual([order.id]);
    });

    it("an order not yet authorized: 'merged' cannot be true (409 not_authorized); an abort that names a moved head ends it head_moved, any other abort failed", async () => {
      const a = await claimed();
      expect((await reportIt(reportBody(a.reply as Claimed))).body).toMatchObject({ error: { code: "not_authorized" } });
      expect((await row(a.order.id)).state).toBe("claimed");
      expect((await reportIt(reportBody(a.reply as Claimed, { result: "aborted", abort_code: "head_moved" }))).status).toBe(200);
      expect(await row(a.order.id)).toMatchObject({ state: "head_moved", outcome_code: "public_head_moved" });
      const b = await claimed();
      await reportIt(reportBody(b.reply as Claimed, { result: "aborted", abort_code: "read_failed" }));
      expect(await row(b.order.id)).toMatchObject({ state: "failed", outcome_code: "runner_merge_failed" });
    });

    describe("a late report for an order that is already over (expired, superseded or failed while authorized): the cloud reads GitHub first", () => {
      const over = async (how: "expired" | "superseded" | "failed") => {
        const c = await authorized();
        if (how === "expired") {
          // The deadline passed while the runner worked (its lease was extended by nothing: asking never extends it).
          advance(minutes(PLANE_MERGE_ORDER_DEADLINE_MINUTES) - 1000);
          await admin.query("UPDATE plane_merge_orders SET lease_expires_at = now() + interval '1 hour' WHERE id = $1", [c.order.id]);
          advance(2000);
          await store.expireDue({ accountId: A.accountId, orderId: c.order.id });
        } else {
          await store.finish({ accountId: A.accountId, orderId: c.order.id, to: how, code: how === "superseded" ? "superseded_by_new_order" : "runner_merge_failed", actor: { by: "cloud" } });
        }
        expect((await row(c.order.id)).state).toBe(how);
        // The over order's row is final; the lease the runner names is still the order's own.
        return c;
      };

      it.each(["expired", "superseded", "failed"] as const)("%s: GitHub says merged at the expected head -> recorded (once, from GitHub's answer), the row stays as it was", async (how) => {
        const c = await over(how);
        pull = { open: false, merged: true, headSha: HEAD };
        const res = await reportIt(reportBody(c.reply));
        expect(res.status).toBe(200);
        expect(recorded).toEqual([c.order.id]);
        expect((await row(c.order.id)).state).toBe(how);
      });

      it.each(["expired", "superseded", "failed"] as const)("%s: GitHub says it did not merge (open, another head, merged elsewhere) -> 409 and NOTHING recorded", async (how) => {
        const c = await over(how);
        for (const facts of [{ open: true, merged: false, headSha: HEAD }, { open: false, merged: true, headSha: "e".repeat(40) }] as PublicPullFacts[]) {
          pull = facts;
          const res = await reportIt(reportBody(c.reply));
          expect(res.status).toBe(409);
          expect(res.body).toMatchObject({ reason: "order_terminal" });
        }
        expect(recorded).toEqual([]);
      });

      it("GitHub cannot be asked: 503 and nothing recorded; the report is retried", async () => {
        const c = await over("superseded");
        pull = new Error("GitHub down");
        expect((await reportIt(reportBody(c.reply))).status).toBe(503);
        expect(recorded).toEqual([]);
        pull = { open: false, merged: true, headSha: HEAD };
        expect((await reportIt(reportBody(c.reply))).status).toBe(200);
        expect(recorded).toEqual([c.order.id]);
      });

      it("only the runner and lease generation that held the order are heard; a report that does not say merged is never looked up", async () => {
        const c = await over("failed");
        pull = { open: false, merged: true, headSha: HEAD };
        const other = newKey();
        await mkRunner(A, other);
        expect((await reportIt(reportBody(c.reply), deps(), other)).status).toBe(409);
        expect((await reportIt(reportBody(c.reply, { lease_generation: 5 }))).status).toBe(409);
        expect((await reportIt(reportBody(c.reply, { result: "refused", http_status: 409 }))).status).toBe(409);
        expect(recorded).toEqual([]);
      });
    });
  });

  describe("settleAuthorizedOrder (an authorized order whose lease ran out without a report)", () => {
    it("ends it from GitHub alone: merged at the head -> merged and recorded; open at the head -> failed runner_merge_failed; moved -> head_moved", async () => {
      const merged = await authorized();
      pull = { open: false, merged: true, headSha: HEAD };
      const p = port();
      expect(await settleAuthorizedOrder(p, A.accountId, (await store.getById({ accountId: A.accountId, orderId: merged.order.id }))!, null)).toMatchObject({ state: "merged", recorded: true });
      expect(recorded).toEqual([merged.order.id]);
      const stale = await authorized();
      pull = { open: true, merged: false, headSha: HEAD };
      expect(await settleAuthorizedOrder(p, A.accountId, (await store.getById({ accountId: A.accountId, orderId: stale.order.id }))!, null)).toMatchObject({ state: "failed", code: "runner_merge_failed" });
      const moved = await authorized();
      pull = { open: true, merged: false, headSha: "e".repeat(40) };
      expect(await settleAuthorizedOrder(p, A.accountId, (await store.getById({ accountId: A.accountId, orderId: moved.order.id }))!, null)).toMatchObject({ state: "head_moved" });
    });

    it("a GitHub read that fails throws and ends nothing", async () => {
      const { order } = await authorized();
      pull = new Error("down");
      await expect(settleAuthorizedOrder(port(), A.accountId, (await store.getById({ accountId: A.accountId, orderId: order.id }))!, null)).rejects.toThrow("down");
      expect((await row(order.id)).state).toBe("authorized");
    });
  });
});
