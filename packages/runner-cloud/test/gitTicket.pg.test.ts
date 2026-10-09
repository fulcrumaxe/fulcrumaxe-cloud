import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GIT_TICKET_PATH, GitTicketReply, STOP_REASONS, StopReply, sha256Text, type Job } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { branchOf, gitTicketRun, toResponse, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerLeaseOps } from "../src/index.js";
import { ORIGIN, harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#6 R5a-2b (C27 section 1.1): POST /api/runner/git-ticket, with a recording stand-in for the worker. The real worker, the real fence
 * and the real signer are exercised end to end in packages/worker/test/gitTicket.pg.test.ts; what is pinned here is the route's own
 * decisions: who is asked, in what order, what is refused and with which status.
 */
describe("git-ticket route [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  type Context = Awaited<ReturnType<RunnerLeaseOps["gitTicketContext"]>>;
  let context: Context;
  let signResult: Awaited<ReturnType<RunnerLeaseOps["signGitTicket"]>>;
  let refuse: unknown = null;
  const RUN = randomUUID();
  const REPO = { id: randomUUID(), owner: "acme", name: "widgets" };
  const EXPIRES = new Date("2026-10-10T12:05:00.000Z");
  const TICKET = ["aGVhZGVy", "Y2xhaW1z", "c2ln"].join(".");

  const job = (over: Partial<Job> = {}): Job => ({
    schema_version: 1,
    job_id: randomUUID(),
    run_id: RUN,
    repo: { id: REPO.id, owner: "acme", name: "widgets", private: true },
    role: "executor",
    mode: "verified",
    spec: null,
    task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
    role_card: { text: "c", sha256: sha256Text("c") },
    role_tools_sha256: "a".repeat(64),
    continues: null,
    branch_prefix: "fx/",
    model_hint: null,
    issued_at: "2026-10-10T12:00:00.000Z",
    expires_at: "2026-10-13T12:00:00.000Z",
    key_id: "k1",
    ...over,
  });
  const verified = (over: Partial<Extract<Context, { kind: "context" }>> = {}): Context => ({ kind: "context", role: "executor", runtime: "runner", executionMode: "runner_verified", repo: REPO, job: job(), ...over });

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
    gitTicketContext: async (input) => {
      calls.push({ method: "context", input: { ...input } });
      if (refuse) throw refuse;
      return context;
    },
    signGitTicket: async (input) => {
      calls.push({ method: "sign", input: { ...input } });
      if (refuse) throw refuse;
      return signResult;
    },
  };
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ leases, ...over });
  const run = (fn: () => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>) => toResponse(fn);
  const req = (body: unknown = { run_id: RUN, lease_generation: 2 }, k: TestKey = key, o: Parameters<typeof signed>[3] = {}): RunnerHttpRequest => signed(k, GIT_TICKET_PATH, body, o);
  const ask = (r: RunnerHttpRequest = req(), d: RunnerCloudDeps = deps()) => run(() => gitTicketRun(d, r));

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
    context = verified();
    signResult = { ticket: TICKET, expiresAt: EXPIRES, proxyOrigin: "https://proxy.example.test" };
    await h.admin.query("UPDATE runners SET revoked_at = NULL WHERE id = $1", [runnerId]);
  });

  it("the path is the constant /api/runner/git-ticket", () => {
    expect(GIT_TICKET_PATH).toBe("/api/runner/git-ticket");
  });

  describe("a cloud-verified run with a held lease", () => {
    it("is 200 with exactly { ticket, expires_at, proxy_origin }, and the reply parses as the protocol says", async () => {
      const res = await ask();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ticket: TICKET, expires_at: "2026-10-10T12:05:00.000Z", proxy_origin: "https://proxy.example.test" });
      expect(GitTicketReply.safeParse(res.body).success).toBe(true);
      expect(res.headers).toMatchObject({ "cache-control": "no-store" });
    });

    it("asks the fence first, then signs: the issuer is the configured origin, the repo and the ref are from the cloud's own rows", async () => {
      await ask();
      expect(calls.map((c) => c.method)).toEqual(["context", "sign"]);
      expect(calls[0]!.input).toEqual({ accountId: A.accountId, runnerId, runId: RUN, leaseGeneration: 2 });
      expect(calls[1]!.input).toEqual({ issuer: ORIGIN, accountId: A.accountId, runnerId, runId: RUN, leaseGeneration: 2, repo: REPO, ref: `fx/${RUN}-g2` });
    });

    it("takes the account and runner from the verified signature, whatever the headers say", async () => {
      const r = req();
      r.headers = { ...r.headers, "x-fx-account-id": randomUUID(), "x-fx-runner-id": randomUUID() };
      await ask(r);
      expect(calls[0]!.input).toMatchObject({ accountId: A.accountId, runnerId });
    });

    it("signs a fix round for the continuation's own branch, and a fresh run for its generation's branch", async () => {
      const earlier = randomUUID();
      context = verified({ job: job({ continues: { parent_run_id: earlier, session_id: "sess-1", branch: `fx/${earlier}-g4` } }) });
      await ask();
      expect(calls[1]!.input["ref"]).toBe(`fx/${earlier}-g4`);
      calls.length = 0;
      context = verified();
      await ask(req({ run_id: RUN, lease_generation: 7 }));
      expect(calls[1]!.input["ref"]).toBe(`fx/${RUN}-g7`);
    });

    it("uses done's own branchOf, so the two cannot name different branches", () => {
      expect(branchOf(job(), { runId: RUN, leaseGeneration: 5 })).toBe(`fx/${RUN}-g5`);
    });

    it("signs for a reviewer's run too: whether a role may push is the proxy's rule, not this route's", async () => {
      context = verified({ role: "code-reviewer" });
      expect((await ask()).status).toBe(200);
    });
  });

  describe("refusals", () => {
    it("a stale generation is 409 { continue: false, reason: stale_generation } and nothing is signed", async () => {
      context = { kind: "fenced", reason: "stale_generation" };
      const res = await ask();
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ continue: false, reason: "stale_generation" });
      expect(calls.map((c) => c.method)).toEqual(["context"]);
    });

    it("every stop reason the fence gives is the same 409 reply heartbeat gives", async () => {
      for (const reason of STOP_REASONS) {
        calls.length = 0;
        context = { kind: "fenced", reason };
        const res = await ask();
        expect(res.status, reason).toBe(409);
        expect(StopReply.parse(res.body)).toEqual({ continue: false, reason });
        expect(calls.map((c) => c.method)).toEqual(["context"]);
      }
    });

    it("a runner_local run is 403 not_cloud_verified, and nothing is signed", async () => {
      context = verified({ executionMode: "runner_local" });
      const res = await ask();
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "not_cloud_verified" } });
      expect(calls.map((c) => c.method)).toEqual(["context"]);
    });

    it("so is a sandbox run, a run whose runtime is not the runner, and any mode the cloud does not know", async () => {
      for (const over of [{ executionMode: "sandbox" }, { runtime: "sandbox" }, { runtime: "sandbox", executionMode: "runner_verified" }, { executionMode: "" }, { executionMode: "RUNNER_VERIFIED" }, { runtime: "Runner" }]) {
        calls.length = 0;
        context = verified(over);
        const res = await ask();
        expect(res.status, JSON.stringify(over)).toBe(403);
        expect(calls.map((c) => c.method)).toEqual(["context"]);
      }
    });

    it("a run with no repository or no readable job is a plain 500 and nothing is signed", async () => {
      for (const over of [{ repo: null }, { job: null }]) {
        calls.length = 0;
        context = verified(over);
        const res = await ask();
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("acme");
        expect(calls.map((c) => c.method)).toEqual(["context"]);
      }
    });

    it("a missing signing key (the worker signs nothing) is 503 not_configured", async () => {
      signResult = null;
      const res = await ask();
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: { code: "not_configured" } });
    });

    it("a worker that is not configured is 503, and a runner it refuses (42501) is 401", async () => {
      expect((await ask(req(), deps({ leases: null }))).status).toBe(503);
      refuse = Object.assign(new Error("refused"), { code: "42501" });
      expect((await ask()).status).toBe(401);
    });

    it("a signer that throws is a bare 500 that carries none of its text", async () => {
      refuse = null;
      const throwing: RunnerLeaseOps = { ...leases, signGitTicket: async () => { throw new Error("password=hunter2 in /srv/keys"); } };
      const res = await ask(req(), deps({ leases: throwing }));
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain("hunter2");
    });
  });

  describe("authentication, as for every runner route", () => {
    it("an unsigned request, an unknown key, a tampered body and a revoked runner are 401 and reach nothing", async () => {
      const good = req();
      const { signature: _s, "signature-input": _i, ...unsigned } = good.headers;
      expect((await ask({ ...good, headers: unsigned })).status).toBe(401);
      expect((await ask(req(undefined, newKey()))).status).toBe(401);
      expect((await ask({ ...good, body: Buffer.from(JSON.stringify({ run_id: RUN, lease_generation: 9 })) })).status).toBe(401);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
      expect((await ask(req())).status).toBe(401);
      expect(calls).toEqual([]);
    });

    it("a session cookie or bearer token is no credential", async () => {
      const r = req();
      const { signature: _s, "signature-input": _i, ...unsigned } = r.headers;
      expect((await ask({ ...r, headers: { ...unsigned, cookie: "fx_session=abc", authorization: "Bearer fxat_abc" } })).status).toBe(401);
      expect(calls).toEqual([]);
    });

    it("a signature made for another route's path does not open this one", async () => {
      expect((await ask(signed(key, "/api/runner/heartbeat", { run_id: RUN, lease_generation: 2 }))).status).toBe(401);
      expect(calls).toEqual([]);
    });

    it("spends the nonce: the same signed request twice is 409 nonce_reused, and the second reaches nothing", async () => {
      const once = req(undefined, key, { nonce: "g".repeat(22) });
      expect((await ask(once)).status).toBe(200);
      const second = await ask(once);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ error: { code: "nonce_reused" } });
      expect(calls.map((c) => c.method)).toEqual(["context", "sign"]);
    });

    it("a body of more than 256 KiB is 413 before its signature is read", async () => {
      const big = req(undefined, key, { rawBody: Buffer.alloc(256 * 1024 + 1, 0x20) });
      expect((await ask(big)).status).toBe(413);
      expect(calls).toEqual([]);
    });
  });

  describe("the message", () => {
    it("takes exactly { run_id, lease_generation }: a repo, a ref or any other field is 400, and so is a missing one", async () => {
      for (const body of [{ run_id: RUN }, { lease_generation: 1 }, { run_id: RUN, lease_generation: 1, ref: "main" }, { run_id: RUN, lease_generation: 1, repo: "acme/widgets" }, { run_id: "x", lease_generation: 1 }, {}, []]) {
        expect((await ask(req(body))).status, JSON.stringify(body)).toBe(400);
      }
      expect(calls).toEqual([]);
    });

    it("is JSON, or 400", async () => {
      expect((await ask(req(undefined, key, { rawBody: Buffer.from("not json") }))).status).toBe(400);
      expect(calls).toEqual([]);
    });
  });
});
