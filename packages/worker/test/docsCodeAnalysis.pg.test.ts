import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CLAUDE_CLI_VERSION, CLONE_PINNED_SCRIPT, DISCOVERY_ANALYST_ROLE, VERIFIER_WORKDIR, createTestConnectionStatusPort, type SdkCommand, type SdkSandbox, type VercelSandboxSdk } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { queueAnalysis } from "@fx/db/src/discoveryAnalyses.js";
import { analysisSettings, discoverySettings, resetPlanDataCache, type AnalysisSettings } from "@fx/plan-data";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { overRepoDailyUsd } from "../../core/src/plan/proposalVerifyLimits.js";
import { buildAnalystPrompt } from "../../pipeline/src/discovery/analystPrompt.js";
import { parseAnalystOutput } from "../../pipeline/src/discovery/analystOutput.js";
import { buildVerifierPrompt } from "../../pipeline/src/discovery/verifierPrompt.js";
import { recordFromOutput } from "../../pipeline/src/discovery/verifierResult.js";
import { createFakeModelConnectionPort } from "../../runner/test/helpers/sandboxTargetFakes.js";
import { buildWorker, type Worker } from "../src/compositionRoot.js";
import { createDocsCodeAnalysisSweep, MAX_ANALYSIS_ATTEMPTS, type DocsCodeAnalysisCounts, type DocsCodeAnalysisDeps } from "../src/docsCodeAnalysis.js";
import { createDiscoverySchedule } from "../src/discoverySchedule.js";
import { createProposalVerifySweep } from "../src/proposalVerify.js";
import { createRunStarter } from "../src/starter.js";
import { seedPreviewTarget } from "./support/previewTarget.js";

/**
 * D#483 S4-f3 [pg]: the docs-and-code analysis pass end to end over the production pieces: the real seat resolver (purpose "analyse"), the production run
 * starter and the real SandboxTarget (the Vercel SDK fake plays the sandbox and prints the agent's final message with its envelope; no model is called), the
 * S4-f1 prompt and parser, and S4-f2's queue and merge. The SDK fake records every clone command and answers it with `cloneExit` (git's own code for a
 * commit it cannot fetch is 128), so a failed run is a real failed launch. Only the figures are test values.
 */
const SHA = "c".repeat(40);
const MOVED = "d".repeat(40);
const CANDIDATES = {
  candidates: [
    { kind: "docs", title: "Existing issue seven", summary: "The docs promise it.", refs: [], names_issue: 7 },
    { kind: "docs", title: "New idea one", summary: "Document the flag.", refs: [{ path: "docs/a.md", start_line: 3, end_line: 9 }] },
    { kind: "code", title: "New idea two", summary: "Handle the empty case.", refs: [{ path: "src/a.ts", start_line: 1, end_line: 2 }] },
  ],
};
const PER_RUN = 1.3;

