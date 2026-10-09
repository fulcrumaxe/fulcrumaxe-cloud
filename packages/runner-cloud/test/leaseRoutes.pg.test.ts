import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaimRateLimitedReply, ClaimReply, EventsReply, HeartbeatReply, MAX_EVENTS_PER_BATCH, STOP_REASONS, SeqNotIncreasingReply, StopReply, sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { MAX_BODY_BYTES, claimRun, eventsPath, heartbeatRun, ingestEvents, toResponse, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

const CLAIM = "/api/runner/claim";
const HEARTBEAT = "/api/runner/heartbeat";

/** [pg] D#6 R2b-3: the claim, heartbeat and events handlers, with a recording stand-in for the worker. */
describe("lease routes [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let claimResult: Awaited<ReturnType<RunnerLeaseOps["claimRunnerRun"]>>;
  let verdict = "ok";
  let reason: (typeof STOP_REASONS)[number] = "run_terminal";
  const LEASE_END = new Date("2026-10-10T12:01:30.000Z");
  let ingestResult: Awaited<ReturnType<RunnerLeaseOps["ingestRunnerEvents"]>>;
  let refuse: unknown = null;

  const leases: RunnerLeaseOps = {
    claimRunnerRun: async (input) => {
      calls.push({ method: "claim", input });
      if (refuse) throw refuse;
      return claimResult;
    },
    heartbeatRunnerRun: async (input) => {
      calls.push({ method: "heartbeat", input });
      if (refuse) throw refuse;
      return verdict === "ok" ? { verdict: "ok", leaseExpiresAt: LEASE_END } : { verdict, reason };
    },
    ingestRunnerEvents: async (input) => {
      calls.push({ method: "events", input: { ...input } });
      if (refuse) throw refuse;
      return ingestResult;
    },
    // `git-ticket` has its own suite (gitTicket.pg.test.ts), as `done` has (done.pg.test.ts); these routes' tests never reach either.
    gitTicketContext: async () => {
      throw new Error("not used by these tests");
    },
    signGitTicket: async () => {
      throw new Error("not used by these tests");
    },
    // `done` has its own suite (done.pg.test.ts); these routes' tests never reach it.
    beginRunnerDone: async () => {
      throw new Error("not used by these tests");
    },
    finishRunnerDone: async () => {
      throw new Error("not used by these tests");
    },
  };
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ leases, ...over });
  const run = (fn: () => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>) => toResponse(fn);
  const RUN = randomUUID();
  const event = (seq: number, extra: object = {}) => ({ seq, ts: "2026-10-10T12:00:00.000Z", type: "tool_use", tool_name: "Edit", ...extra });

  const job: Job = {
    schema_version: 1,
    job_id: randomUUID(),
    run_id: RUN,
    repo: { id: randomUUID(), owner: "acme", name: "app", private: true },
    role: "executor",
    mode: "local",
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
  };

  beforeAll(async () => {
    h = await harness();
    A = await seedAccount(h.admin, randomUUID());
    key = newKey();
    runnerId = await registerKey(h.admin, A.accountId, A.userId, key);
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    calls.length = 0;
    verdict = "ok";
    reason = "run_terminal";
    refuse = null;
    claimResult = { kind: "idle", retryAfter: 60 };
    ingestResult = { outcome: "accepted", stored: 1, duplicates: 0, leaseExpiresAt: LEASE_END };
    await h.admin.query("UPDATE runners SET revoked_at = NULL WHERE id = $1", [runnerId]);
    await h.admin.query("DELETE FROM runner_claim_stamps WHERE runner_id = $1", [runnerId]);
  });

  /** The request, signed by `k` (default: the registered runner). */
  const req = (path: string, body: unknown, k: TestKey = key, o: Parameters<typeof signed>[3] = {}): RunnerHttpRequest => signed(k, path, body, o);

  describe("authentication, on every route", () => {
    const cases: Array<[string, (r: RunnerHttpRequest) => Promise<{ status: number }>, string, unknown]> = [
      ["claim", (r) => run(() => claimRun(deps(), r)), CLAIM, {}],
      ["heartbeat", (r) => run(() => heartbeatRun(deps(), r)), HEARTBEAT, { run_id: RUN, lease_generation: 1 }],
      ["events", (r) => run(() => ingestEvents(deps(), r, RUN)), eventsPath(RUN), { run_id: RUN, lease_generation: 1, events: [event(0)] }],
    ];
    for (const [name, call, path, body] of cases) {
      it(`${name}: an unsigned request, an unknown key, a tampered body and a revoked runner are 401 and reach nothing`, async () => {
        const good = req(path, body);
        const { signature: _s, "signature-input": _i, ...unsigned } = good.headers;
        expect((await call({ ...good, headers: unsigned })).status).toBe(401);
        expect((await call(req(path, body, newKey()))).status).toBe(401);
        expect((await call({ ...good, body: Buffer.from(JSON.stringify({ ...(body as object), x: 1 })) })).status).toBe(401);
        await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
        expect((await call(req(path, body))).status).toBe(401);
        expect(calls).toEqual([]);
      });

      it(`${name}: a session cookie or bearer token is no credential`, async () => {
        const r = req(path, body);
        const { signature: _s, "signature-input": _i, ...unsigned } = r.headers;
        expect((await call({ ...r, headers: { ...unsigned, cookie: "fx_session=abc", authorization: "Bearer fxat_abc" } })).status).toBe(401);
        expect(calls).toEqual([]);
      });

      it(`${name}: the worker is told the runner's own account and id, whatever the body or headers say`, async () => {
        const other = randomUUID();
        const r = req(path, body);
        r.headers = { ...r.headers, "x-fx-account-id": other };
        await call(r);
        expect(calls[0]!.input).toMatchObject({ accountId: A.accountId, runnerId });
      });

      it(`${name}: a worker that is not configured is 503, and a runner it refuses (42501) is 401`, async () => {
        const unconfigured = deps({ leases: null });
        const r = req(path, body);
        const res = await run(() => (name === "claim" ? claimRun(unconfigured, r) : name === "heartbeat" ? heartbeatRun(unconfigured, r) : ingestEvents(unconfigured, r, RUN)));
        expect(res.status).toBe(503);
        refuse = Object.assign(new Error("refused"), { code: "42501" });
        expect((await call(req(path, body))).status).toBe(401);
      });
    }
  });

  describe("claim", () => {
    it("answers an idle claim with exactly { retry_after } and a Retry-After header", async () => {
      const res = await run(() => claimRun(deps(), req(CLAIM, {})));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ retry_after: 60 });
      expect(res.headers).toMatchObject({ "retry-after": "60" });
    });

    it("answers a claimed run with the signed job, its run id and the lease generation, and the reply parses as the protocol says", async () => {
      claimResult = { kind: "claimed", signedJob: signJob(job, generateKeyPairSync("ed25519").privateKey), runId: RUN, leaseGeneration: 1 };
      const res = await run(() => claimRun(deps(), req(CLAIM, {})));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual(["lease_generation", "run_id", "signed_job"]);
      expect(ClaimReply.safeParse(res.body).success).toBe(true);
    });

    it("refuses a second claim inside 4 seconds with 429 and retry_after, and the worker runs no claim for it", async () => {
      expect((await run(() => claimRun(deps(), req(CLAIM, {})))).status).toBe(200);
      expect(calls).toHaveLength(1);
      const second = await run(() => claimRun(deps(), req(CLAIM, {})));
      expect(second.status).toBe(429);
      expect(ClaimRateLimitedReply.safeParse(second.body).success).toBe(true);
      expect(Object.keys(second.body as object)).toEqual(["retry_after"]);
      const retryAfter = (second.body as { retry_after: number }).retry_after;
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(4);
      expect(second.headers).toMatchObject({ "retry-after": String(retryAfter) });
      expect(calls).toHaveLength(1);
      await h.admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '4 seconds' WHERE runner_id = $1", [runnerId]);
      expect((await run(() => claimRun(deps(), req(CLAIM, {})))).status).toBe(200);
      expect(calls).toHaveLength(2);
    });

    it("spends the nonce: the same signed claim twice is 409, and the second reaches nothing", async () => {
      const once = req(CLAIM, {}, key, { nonce: "n".repeat(22) });
      expect((await run(() => claimRun(deps(), once))).status).toBe(200);
      await h.admin.query("DELETE FROM runner_claim_stamps WHERE runner_id = $1", [runnerId]);
      expect((await run(() => claimRun(deps(), once))).status).toBe(409);
      expect(calls).toHaveLength(1);
    });

    it("takes no body: a field is 400", async () => {
      expect((await run(() => claimRun(deps(), req(CLAIM, { account_id: A.accountId })))).status).toBe(400);
      expect(calls).toEqual([]);
    });
  });

  describe("heartbeat", () => {
    const beat = (body: unknown = { run_id: RUN, lease_generation: 1 }) => run(() => heartbeatRun(deps(), req(HEARTBEAT, body)));

    it("a held run is 200 { continue: true, lease_expires_at } with the lease's end as an ISO UTC time", async () => {
      const res = await beat();
      expect(res.status).toBe(200);
      expect(HeartbeatReply.safeParse(res.body).success).toBe(true);
      expect(res.body).toEqual({ continue: true, lease_expires_at: "2026-10-10T12:01:30.000Z" });
      expect(calls[0]!.input).toMatchObject({ runId: RUN, leaseGeneration: 1 });
    });

    it("every way of not holding the run is 409 { continue: false, reason } with the reason the worker derived", async () => {
      for (const r of STOP_REASONS) {
        verdict = "not_ok";
        reason = r;
        const res = await beat();
        expect(res.status, r).toBe(409);
        expect(StopReply.safeParse(res.body).success, r).toBe(true);
        expect(res.body, r).toEqual({ continue: false, reason: r });
      }
    });

    it("refuses a body that is not exactly run_id and lease_generation", async () => {
      for (const body of [{}, { run_id: "x", lease_generation: 1 }, { run_id: RUN, lease_generation: -1 }, { run_id: RUN, lease_generation: 1, extra: 1 }]) {
        expect((await beat(body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(calls).toEqual([]);
    });
  });

  describe("events", () => {
    const send = (body: unknown, runId = RUN, d = deps()) => run(() => ingestEvents(d, req(eventsPath(runId), body), runId));
    const batch = (events: object[]) => ({ run_id: RUN, lease_generation: 1, events });

    it("accepts a batch: 200 { continue, accepted, duplicates, lease_expires_at } and the worker gets the events", async () => {
      ingestResult = { outcome: "accepted", stored: 2, duplicates: 1, leaseExpiresAt: LEASE_END };
      const res = await send(batch([event(0), event(1)]));
      expect(res).toMatchObject({ status: 200, body: { continue: true, accepted: 2, duplicates: 1, lease_expires_at: "2026-10-10T12:01:30.000Z" } });
      expect(EventsReply.safeParse(res.body).success).toBe(true);
      expect((calls[0]!.input.events as unknown[]).length).toBe(2);
    });

    it("a batch at or below the last accepted seq is 409 seq_not_increasing, which keeps the runner going and names the number", async () => {
      ingestResult = { outcome: "seq_not_increasing", lastAcceptedSeq: 7 };
      const seq = await send(batch([event(0)]));
      expect(seq.status).toBe(409);
      expect(seq.body).toEqual({ continue: true, error: "seq_not_increasing", last_accepted_seq: 7 });
      expect(SeqNotIncreasingReply.safeParse(seq.body).success).toBe(true);
      expect(StopReply.safeParse(seq.body).success).toBe(false);
    });

    it("numbers that do not strictly increase inside the batch are 400 seq_order", async () => {
      ingestResult = { outcome: "seq_order" };
      const res = await send(batch([event(1), event(1)]));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "seq_order" } });
      expect(res.body).not.toHaveProperty("continue");
    });

    it("a fence mismatch is 409 { continue: false, reason }, whatever the reason", async () => {
      for (const r of STOP_REASONS) {
        ingestResult = { outcome: "fenced", reason: r };
        expect(await send(batch([event(0)])), r).toMatchObject({ status: 409, body: { continue: false, reason: r } });
      }
    });

    it("limits a batch to 100 events and 256 KiB", async () => {
      expect((await send(batch(Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => event(i))))).status).toBe(400);
      expect((await send(batch(Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, i) => event(i))))).status).toBe(200);
      const big = signed(key, eventsPath(RUN), null, { rawBody: Buffer.alloc(MAX_BODY_BYTES + 1, 0x20) });
      expect((await run(() => ingestEvents(deps(), big, RUN))).status).toBe(413);
    });

    it("the path and the body must name the same run, and the path must be a run id", async () => {
      expect((await send(batch([event(0)]), randomUUID())).status).toBe(400);
      expect((await send(batch([event(0)]), "not-a-uuid" as typeof RUN)).status).toBe(404);
    });

    it("an event with text, output, content or message is 400, and what was sent is never logged", async () => {
      const marker = "TOP-SECRET-OUTPUT-MARKER";
      const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
      try {
        for (const field of ["text", "output", "content", "message"]) {
          const res = await send(batch([event(0, { [field]: marker })]));
          expect(res.status, field).toBe(400);
          expect(JSON.stringify(res.body)).not.toContain(marker);
        }
        const logged = spies.flatMap((s) => s.mock.calls).map((c) => JSON.stringify(c)).join("\n");
        expect(logged).not.toContain(marker);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
      expect(calls).toEqual([]);
    });
  });
});
