import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdvanceItem, AdvanceRunOutcome, AdvanceRunRequest, AdvanceStartArgs, AdvanceStepResult, StartGateStepInput, Worker } from "../src/index.js";
import type { IssueReadResult } from "@fx/github";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { readStartDecision } from "@fx/core/src/work-items/startDecision.js";
import { createAutoStartSweep } from "../src/autoStartSweep.js";
import { createStartGate } from "../src/startGateStep.js";

/**
 * [pg] D#483 S5-b1a-2 with the start gate in the stage driver: an item the auto-start sweep started, advanced by the REAL driver (`workItemAdvanceWorkflow`) with
 * the REAL start gate (`createStartGate`, `decideStart`, the 0913/0916 definers) over a real database, and only the agent steps faked. The request the dial files
 * stands in the name of the person who confirmed the weekly limit, but it is the dial's: triage, whatever it finds, must never record a PERSON start receipt in
 * that name, and the card must never say "Started by" them.
 */
vi.mock("workflow", () => ({ sleep: vi.fn(async () => undefined) }));
vi.mock("workflow/api", () => ({ resumeHook: vi.fn(), start: vi.fn() }));

// The web app's modules are loaded at run time (as advanceProposalIntake.pg does), so this package's typecheck never compiles apps/web and the guards that keep
// other packages out of the worker's internals stay clean. The shapes below are the parts of those modules this test uses.
let setWorkerWiringForTests: (w?: { provider: () => never; createWorker: () => Promise<Worker> }) => void;
let setIssueReaderForTests: (f?: (...a: unknown[]) => Promise<IssueReadResult>) => void;
let workItemAdvanceWorkflow: (a: AdvanceStartArgs) => Promise<{ status: string; detail?: string }>;

const LOGIN = "fx_dial_triage_test";
const ISSUE_NUMBER = 5100;

