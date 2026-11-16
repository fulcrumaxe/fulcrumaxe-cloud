import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOY_VERIFIER_ROLE } from "@fulcrumaxe/runner-protocol";
import type { StartAgentRunInput } from "@fx/runner";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { SeedRefs } from "@fx/db/test/helpers/seed.js";
import { placeDeployOrder } from "@fx/core/src/verify/orders.js";
import { openVerifyRow, readVerifyRow, startDeploying, type VerifyRow } from "@fx/core/src/verify/rows.js";
import { readVerifyAttempt } from "@fx/core/src/work-items/verifyDetail.js";
import { buildVerifyPrompt } from "../../../pipeline/src/verify/prompt.js";
import { outcomeFromAnswer } from "../../../pipeline/src/verify/rules.js";
import type { RunStarter } from "../../src/preview.js";
import type { SeatResult } from "../../src/seat.js";
import { createVerifyRun, type VerifyRunDeps } from "../../src/verifyRun.js";
import { createWorld, type World } from "./world.js";

/**
 * PIPELINE-SCENARIO-HARNESS, scenario 6 [pg]: the post-merge verify of a Spec with two view-only filter criteria and one persisted one. A view-only criterion (a filter that
 * changes what is shown and saves nothing) is judged without a reload, because a reload resets it on purpose; a persisted one still needs the reload step.
 *
 * The path is the product's own end to end: the Spec text is classified when the row opens (`openVerifyRow`, `classifyPersistence`), the tester's prompt names the view-only journeys,
 * the stage's `ready` starts the job and `settle` reads the finished run through the pipeline's answer rules into the row and the card's detail. What a scenario writes by hand is the
 * fixture account and merged item, the strict starter (it refuses what the real one refuses) and the tester's own answer (the JSON it ends with).
 */
const sha = (c: string): string => c.repeat(40);
const RUN_USD = 1.25;

// The wording of the real criteria that exposed the gap (a Runs-app filter), and a plain persisted one.
const VIEW_ROLE = "[ui] Choosing `Build · Executor` in Role leaves only executor runs in the list, and pressing Show more adds older runs that are all executor runs too.";
const VIEW_EMPTY = "[ui] With a Role and Status combination that no run has, the list is replaced by the words `No runs match these filters.` and no Show more button is offered.";
const PERSISTED = "[ui] Saving the nickname keeps it after the page is opened again.";
const SPEC = `1. ${VIEW_ROLE}\n2. ${VIEW_EMPTY}\n3. ${PERSISTED}`;

