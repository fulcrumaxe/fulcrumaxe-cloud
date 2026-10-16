import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GIT_TICKET_PATH, sha256Text, type Job } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { gitTicketRun, toResponse, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#599 PL-2b-2 (security model 3): the git-ticket route signs the item's pull request branch only when the run's bound event agrees. The worker's
 * real read of that event (three-way agreement) is pinned in packages/worker/test/gitTicketItemBranch.pg.test.ts; here is the route's own decision.
 */
describe("git-ticket route, item pull request branch [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let key: TestKey;
  const calls: string[] = [];
  type Context = Awaited<ReturnType<RunnerLeaseOps["gitTicketContext"]>>;
  let context: Context;
  const RUN = randomUUID();
  const REPO = { id: randomUUID(), owner: "acme", name: "widgets" };
  const TICKET = ["aGVhZGVy", "Y2xhaW1z", "c2ln"].join(".");
  const signedRefs: string[] = [];

  const job = (branch: string, withPr = true): Job => ({
    schema_version: 1,
    job_id: randomUUID(),
    run_id: RUN,
    repo: { id: REPO.id, owner: "acme", name: "widgets", private: true },
    role: "executor",
    mode: "verified",
    spec: null,
    task: { kind: "fix", prompt: "p", prompt_sha256: sha256Text("p") },
    role_card: { text: "c", sha256: sha256Text("c") },
    role_tools_sha256: "a".repeat(64),
    continues: { parent_run_id: randomUUID(), session_id: null, branch, ...(withPr ? { pr_number: 12 } : {}) },
    branch_prefix: "fx/",
    model_hint: null,
    issued_at: "2026-10-10T12:00:00.000Z",
    expires_at: "2026-10-13T12:00:00.000Z",
    key_id: "k1",
  });
  const ctx = (branch: string, boundBranch: string | null | undefined): Context => ({
    kind: "context",
    role: "executor",
    runtime: "runner",
    executionMode: "runner_verified",
    repo: REPO,
    job: job(branch),
    ...(boundBranch === undefined ? {} : { boundBranch }),
  });

  const leases: RunnerLeaseOps = {
    claimRunnerRun: async () => {
      throw new Error("not used");
    },
    heartbeatRunnerRun: async () => {
      throw new Error("not used");
    },
    ingestRunnerEvents: async () => {
      throw new Error("not used");
    },
    beginRunnerDone: async () => {
      throw new Error("not used");
    },
    finishRunnerDone: async () => {
      throw new Error("not used");
    },
    gitTicketContext: async () => {
      calls.push("context");
      return context;
    },
    signGitTicket: async (input) => {
      calls.push("sign");
      signedRefs.push(input.ref);
      return { ticket: TICKET, expiresAt: new Date("2026-10-10T12:05:00.000Z"), proxyOrigin: "https://proxy.example.test" };
    },
  };
  const deps = (): RunnerCloudDeps => h.deps({ leases });
  const req = (): RunnerHttpRequest => signed(key, GIT_TICKET_PATH, { run_id: RUN, lease_generation: 2 }, {});
  const ask = () => toResponse(() => gitTicketRun(deps(), req()));

  beforeAll(async () => {
    h = await harness();
    A = await seedAccount(h.admin, randomUUID());
    key = newKey();
    await registerKey(h.admin, A.accountId, A.userId, key);
  });
  afterAll(() => h.close());
  beforeEach(() => {
    calls.length = 0;
    signedRefs.length = 0;
  });

  it("signs fx/issue-7 for a run whose job continues it and whose bound event names it", async () => {
    context = ctx("fx/issue-7", "fx/issue-7");
    const res = await ask();
    expect(res.status).toBe(200);
    expect(signedRefs).toEqual(["fx/issue-7"]);
  });

  it("answers 403 ticket_branch_unbound and signs nothing when the bound event is missing, null or names another branch", async () => {
    for (const bound of [undefined, null, "fx/issue-8"] as const) {
      calls.length = 0;
      context = ctx("fx/issue-7", bound);
      const res = await ask();
      expect(res.status, String(bound)).toBe(403);
      expect(res.body).toMatchObject({ error: { code: "ticket_branch_unbound" } });
      expect(calls).toEqual(["context"]);
    }
    expect(signedRefs).toEqual([]);
  });

  it("a run branch needs no binding and is signed as before", async () => {
    const branch = `fx/${randomUUID()}-g3`;
    context = ctx(branch, null);
    expect((await ask()).status).toBe(200);
    expect(signedRefs).toEqual([branch]);
  });
});
