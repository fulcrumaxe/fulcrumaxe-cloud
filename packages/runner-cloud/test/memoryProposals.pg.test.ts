import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_PROPOSALS_PATH, MemoryProposalsReply } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { memoryProposalsRun, toResponse, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#601 MEM-6: POST /api/runner/memory-proposals, with a recording stand-in for the worker (the real intake is exercised in packages/worker/test/runnerMemoryProposals.pg.test.ts).
 * Pinned here are the route's own decisions: the signature and its single-use nonce, the strict message, the body-hash check BEFORE the worker is asked, who the worker is told
 * the runner and account are, and the fixed status and code of every answer the worker can give.
 */
describe("memory-proposals route [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  const calls: Array<Record<string, unknown>> = [];
  type Found = Awaited<ReturnType<NonNullable<RunnerLeaseOps["memoryProposals"]>>>;
  let found: Found;
  let refuse: unknown = null;
  const RUN = randomUUID();
  const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
  const item = (body = "run the tests with pnpm", over: Record<string, unknown> = {}) => ({ scope: "repo", kind: "command", body, body_sha256: sha(body), ...over });
  const unused = async (): Promise<never> => {
    throw new Error("not used by these tests");
  };
  const leases = (withMemory = true): RunnerLeaseOps => ({
    claimRunnerRun: unused, heartbeatRunnerRun: unused, ingestRunnerEvents: unused, beginRunnerDone: unused, finishRunnerDone: unused, gitTicketContext: unused, signGitTicket: unused,
    ...(withMemory ? { memoryProposals: async (input) => { calls.push({ ...input }); if (refuse) throw refuse; return found; } } : {}),
  });
  const deps = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ leases: leases(), ...over });
  const req = (body: unknown = { run_id: RUN, proposals: [item()] }, k: TestKey = key, o: Parameters<typeof signed>[3] = {}): RunnerHttpRequest => signed(k, MEMORY_PROPOSALS_PATH, body, o);
  const ask = (r: RunnerHttpRequest = req(), d: RunnerCloudDeps = deps()) => toResponse(() => memoryProposalsRun(d, r));

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
    found = { kind: "ingested", stored: 1, refused: 0 };
    await h.admin.query("UPDATE runners SET revoked_at = NULL WHERE id = $1", [runnerId]);
  });

  it("the path is the constant /api/runner/memory-proposals", () => {
    expect(MEMORY_PROPOSALS_PATH).toBe("/api/runner/memory-proposals");
  });

  it("is 200 with counts only, no-store, and tells the worker the verified runner and account, the run, and scope, kind and body of each proposal and no hash", async () => {
    const res = await ask(req({ run_id: RUN.toUpperCase(), proposals: [item("one"), item("two")] }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ingested", stored: 1, refused: 0 });
    expect(MemoryProposalsReply.safeParse(res.body).success).toBe(true);
    expect(res.headers).toMatchObject({ "cache-control": "no-store" });
    expect(calls).toEqual([{ accountId: A.accountId, runnerId, runId: RUN, proposals: [{ scope: "repo", kind: "command", body: "one" }, { scope: "repo", kind: "command", body: "two" }] }]);
  });

  it("takes the account and runner from the verified signature, whatever the headers say", async () => {
    const r = req();
    r.headers = { ...r.headers, "x-fx-account-id": randomUUID(), "x-fx-runner-id": randomUUID() };
    await ask(r);
    expect(calls[0]).toMatchObject({ accountId: A.accountId, runnerId });
  });

  it("answers already_ingested with the same counts-only shape", async () => {
    found = { kind: "already_ingested", stored: 0, refused: 0 };
    expect((await ask()).body).toEqual({ status: "already_ingested", stored: 0, refused: 0 });
  });

  it("a body whose hash is not its own is 400 invalid_message and the worker is never asked (any one proposal of the three)", async () => {
    const bad = { ...item("the text the person saw"), body: "the text that was swapped in" };
    for (const proposals of [[bad], [item("fine"), bad], [item("a"), item("b"), { ...item("c"), body_sha256: sha("C") }]]) {
      const res = await ask(req({ run_id: RUN, proposals }));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: "invalid_message" } });
    }
    expect(calls).toEqual([]);
  });

  it("refuses what the strict message refuses, before the worker: an extra key, no proposals, a fourth, a control character, a bad scope", async () => {
    const bodies: unknown[] = [
      { run_id: RUN, proposals: [item()], account_id: A.accountId },
      { run_id: RUN, proposals: [item("x", { why: "because" })] },
      { run_id: RUN, proposals: [] },
      { run_id: RUN, proposals: [item("a"), item("b"), item("c"), item("d")] },
      { run_id: RUN, proposals: [item("line one\nline two")] },
      { run_id: RUN, proposals: [item("x", { scope: "account" })] },
      { run_id: "not-a-uuid", proposals: [item()] },
    ];
    for (const body of bodies) expect((await ask(req(body))).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    expect(calls).toEqual([]);
  });

  it("an unsigned request, a revoked runner and a replayed nonce never reach the worker", async () => {
    expect((await ask({ method: "POST", headers: {}, body: Buffer.from(JSON.stringify({ run_id: RUN, proposals: [item()] })) })).status).toBe(401);
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runnerId]);
    expect((await ask()).status).toBe(401);
    await h.admin.query("UPDATE runners SET revoked_at = NULL WHERE id = $1", [runnerId]);
    const once = req(undefined, key, { nonce: "memory-proposals-nonce-0001" });
    expect((await ask(once)).status).toBe(200);
    expect((await ask(once)).status).not.toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("run_not_yours is 403, capability_missing is 403 and run_not_finished is 409, each with its own fixed code", async () => {
    for (const [kind, status] of [["run_not_yours", 403], ["capability_missing", 403], ["run_not_finished", 409]] as const) {
      found = { kind };
      const res = await ask();
      expect(res.status, kind).toBe(status);
      expect(res.body, kind).toMatchObject({ error: { code: kind } });
    }
  });

  it("a worker that is not configured is 503 not_configured, one without the method too, and a runner the worker refuses (42501) is 401", async () => {
    expect((await ask(req(), deps({ leases: undefined }))).status).toBe(503);
    const res = await ask(req(), deps({ leases: leases(false) }));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "not_configured" } });
    refuse = Object.assign(new Error("denied"), { code: "42501" });
    expect((await ask()).status).toBe(401);
  });
});