describe("an item the dial started, advanced by the real driver [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let n = 0;

  beforeAll(async () => {
    const web = (file: string) => fileURLToPath(new URL(`../../../apps/web/${file}`, import.meta.url));
    ({ setWorkerWiringForTests } = (await import(/* @vite-ignore */ web("lib/worker.ts"))) as { setWorkerWiringForTests: typeof setWorkerWiringForTests });
    ({ setIssueReaderForTests } = (await import(/* @vite-ignore */ web("lib/github/issueRead.ts"))) as { setIssueReaderForTests: typeof setIssueReaderForTests });
    ({ workItemAdvanceWorkflow } = (await import(/* @vite-ignore */ web("workflows/workItemAdvance.ts"))) as { workItemAdvanceWorkflow: typeof workItemAdvanceWorkflow });
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
  });
  afterAll(async () => {
    admin?.release();
    for (const p of [receiptPool, adminPool]) await p?.end();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setWorkerWiringForTests();
    setIssueReaderForTests();
  });
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  /** A dial-started item: a verified internal small proposal, a weekly limit, an announce dial for small, bug and doc; the sweep's own gate starts it. */
  async function dialStarted(): Promise<{ t: SeedRefs; item: string }> {
    const t = await seedAccount(admin, randomUUID());
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, NULL, 'weekly_autostart', 20, 1, $3)`, [randomUUID(), t.accountId, t.userId]);
    for (const kind of ["small", "bug", "doc"]) {
      await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, $3, 'announce', 'balanced', 1, $4)`, [t.accountId, t.repoId, `start_work_${kind}`, t.userId]);
    }
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, provenance, owner_process, category_hint) VALUES ($1, $2, $3, '{github_issue}', $4, 'Fix the typo', 'internal', 'product', 'small') RETURNING id`,
      [t.accountId, t.repoId, `gh:issue:${ISSUE_NUMBER + ++n}`, ISSUE_NUMBER + n],
    );
    await admin.query(`UPDATE proposals SET verification = 'verified', verified_at = now(), verified_run_id = $2 WHERE id = $1`, [rows[0]!.id, t.runId]);
    const sweep = createAutoStartSweep({ receiptPool, firstRunUsd: async () => 1, warn: () => {} });
    expect(await sweep.gateProposal(t.accountId, rows[0]!.id)).toBe("started");
    const item = (await admin.query("SELECT work_item_id FROM proposals WHERE id = $1", [rows[0]!.id])).rows[0].work_item_id as string;
    return { t, item };
  }

  /** The real driver, the real start gate, the agent steps faked. `root` is the item triage hands back (a second item for a feature, as the real triage makes). */
  function drive(t: SeedRefs, item: string, triage: { category: string; stage: string; root: string }) {
    const itemFacts: AdvanceItem = { stage: "triaged", provenance: "internal", repoId: t.repoId, ghNumber: 7, ghOwner: "acme", ghName: "widgets", hasDiscussion: false, kind: null, hasSpec: false, specVersion: null, executorRunId: null, executionMode: "sandbox", recordedPr: null };
    const outcome: AdvanceRunOutcome = { status: "succeeded", done: true, envelope: { category: triage.category } };
    const gate = createStartGate(receiptPool);
    const worker = {
      advanceLoadItem: vi.fn(async () => itemFacts),
      advanceStartRun: vi.fn(async (_req: AdvanceRunRequest) => ({ ok: true as const, runId: "run-1" })),
      advanceRunOutcome: vi.fn(async () => outcome),
      advanceTriage: vi.fn(async () => ({ status: "triaged", stage: triage.stage, workItemId: triage.root, category: triage.category })),
      advancePanel: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "completed", complete: true, missingRoles: [], round2Ran: false })),
      advanceSpec: vi.fn(async (..._args: unknown[]): Promise<AdvanceStepResult> => ({ status: "published", stage: "spec_ready", version: 1 })),
      advanceRecordEvent: vi.fn(async (..._args: unknown[]) => ({ recorded: true })),
      advanceStartGate: vi.fn((who: { accountId: string; userId: string; workItemId: string }, input: StartGateStepInput) => gate(who, input)),
      advanceLightSpec: vi.fn(async () => ({ status: "published", reason: null, version: 1 })),
      advanceCancel: vi.fn(async () => undefined),
      advanceBuild: vi.fn(async (..._args: unknown[]): Promise<AdvanceStepResult> => ({ status: "refused", reason: "no_model" })),
      advanceBuildFailed: vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "recorded", stage: "needs_human" })),
    };
    setWorkerWiringForTests({ provider: () => ({}) as never, createWorker: async () => worker as unknown as Worker });
    const issue: IssueReadResult = { status: "found", title: "T", body: "B", login: "owner-1", state: "open", labels: [] };
    setIssueReaderForTests(async () => issue);
    // What the stage driver is handed for the request the dial filed: not a person's click (see performAdvanceWorkItem).
    const args: AdvanceStartArgs = { accountId: t.accountId, userId: t.userId, workItemId: item, actionId: randomUUID(), haltEpoch: 0, personFiled: false, dialFiled: true };
    return { worker, run: () => workItemAdvanceWorkflow(args) };
  }

  const personReceipts = async (t: SeedRefs) => Number((await admin.query("SELECT count(*) n FROM decision_receipts WHERE account_id = $1 AND actor <> 'policy'", [t.accountId])).rows[0].n);
  const gateRows = async (t: SeedRefs) => (await admin.query("SELECT work_item_id, decision_type, outcome, decided_by FROM start_gate WHERE account_id = $1 ORDER BY decision_type", [t.accountId])).rows;
  const card = (t: SeedRefs, item: string) => withTenant(receiptPool, t.accountId, (c) => readStartDecision(c, item));

  it.each([["bug"], ["doc"]])("small -> %s at triage records a dial decision, never a person receipt; the card says started automatically", async (category) => {
    const { t, item } = await dialStarted();
    const { worker, run } = drive(t, item, { category, stage: "triaged", root: item });
    await run();
    // The driver asked the gate as unattended and told it which item the dial started; the kind it came in as is read from that item's own gate row, in the gate.
    expect(worker.advanceStartGate.mock.calls[0]![1]).toEqual({ mode: "triage_end", category, cameInAs: null, origin: "unattended", fromItemId: item });
    expect(await personReceipts(t)).toBe(0);
    expect(await gateRows(t)).toEqual([
      { work_item_id: item, decision_type: `start_work_${category}`, outcome: "started", decided_by: "policy" },
      { work_item_id: item, decision_type: "start_work_small", outcome: "started", decided_by: "policy" },
    ].sort((a, b) => a.decision_type.localeCompare(b.decision_type)));
    expect(await card(t, item)).toMatchObject({ state: "started", by: "dial", name: null });
    expect((await card(t, item))!.sentence).toMatch(/^Started automatically under your Balanced setting/);
    expect(worker.advanceLightSpec).toHaveBeenCalled();
  });

  it.each([["feature"], ["critical"]])("small -> %s at triage raises start_after_reclassify (class 3, always asked) and starts nothing more; no person receipt", async (category) => {
    const { t, item } = await dialStarted();
    const root = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'issue', 'internal', 'discussing')`, [root, t.accountId, t.repoId]);
    const { worker, run } = drive(t, item, { category, stage: "discussing", root });
    expect(await run()).toEqual({ status: "waiting", detail: "start_ask_open" });
    expect(worker.advanceStartGate.mock.calls[0]![1]).toMatchObject({ mode: "triage_end", category, cameInAs: null, origin: "unattended", fromItemId: item });
    expect(await personReceipts(t)).toBe(0);
    const rows = await gateRows(t);
    expect(rows).toContainEqual({ work_item_id: root, decision_type: "start_after_reclassify", outcome: "asked", decided_by: null });
    expect(rows.filter((r) => r.outcome === "started" && r.decided_by !== "policy")).toEqual([]);
    expect(worker.advancePanel).not.toHaveBeenCalled();
    expect((await card(t, root))!.sentence).toMatch(/^Waiting for an owner or admin to answer in Needs you: this item turned out larger/);
    // The original item's own card still says what the dial did.
    expect((await card(t, item))!.sentence).toMatch(/^Started automatically under your Balanced setting/);
  });

  it("a build of a dial-started item that ends at a limit and is continued stays the dial's: every gate call is unattended, and no person receipt is recorded", async () => {
    const { t, item } = await dialStarted();
    const { worker, run } = drive(t, item, { category: "bug", stage: "triaged", root: item });
    const limitEnd: AdvanceRunOutcome = { status: "timed_out", done: true, envelope: null, tailRunId: "run-b" };
    const child = "99999999-9999-4999-8999-000000000001";
    // The build starts as run-b, ends at the time limit, and the continuation step answers with a child that succeeds.
    (worker as unknown as Record<string, unknown>).advanceBuild = vi.fn(async (): Promise<AdvanceStepResult> => ({ status: "started", runId: "run-b", branch: "fx/issue-7" }));
    (worker as unknown as Record<string, unknown>).advanceContinue = vi.fn(async () => ({ code: "continued", runId: child, parkedAs: null }));
    (worker as unknown as Record<string, unknown>).advanceRunOutcome = vi.fn(async (_a: string, id: string): Promise<AdvanceRunOutcome> => (id === "run-b" ? limitEnd : { status: "succeeded", done: true, envelope: { category: "bug", summary: "Done." } }));
    await run().catch(() => null);
    const w = worker as unknown as { advanceContinue: ReturnType<typeof vi.fn>; advanceStartGate: ReturnType<typeof vi.fn> };
    expect(w.advanceContinue).toHaveBeenCalledWith({ accountId: t.accountId, userId: t.userId, workItemId: item, haltEpoch: 0 }, "run-b");
    // Only the triage gate asked, as unattended; the continuation asks nothing of the gate and files nothing in a person's name.
    expect(w.advanceStartGate.mock.calls.map((c) => (c[1] as StartGateStepInput).origin)).toEqual(["unattended"]);
    expect(await personReceipts(t)).toBe(0);
    expect((await gateRows(t)).filter((r) => r.outcome === "started" && r.decided_by !== "policy")).toEqual([]);
    expect((await card(t, item))!.sentence).toMatch(/^Started automatically under your Balanced setting/);
  });
});