class StrictStarter implements RunStarter {
  calls: StartAgentRunInput[] = [];
  constructor(private readonly admin: PoolClient) {}
  async start(input: StartAgentRunInput) {
    if (input.role !== DEPLOY_VERIFIER_ROLE) throw new Error("starter: wrong role");
    if (!/^verify-stage:[0-9a-f-]{36}$/.test(input.idempotency?.key ?? "")) throw new Error("starter: bad idempotency key");
    if (!/^[0-9a-f]{40}$/.test(input.cloneRepo?.sha ?? "") || input.headSha !== input.cloneRepo?.sha) throw new Error("starter: the checkout must be pinned to the head");
    if (input.workItemId != null) throw new Error("starter: the tester run is tied to no work item");
    this.calls.push(input);
    const runId = randomUUID();
    await this.admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, head_sha, job_signed) VALUES ($1, $2, $3, 'local', 'running', $4, $5::jsonb)`, [runId, input.accountId, input.role, input.headSha, JSON.stringify({ job: { role: input.role, browser_method: input.browserMethod } })]);
    await this.admin.query(`INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)`, [input.accountId, input.idempotency!.key, runId, input.idempotency!.requestHash]);
    return { runId };
  }
}

const seat = (repoId: string): SeatResult =>
  ({ ok: true, seat: { repoId, product: "team", roleCard: "card", model: "sonnet-5", capUsd: RUN_USD, timeoutMs: 600_000, limits: { maxRunMs: 600_000 }, maxExtensions: 0, spend: { purpose: "run", trigger: "foreground", estimateModelUsd: RUN_USD, estimateComputeUsd: 0, plan: "free", monthlyModelBudgetUsd: 10, perSpawnCapUsd: RUN_USD } } }) as unknown as SeatResult;

/** One journey of the tester's answer: what it did, the page fact that showed it, the undo check, and whether it reloaded. */
const answered = (id: string, reloaded: boolean) => ({ id, result: "pass", steps: [{ did: "chose the option and read the list", dom_fact: "every row shown is an executor run", number: 1 }], console_errors: 0, undo_checked: true, reloaded });

describe("scenario: verify a view-only filter criterion and a persisted one [pg]", { timeout: 120_000 }, () => {
  let w: World;
  let a: SeedRefs;
  let starter: StrictStarter;
  beforeAll(async () => {
    w = await createWorld();
    a = await w.account();
    starter = new StrictStarter(w.admin);
    await w.admin.query(`INSERT INTO verify_settings (repo_id, account_id, enabled, base_url, eligibility) VALUES ($1, $2, true, 'https://app.example', 'all')`, [a.repoId, a.accountId]);
  });
  afterAll(async () => {
    await w.close();
  });

  const tenant = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(w.writerPool, a.accountId, fn);
  const stage = () =>
    createVerifyRun({
      pool: w.writerPool,
      starter,
      resolveSeat: async (req) => seat(req.repoId),
      limits: () => ({ runUsd: RUN_USD, perRepoDailyUsd: 10 }),
      prompt: buildVerifyPrompt,
      outcome: outcomeFromAnswer,
    } satisfies VerifyRunDeps);

  /** A merged item with the Spec, its row opened and queued for deploy, and the stage's `ready` having started the tester job. */
  async function startedRow(pr: number, mergeSha: string): Promise<{ item: string; row: VerifyRow }> {
    const item = randomUUID();
    await w.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'merged')`, [item, a.accountId, a.repoId]);
    await w.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'merged_by_gate', 'merged', $3, $4, 'k')`, [a.accountId, item, mergeSha, pr]);
    await w.admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), 'agent')`, [a.accountId, item, SPEC]);
    const opened = await tenant((c) => openVerifyRow(c, a.accountId, { workItemId: item, prNumber: pr, mergeSha }));
    if (!opened.opened) throw new Error(`not opened: ${opened.reason}`);
    await tenant(async (c) => {
      await startDeploying(c, a.accountId, opened.rowId, true);
      await placeDeployOrder(c, a.accountId, { rowId: opened.rowId, repoId: a.repoId, mergeSha });
    });
    const ready = (await tenant((c) => readVerifyRow(c, a.accountId, opened.rowId)))!;
    expect(await stage().ready({ accountId: a.accountId, repoId: a.repoId, row: ready, deployedCommit: mergeSha })).toBe("started");
    return { item, row: (await tenant((c) => readVerifyRow(c, a.accountId, opened.rowId)))! };
  }
  /** The tester's job ends with `journeys` as its answer; the stage reads it. */
  async function testerAnswers(row: VerifyRow, journeys: unknown[]): Promise<void> {
    await w.admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = $2::jsonb, ended_at = now() WHERE id = $1`, [row.run_id, JSON.stringify({ journeys })]);
    expect(await stage().settle({ accountId: a.accountId, repoId: a.repoId, row })).toBe("settled");
  }

  it("the two filter criteria are held as view-only and the persisted one is not, and the tester's prompt says which", async () => {
    const { row } = await startedRow(31, sha("1"));
    expect(row.journeys.map((j) => [j.id, j.persistence ?? "persisted"])).toEqual([["c1", "view_only"], ["c2", "view_only"], ["c3", "persisted"]]);
    const prompt = starter.calls.at(-1)!.prompt;
    expect(prompt).toContain("JOURNEY c1 (criterion, view only):");
    expect(prompt).toContain("JOURNEY c2 (criterion, view only):");
    expect(prompt).toContain("JOURNEY c3 (criterion):");
  });

  it("filters judged without a reload and the saved change judged with one: the attempt ends verified, and the detail shows all three passed", async () => {
    const { item, row } = await startedRow(32, sha("2"));
    await testerAnswers(row, [answered("c1", false), answered("c2", false), answered("c3", true)]);
    const v = (await tenant((c) => readVerifyAttempt(c, item)))!;
    expect(v.status).toBe("verified");
    expect(v.journeys.map((j) => [j.id, j.status, j.evidence.reloaded])).toEqual([["c1", "passed", false], ["c2", "passed", false], ["c3", "passed", true]]);
  });

  it("the persisted criterion without its reload is not a pass: the attempt ends unverified (hollow_pass) while the filters stay passed", async () => {
    const { item, row } = await startedRow(33, sha("3"));
    await testerAnswers(row, [answered("c1", false), answered("c2", false), answered("c3", false)]);
    const v = (await tenant((c) => readVerifyAttempt(c, item)))!;
    expect(v).toMatchObject({ status: "unverified", reason: "hollow_pass" });
    expect(v.journeys.map((j) => [j.id, j.status])).toEqual([["c1", "passed"], ["c2", "passed"], ["c3", "unproven"]]);
  });

  it("a filter journey is not excused from its undo check", async () => {
    const { item, row } = await startedRow(34, sha("4"));
    await testerAnswers(row, [{ ...answered("c1", false), undo_checked: false }, answered("c2", false), answered("c3", true)]);
    const v = (await tenant((c) => readVerifyAttempt(c, item)))!;
    expect(v).toMatchObject({ status: "unverified", reason: "hollow_pass" });
    expect(v.journeys.map((j) => [j.id, j.status])).toEqual([["c1", "unproven"], ["c2", "passed"], ["c3", "passed"]]);
  });
});
