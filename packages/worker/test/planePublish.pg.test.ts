import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { stampPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { createFakeSandbox, PLANE_PUBLISH_VCPUS, SANDBOX_VCPUS, type AgentRuntime, type NetworkPolicyRule, type PlanePublishLine } from "@fx/runner";
import { phaseLine } from "../../runner/src/planePublish/protocol.js";
import { sandboxRunCost } from "@fx/spend";
import { decideBuildSlot } from "@fx/pipeline";
import { createFakeModelConnectionPort } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { createReaperSdkFake } from "../../runner/test/helpers/reaperSdkFake.js";
import { buildWorker } from "../src/compositionRoot.js";
import { PUBLISH_ATTEMPT_LIMIT, createPlanePublish, createPublishSettler, mayRetryPublish, type PlanePublishDeps } from "../src/planePublish.js";

/**
 * [pg] D#598 P1f-5b: the publish step against the real tables and constraints. The sandbox is the runner package's strict fake (the same
 * contract the real adapter is held to in P1f-5a); GitHub is a recording stand-in whose real calls are exercised in packages/github.
 */
describe("the paired publish step [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let A: SeedRefs;
  let executorRunId: string;
  const BASE = "a".repeat(40);
  const PRIVATE_HEAD = "b".repeat(40);
  const HEAD = "c".repeat(40);
  const TIP = "d".repeat(40);
  const POLICY: NetworkPolicyRule[] = [{ host: "gh-proxy.fixture.test", purpose: "github_proxy" }];
  const noRuntime = { start: async () => undefined, stop: async () => undefined, resume: async () => undefined } as unknown as AgentRuntime;

  let fake: ReturnType<typeof createFakeSandbox>;
  /** What the hook prints; set per test. A function sees the sandbox name. */
  let output: (name: string) => { exitCode: number; stdout: string };
  let onRun: (() => Promise<void>) | undefined;
  let clock = 0;
  const github = { pushed: true, pr: { url: "https://github.com/acme/widgets-public/pull/9" } as { url: string } | null, asked: [] as string[], head: PRIVATE_HEAD as string | null, headError: false };
  let identity: { name: string; email: string } | null;
  let policyError = false;

  const prOpened = (): PlanePublishLine => ({ phase: "pr_opened", branch: undefined, head_sha: HEAD, tip_sha: TIP, pr_number: 9 });
  const say = (...lines: PlanePublishLine[]) => ({ exitCode: 0, stdout: lines.map((l) => phaseLine(l)).join("\n") + "\n" });

  function deps(): PlanePublishDeps {
    const port = fake.port;
    return {
      pool: writerPool,
      port: {
        ...port,
        createSandbox: async (o) => {
          const h = await port.createSandbox(o);
          fake.scriptCommand(o.sandboxName, output(o.sandboxName));
          return h;
        },
        runCommand: async (h, o) => {
          clock += 7_000; // seven seconds in the sandbox
          if (onRun) await onRun();
          return port.runCommand!(h, o);
        },
      } as PlanePublishDeps["port"],
      hook: () => "// the built hook",
      networkPolicy: async () => {
        if (policyError) throw new Error("not configured");
        return POLICY;
      },
      identity: () => identity,
      privateHead: async () => {
        if (github.headError) throw new Error("github down");
        return github.head;
      },
      hosted: {
        verifyPushed: async () => (github.asked.push("pushed"), github.pushed),
        verifyPullRequest: async () => (github.asked.push("pr"), github.pr),
        openPullRequest: async () => Promise.reject(new Error("not used here")),
      },
      now: () => clock,
    };
  }
  const publish = () => createPlanePublish(deps());

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  const pair = (globs: string[] = ["docs/ops/"]) =>
    admin.query(
      `INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3)
       ON CONFLICT (repo_id) DO UPDATE SET overlay_globs = EXCLUDED.overlay_globs`,
      [A.repoId, A.accountId, globs],
    );
  const planeRow = async () => (await admin.query("SELECT * FROM plane_pushes WHERE work_item_id = $1", [A.workItemId])).rows[0];
  const attempts = async () => (await admin.query("SELECT * FROM plane_push_attempts WHERE account_id = $1 ORDER BY attempt_no", [A.accountId])).rows;
  const publishRuns = async () => (await admin.query("SELECT id, role, runtime, dispatch_repo_id, parent_run_id, head_sha, status, work_item_id, sandbox_name, envelope, usd FROM agent_runs WHERE account_id = $1 AND role = 'plane_publish' ORDER BY created_at", [A.accountId])).rows;

  beforeEach(async () => {
    fake = createFakeSandbox(noRuntime);
    output = () => say(prOpened());
    onRun = undefined;
    clock = 1_000_000;
    github.pushed = true;
    github.pr = { url: "https://github.com/acme/widgets-public/pull/9" };
    github.asked.length = 0;
    github.head = PRIVATE_HEAD;
    github.headError = false;
    identity = { name: "Fulcrumaxe Bot", email: "bot@example.com" };
    policyError = false;
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [A.repoId]);
    await admin.query("UPDATE work_items SET gh_number = 42, title = 'Add a thing' WHERE id = $1", [A.workItemId]);
    await pair();
    await withTenant(appPool, A.accountId, (c) => stampPlanePush(c, { accountId: A.accountId, workItemId: A.workItemId, repoId: A.repoId }));
    executorRunId = await executorRun("succeeded");
  });

  async function executorRun(status: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, head_sha)
       VALUES ($1, $2, $3, 'executor', 'production', $4, 'sandbox', $5, $6)`,
      [id, A.accountId, A.workItemId, status, A.repoId, BASE],
    );
    return id;
  }

  describe("one attempt, end to end", () => {
    it("opens the public change: the rows have the specified fields, the name is pp- plus the attempt whose run_id is this run, the sandbox is 1 vCPU and gone", async () => {
      const r = await publish().publishPairedChange({ accountId: A.accountId, executorRunId });
      expect(r).toEqual({ kind: "published", state: "pr_opened", attemptNo: 1 });

      const [run, ...more] = await publishRuns();
      expect(more).toEqual([]);
      const [attempt] = await attempts();
      expect(run).toMatchObject({ role: "plane_publish", runtime: "production", dispatch_repo_id: A.repoId, parent_run_id: executorRunId, head_sha: null, status: "succeeded", work_item_id: A.workItemId });
      expect(attempt).toMatchObject({ kind: "push", runtime: "sandbox", run_id: run.id, attempt_no: 1, outcome: "pr_opened" });
      expect(attempt.finished_at).toBeInstanceOf(Date);
      // Exactly pp- plus the attempt id, and the attempt's run is this run.
      expect(run.sandbox_name).toBe(`pp-${attempt.id}`);
      expect(fake.state.created.map((c) => c.sandboxName)).toEqual([run.sandbox_name]);
      expect(fake.state.created[0]).toMatchObject({ vcpus: PLANE_PUBLISH_VCPUS });
      expect(fake.state.stopped.map((h) => h.sandboxName)).toEqual([run.sandbox_name]);
      expect(fake.state.deleted.map((h) => h.sandboxName)).toEqual([run.sandbox_name]);
      expect(fake.state.commands[0]!.policyPurposes).toEqual(["github_proxy"]);

      const input = JSON.parse(fake.state.writtenFiles.find((f) => f.path.endsWith("input.json"))!.content);
      const row = await planeRow();
      expect(input).toMatchObject({ own: { owner: "acme", name: "widgets" }, codeRepo: "acme/widgets-public", privateBase: BASE, privateHead: PRIVATE_HEAD, branch: row.branch });
      expect(row).toMatchObject({ state: "pr_opened", head_sha: HEAD, tip_sha: TIP, pr_number: 9, pr_url: "https://github.com/acme/widgets-public/pull/9", code: null });
      expect(github.asked).toEqual(["pushed", "pr"]);
    });

    it("the run summary carries the seconds and a cost priced from 1 vCPU: half of what the pinned 2 gives", async () => {
      await publish().publishPairedChange({ accountId: A.accountId, executorRunId });
      const [run] = await publishRuns();
      expect(run.envelope.publish).toMatchObject({ attempt_no: 1, outcome: "pr_opened", seconds: 7, vcpus: 1 });
      const one = sandboxRunCost([{ ownDurationMs: 600_000 }], { vcpus: PLANE_PUBLISH_VCPUS }).usd;
      const two = sandboxRunCost([{ ownDurationMs: 600_000 }], { vcpus: SANDBOX_VCPUS }).usd;
      expect(one * 2).toBeCloseTo(two, 3);
      expect(Number(run.usd)).toBe(sandboxRunCost([{ ownDurationMs: 7000 }], { vcpus: 1 }).usd);
      expect(Number(run.envelope.publish.seconds)).toBeLessThan(90);
    });

    it("a no-change run records no_public_change; a pushed branch whose PR could not open records pushed_pr_not_opened", async () => {
      output = () => say({ phase: "no_change" });
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toMatchObject({ kind: "published", state: "no_public_change" });
      expect((await planeRow()).state).toBe("no_public_change");
    });

    it("pushed_pr_not_opened: the branch is verified, no PR is asked about", async () => {
      output = () => say({ phase: "pr_failed", head_sha: HEAD, tip_sha: TIP });
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toMatchObject({ kind: "published", state: "pushed_pr_not_opened" });
      expect(github.asked).toEqual(["pushed"]);
      expect(await planeRow()).toMatchObject({ state: "pushed_pr_not_opened", head_sha: HEAD, pr_number: null });
    });

    it("a hook refusal is recorded with its code and place-plus-rule entries", async () => {
      output = () => say({ phase: "refused", code: "scan_refused", refusals: [{ kind: "path", place: "docs/ops/a.md", rule_key: "overlay" }] });
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toEqual({ kind: "refused", code: "scan_refused", attemptNo: 1 });
      expect(await planeRow()).toMatchObject({ state: "refused", code: "scan_refused", refusals: [{ kind: "path", place: "docs/ops/a.md", rule_key: "overlay" }] });
    });
  });

  describe("only a finished sandbox executor run on a paired repo publishes", () => {
    it("an unpaired item, a run that did not succeed, and a replay each start 0 publish runs and 0 sandboxes", async () => {
      const failed = await executorRun("failed");
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId: failed })).toEqual({ kind: "skipped", why: "not_done" });
      const other = await seedAccount(admin, randomUUID());
      await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'w2' WHERE id = $1", [other.repoId]);
      const otherRun = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, dispatch_repo_id, head_sha) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4, $5)`, [otherRun, other.accountId, other.workItemId, other.repoId, BASE]);
      expect(await publish().publishPairedChange({ accountId: other.accountId, executorRunId: otherRun })).toEqual({ kind: "skipped", why: "not_paired" });
      expect(await publishRuns()).toEqual([]);
      expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1 AND role = 'plane_publish'", [other.accountId])).rows[0].n).toBe(0);
      expect(fake.state.created).toEqual([]);

      await publish().publishPairedChange({ accountId: A.accountId, executorRunId });
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toEqual({ kind: "skipped", why: "busy" });
      expect(await publishRuns()).toHaveLength(1);
    });
  });

  describe("every state ends clean", () => {
    it("a crash (non-zero exit), a line with an unknown field, and no terminal line each end refused hook_crashed, the run failed, the attempt finished, the sandbox deleted", async () => {
      const cases: Array<(n: string) => { exitCode: number; stdout: string }> = [
        () => ({ exitCode: 1, stdout: "" }),
        // an unknown field: the line is dropped on parse, so there is no terminal line
        () => ({ exitCode: 0, stdout: `{"fx":"plane_publish","phase":"pr_opened","head_sha":"${HEAD}","tip_sha":"${TIP}","pr_number":9,"diff":"secret"}\n` }),
        () => say({ phase: "scanning" }),
      ];
      for (const [i, c] of cases.entries()) {
        output = c;
        const r = i === 0 ? await publish().publishPairedChange({ accountId: A.accountId, executorRunId }) : await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId });
        expect(r).toEqual({ kind: "refused", code: "hook_crashed", attemptNo: i + 1 });
      }
      const runs = await publishRuns();
      expect(runs.map((x) => x.status)).toEqual(["failed", "failed", "failed"]);
      expect((await attempts()).every((a) => a.finished_at !== null && a.outcome === "hook_crashed")).toBe(true);
      expect(fake.state.deleted).toHaveLength(3);
      expect(await planeRow()).toMatchObject({ state: "refused", code: "hook_crashed", head_sha: null });
    });

    it("a doubtful report records report_mismatch and stores nothing from the hook: a branch GitHub does not show, a PR it does not show, a foreign branch name", async () => {
      github.pushed = false;
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toEqual({ kind: "refused", code: "report_mismatch", attemptNo: 1 });
      expect(await planeRow()).toMatchObject({ state: "refused", code: "report_mismatch", head_sha: null, tip_sha: null, pr_number: null });
      github.pushed = true;
      github.pr = null;
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toMatchObject({ code: "report_mismatch", attemptNo: 2 });
      expect((await planeRow()).pr_number).toBeNull();
      output = () => say({ phase: "pr_opened", branch: "fx/p-someone-elses", head_sha: HEAD, tip_sha: TIP, pr_number: 9 });
      github.pr = { url: "https://github.com/acme/widgets-public/pull/9" };
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toMatchObject({ code: "report_mismatch", attemptNo: 3 });
    });

    it("the pairing changing while the hook runs records pairing_changed and trusts nothing from the hook, even a clean pr_opened", async () => {
      onRun = async () => void (await pair(["docs/ops/", "more/"]));
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toEqual({ kind: "refused", code: "pairing_changed", attemptNo: 1 });
      expect(await planeRow()).toMatchObject({ state: "refused", code: "pairing_changed", head_sha: null, pr_number: null });
      expect(github.asked).toEqual([]);
    });

    it("a pairing that moved before the hook, an unusable proxy, a missing identity, a missing private branch and an unreadable GitHub each start no sandbox", async () => {
      await pair(["docs/ops/", "moved/"]);
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toEqual({ kind: "refused", code: "pairing_changed", attemptNo: null });
      expect(fake.state.created).toEqual([]);
      for (const [arrange, code] of [
        [() => void (policyError = true), "public_unavailable"],
        [() => ((policyError = false), (identity = null)), "bad_input"],
        [() => ((identity = { name: "B", email: "b@example.com" }), (github.head = null)), "bad_input"],
        [() => ((github.head = PRIVATE_HEAD), (github.headError = true)), "public_unavailable"],
      ] as const) {
        arrange();
        expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toEqual({ kind: "refused", code, attemptNo: null });
      }
      expect(fake.state.created).toEqual([]);
      expect(await publishRuns()).toEqual([]);
      expect(await attempts()).toEqual([]); // none of these spent an attempt
    });
  });

  describe("Try the push again", () => {
    async function refuseOnce(): Promise<void> {
      output = () => say({ phase: "refused", code: "push_failed" });
    }

    it("makes attempt 2 and then 3; a fourth is refused retry_limit and creates no sandbox and no run row", async () => {
      await refuseOnce();
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toMatchObject({ attemptNo: 1 });
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toMatchObject({ code: "push_failed", attemptNo: 2 });
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toMatchObject({ attemptNo: 3 });
      const created = fake.state.created.length;
      const runs = (await publishRuns()).length;
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toEqual({ kind: "refused", code: "retry_limit", attemptNo: null });
      expect(fake.state.created).toHaveLength(created);
      expect(await publishRuns()).toHaveLength(runs);
      expect(await planeRow()).toMatchObject({ state: "refused", code: "retry_limit" });
      expect(await attempts()).toHaveLength(PUBLISH_ATTEMPT_LIMIT);
      // the same answer again, and the predicate agrees
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toMatchObject({ code: "retry_limit" });
    });

    it("with the pairing off the retry ends in pairing_off, pushes nothing and creates no sandbox", async () => {
      await refuseOnce();
      await publish().publishPairedChange({ accountId: A.accountId, executorRunId });
      await admin.query("DELETE FROM repo_pairing WHERE repo_id = $1", [A.repoId]);
      const created = fake.state.created.length;
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toEqual({ kind: "refused", code: "pairing_off", attemptNo: null });
      expect(fake.state.created).toHaveLength(created);
      expect(await planeRow()).toMatchObject({ state: "refused", code: "pairing_off" });
    });

    it("is skipped in any state the predicate refuses: building, an opened PR", async () => {
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toEqual({ kind: "skipped", why: "not_retryable" });
      await publish().publishPairedChange({ accountId: A.accountId, executorRunId });
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toEqual({ kind: "skipped", why: "not_retryable" });
    });

    it("the predicate: refused + sandbox + under 3 only, and never for a person-managed branch", () => {
      const f = { state: "refused", lastPushRuntime: "sandbox", pushAttempts: 2, managedByPerson: false } as const;
      expect(mayRetryPublish(f)).toBe(true);
      expect(mayRetryPublish({ ...f, pushAttempts: 3 })).toBe(false);
      expect(mayRetryPublish({ ...f, lastPushRuntime: "runner" })).toBe(false);
      expect(mayRetryPublish({ ...f, state: "pr_opened" })).toBe(false);
      expect(mayRetryPublish({ ...f, state: "pushed_pr_not_opened" })).toBe(false);
      expect(mayRetryPublish({ ...f, managedByPerson: true })).toBe(false);
    });
  });

  describe("the schema is the backstop", () => {
    it("a second attempt row for the same number fails on the unique index, and no sandbox exists for it", async () => {
      await publish().publishPairedChange({ accountId: A.accountId, executorRunId });
      const row = await planeRow();
      await expect(admin.query(`INSERT INTO plane_push_attempts (account_id, plane_push_id, runtime, kind, attempt_no) VALUES ($1, $2, 'sandbox', 'push', 1)`, [A.accountId, row.id])).rejects.toMatchObject({ code: "23505" });
      expect(fake.state.created).toHaveLength(1);
    });
  });

  describe("review fixes", () => {
    it("an item re-paired to another public repo cannot push to the old one: no attempt, no sandbox, no run row; and the row chosen is the current pairing's", async () => {
      output = () => say({ phase: "refused", code: "push_failed" });
      await publish().publishPairedChange({ accountId: A.accountId, executorRunId });
      const created = fake.state.created.length;
      await admin.query("UPDATE repo_pairing SET code_repo = 'acme/elsewhere' WHERE repo_id = $1", [A.repoId]);
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toEqual({ kind: "refused", code: "pairing_changed", attemptNo: null });
      expect(fake.state.created).toHaveLength(created);
      expect(await publishRuns()).toHaveLength(1);
      expect(await attempts()).toHaveLength(1);
      // A second push row for the new repo (the item paired to it later) is the one chosen, whatever the order of the rows.
      await withTenant(appPool, A.accountId, (c) => stampPlanePush(c, { accountId: A.accountId, workItemId: A.workItemId, repoId: A.repoId }));
      const rows = (await admin.query("SELECT code_repo FROM plane_pushes WHERE work_item_id = $1 ORDER BY created_at", [A.workItemId])).rows;
      expect(rows.map((r) => r.code_repo).sort()).toEqual(["acme/elsewhere", "acme/widgets-public"]);
      output = () => say(prOpened());
      // The row for the current pairing is chosen (it is `building`, not retryable), never the old repo's refused row.
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toEqual({ kind: "skipped", why: "not_retryable" });
      expect(fake.state.created).toHaveLength(created);
    });

    it("a valid terminal line beside a marked line with an unknown field is a hook crash, with nothing stored", async () => {
      output = () => ({
        exitCode: 0,
        stdout: `${phaseLine(prOpened())}\n{"fx":"plane_publish","phase":"building","diff":"secret"}\n`,
      });
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toEqual({ kind: "refused", code: "hook_crashed", attemptNo: 1 });
      expect(await planeRow()).toMatchObject({ state: "refused", code: "hook_crashed", head_sha: null, pr_number: null });
      expect(github.asked).toEqual([]);
    });

    it("attempts are numbered per kind (0882): a pr_open row does not move the push number, and the limit counts push attempts only", async () => {
      const row = await planeRow();
      await admin.query(`INSERT INTO plane_push_attempts (account_id, plane_push_id, runtime, kind, attempt_no, finished_at) VALUES ($1, $2, 'hosted', 'pr_open', 1, now())`, [A.accountId, row.id]);
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toEqual({ kind: "published", state: "pr_opened", attemptNo: 1 });
    });

    it("a cancel that ends the run mid-flight does not roll back the outcome or the attempt's finished_at; the run stays cancelled", async () => {
      onRun = async () => void (await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE account_id = $1 AND role = 'plane_publish'", [A.accountId]));
      expect(await publish().publishPairedChange({ accountId: A.accountId, executorRunId })).toMatchObject({ kind: "published", state: "pr_opened" });
      const [run] = await publishRuns();
      const [attempt] = await attempts();
      expect(run.status).toBe("cancelled");
      expect(attempt.finished_at).toBeInstanceOf(Date);
      expect(attempt.outcome).toBe("pr_opened");
      expect(await planeRow()).toMatchObject({ state: "pr_opened", pr_number: 9 });
    });
  });

  describe("a publish run whose worker died (the lost-run settle)", () => {
    /** The rows a worker that died mid-attempt leaves: a running publish run named pp-<attempt>, its unfinished attempt row, the item mid-flight. */
    async function dead(ageMinutes: number, nameOverride?: string): Promise<{ name: string; runId: string; attemptId: string }> {
      const runId = randomUUID();
      const attemptId = randomUUID();
      const name = nameOverride ?? `pp-${attemptId}`;
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id, parent_run_id, sandbox_requested_at)
         VALUES ($1, $2, $3, 'plane_publish', 'production', 'running', $4, $5, $6, now() - make_interval(mins => $7))`,
        [runId, A.accountId, A.workItemId, name, A.repoId, executorRunId, ageMinutes],
      );
      const row = await planeRow();
      await admin.query(`INSERT INTO plane_push_attempts (id, account_id, plane_push_id, run_id, runtime, kind, attempt_no) VALUES ($1, $2, $3, $4, 'sandbox', 'push', 1)`, [attemptId, A.accountId, row.id, runId]);
      await admin.query("UPDATE plane_pushes SET state = 'scanning' WHERE id = $1", [row.id]);
      return { name, runId, attemptId };
    }
    const settler = () => createPublishSettler({ pool: writerPool, port: fake.port, now: () => Date.now() });

    it("a vanished sandbox: the run ends failed, the attempt finishes hook_crashed, the item is refused so a retry is offered", async () => {
      const d = await dead(10);
      fake.scriptExists(d.name, false);
      expect(await settler().settleIfLost({ id: d.runId, accountId: A.accountId })).toBe("settled");
      expect((await publishRuns())[0]).toMatchObject({ status: "failed" });
      expect((await attempts())[0]).toMatchObject({ outcome: "hook_crashed" });
      expect((await attempts())[0].finished_at).toBeInstanceOf(Date);
      expect(await planeRow()).toMatchObject({ state: "refused", code: "hook_crashed" });
      expect(await settler().settleIfLost({ id: d.runId, accountId: A.accountId })).toBe("alive"); // nothing left to do
      output = () => say({ phase: "no_change" });
      expect(await publish().retryPublish({ accountId: A.accountId, workItemId: A.workItemId })).toMatchObject({ kind: "published", attemptNo: 2 });
    });

    it("a live young sandbox is left alone", async () => {
      const d = await dead(10);
      await fake.port.createSandbox({ sandboxName: d.name, retention: { persistent: false }, timeoutMs: 600_000, vcpus: PLANE_PUBLISH_VCPUS });
      expect(await settler().settleIfLost({ id: d.runId, accountId: A.accountId })).toBe("alive");
      expect((await publishRuns())[0]).toMatchObject({ status: "running" });
    });

    it("a sandbox past its own timeout is stopped and deleted by its RECORDED pp- name and the run settled", async () => {
      const d = await dead(90);
      await fake.port.createSandbox({ sandboxName: d.name, retention: { persistent: false }, timeoutMs: 600_000, vcpus: PLANE_PUBLISH_VCPUS });
      expect(await settler().settleIfLost({ id: d.runId, accountId: A.accountId })).toBe("settled");
      expect(fake.state.deleted.map((h) => h.sandboxName)).toEqual([d.name]);
      expect((await publishRuns())[0]).toMatchObject({ status: "failed" });
    });

    // Each case would be settled (sandbox gone, or aged past the sandbox timeout) if the name were trusted, so only the name check keeps it alive.
    for (const [label, age, gone] of [["its sandbox is gone", 10, true], ["it is older than the sandbox timeout", 90, false]] as const) {
      it(`a recorded name that is not pp- plus its own attempt's id is never acted on, even when ${label}`, async () => {
        const d = await dead(age, `pp-${randomUUID()}`);
        if (gone) fake.scriptExists(d.name, false);
        else await fake.port.createSandbox({ sandboxName: d.name, retention: { persistent: false }, timeoutMs: 600_000, vcpus: PLANE_PUBLISH_VCPUS });
        const settledBefore = (await attempts()).length;
        expect(await settler().settleIfLost({ id: d.runId, accountId: A.accountId })).toBe("alive");
        expect(fake.state.stopped).toEqual([]);
        expect(fake.state.deleted).toEqual([]);
        expect((await publishRuns())[0]).toMatchObject({ status: "running" });
        const rows = await attempts();
        expect(rows).toHaveLength(settledBefore);
        expect(rows[0]!.finished_at).toBeNull();
        expect(await planeRow()).toMatchObject({ state: "scanning" });
      });
    }
  });

  describe("the slot count", () => {
    it("a live plane_publish run does not change the slot decision for another item of the account", async () => {
      const second = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', 7, 'internal', 'spec_ready')`, [second, A.accountId, A.repoId]);
      const decide = () => withTenant(appPool, A.accountId, (c) => decideBuildSlot(c, A.accountId, second));
      const before = await decide();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, dispatch_repo_id, parent_run_id) VALUES ($1, $2, $3, 'plane_publish', 'production', 'running', $4, $5)`,
        [randomUUID(), A.accountId, A.workItemId, A.repoId, executorRunId],
      );
      expect(await decide()).toEqual(before);
      // And with the account's one repo slot held by the first item, the second still waits for exactly the same reason.
      await admin.query("UPDATE work_items SET stage = 'in_progress' WHERE id = $1", [A.workItemId]);
      const held = await decide();
      expect(held).toMatchObject({ granted: false });
      await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1 AND role = 'plane_publish'", [A.accountId]);
      expect(await decide()).toEqual(held);
    });
  });
});

describe("through the Worker surface [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  const build = (planePublish?: NonNullable<Parameters<typeof buildWorker>[0]["ports"]["planePublish"]>) =>
    buildWorker({
      env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
      vercel: { teamId: "team_1", projectId: "prj_1", getToken: async () => "tok" },
      ports: { decryptTenantKey: async () => "k", modelConnection: createFakeModelConnectionPort(), connectionStatus: { markBroken: async () => {}, markCreditsExhausted: async () => {} }, hooks: { resume: async () => {} }, ...(planePublish ? { planePublish } : {}) },
      sdk: createReaperSdkFake().sdk,
      createPools: async () => ({ runnerPool: writerPool, platformOpsPool: writerPool, receiptPool: writerPool, close: async () => undefined }),
    });

  it("a worker built without the publish ports answers not_configured and starts nothing", async () => {
    const worker = await build();
    const a = await seedAccount(admin, randomUUID());
    expect(await worker.publishPairedChange({ accountId: a.accountId, executorRunId: randomUUID() })).toEqual({ kind: "not_configured" });
    expect(await worker.retryPublish({ accountId: a.accountId, workItemId: a.workItemId })).toEqual({ kind: "not_configured" });
  });

  it("a worker with the ports calls the step: an unpaired item is skipped with no run row, the sandbox port untouched", async () => {
    let asked = 0;
    const worker = await build({
      hook: () => "x",
      identity: () => ({ name: "B", email: "b@example.com" }),
      privateHead: async () => (asked++, null),
      hosted: { verifyPushed: async () => (asked++, false), verifyPullRequest: async () => (asked++, null), openPullRequest: async () => (asked++, Promise.reject(new Error("unused"))) },
    });
    const a = await seedAccount(admin, randomUUID());
    const run = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, dispatch_repo_id) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4)`, [run, a.accountId, a.workItemId, a.repoId]);
    expect(await worker.publishPairedChange({ accountId: a.accountId, executorRunId: run })).toEqual({ kind: "skipped", why: "not_paired" });
    expect(await worker.retryPublish({ accountId: a.accountId, workItemId: a.workItemId })).toEqual({ kind: "skipped", why: "not_paired" });
    expect(asked).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE account_id = $1 AND role = 'plane_publish'", [a.accountId])).rows[0].n).toBe(0);
  });
});