let envelope: unknown = CANDIDATES;
let cloneExit = 0;
let head = SHA;
let markerPresent = false;
const writes: Array<{ path: string; content: string }> = [];
const clones: string[][] = [];
const finalLine = (): string =>
  `${JSON.stringify({ type: "result", is_error: false, result: `Done.\n<!-- AGENT_OUTPUT -->\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\`\n<!-- /AGENT_OUTPUT -->`, session_id: "cc-1", total_cost_usd: 0.1, usage: { input_tokens: 100, output_tokens: 20 } })}\n`;

function sdkFake(): VercelSandboxSdk {
  const sandbox = (name: string): SdkSandbox => ({
    name,
    status: "running",
    currentSession: () => ({ sessionId: "sess-1" }),
    async runCommand(params): Promise<SdkCommand> {
      const isClone = params.cmd === "sh" && params.args?.[0] === "-c" && params.args?.[2] === "fx-clone";
      if (isClone) clones.push([...(params.args ?? [])]);
      const out = params.args?.[2] === "fx-pin" ? `${CLAUDE_CLI_VERSION}\n` : params.cmd === "sh" && params.args?.[0] === "-c" && String(params.args?.[1]).includes("proc") ? "12.5 3000 4096\n" : params.args?.includes("fx-agent") ? finalLine() : "";
      return {
        async *logs() {
          if (out) yield { stream: "stdout", data: out };
        },
        wait: async () => ({ exitCode: isClone ? cloneExit : 0 }),
        kill: async () => undefined,
      };
    },
    writeFiles: async (files) => void writes.push(...files.map((f) => ({ path: f.path, content: Buffer.from(f.content).toString("utf8") }))),
    updateNetworkPolicy: async () => undefined,
    extendTimeout: async () => undefined,
    stop: async () => undefined,
    delete: async () => undefined,
    listSessions: async () => ({ sessions: [{ id: "sess-1", memory: 4096, region: "iad1", duration: 60_000, activeCpuDurationMs: 10_000, networkTransfer: { ingress: 5, egress: 100 } }], pagination: { next: null } }),
  });
  return { create: async (p) => sandbox(p.name), get: async (p) => sandbox(p.name) };
}

describe("the docs-and-code analysis pass [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let worker: Worker;
  let settings: () => AnalysisSettings = () => ({ on: true, perRepoDailyUsd: 5.3, analysisPerRunUsd: PER_RUN });
  /** The analyses a pass may look at (the database is shared by every test here), or every one when null. */
  let only: string[] | null = null;
  /** Rows handed to the pass as they are, for a repository the real lister leaves out (disconnected, or not a sandbox one). */
  let forced: Array<{ account_id: string; analysis_id: string }> | null = null;
  let sweep: () => Promise<DocsCodeAnalysisCounts>;
  /** The production deps of `sweep`, for a test that needs its own clock or the default lister. */
  let deps: DocsCodeAnalysisDeps;
  let verify: () => Promise<unknown>;
  let spentN = 900;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    worker = await buildWorker({
      env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
      vercel: { teamId: "team_1", projectId: "prj_1", getToken: async () => "tok" },
      ports: { decryptTenantKey: async () => "fake-key", modelConnection: createFakeModelConnectionPort(), connectionStatus: createTestConnectionStatusPort(), hooks: { resume: async () => undefined }, follow: async () => undefined },
      sdk: sdkFake(),
      lookup: async () => [{ address: "140.82.112.3", family: 4 }],
      createPools: async () => ({ runnerPool: writerPool, platformOpsPool: adminPool, receiptPool: adminPool, close: async () => undefined }),
    });
    const starter = createRunStarter({ pool: writerPool, registry: worker.registry, follow: async () => undefined, queued: "refuse" });
    const github = () => ({ headSha: async () => head, readFile: async (path: string) => (markerPresent && path === ".autonomous-team/project.json" ? "{}" : null) });
    deps = {
      pool: writerPool,
      resolveSeat: worker.resolveRunSeat,
      starter,
      github,
      settings: () => settings(),
      prompt: buildAnalystPrompt,
      parse: parseAnalystOutput,
      list: async () => forced ?? (await writerPool.query<{ account_id: string; analysis_id: string }>("SELECT account_id, analysis_id FROM discovery_analysis_list_due(200)")).rows.filter((r) => only === null || only.includes(r.analysis_id)),
    };
    sweep = createDocsCodeAnalysisSweep(deps);
    verify = createProposalVerifySweep({
      pool: writerPool,
      resolveSeat: worker.resolveRunSeat,
      starter,
      github,
      settings: () => ({ on: true, perRepoDailyUsd: 50, verifyPerProposalUsd: 0.4, externalVerifiesPerRepoPerDay: 7 }),
      prompt: buildVerifierPrompt,
      record: recordFromOutput,
    });
  });
  afterAll(async () => {
    await worker.close();
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  afterEach(() => {
    envelope = CANDIDATES;
    cloneExit = 0;
    head = SHA;
    markerPresent = false;
    forced = null;
    only = null;
    settings = () => ({ on: true, perRepoDailyUsd: 5.3, analysisPerRunUsd: PER_RUN });
  });

  async function target(): Promise<{ a: SeedRefs; repoId: string }> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE model_connections SET status = 'ok' WHERE account_id = $1", [a.accountId]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 500 WHERE id = $1", [a.accountId]);
    return { a, repoId: (await seedPreviewTarget(admin, a)).repoId };
  }
  async function queued(a: SeedRefs, repoId: string, sha = SHA): Promise<string> {
    return (await queueAnalysis(writerPool, a.accountId, repoId, sha))!.id;
  }
  async function pass(...ids: string[]): Promise<DocsCodeAnalysisCounts> {
    only = ids;
    forced = null;
    return sweep();
  }
  const row = async (id: string) => (await admin.query("SELECT state, skip_reason, attempts, run_id, counts FROM discovery_analyses WHERE id = $1", [id])).rows[0] as { state: string; skip_reason: string | null; attempts: number; run_id: string | null; counts: Record<string, number> | null };
  const runsOf = async (id: string) =>
    (await admin.query<{ id: string; role: string; status: string; head_sha: string | null; work_item_id: string | null; idempotency_key: string }>(
      `SELECT r.id, r.role, r.status, r.head_sha, r.work_item_id, k.idempotency_key FROM agent_run_idempotency_keys k JOIN agent_runs r ON r.id = k.run_id WHERE k.idempotency_key LIKE $1 ORDER BY r.created_at`,
      [`docs-code-analysis:${id}:%`],
    )).rows;
  /** Waits for every run of the analysis to end (the in-process target finalizes after the start returns). */
  async function ended(id: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const rs = await runsOf(id);
      if (rs.length > 0 && rs.every((r) => !["pending", "running"].includes(r.status))) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("analysis run did not end");
  }
  const reservations = async (accountId: string): Promise<number> => (await admin.query("SELECT count(*)::int AS n FROM spend_reservations WHERE account_id = $1", [accountId])).rows[0].n;
  const proposalsOf = async (repoId: string) => (await admin.query("SELECT title, state, verification, provenance, owner_process, sources, analysis_refs, dedupe_key FROM proposals WHERE repo_id = $1 ORDER BY title", [repoId])).rows;
  const tableCount = async (table: string, accountId: string): Promise<number> => Number((await admin.query(`SELECT count(*) FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].count);
  /** A verifier run of the repository started today holding `usd` in the ledger (its proposal is internal-loop, so no pass lists it). */
  async function verifierSpend(a: SeedRefs, repoId: string, usd: number): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, provenance, owner_process) VALUES ($1, $2, $3, '{github_issue}', $4, 'spent', 'internal', 'internal_loop') RETURNING id`,
      [a.accountId, repoId, `gh:issue:${++spentN}`, spentN],
    );
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, ended_at) VALUES ($1, $2, 'proposal-verifier', 'local', 'succeeded', now())`, [runId, a.accountId]);
    const { rows: key } = await admin.query<{ idempotency_key: string }>(
      `INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4) RETURNING idempotency_key`,
      [a.accountId, `proposal-verify:${rows[0]!.id}:aaaaaaaa:0`, runId, "d".repeat(64)],
    );
    await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model')`, [a.accountId, usd, runId]);
    return key[0]!.idempotency_key;
  }

  it("C25-f3-1, C25-f3-2: a queued analysis starts one analyst run on the pinned sha, merges what it proposes, and the next verifier pass reads the new rows' refs as fenced source lines; no work item, action request or start is written and no proposal leaves new", async () => {
    const { a, repoId } = await target();
    await admin.query(`INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, provenance, owner_process) VALUES ($1, $2, 'gh:issue:7', '{github_issue}', 7, 'Issue seven', 'external', 'product')`, [a.accountId, repoId]);
    const id = await queued(a, repoId);
    const before = await Promise.all(["work_items", "run_action_requests", "start_gate"].map((t) => tableCount(t, a.accountId)));

    writes.length = 0;
    clones.length = 0;
    expect((await pass(id)).started).toBe(1);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ role: DISCOVERY_ANALYST_ROLE, head_sha: SHA, work_item_id: null, idempotency_key: `docs-code-analysis:${id}:1` });
    expect(await row(id)).toMatchObject({ state: "running", attempts: 1, run_id: run!.id });
    // The prompt is the analyst's, it names the pinned commit and lists the repository's existing proposal behind the fence.
    const prompt = writes.find((w) => w.path.startsWith("/tmp/fx-prompt-"))!.content;
    expect(prompt).toContain(SHA);
    expect(prompt).toContain("EXISTING PROPOSAL");
    // The reservation is the analysis figure, and the checkout is the pinned commit (the pinned clone script, with the row's sha as its own argument).
    const reserved = await admin.query("SELECT usd_reserved::float AS usd FROM spend_reservations WHERE run_id = $1 AND budget = 'model'", [run!.id]);
    expect(reserved.rows).toEqual([{ usd: PER_RUN }]);
    expect(clones.length).toBeGreaterThan(0);
    for (const c of clones) expect(c).toEqual(["-c", CLONE_PINNED_SCRIPT, "fx-clone", expect.stringMatching(/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/), VERIFIER_WORKDIR, expect.any(String), SHA]);

    await ended(id);
    expect((await pass(id)).recorded).toBe(1);
    expect(await row(id)).toMatchObject({ state: "succeeded", skip_reason: null, attempts: 1, counts: { merged_issue: 1, merged_duplicate: 0, merged_title: 0, created: 2, named_item_not_in_inbox: 0, candidates: 3 } });
    const rows = await proposalsOf(repoId);
    expect(rows.map((r) => r.title)).toEqual(["Issue seven", "New idea one", "New idea two"]);
    expect(rows.find((r) => r.title === "Issue seven")!.sources).toEqual(["github_issue", "docs"]);
    for (const t of ["New idea one", "New idea two"]) expect(rows.find((r) => r.title === t)).toMatchObject({ state: "new", verification: "pending", provenance: "internal", owner_process: "product" });
    expect(rows.find((r) => r.title === "New idea one")!.analysis_refs).toEqual(["docs/a.md:3-9"]);
    // R-597-1: the analyst only proposed.
    expect(await Promise.all(["work_items", "run_action_requests", "start_gate"].map((t) => tableCount(t, a.accountId)))).toEqual(before);
    expect(rows.every((r) => r.state === "new")).toBe(true);
    // A further pass starts nothing: the head already has its analysis.
    expect(await pass(id)).toMatchObject({ listed: 0, started: 0 });
    expect(await runsOf(id)).toHaveLength(1);

    // The verifier lists the two new rows, and its prompt carries their refs as fenced source lines.
    writes.length = 0;
    envelope = { category: "bug", claims: [] };
    await verify();
    const prompts = writes.filter((w) => w.path.startsWith("/tmp/fx-prompt-")).map((w) => w.content);
    const oneIdea = prompts.find((p) => p.includes("New idea one"))!;
    expect(oneIdea).toContain("SOURCE 1:");
    expect(oneIdea).toContain("docs/a.md:3-9");
    expect(prompts.find((p) => p.includes("New idea two"))).toContain("src/a.ts:1-2");
  });

  it("an engine-loop repository's new rows are owned by its loop, as discovery does", async () => {
    const { a, repoId } = await target();
    markerPresent = true;
    const id = await queued(a, repoId);
    await pass(id);
    await ended(id);
    await pass(id);
    expect((await proposalsOf(repoId)).filter((r) => r.dedupe_key.startsWith("src:")).map((r) => r.owner_process)).toEqual(["internal_loop", "internal_loop"]);
  });

  it("C25-f3-3: an output the parser rejects ends the analysis failed (output_rejected) after its attempt and writes nothing to proposals", async () => {
    const { a, repoId } = await target();
    envelope = { candidates: CANDIDATES.candidates.slice(0, 2), claims: [] };
    const id = await queued(a, repoId);
    await pass(id);
    await ended(id);
    expect((await pass(id)).failed).toBe(1);
    expect(await row(id)).toMatchObject({ state: "failed", skip_reason: "output_rejected", attempts: 1 });
    expect(await proposalsOf(repoId)).toEqual([]);
    expect(await runsOf(id)).toHaveLength(1);
  });

  it("C25-f3-4: a failed run counts an attempt on a new key, and the third failure is the last", async () => {
    const { a, repoId } = await target();
    cloneExit = 128;
    const id = await queued(a, repoId);
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS + 2; i++) {
      await pass(id);
      if ((await runsOf(id)).length > 0) await ended(id);
      await pass(id);
    }
    const runs = await runsOf(id);
    expect(runs.map((r) => r.idempotency_key)).toEqual([1, 2, 3].map((n) => `docs-code-analysis:${id}:${n}`));
    expect(runs.every((r) => r.status === "failed")).toBe(true);
    expect(await row(id)).toMatchObject({ state: "failed", skip_reason: "run_failed", attempts: MAX_ANALYSIS_ATTEMPTS });
    expect(await proposalsOf(repoId)).toEqual([]);
  });

  it("a seat that refuses (no model budget) counts an attempt each pass and the third ends the analysis with the seat's code; no run is made", async () => {
    const { a, repoId } = await target();
    await admin.query("UPDATE accounts SET model_budget_usd_month = 0 WHERE id = $1", [a.accountId]);
    const id = await queued(a, repoId);
    expect(await row(id)).toMatchObject({ attempts: 0 });
    await pass(id);
    expect(await row(id)).toMatchObject({ state: "queued", attempts: 1 });
    await pass(id);
    await pass(id);
    const end = await row(id);
    expect(end).toMatchObject({ state: "failed", attempts: MAX_ANALYSIS_ATTEMPTS });
    expect(end.skip_reason).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(await runsOf(id)).toEqual([]);
    expect(await pass(id)).toMatchObject({ listed: 0 });
  });

  it("C25-f3-5: a head that moved since queueing ends the analysis skipped (head_moved) and starts no run", async () => {
    const { a, repoId } = await target();
    const id = await queued(a, repoId);
    head = MOVED;
    expect((await pass(id)).skipped).toBe(1);
    expect(await row(id)).toMatchObject({ state: "skipped", skip_reason: "head_moved", attempts: 0 });
    expect(await runsOf(id)).toEqual([]);
  });

  it("C25-f3-6: each skip reason is recorded for its repository and nothing is started or reserved; a repository disconnected while its run goes gets that result discarded", async () => {
    const cases: Array<[string, (a: SeedRefs, repoId: string) => Promise<void>]> = [
      ["repo_not_connected", async (_a, repoId) => void (await admin.query("UPDATE repos SET installation_id = NULL WHERE id = $1", [repoId]))],
      ["discovery_off", async (a, repoId) => void (await admin.query(`INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'off', 1, $3)`, [a.accountId, repoId, a.userId]))],
      ["free_preview", async (a) => void (await admin.query("UPDATE accounts SET stripe_customer_id = NULL WHERE id = $1", [a.accountId]))],
      ["account_not_active", async (a) => void (await admin.query("UPDATE accounts SET owner_paused_at = now() WHERE id = $1", [a.accountId]))],
    ];
    for (const [reason, change] of cases) {
      const { a, repoId } = await target();
      const id = await queued(a, repoId);
      const reservedBefore = await reservations(a.accountId);
      await change(a, repoId);
      forced = [{ account_id: a.accountId, analysis_id: id }];
      expect((await sweep()).skipped, reason).toBe(1);
      expect(await row(id), reason).toMatchObject({ state: "skipped", skip_reason: reason, attempts: 0 });
      expect(await runsOf(id), reason).toEqual([]);
      expect(await reservations(a.accountId), reason).toBe(reservedBefore);
    }
    // Disconnected mid-run: the run finishes, the pass looks again, and nothing is merged.
    const { a, repoId } = await target();
    const id = await queued(a, repoId);
    await pass(id);
    await ended(id);
    await admin.query("UPDATE repos SET installation_id = NULL WHERE id = $1", [repoId]);
    forced = [{ account_id: a.accountId, analysis_id: id }];
    await sweep();
    expect(await row(id)).toMatchObject({ state: "skipped", skip_reason: "repo_not_connected" });
    expect(await proposalsOf(repoId)).toEqual([]);
    // Switched off while its run goes: the pass's own look discards the result (the merge writer only guards the connection).
    const off = await target();
    const offId = await queued(off.a, off.repoId);
    await pass(offId);
    await ended(offId);
    await admin.query(`INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'off', 1, $3)`, [off.a.accountId, off.repoId, off.a.userId]);
    await pass(offId);
    expect(await row(offId)).toMatchObject({ state: "skipped", skip_reason: "discovery_off" });
    expect(await proposalsOf(off.repoId)).toEqual([]);
  });

  it("C25-f3-7: without the analysis figure the pass reports analysis_unconfigured and starts nothing, and the verifier pass still verifies on the same plan data", async () => {
    const saved = process.env.FX_PLAN_DATA;
    try {
      const base = JSON.parse(process.env.FX_PLAN_DATA!);
      process.env.FX_PLAN_DATA = JSON.stringify({ ...base, discovery: { perRepoDailyUsd: 41, verifyPerProposalUsd: 0.4, externalVerifiesPerRepoPerDay: 7 } });
      resetPlanDataCache();
      settings = analysisSettings;
      const { a, repoId } = await target();
      const id = await queued(a, repoId);
      expect(await pass(id)).toMatchObject({ idle: "analysis_unconfigured", listed: 0, started: 0 });
      expect(await runsOf(id)).toEqual([]);
      expect(await row(id)).toMatchObject({ state: "queued", attempts: 0 });
      // The verifier reads the same data through its own reader and runs.
      await admin.query(`INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, provenance, owner_process) VALUES ($1, $2, 'gh:issue:5', '{github_issue}', 5, 'Check me', 'internal', 'product')`, [a.accountId, repoId]);
      const verifier = createProposalVerifySweep({
        pool: writerPool,
        resolveSeat: worker.resolveRunSeat,
        starter: createRunStarter({ pool: writerPool, registry: worker.registry, follow: async () => undefined, queued: "refuse" }),
        github: () => ({ headSha: async () => SHA, readFile: async () => null }),
        settings: discoverySettings,
        prompt: buildVerifierPrompt,
        record: recordFromOutput,
      });
      const counts = await verifier();
      expect(counts.idle).toBeUndefined();
      expect(counts.listed).toBeGreaterThan(0);
      expect(counts.started + counts.recorded).toBeGreaterThan(0);
    } finally {
      if (saved !== undefined) process.env.FX_PLAN_DATA = saved;
      resetPlanDataCache();
    }
  });

  it("C25-f3-8 (S4-f4 widened the lister; C27-f3f-2 ends Local-only): a runner_verified repository's analysis is listed and this pass (no runner starter wired) starts nothing for it; a runner_local one is listed and ends skipped (repo_runs_locally) with no run", async () => {
    for (const mode of ["runner_verified", "runner_local"]) {
      const { a, repoId } = await target();
      const id = await queued(a, repoId);
      await admin.query("UPDATE repos SET execution_mode = $2 WHERE id = $1", [repoId, mode]);
      expect((await writerPool.query("SELECT analysis_id FROM discovery_analysis_list_due(200)")).rows.map((r) => r.analysis_id), mode).toContain(id);
      await pass(id);
      expect(await runsOf(id), mode).toEqual([]);
      if (mode === "runner_verified") expect(await row(id), mode).toMatchObject({ state: "queued", attempts: 0, skip_reason: null });
      else expect(await row(id), mode).toMatchObject({ state: "skipped", attempts: 0, skip_reason: "repo_runs_locally" });
    }
  });

  it("C27-f3f-1: a queued analysis whose repository is then disconnected (or moved off team) is listed by the real lister on the next pass and ends skipped with that reason; no run is started, nothing is reserved and no head is read", async () => {
    const cases: Array<[string, string]> = [
      ["repo_not_connected", "UPDATE repos SET installation_id = NULL WHERE id = $1"],
      ["repo_not_team", "UPDATE repos SET product = 'sitekit' WHERE id = $1"],
    ];
    for (const [reason, change] of cases) {
      const { a, repoId } = await target();
      const id = await queued(a, repoId);
      const reservedBefore = await reservations(a.accountId);
      await admin.query(change, [repoId]);
      head = MOVED; // a head read would end it head_moved instead
      expect(await pass(id), reason).toMatchObject({ listed: 1, skipped: 1, started: 0 });
      expect(await row(id), reason).toMatchObject({ state: "skipped", skip_reason: reason, attempts: 0, run_id: null });
      expect(await runsOf(id), reason).toEqual([]);
      expect(await reservations(a.accountId), reason).toBe(reservedBefore);
      expect(await pass(id), reason).toMatchObject({ listed: 0 });
      head = SHA;
    }
  });

  it("C27-f3f-2: a queued analysis on a repository switched to runner_local ends skipped (repo_runs_locally) with no run; switched back, a new head queues a fresh analysis through the sweep, and the pass starts it", async () => {
    const { a, repoId } = await target();
    const id = await queued(a, repoId);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [repoId]);
    expect(await pass(id)).toMatchObject({ listed: 1, skipped: 1, started: 0 });
    expect(await row(id)).toMatchObject({ state: "skipped", skip_reason: "repo_runs_locally", attempts: 0 });
    expect(await runsOf(id)).toEqual([]);

    await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [repoId]);
    head = MOVED;
    // The real sweep lister, narrowed to this repository (the database is shared).
    const schedule = createDiscoverySchedule({
      pool: writerPool,
      openSource: () => ({ head: async () => ({ defaultBranch: "main", sha: head }), file: async () => null, recentOpen: async () => ({ items: [] }) }),
      settings: () => settings(),
      list: async (after, limit) => {
        let cur = after;
        for (;;) {
          const { rows } = await writerPool.query<{ account_id: string; repo_id: string; period_ref: string }>("SELECT * FROM discovery_sweep_list_due($1, $2, $3)", [limit, cur?.accountId ?? null, cur?.repoId ?? null]);
          const own = rows.filter((r) => r.repo_id === repoId);
          if (own.length > 0 || rows.length < limit) return own;
          cur = { accountId: rows[rows.length - 1]!.account_id, repoId: rows[rows.length - 1]!.repo_id };
        }
      },
    });
    expect(await schedule()).toMatchObject({ analyses: 1, errors: 0 });
    const fresh = (await admin.query<{ id: string; state: string; head_sha: string }>("SELECT id, state, head_sha FROM discovery_analyses WHERE repo_id = $1 AND id <> $2", [repoId, id])).rows;
    expect(fresh).toEqual([{ id: expect.any(String), state: "queued", head_sha: MOVED }]);
    expect(await row(id)).toMatchObject({ state: "skipped", skip_reason: "repo_runs_locally" });
    expect((await pass(fresh[0]!.id)).started).toBe(1);
    await ended(fresh[0]!.id);
  });

  it("C27-f3f-3: a launch that fails three times uses one attempt per pass on a test clock (attempts 1, then 2, then the analysis ends failed with the run's code), and the pass between attempts keeps the code as the hold reason", async () => {
    let clock = Date.parse("2026-11-02T12:00:00Z");
    const timed = createDocsCodeAnalysisSweep({ ...deps, now: () => clock });
    const { a, repoId } = await target();
    cloneExit = 128;
    const id = await queued(a, repoId);
    for (let n = 1; n <= MAX_ANALYSIS_ATTEMPTS; n++) {
      only = [id];
      const counts = await timed();
      // The clock never moves inside a pass, so its budget is not what stopped it: the failed launch was answered and the next attempt left for a later pass.
      expect(counts, `pass ${n}`).toMatchObject({ listed: 1, failed: 1, started: 0 });
      const runs = await runsOf(id);
      expect(runs.map((r) => r.idempotency_key), `pass ${n}`).toEqual(Array.from({ length: n }, (_, i) => `docs-code-analysis:${id}:${i + 1}`));
      expect(runs.every((r) => r.status === "failed"), `pass ${n}`).toBe(true);
      if (n < MAX_ANALYSIS_ATTEMPTS) expect(await row(id), `pass ${n}`).toMatchObject({ state: "running", attempts: n, run_id: null, skip_reason: "run_failed" });
      clock += 15 * 60_000;
    }
    expect(await row(id)).toMatchObject({ state: "failed", skip_reason: "run_failed", attempts: MAX_ANALYSIS_ATTEMPTS });
    only = [id];
    expect(await timed()).toMatchObject({ listed: 0 });
    expect(await runsOf(id)).toHaveLength(MAX_ANALYSIS_ATTEMPTS);
  });

  it("S4f-5 (second half): verifier spend and the analyst's reservation share perRepoDailyUsd; a held analysis stays queued with daily_cap and nothing reserved, and starts the next UTC day", async () => {
    settings = () => ({ on: true, perRepoDailyUsd: 2.6, analysisPerRunUsd: PER_RUN });
    // 1.7 of verifier spend today plus the 1.3 reservation is past 2.6: held.
    const { a, repoId } = await target();
    const key = await verifierSpend(a, repoId, 1.7);
    const id = await queued(a, repoId);
    const reservedBefore = await reservations(a.accountId);
    expect((await pass(id)).daily_cap).toBe(1);
    expect(await row(id)).toMatchObject({ state: "queued", skip_reason: "daily_cap", attempts: 0 });
    expect(await runsOf(id)).toEqual([]);
    expect(await reservations(a.accountId)).toBe(reservedBefore);
    // The next UTC day (the clock is the database's, so the verifier's run is moved to yesterday): it starts and reserves the figure.
    await admin.query("UPDATE agent_run_idempotency_keys SET created_at = now() - interval '1 day' WHERE account_id = $1 AND idempotency_key = $2", [a.accountId, key]);
    expect((await pass(id)).started).toBe(1);
    const [run] = await runsOf(id);
    expect((await admin.query("SELECT usd_reserved::float AS usd FROM spend_reservations WHERE run_id = $1 AND budget = 'model'", [run!.id])).rows).toEqual([{ usd: PER_RUN }]);
    expect(await row(id)).toMatchObject({ state: "running", skip_reason: null });

    // The same counter the other way: the analyst's open reservations (its model figure and the run's compute estimate, 1.444 together) count against a
    // verifier run's day, as the verifier's own do.
    expect(await overRepoDailyUsd(admin, a.accountId, repoId, 0.4, 1.8)).toBe(true);
    expect(await overRepoDailyUsd(admin, a.accountId, repoId, 0.4, 1.9)).toBe(false);
    // And a repository's other tenants are not counted.
    const other = await target();
    expect(await overRepoDailyUsd(admin, other.a.accountId, other.repoId, 0.4, 1.8)).toBe(false);
    await ended(id);
  });

  it("C27-f3f-4: the default lister branch (no deps.list) lists exactly the due rows of two accounts, at most 5 of one account per pass, oldest first; the lister refuses a platform_ops login and a bad limit", async () => {
    // The database is shared: every other waiting analysis is ended first, so the default branch's list is this test's alone.
    await admin.query("UPDATE discovery_analyses SET state = 'skipped', skip_reason = 'test_cleared', finished_at = now() WHERE state IN ('queued', 'running')");
    const rest: DocsCodeAnalysisDeps = { ...deps };
    delete rest.list;
    const unlisted = createDocsCodeAnalysisSweep(rest);
    const A = await target();
    const B = await target();
    const shaOf = (n: number): string => n.toString(16).padStart(40, "0");
    const aIds: string[] = [];
    for (let n = 1; n <= 6; n++) aIds.push(await queued(A.a, A.repoId, shaOf(n)));
    const bIds = [await queued(B.a, B.repoId, shaOf(7)), await queued(B.a, B.repoId, shaOf(8))];
    // An ended analysis and a deleted account's analysis are not due.
    const C = await target();
    const gone = await queued(C.a, C.repoId, shaOf(9));
    await admin.query("UPDATE accounts SET deleted_at = now() WHERE id = $1", [C.a.accountId]);
    // No listed analysis matches the head, so each one the pass is handed ends head_moved and starts nothing: what ended is exactly what was listed.
    head = MOVED;
    expect(await unlisted()).toMatchObject({ listed: 7, skipped: 7, started: 0 });
    const states = async (ids: string[]) => (await admin.query<{ id: string; state: string; skip_reason: string | null }>("SELECT id, state, skip_reason FROM discovery_analyses WHERE id = ANY($1::uuid[])", [ids])).rows;
    const ended7 = await states([...aIds.slice(0, 5), ...bIds]);
    expect(ended7).toHaveLength(7);
    for (const r of ended7) expect(r).toMatchObject({ state: "skipped", skip_reason: "head_moved" });
    expect(await states([aIds[5]!, gone])).toEqual(expect.arrayContaining([{ id: aIds[5], state: "queued", skip_reason: null }, { id: gone, state: "queued", skip_reason: null }]));
    // The sixth of account A is listed on the next pass.
    expect(await unlisted()).toMatchObject({ listed: 1, skipped: 1 });
    await admin.query("UPDATE accounts SET deleted_at = NULL WHERE id = $1", [C.a.accountId]);

    const ops = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(ops.query("SELECT * FROM discovery_analysis_list_due(5)")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await ops.end();
    }
    for (const bad of ["0", "201", "NULL"]) await expect(writerPool.query(`SELECT * FROM discovery_analysis_list_due(${bad})`), bad).rejects.toMatchObject({ code: "22023" });
  });
});
