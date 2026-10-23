import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PLANE_PUSH_PAIRING_PATH, PLANE_PUSH_REPORT_PATH, PLANE_PUSH_TOKEN_PATH, PlanePushPairingReply, PlanePushReportReply, PlanePushTokenReply, STOP_REASONS, StopReply, pairingDigest } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { PLANE_PUSH_REPORT_CODES, planePushPairingRun, planePushReportRun, planePushTokenRun, toResponse, type PlanePushHostedPort, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#598 P1f-2: POST /api/runner/plane-push-token and /plane-push-report, with recording stand-ins for the worker and for GitHub. The real
 * worker (fence, rows, the unique grant) is exercised in packages/worker/test/planePush.pg.test.ts and the real GitHub calls in
 * packages/github/test/planePushHosted.test.ts; what is pinned here is the routes' own decisions: who is asked, in what order, what each
 * answer becomes, and that a runner's report is never recorded before GitHub has been asked.
 */
describe("plane-push routes [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  const RUN = randomUUID();
  const PLANE = randomUUID();
  const BRANCH = `fx/p-${PLANE}`;
  const HEAD = "a".repeat(40);
  const TIP = "b".repeat(40);
  const TOKEN = ["g", "hs", "t".repeat(36)].join("_"); // gitleaks:allow
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  type Ops = Required<Pick<RunnerLeaseOps, "planePushGrant" | "planePushSettleGrant" | "planePushReportContext" | "planePushRecordReport">>;
  let grant: Awaited<ReturnType<Ops["planePushGrant"]>>;
  let context: Awaited<ReturnType<Ops["planePushReportContext"]>>;
  let recordResult: Awaited<ReturnType<Ops["planePushRecordReport"]>>;
  let mintError: unknown = null;
  let pushedOk = true;
  let prAnswer: { url: string } | null = null;
  let githubError: unknown = null;
  let settleResult = true;
  let settleError: unknown = null;
  let refuse: unknown = null;
  const EXPIRES = new Date("2026-10-16T12:55:00.000Z");
  /** The digest stamped at build start, as the stand-in worker states it; a report must echo it. */
  const STAMP = "c".repeat(64);
  // The digest of the fixed pairing the stand-in worker answers with, computed outside this code: printf '%s' '["acme/widgets-public",["docs/ops/","scripts/private/"],null,"rules/plan-data.json"]' | sha256sum
  const PAIRED = "3f54f3beefc4adf91ce2ba6b4056d9cb5b80aef192acd87031bf6a258a3d51c3";
  let identity: { name: string; email: string } | null = { name: "Fulcrumaxe Bot", email: "bot@example.com" };
  let itemTitle = "Add the export button";
  let pairing: Awaited<ReturnType<NonNullable<RunnerLeaseOps["planePushPairing"]>>>;

  const granted = (): Awaited<ReturnType<Ops["planePushGrant"]>> => ({ kind: "granted", attemptId: randomUUID(), id: PLANE, codeRepo: "acme/widgets-public", branch: BRANCH, itemTitle, prFooter: null, issueNumber: null });
  const withToken = (): Awaited<ReturnType<Ops["planePushReportContext"]>> => ({ kind: "context", plane: { id: PLANE, codeRepo: "acme/widgets-public", branch: BRANCH, pairingDigest: STAMP, state: "building" }, attempt: { id: randomUUID(), tokenIssued: true, finished: false, outcome: null } });

  const leases: RunnerLeaseOps = {
    claimRunnerRun: async () => {
      throw new Error("not used by these tests");
    },
    heartbeatRunnerRun: async () => {
      throw new Error("not used by these tests");
    },
    ingestRunnerEvents: async () => {
      throw new Error("not used by these tests");
    },
    beginRunnerDone: async () => {
      throw new Error("not used by these tests");
    },
    finishRunnerDone: async () => {
      throw new Error("not used by these tests");
    },
    gitTicketContext: async () => {
      throw new Error("not used by these tests");
    },
    signGitTicket: async () => {
      throw new Error("not used by these tests");
    },
    planePushGrant: async (input) => {
      calls.push({ method: "grant", input: { ...input } });
      if (refuse) throw refuse;
      return grant;
    },
    planePushPairing: async (input) => {
      calls.push({ method: "pairing", input: { ...input } });
      if (refuse) throw refuse;
      return pairing;
    },
    planePushSettleGrant: async (input) => {
      calls.push({ method: "settle", input: { ...input } });
      if (settleError) throw settleError;
      return settleResult;
    },
    planePushReportContext: async (input) => {
      calls.push({ method: "context", input: { ...input } });
      if (refuse) throw refuse;
      return context;
    },
    planePushRecordReport: async (input) => {
      calls.push({ method: "record", input: { ...input } });
      return recordResult;
    },
  };
  const port: PlanePushHostedPort = {
    mintToken: async (codeRepo) => {
      calls.push({ method: "mint", input: { codeRepo } });
      if (mintError) throw mintError;
      return { token: TOKEN, expiresAt: EXPIRES };
    },
    verifyPushed: async (input) => {
      calls.push({ method: "verifyPushed", input: { ...input } });
      if (githubError) throw githubError;
      return pushedOk;
    },
    verifyPullRequest: async (input) => {
      calls.push({ method: "verifyPullRequest", input: { ...input } });
      if (githubError) throw githubError;
      return prAnswer;
    },
    revokeToken: async (token) => {
      calls.push({ method: "revoke", input: { token } });
      return true;
    },
  };
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ leases, planePush: port, planePushIdentity: () => identity, ...over });
  const run = (fn: () => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>) => toResponse(fn);
  const tokenReq = (body: unknown = { run_id: RUN, lease_generation: 2 }, k: TestKey = key, o: Parameters<typeof signed>[3] = {}): RunnerHttpRequest => signed(k, PLANE_PUSH_TOKEN_PATH, body, o);
  const reportReq = (body: Record<string, unknown>, k: TestKey = key, o: Parameters<typeof signed>[3] = {}): RunnerHttpRequest => signed(k, PLANE_PUSH_REPORT_PATH, { run_id: RUN, lease_generation: 2, pairing_digest: STAMP, ...body }, o);
  const askToken = (r: RunnerHttpRequest = tokenReq(), d: RunnerCloudDeps = deps()) => run(() => planePushTokenRun(d, r));
  const pairingReq = (body: unknown = { run_id: RUN, lease_generation: 2 }, k: TestKey = key, o: Parameters<typeof signed>[3] = {}): RunnerHttpRequest => signed(k, PLANE_PUSH_PAIRING_PATH, body, o);
  const askPairing = (r: RunnerHttpRequest = pairingReq(), d: RunnerCloudDeps = deps()) => run(() => planePushPairingRun(d, r));
  const askReport = (body: Record<string, unknown>, d: RunnerCloudDeps = deps()) => run(() => planePushReportRun(d, reportReq(body)));
  const names = () => calls.map((c) => c.method);
  const record = () => calls.find((c) => c.method === "record")?.input as { outcome: Record<string, unknown> | null; terminal: boolean; label: string; tokenRevoked?: boolean } | undefined;

  beforeAll(async () => {
    h = await harness();
    A = await seedAccount(h.admin, randomUUID());
    key = newKey();
    runnerId = await registerKey(h.admin, A.accountId, A.userId, key);
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    calls.length = 0;
    refuse = null;
    mintError = null;
    githubError = null;
    settleResult = true;
    settleError = null;
    pushedOk = true;
    prAnswer = { url: "https://github.com/acme/widgets-public/pull/9" };
    identity = { name: "Fulcrumaxe Bot", email: "bot@example.com" };
    itemTitle = "Add the export button";
    pairing = { kind: "pairing", codeRepo: "acme/widgets-public", overlayGlobs: ["docs/ops/", "scripts/private/"], identifierRulesPath: null, planDataRulesPath: "rules/plan-data.json", pairingDigest: PAIRED };
    grant = granted();
    context = withToken();
    recordResult = { kind: "recorded", recorded: true };
    await h.admin.query("UPDATE runners SET revoked_at = NULL WHERE id = $1", [runnerId]);
  });

  it("the paths are the constants of the protocol", () => {
    expect(PLANE_PUSH_TOKEN_PATH).toBe("/api/runner/plane-push-token");
    expect(PLANE_PUSH_REPORT_PATH).toBe("/api/runner/plane-push-report");
    expect(PLANE_PUSH_PAIRING_PATH).toBe("/api/runner/plane-push-pairing");
  });

  describe("token: a granted request", () => {
    it("is 200 with exactly { token, expires_at, code_repo, branch, base, pr, identity } from our rows and settings, never cached, and parses as the protocol says", async () => {
      const res = await askToken();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        token: TOKEN,
        expires_at: "2026-10-16T12:55:00.000Z",
        code_repo: "acme/widgets-public",
        branch: BRANCH,
        base: "main",
        pr: { title: "Add the export button", body: `This change was prepared by a fulcrumaxe run and checked against the paired repository's rules before it was sent.\n\nRun: ${RUN}\n` },
        identity: { name: "Fulcrumaxe Bot", email: "bot@example.com" },
      });
      expect(PlanePushTokenReply.safeParse(res.body).success).toBe(true);
      expect(res.headers).toMatchObject({ "cache-control": "no-store" });
    });

    it("reserves the grant first, then mints for the REPO IN OUR ROW, then marks the token issued", async () => {
      await askToken();
      expect(names()).toEqual(["grant", "mint", "settle"]);
      expect(calls[0]!.input).toEqual({ accountId: A.accountId, runnerId, runId: RUN, leaseGeneration: 2 });
      expect(calls[1]!.input).toEqual({ codeRepo: "acme/widgets-public" });
      expect(calls[2]!.input).toMatchObject({ accountId: A.accountId, runId: RUN, leaseGeneration: 2, issued: true });
    });

    it("an UPPERCASE run id is lowercased once at the boundary: 200, the worker is asked with the lowercase id, and the text carries it (it used to spend a grant and a mint, then fail)", async () => {
      const res = await askToken(tokenReq({ run_id: RUN.toUpperCase(), lease_generation: 2 }));
      expect(res.status).toBe(200);
      expect(names()).toEqual(["grant", "mint", "settle"]);
      expect(calls[0]!.input).toMatchObject({ runId: RUN });
      expect(calls[2]!.input).toMatchObject({ runId: RUN, issued: true });
      expect((res.body as { pr: { body: string } }).pr.body).toContain(`Run: ${RUN}`);
      expect(names()).not.toContain("revoke");
    });

    it("takes the account and runner from the verified signature, whatever the headers say", async () => {
      const r = tokenReq();
      r.headers = { ...r.headers, "x-fx-account-id": randomUUID(), "x-fx-runner-id": randomUUID() };
      await askToken(r);
      expect(calls[0]!.input).toMatchObject({ accountId: A.accountId, runnerId });
    });
  });

  describe("token: refusals", () => {
    it("a fenced lease is the 409 { continue: false, reason } a heartbeat gives, for every reason, and nothing is minted", async () => {
      for (const reason of STOP_REASONS) {
        calls.length = 0;
        grant = { kind: "fenced", reason };
        const res = await askToken();
        expect(res.status, reason).toBe(409);
        expect(StopReply.parse(res.body)).toEqual({ continue: false, reason });
        expect(names()).toEqual(["grant"]);
      }
    });

    it.each([
      [{ kind: "not_paired" }, 403, "not_paired"],
      [{ kind: "pairing_changed" }, 409, "pairing_changed"],
      [{ kind: "already_issued" }, 409, "already_issued"],
      [{ kind: "attempts_exhausted" }, 409, "attempts_exhausted"],
    ] as const)("%j is %i %s and mints nothing", async (g, status, code) => {
      grant = g as typeof grant;
      const res = await askToken();
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ error: { code } });
      expect(names()).toEqual(["grant"]);
    });

    it.each([
      ["app_not_installed", 409, "app_not_installed"],
      ["token_scope_mismatch", 502, "token_scope_mismatch"],
      ["public_unavailable", 503, "public_unavailable"],
      ["not_configured", 503, "not_configured"],
    ])("a mint GitHub refuses with %s is %i, the attempt records the code, and no token is in the answer", async (code, status, expected) => {
      mintError = Object.assign(new Error(`${code} ${TOKEN}`), { code });
      const res = await askToken();
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ error: { code: expected } });
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
      expect(names()).toEqual(["grant", "mint", "settle"]);
      expect(calls[2]!.input).toMatchObject({ issued: false, code: code === "not_configured" ? "not_configured" : code });
    });

    it("a settle that throws, or matches no row, after a successful mint revokes the token before answering 500, and the answer carries no token", async () => {
      settleError = new Error(`db ${TOKEN}`);
      let res = await askToken();
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
      expect(names()).toEqual(["grant", "mint", "settle", "revoke"]);
      expect(calls[3]!.input).toEqual({ token: TOKEN });
      calls.length = 0;
      settleError = null;
      settleResult = false;
      grant = granted();
      res = await askToken();
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
      expect(names()).toEqual(["grant", "mint", "settle", "revoke"]);
    });

    it("a normal hand-over revokes nothing (the hook holds the token and revokes it)", async () => {
      await askToken();
      expect(names()).not.toContain("revoke");
    });

    it("an unknown failure from the mint is a bare 500 that carries none of its text, and the attempt is still finished", async () => {
      mintError = new Error(`boom ${TOKEN}`);
      const res = await askToken();
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
      expect(calls[2]!.input).toMatchObject({ issued: false, code: "mint_failed" });
    });

    it("a worker or GitHub side that is not configured is 503 not_configured, and a runner the worker refuses (42501) is 401", async () => {
      expect((await askToken(tokenReq(), deps({ leases: null }))).status).toBe(503);
      expect((await askToken(tokenReq(), deps({ planePush: null }))).status).toBe(503);
      const old: RunnerLeaseOps = { ...leases };
      delete (old as { planePushGrant?: unknown }).planePushGrant;
      expect((await askToken(tokenReq(), deps({ leases: old }))).status).toBe(503);
      expect(names()).toEqual([]);
      refuse = Object.assign(new Error("refused"), { code: "42501" });
      expect((await askToken()).status).toBe(401);
    });
  });

  describe("authentication, as for every runner route", () => {
    it("an unsigned request, an unknown key, a tampered body and a revoked runner are 401 and reach nothing", async () => {
      const good = tokenReq();
      const { signature: _s, "signature-input": _i, ...unsigned } = good.headers;
      expect((await askToken({ ...good, headers: unsigned })).status).toBe(401);
      expect((await askToken(tokenReq(undefined, newKey()))).status).toBe(401);
      expect((await askToken({ ...good, body: Buffer.from(JSON.stringify({ run_id: RUN, lease_generation: 9 })) })).status).toBe(401);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
      expect((await askToken(tokenReq())).status).toBe(401);
      expect((await askReport({ phase: "scanning" })).status).toBe(401);
      expect(calls).toEqual([]);
    });

    it("a signature made for the other route's path does not open this one", async () => {
      expect((await askToken(signed(key, PLANE_PUSH_REPORT_PATH, { run_id: RUN, lease_generation: 2 }))).status).toBe(401);
      expect((await run(() => planePushReportRun(deps(), signed(key, PLANE_PUSH_TOKEN_PATH, { run_id: RUN, lease_generation: 2, phase: "scanning" })))).status).toBe(401);
      expect(calls).toEqual([]);
    });

    it("spends the nonce: the same signed token request twice is 409 nonce_reused, and the second reaches nothing", async () => {
      const once = tokenReq(undefined, key, { nonce: randomBytes(16).toString("base64url") });
      expect((await askToken(once)).status).toBe(200);
      const second = await askToken(once);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ error: { code: "nonce_reused" } });
      expect(names()).toEqual(["grant", "mint", "settle"]);
    });

    it("spends the nonce on the report route too: the same signed report twice is 409 nonce_reused, and the second reaches neither the worker nor GitHub", async () => {
      const once = reportReq({ phase: "pushed", head_sha: HEAD, tip_sha: TIP }, key, { nonce: randomBytes(16).toString("base64url") });
      expect((await run(() => planePushReportRun(deps(), once))).status).toBe(200);
      const seen = names();
      expect(seen).toEqual(["context", "verifyPushed", "record"]);
      const second = await run(() => planePushReportRun(deps(), once));
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ error: { code: "nonce_reused" } });
      expect(names()).toEqual(seen);
    });

    it("a body of more than 256 KiB is 413 before its signature is read", async () => {
      expect((await askToken(tokenReq(undefined, key, { rawBody: Buffer.alloc(256 * 1024 + 1, 0x20) }))).status).toBe(413);
      expect(calls).toEqual([]);
    });
  });

  describe("the messages are strict", () => {
    it("the token request takes exactly { run_id, lease_generation }", async () => {
      for (const body of [{ run_id: RUN }, { run_id: RUN, lease_generation: 1, repo: "acme/x" }, { run_id: RUN, lease_generation: 1, branch: "main" }, {}, []]) {
        expect((await askToken(tokenReq(body))).status, JSON.stringify(body)).toBe(400);
      }
      expect(calls).toEqual([]);
    });

    it("a report with a content, a diff, or any other unknown field is 400 and reaches nothing", async () => {
      for (const extra of [{ content: "secret = 1" }, { diff: "+x" }, { token: TOKEN }, { repo: "evil/x" }, { value: "matched text" }]) {
        const res = await askReport({ phase: "refused", code: "scan_refused", ...extra });
        expect(res.status, JSON.stringify(Object.keys(extra))).toBe(400);
      }
      expect((await askReport({ phase: "merged" })).status).toBe(400);
      expect(calls).toEqual([]);
    });

    it("a refusal entry with any field but kind, place and rule_key is 400", async () => {
      expect((await askReport({ phase: "refused", code: "scan_refused", refusals: [{ kind: "identifier", place: "a.ts:1", rule_key: "r", matched: "x" }] })).status).toBe(400);
    });
  });

  describe("report: the fence and our rows", () => {
    it("a fenced lease is the same 409 stop reply and nothing is recorded or asked of GitHub", async () => {
      context = { kind: "fenced", reason: "lease_expired" };
      const res = await askReport({ phase: "pushed", head_sha: HEAD, tip_sha: TIP });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ continue: false, reason: "lease_expired" });
      expect(names()).toEqual(["context"]);
    });

    it("a run with no record is 403 not_paired", async () => {
      context = { kind: "not_paired" };
      const res = await askReport({ phase: "scanning" });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "not_paired" } });
      expect(names()).toEqual(["context"]);
    });

    it("a report is accepted whatever the pairing says now: only the token route checks the digest (a pairing_changed refusal must be recordable)", async () => {
      const res = await askReport({ phase: "refused", code: "pairing_changed" });
      expect(res.status).toBe(200);
      expect(record()).toMatchObject({ outcome: { state: "refused", code: "pairing_changed" }, terminal: true, label: "pairing_changed" });
    });
  });

  describe("report: phases that need no GitHub", () => {
    it("building records nothing on the item (the stamp already says it) and still answers { recorded: true }", async () => {
      const res = await askReport({ phase: "building" });
      expect(res.status).toBe(200);
      expect(PlanePushReportReply.parse(res.body)).toEqual({ recorded: true });
      expect(res.headers).toMatchObject({ "cache-control": "no-store" });
      expect(record()).toMatchObject({ outcome: null, terminal: false });
      expect(names()).toEqual(["context", "record"]);
    });

    it("scanning, no_change and a refusal are recorded as such, without asking GitHub", async () => {
      await askReport({ phase: "scanning" });
      expect(record()).toMatchObject({ outcome: { state: "scanning" }, terminal: false, label: "scanning" });
      calls.length = 0;
      await askReport({ phase: "no_change" });
      expect(record()).toMatchObject({ outcome: { state: "no_public_change" }, terminal: true, label: "no_change" });
      calls.length = 0;
      const refusals = [{ kind: "identifier", place: "src/a.ts:12", rule_key: "ident.internal-name" }];
      await askReport({ phase: "refused", code: "scan_refused", refusals, token_revoked: true });
      expect(record()).toMatchObject({ outcome: { state: "refused", code: "scan_refused", refusals }, terminal: true, label: "scan_refused", tokenRevoked: true });
      expect(names()).not.toContain("verifyPushed");
    });

    it("a refusal without a code, or a push without its shas, is 400", async () => {
      expect((await askReport({ phase: "refused" })).status).toBe(400);
      expect((await askReport({ phase: "pushed" })).status).toBe(400);
      expect((await askReport({ phase: "pr_opened", head_sha: HEAD, tip_sha: TIP })).status).toBe(400);
      expect(names().filter((n) => n === "record")).toEqual([]);
    });
  });

  describe("report: what GitHub must confirm", () => {
    it("pushed asks GitHub with the record's repo and branch (not the report's), then records the sha and the tip", async () => {
      const res = await askReport({ phase: "pushed", head_sha: HEAD, tip_sha: TIP, branch: BRANCH, token_revoked: false });
      expect(res.status).toBe(200);
      expect(names()).toEqual(["context", "verifyPushed", "record"]);
      expect(calls[1]!.input).toEqual({ codeRepo: "acme/widgets-public", branch: BRANCH, headSha: HEAD, tipSha: TIP });
      expect(record()).toMatchObject({ outcome: { state: "pushed", headSha: HEAD, tipSha: TIP }, terminal: false, label: "pushed", tokenRevoked: false });
    });

    it("pr_opened also asks about the pull request, and records the ADDRESS GitHub gave, not one the runner could name", async () => {
      await askReport({ phase: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9 });
      expect(names()).toEqual(["context", "verifyPushed", "verifyPullRequest", "record"]);
      expect(calls[2]!.input).toEqual({ codeRepo: "acme/widgets-public", branch: BRANCH, number: 9 });
      expect(record()).toMatchObject({ outcome: { state: "pr_opened", prNumber: 9, prUrl: "https://github.com/acme/widgets-public/pull/9" }, terminal: true, label: "pr_opened" });
    });

    it.each([
      ["another pull request number", "https://github.com/acme/widgets-public/pull/10"],
      ["another repository", "https://github.com/evil/widgets-public/pull/9"],
      ["a page of the pull request", "https://github.com/acme/widgets-public/pull/9/files"],
    ])("an address GitHub's read gave for %s is a report_mismatch and is never stored", async (_name, url) => {
      prAnswer = { url };
      await askReport({ phase: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9 });
      expect(record()).toMatchObject({ outcome: { state: "refused", code: "report_mismatch" }, terminal: true, label: "report_mismatch" });
      expect(JSON.stringify(record())).not.toContain(url);
    });

    it("pr_failed is recorded as pushed_pr_not_opened after the same check of the push", async () => {
      await askReport({ phase: "pr_failed", head_sha: HEAD, tip_sha: TIP });
      expect(names()).toEqual(["context", "verifyPushed", "record"]);
      expect(record()).toMatchObject({ outcome: { state: "pushed_pr_not_opened", headSha: HEAD, tipSha: TIP }, terminal: true, label: "pr_failed" });
    });

    it.each([
      ["GitHub does not show the head or its parent", () => { pushedOk = false; }, { phase: "pushed" }],
      ["GitHub does not show the pull request as asked", () => { prAnswer = null; }, { phase: "pr_opened", pr_number: 9 }],
      ["the run was never granted a token", () => { context = { ...withToken(), attempt: null } as typeof context; }, { phase: "pushed" }],
      ["the grant never became a token", () => { context = { ...withToken(), attempt: { id: randomUUID(), tokenIssued: false, finished: false, outcome: null } } as typeof context; }, { phase: "pushed" }],
      ["the report names another branch", () => undefined, { phase: "pushed", branch: "fx/p-someone-else" }],
    ])("%s: records refused / report_mismatch and stores no sha, branch or pull request", async (_label, arrange, extra) => {
      arrange();
      const res = await askReport({ head_sha: HEAD, tip_sha: TIP, ...extra });
      expect(res.status).toBe(200);
      expect(record()).toEqual(expect.objectContaining({ outcome: { state: "refused", code: "report_mismatch" }, terminal: true, label: "report_mismatch" }));
      expect(JSON.stringify(record()!.outcome)).not.toContain(HEAD);
    });

    it("when GitHub cannot be asked nothing is recorded and the answer is 503, so the hook sends the report again", async () => {
      githubError = Object.assign(new Error("down"), { code: "public_unavailable" });
      const res = await askReport({ phase: "pushed", head_sha: HEAD, tip_sha: TIP });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: { code: "public_unavailable" } });
      expect(names()).toEqual(["context", "verifyPushed"]);
      githubError = Object.assign(new Error("no app"), { code: "not_configured" });
      expect((await askReport({ phase: "pushed", head_sha: HEAD, tip_sha: TIP })).body).toMatchObject({ error: { code: "not_configured" } });
    });

    it("bounded work: a push report on a FINISHED attempt is answered 200 with no GitHub read and nothing recorded", async () => {
      context = { kind: "context", plane: { id: PLANE, codeRepo: "acme/widgets-public", branch: BRANCH, pairingDigest: STAMP, state: "refused" }, attempt: { id: randomUUID(), tokenIssued: true, finished: true, outcome: "pr_opened" } };
      for (const body of [{ phase: "pushed", head_sha: HEAD, tip_sha: TIP }, { phase: "pr_failed", head_sha: HEAD, tip_sha: TIP }, { phase: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9 }]) {
        calls.length = 0;
        const res = await askReport(body);
        expect(res.status, body.phase).toBe(200);
        expect(res.body).toEqual({ recorded: true });
        expect(names(), body.phase).toEqual(["context"]);
      }
    });

    it("bounded work: a second `pushed` report for an attempt that already verified one is free, and the report that ends the attempt is still verified (two verified reports at most)", async () => {
      context = { kind: "context", plane: { id: PLANE, codeRepo: "acme/widgets-public", branch: BRANCH, pairingDigest: STAMP, state: "pushed" }, attempt: { id: randomUUID(), tokenIssued: true, finished: false, outcome: "pushed" } };
      await askReport({ phase: "pushed", head_sha: HEAD, tip_sha: TIP });
      expect(names()).toEqual(["context"]);
      calls.length = 0;
      await askReport({ phase: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9 });
      expect(names()).toEqual(["context", "verifyPushed", "verifyPullRequest", "record"]);
    });

    it("a report of a 64-character sha gets the fixed refusal bad_input, with no GitHub read and no 503", async () => {
      const res = await askReport({ phase: "pushed", head_sha: "a".repeat(64), tip_sha: "b".repeat(64) });
      expect(res.status).toBe(200);
      expect(names()).toEqual(["context", "record"]);
      expect(record()).toMatchObject({ outcome: { state: "refused", code: "bad_input" }, terminal: true, label: "bad_input" });
    });

    it("a refusal code off the fixed list is stored as push_failed, and one on the list is kept", async () => {
      await askReport({ phase: "refused", code: "made_up_by_a_runner" });
      expect(record()).toMatchObject({ outcome: { state: "refused", code: "push_failed" }, label: "push_failed" });
      for (const code of PLANE_PUSH_REPORT_CODES) {
        calls.length = 0;
        await askReport({ phase: "refused", code });
        expect(record(), code).toMatchObject({ outcome: { state: "refused", code } });
      }
      calls.length = 0;
      await askReport({ phase: "refused", code: "report_mismatch" });
      expect(record()).toMatchObject({ outcome: { state: "refused", code: "push_failed" } });
    });

    it("an unexpected failure is a bare 500 that carries none of its text", async () => {
      githubError = new Error(`bug ${TOKEN}`);
      const res = await askReport({ phase: "pushed", head_sha: HEAD, tip_sha: TIP });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    });

    it("a record the fence then refuses is the same stop reply", async () => {
      recordResult = { kind: "fenced", reason: "run_terminal" };
      const res = await askReport({ phase: "scanning" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ continue: false, reason: "run_terminal" });
    });
  });
  describe("pairing: POST /api/runner/plane-push-pairing", () => {
    it("is 200 with exactly the pairing and its digest, never cached; the digest equals an independently computed one and the stand-in worker is the only thing asked", async () => {
      const res = await askPairing();
      expect(res.status).toBe(200);
      expect(res.headers).toMatchObject({ "cache-control": "no-store" });
      expect(res.body).toEqual({ code_repo: "acme/widgets-public", overlay_globs: ["docs/ops/", "scripts/private/"], identifier_rules_path: null, plan_data_rules_path: "rules/plan-data.json", pairing_digest: PAIRED });
      expect(PlanePushPairingReply.safeParse(res.body).success).toBe(true);
      expect(pairingDigest({ codeRepo: "acme/widgets-public", overlayGlobs: ["docs/ops/", "scripts/private/"], identifierRulesPath: null, planDataRulesPath: "rules/plan-data.json" })).toBe(PAIRED);
      // Read-only: no grant, no GitHub (no mint, no verification), no settle, no record.
      expect(names()).toEqual(["pairing"]);
      expect(calls[0]!.input).toEqual({ accountId: A.accountId, runnerId, runId: RUN, leaseGeneration: 2 });
    });

    it("takes the account and runner from the verified signature, whatever the headers say", async () => {
      const r = pairingReq();
      r.headers = { ...r.headers, "x-fx-account-id": randomUUID(), "x-fx-runner-id": randomUUID() };
      await askPairing(r);
      expect(calls[0]!.input).toMatchObject({ accountId: A.accountId, runnerId });
    });

    it("has no use-once rule of its own: two signed requests (load, then the re-check) are both answered, while the same signed request replayed is 409 nonce_reused", async () => {
      expect((await askPairing()).status).toBe(200);
      expect((await askPairing()).status).toBe(200);
      expect(names()).toEqual(["pairing", "pairing"]);
      const once = pairingReq(undefined, key, { nonce: randomBytes(16).toString("base64url") });
      expect((await askPairing(once)).status).toBe(200);
      calls.length = 0;
      const replay = await askPairing(once);
      expect(replay.status).toBe(409);
      expect(replay.body).toMatchObject({ error: { code: "nonce_reused" } });
      expect(names()).toEqual([]);
    });

    it("a fenced lease is the 409 { continue: false, reason } a heartbeat gives, for every reason", async () => {
      for (const reason of STOP_REASONS) {
        pairing = { kind: "fenced", reason };
        const res = await askPairing();
        expect(res.status, reason).toBe(409);
        expect(StopReply.parse(res.body)).toEqual({ continue: false, reason });
      }
    });

    it("a run that is not paired is 403 not_paired; a changed or removed pairing is 409 pairing_changed with no pairing in the body", async () => {
      pairing = { kind: "not_paired" };
      const none = await askPairing();
      expect(none.status).toBe(403);
      expect(none.body).toMatchObject({ error: { code: "not_paired" } });
      pairing = { kind: "pairing_changed" };
      const changed = await askPairing();
      expect(changed.status).toBe(409);
      expect(changed.body).toMatchObject({ error: { code: "pairing_changed" } });
      for (const field of ["overlay_globs", "code_repo", "pairing_digest", "docs/ops", "rules/plan-data.json"]) expect(JSON.stringify(changed.body), field).not.toContain(field);
    });

    it("a worker that answers a pairing that disagrees with its own digest cannot get it out: the reply schema refuses it (a bare 500, no pairing in the body)", async () => {
      pairing = { kind: "pairing", codeRepo: "acme/widgets-public", overlayGlobs: ["docs/ops/", "elsewhere/"], identifierRulesPath: null, planDataRulesPath: "rules/plan-data.json", pairingDigest: PAIRED };
      const res = await askPairing();
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain("elsewhere");
    });

    it("the message is exactly { run_id, lease_generation }", async () => {
      for (const body of [{ run_id: RUN }, { run_id: RUN, lease_generation: 1, repo: "acme/x" }, { run_id: RUN, lease_generation: 1, globs: ["x"] }, {}, []]) {
        expect((await askPairing(pairingReq(body))).status, JSON.stringify(body)).toBe(400);
      }
      expect(calls).toEqual([]);
    });

    it("an unsigned request, an unknown key, a revoked runner and a signature made for another route's path are 401 and reach nothing; a body over 256 KiB is 413", async () => {
      const good = pairingReq();
      const { signature: _s, "signature-input": _i, ...unsigned } = good.headers;
      expect((await askPairing({ ...good, headers: unsigned })).status).toBe(401);
      expect((await askPairing(pairingReq(undefined, newKey()))).status).toBe(401);
      expect((await askPairing(signed(key, PLANE_PUSH_TOKEN_PATH, { run_id: RUN, lease_generation: 2 }))).status).toBe(401);
      expect((await askToken(signed(key, PLANE_PUSH_PAIRING_PATH, { run_id: RUN, lease_generation: 2 }))).status).toBe(401);
      expect((await askPairing(pairingReq(undefined, key, { rawBody: Buffer.alloc(256 * 1024 + 1, 0x20) }))).status).toBe(413);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
      expect((await askPairing()).status).toBe(401);
      expect(calls).toEqual([]);
    });

    it("a worker that is not configured, or an older one without the method, is 503 not_configured; a runner the worker refuses (42501) is 401", async () => {
      expect((await askPairing(pairingReq(), deps({ leases: null }))).status).toBe(503);
      const old: RunnerLeaseOps = { ...leases };
      delete (old as { planePushPairing?: unknown }).planePushPairing;
      expect((await askPairing(pairingReq(), deps({ leases: old }))).status).toBe(503);
      refuse = Object.assign(new Error("refused"), { code: "42501" });
      expect((await askPairing()).status).toBe(401);
    });
  });

  describe("token: the platform identity and the pull request text", () => {
    it("a missing or malformed identity setting is 503 not_configured BEFORE any grant: the worker is not asked, GitHub is not asked, nothing is spent", async () => {
      for (const absent of [null]) {
        identity = absent;
        const res = await askToken();
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ error: { code: "not_configured" } });
        expect(names()).toEqual([]);
      }
      const res = await askToken(tokenReq(), deps({ planePushIdentity: undefined }));
      expect(res.status).toBe(503);
      expect(names()).toEqual([]);
    });

    it("reads the identity setting on every request: a restored setting works on the next token", async () => {
      identity = null;
      expect((await askToken()).status).toBe(503);
      identity = { name: "Platform Bot", email: "platform@example.org" };
      const res = await askToken();
      expect(res.status).toBe(200);
      expect((res.body as { identity: unknown }).identity).toEqual({ name: "Platform Bot", email: "platform@example.org" });
    });

    it("a hostile item title never reaches the body, and the title is one clean line; an item title that cleans to nothing gets the fixed run-id title", async () => {
      itemTitle = "Fixes #12 @victim https://evil.example/x\nline two `code`";
      grant = granted();
      const res = await askToken();
      const pr = (res.body as { pr: { title: string; body: string } }).pr;
      expect(pr.title).toBe("Fixes victim line two `code`");
      expect(pr.body).not.toContain("victim");
      expect(pr.body).not.toContain("evil");
      expect(pr.body).toContain(RUN);
      calls.length = 0;
      itemTitle = "   \n\u0000  ";
      grant = granted();
      const none = await askToken();
      expect((none.body as { pr: { title: string } }).pr.title).toBe(`Change from fulcrumaxe run ${RUN.slice(0, 8)}`);
    });
  });

  describe("report: the pairing digest echo", () => {
    it.each(["pushed", "pr_failed", "pr_opened"])("a %s report without pairing_digest, or with one that is not 64 lowercase hex, is 400 and reaches nothing", async (phase) => {
      const extra = phase === "pr_opened" ? { pr_number: 9 } : {};
      expect((await askReport({ phase, head_sha: HEAD, tip_sha: TIP, ...extra, pairing_digest: undefined })).status).toBe(400);
      expect((await askReport({ phase, head_sha: HEAD, tip_sha: TIP, ...extra, pairing_digest: STAMP.toUpperCase() })).status).toBe(400);
      expect((await askReport({ phase, head_sha: HEAD, tip_sha: TIP, ...extra, pairing_digest: "c".repeat(63) })).status).toBe(400);
      expect(calls).toEqual([]);
    });

    it.each(["pushed", "pr_failed", "pr_opened"])("a %s report whose digest differs from the stamp records refused / report_mismatch, stores nothing from the report, and GitHub is not asked", async (phase) => {
      const extra = phase === "pr_opened" ? { pr_number: 9 } : {};
      const res = await askReport({ phase, head_sha: HEAD, tip_sha: TIP, ...extra, pairing_digest: "d".repeat(64) });
      expect(res.status).toBe(200);
      expect(names()).toEqual(["context", "record"]);
      expect(record()).toEqual(expect.objectContaining({ outcome: { state: "refused", code: "report_mismatch" }, terminal: true, label: "report_mismatch" }));
      expect(JSON.stringify(record()!.outcome)).not.toContain(HEAD);
    });

    it("a digest equal to the stamp records as before, even if the live pairing has since moved (the stamp is what is compared; the pairing route is where an edit is caught)", async () => {
      pairing = { kind: "pairing_changed" };
      const res = await askReport({ phase: "pushed", head_sha: HEAD, tip_sha: TIP });
      expect(res.status).toBe(200);
      expect(names()).toEqual(["context", "verifyPushed", "record"]);
      expect(record()).toMatchObject({ outcome: { state: "pushed", headSha: HEAD, tipSha: TIP } });
    });

    it("phases that claim nothing on GitHub need no digest, and one they send is not compared", async () => {
      for (const body of [{ phase: "building" }, { phase: "scanning" }, { phase: "no_change" }, { phase: "refused", code: "scan_refused" }]) {
        calls.length = 0;
        expect((await askReport({ ...body, pairing_digest: undefined })).status, body.phase).toBe(200);
        calls.length = 0;
        expect((await askReport({ ...body, pairing_digest: "d".repeat(64) })).status, body.phase).toBe(200);
        expect(record()!.outcome === null || (record()!.outcome as { code?: string }).code !== "report_mismatch", body.phase).toBe(true);
      }
    });
  });
});
