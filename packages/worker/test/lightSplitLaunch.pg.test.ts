import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createRecordingRunActionSignal } from "@fx/core/src/runActions/index.js";
import { SESSION_COOKIE_NAME, signSession } from "@fx/core/src/auth/session.js";
import type { ChildLaunchDeps } from "@fx/core/src/decisions/childLaunch.js";
import { childEnvelopeRoom, setWorkItemEnvelope, writeEnvelopeVersion } from "@fx/spend";
import { startBuildForItem } from "@fx/pipeline/testing/build";
import { readBuildWaitReason } from "@fx/pipeline";
import { publishLightSpec } from "../../pipeline/src/advance/lightSpec.js";
import type { AdvanceRunPorts } from "../../pipeline/src/advance/runPorts.js";
import { runTriageStep } from "../../pipeline/src/plan/step.js";
import { runSpecStep } from "../../pipeline/src/plan/spec.js";
import { FixtureRunner, FixtureWriter, OWNER, discussingItem, fixtureClassifier } from "../../pipeline/test/plan/helpers/panelFixtures.js";
import { handleApiRequest } from "../../api/src/handler.js";
import { ROUTES } from "../../api/src/routes/index.js";
import { runActionDeps } from "../../api/src/routes/run-actions.js";
import { createAdvanceModule, type AdvanceStartArgs } from "../src/advance.js";
import { createRunActionFacade } from "../src/runActions.js";
import { createStageResume } from "../src/stageResume.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { getWorkItemActivity } from "@fx/core/src/work-items/activity.js";
import { buildWaitSentence } from "@fx/api/src/routes/work-item-activity.js";
import { PARKED_STAGE_REGISTRY } from "@fx/pipeline";
import { createAutoStartSweep } from "../src/autoStartSweep.js";

/**
 * D#483 S5-b2b/S5-b2c [pg]: the whole path of a short Spec that plans two pull requests. The Spec is published by the real `publishLightSpec` through the worker's real
 * `advanceLightSpec`; the person's approval is the real `POST /work-items/{id}/approve` route; the children are launched by the real auto-start sweep through the real
 * `gateChildLaunch`. No run, approval, receipt or child row is inserted by hand. The parent's item envelope is attached the way a proposal's approval attaches it
 * (the real writer and the real definer, at Triaged, before any work); the dial setting is plain tenant configuration.
 */
const LOGIN = "fx_light_split_launch";
const PRICE = 1;

describe("a short Spec that plans two pull requests launches both children after the person's approval [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let receiptPool: Pool;
  const signal = createRecordingRunActionSignal();
  let nextNumber = 9800;

  const room: ChildLaunchDeps["room"] = async (client, input) => {
    const r = await childEnvelopeRoom(client, { accountId: input.accountId, envelopeId: input.envelopeId, childId: input.childId, firstRunUsd: PRICE });
    return { fits: r.fits, remainingUsd: r.remainingUsd, priceUsd: PRICE };
  };
  const child: ChildLaunchDeps = { buildSupported: true, room };

  beforeAll(async () => {
    process.env.FX_SESSION_SECRET = "s".repeat(32);
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.WORKER_DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    for (const p of [adminPool, writerPool, appPool, opsPool, receiptPool]) await p.end();
  });
  beforeEach(() => {
    runActionDeps.getRunActionSignal = () => signal;
  });
  afterEach(() => {
    runActionDeps.getRunActionSignal = () => null;
  });

  const ROWS = [
    { key: "page-a", title: "Docs page A", depends_on: [] },
    { key: "page-b", title: "Docs page B", depends_on: [] },
  ];
  const SPLIT = { feasible: true, reason: "", split_proposed: true, summary: "Two independent pages.", spec: "1. Page A exists.\n2. Page B exists.", acceptance_files: ["docs/a.md", "docs/b.md"], planned_prs: ROWS };
  const ONE = { feasible: true, reason: "", split_proposed: false, summary: "Fix the year.", spec: "1. The footer shows the year.", acceptance_files: ["docs/a.md"] };
  const moduleOf = () => createAdvanceModule(writerPool, { starter: null as never, resolveRunSeat: null as never, startAdvance: async () => undefined, triage: null, registry: {} as never, lightSpec: publishLightSpec });

  /** An account with a connected repo, a budget, the weekly auto-start limit and the launch dial at `act` (plain tenant configuration). */
  async function account(): Promise<SeedRefs> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [a.repoId]);
    await admin.query("UPDATE accounts SET model_budget_usd_month = 600 WHERE id = $1", [a.accountId]);
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, NULL, 'weekly_autostart', 50, 1, $3)`, [randomUUID(), a.accountId, a.userId]);
    await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'launch_sub_item', 'act', 'autonomous', 1, $3)`, [a.accountId, a.repoId, a.userId]);
    return a;
  }

  /** What a proposal's approval does at Triaged, before any work: an item envelope through the real writer and the real definer. */
  async function envelopeFor(a: SeedRefs, workItemId: string): Promise<void> {
    await withTenant(appPool, a.accountId, a.userId, async (c) => {
      const { envelopeId } = await writeEnvelopeVersion(c, { accountId: a.accountId, scope: "item", repoId: a.repoId, amountUsd: 20, estimateUsd: null, marginPct: null, minAmountUsd: PRICE });
      await setWorkItemEnvelope(c, workItemId, envelopeId);
    });
  }

  /** A triaged doc item that an owner approved with an item envelope, then its short Spec published with `output`. */
  async function specReady(output: unknown, opts: { envelope?: boolean } = {}): Promise<{ a: SeedRefs; workItemId: string; pmRun: string }> {
    const a = await account();
    const t = await runTriageStep(
      { pool: writerPool, accountId: a.accountId, classifier: fixtureClassifier("doc") },
      { mode: "new", event: { ...OWNER, body: "Document both pages." }, title: "Docs pages", sourceEventId: randomUUID(), repoId: a.repoId },
    );
    if (t.status !== "triaged") throw new Error(`fixture: ${JSON.stringify(t)}`);
    const workItemId = t.workItemId;
    await admin.query("UPDATE work_items SET gh_number = $2, repo_id = $3 WHERE id = $1", [workItemId, nextNumber++, a.repoId]);
    if (opts.envelope !== false) await envelopeFor(a, workItemId);
    // The PM's finished run, as the workflow leaves it before the publish step.
    const pmRun = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope) VALUES ($1, $2, $3, 'project-manager', 'production', 'succeeded', $4::jsonb)", [pmRun, a.accountId, workItemId, JSON.stringify(output)]);
    const out = await moduleOf().advanceLightSpec({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 }, pmRun, randomUUID());
    expect(out).toMatchObject({ status: "published", version: 1 });
    return { a, workItemId, pmRun };
  }

  async function approveByRoute(a: SeedRefs, workItemId: string): Promise<Response> {
    const h = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession({ accountId: a.accountId, userId: a.userId })}` });
    return handleApiRequest(new Request(`http://localhost/api/v1/work-items/${workItemId}/approve`, { method: "POST", headers: h }), appPool, opsPool, ROUTES);
  }
  const kidsOf = async (id: string) => (await admin.query<{ id: string; planned_pr_key: string }>("SELECT id, planned_pr_key FROM work_items WHERE parent_id = $1 ORDER BY planned_pr_key", [id])).rows;
  const executorRuns = async (id: string) => Number((await admin.query<{ n: string }>("SELECT count(*) AS n FROM agent_runs WHERE work_item_id = $1 AND role = 'executor'", [id])).rows[0]!.n);
  const pinnedRuns = async (id: string) => (await admin.query("SELECT 1 FROM agent_runs WHERE work_item_id = $1 AND spec_version_id IS NOT NULL", [id])).rows.length;
  const noStart: AdvanceRunPorts = {
    startRun: async () => {
      throw new Error("an executor run was started");
    },
    outcome: async () => {
      throw new Error("unused");
    },
    cancel: async () => undefined,
  };
  const sweepOf = (c: ChildLaunchDeps = child) => createAutoStartSweep({ receiptPool, firstRunUsd: async () => PRICE, child: c, warn: (m: string) => console.error("WARN", m) });

  it("publish (split), the person's approval through the route, then the sweep: both children reach started, with a receipt each naming the parent and its approval", async () => {
    const { a, workItemId } = await specReady(SPLIT);
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    const kids = await kidsOf(workItemId);
    expect(kids.map((k) => k.planned_pr_key)).toEqual(["page-a", "page-b"]);

    const sweep = sweepOf();
    expect(await sweep.gateChild(a.accountId, kids[0]!.id)).toEqual({ outcome: "started" });
    expect(await sweep.gateChild(a.accountId, kids[1]!.id)).toEqual({ outcome: "started" });

    const receipts = (await admin.query(`SELECT sub_item_key, actor, class, chosen, approval_id, run_id, spec_version_id FROM decision_receipts WHERE work_item_id = $1 AND decision_type = 'launch_sub_item' ORDER BY sub_item_key`, [workItemId])).rows;
    expect(receipts.map((r) => r.sub_item_key)).toEqual(["page-a", "page-b"]);
    const approval = (await admin.query<{ id: string; spec_version_id: string }>("SELECT id, spec_version_id FROM work_item_approvals WHERE work_item_id = $1", [workItemId])).rows;
    expect(approval).toHaveLength(1);
    for (const r of receipts) expect(r).toMatchObject({ actor: "policy", class: "human_over_the_loop", approval_id: approval[0]!.id, spec_version_id: approval[0]!.spec_version_id });
    // The anchor is a run of the parent that is pinned to the approved version; the parent itself built nothing.
    const anchor = (await admin.query<{ role: string; spec_version_id: string; status: string }>("SELECT role, spec_version_id, status FROM agent_runs WHERE id = $1", [receipts[0]!.run_id])).rows[0]!;
    expect(anchor).toMatchObject({ role: "project-manager", spec_version_id: approval[0]!.spec_version_id, status: "succeeded" });
    expect((await admin.query("SELECT envelope->>'summary' AS summary, usd FROM agent_runs WHERE id = $1", [receipts[0]!.run_id])).rows[0]).toMatchObject({ summary: "Recorded the approved Spec version so its planned pull requests can start. No work was run." });
    expect(await executorRuns(workItemId)).toBe(0);
    // Each child's start is filed, and the parent's envelope is what it runs under.
    const parentEnvelope = (await admin.query<{ envelope_id: string }>("SELECT envelope_id FROM work_items WHERE id = $1", [workItemId])).rows[0]!.envelope_id;
    for (const k of kids) {
      expect((await admin.query("SELECT envelope_id FROM work_items WHERE id = $1", [k.id])).rows[0]!.envelope_id).toBe(parentEnvelope);
      expect((await admin.query("SELECT 1 FROM run_action_requests WHERE target_id = $1 AND kind = 'advance_work_item'", [k.id])).rows).toHaveLength(1);
    }
  });

  const envelopeRows = async (accountId: string) => (await admin.query<{ id: string; scope: string; amount_usd: string }>("SELECT id, scope, amount_usd FROM approval_envelopes WHERE account_id = $1 AND scope <> 'weekly_autostart' ORDER BY created_at", [accountId])).rows;
  const envelopeOf = async (id: string) => (await admin.query<{ envelope_id: string | null }>("SELECT envelope_id FROM work_items WHERE id = $1", [id])).rows[0]!.envelope_id;

  it("a split parent approved from the card with NO envelope gets an item envelope in the approval, and both children reach started", async () => {
    // The parent was never given an envelope (no proposal approval): nothing here attaches one by hand.
    const { a, workItemId } = await specReady(SPLIT, { envelope: false });
    expect(await envelopeOf(workItemId)).toBeNull();
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    const envelopeId = await envelopeOf(workItemId);
    expect(envelopeId).not.toBeNull();
    const rows = await envelopeRows(a.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: envelopeId, scope: "item" });
    expect(Number(rows[0]!.amount_usd)).toBeGreaterThan(0);
    const kids = await kidsOf(workItemId);
    const sweep = sweepOf();
    expect(await sweep.gateChild(a.accountId, kids[0]!.id)).toEqual({ outcome: "started" });
    expect(await sweep.gateChild(a.accountId, kids[1]!.id)).toEqual({ outcome: "started" });
    for (const k of kids) expect(await envelopeOf(k.id)).toBe(envelopeId);
    // A second click is a repeat: no second envelope.
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    expect(await envelopeRows(a.accountId)).toHaveLength(1);
  });

  it("room still holds under the attached envelope: a child that does not fit is held", async () => {
    const { a, workItemId } = await specReady(SPLIT, { envelope: false });
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    const kids = await kidsOf(workItemId);
    const tight: ChildLaunchDeps = { buildSupported: true, room: async () => ({ fits: false, remainingUsd: 0, priceUsd: PRICE }) };
    expect(await sweepOf(tight).gateChild(a.accountId, kids[0]!.id)).toMatchObject({ outcome: "no_room", code: "parent_envelope_reached" });
  });

  it("a parent that already has an envelope keeps it unchanged, and no second one is written", async () => {
    const { a, workItemId } = await specReady(SPLIT);
    const before = await envelopeOf(workItemId);
    const rowsBefore = await envelopeRows(a.accountId);
    expect(before).not.toBeNull();
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    expect(await envelopeOf(workItemId)).toBe(before);
    expect(await envelopeRows(a.accountId)).toEqual(rowsBefore);
  });

  it("an account with nothing left to spend refuses the split approval like a proposal's, and the approval is rolled back with it", async () => {
    const { a, workItemId } = await specReady(SPLIT, { envelope: false });
    await admin.query("UPDATE accounts SET model_budget_usd_month = 0 WHERE id = $1", [a.accountId]);
    const res = await approveByRoute(a, workItemId);
    expect(res.status).toBe(409);
    expect(await kidsOf(workItemId)).toEqual([]);
    expect((await admin.query("SELECT 1 FROM work_item_approvals WHERE work_item_id = $1", [workItemId])).rows).toEqual([]);
    expect(await envelopeOf(workItemId)).toBeNull();
  });

  it("a Spec that plans one pull request is approved as before: no envelope is attached", async () => {
    const { a, workItemId } = await specReady(ONE, { envelope: false });
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    expect(await envelopeOf(workItemId)).toBeNull();
    expect(await envelopeRows(a.accountId)).toEqual([]);
  });

  it("the setter still refuses a started item outside the approval's own transaction, split parent or not", async () => {
    const { a, workItemId } = await specReady(SPLIT, { envelope: false });
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    // Undo the attach as the superuser, then try again later as a person: the approval row is no longer from this transaction.
    const envelopeId = (await envelopeOf(workItemId))!;
    await admin.query("UPDATE work_items SET envelope_id = NULL WHERE id = $1", [workItemId]);
    await expect(withTenant(appPool, a.accountId, a.userId, (c) => setWorkItemEnvelope(c, workItemId, envelopeId))).rejects.toMatchObject({ code: "work_started" });
    expect(await envelopeOf(workItemId)).toBeNull();
  });

  it("the envelope limit still holds: with no room under the parent's envelope the child is held, and nothing is written", async () => {
    const { a, workItemId } = await specReady(SPLIT);
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    const kids = await kidsOf(workItemId);
    const tight: ChildLaunchDeps = { buildSupported: true, room: async () => ({ fits: false, remainingUsd: 0, priceUsd: PRICE }) };
    expect(await sweepOf(tight).gateChild(a.accountId, kids[0]!.id)).toMatchObject({ outcome: "no_room", code: "parent_envelope_reached" });
    expect((await admin.query("SELECT 1 FROM decision_receipts WHERE work_item_id = $1 AND decision_type = 'launch_sub_item'", [workItemId])).rows).toEqual([]);
  });

  it("a replay of the publish step adds no second anchor, and a single-PR Spec gets none", async () => {
    const { a, workItemId, pmRun } = await specReady(SPLIT);
    expect(await pinnedRuns(workItemId)).toBe(1);
    await moduleOf().advanceLightSpec({ accountId: a.accountId, userId: a.userId, workItemId, haltEpoch: 0 }, pmRun, randomUUID());
    expect(await pinnedRuns(workItemId)).toBe(1);
    const single = await specReady(ONE);
    expect(await pinnedRuns(single.workItemId)).toBe(0);
  });

  it("a re-spec of a split parent to a single pull request does not build the parent: the load says it has children, the build start is refused with a fixed stop, and the children are untouched", async () => {
    const { a, workItemId } = await specReady(SPLIT);
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    const before = await kidsOf(workItemId);
    // A newer Spec version that plans one pull request (a table is stored only from two rows, so the newest version has none).
    await admin.query(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 2, 'v2', encode(sha256(convert_to('v2', 'UTF8')), 'hex'), 'agent', '{}'::jsonb)`,
      [a.accountId, workItemId],
    );
    const loaded = await moduleOf().advanceLoadItem(a.accountId, workItemId);
    expect(loaded).toMatchObject({ stage: "spec_ready", hasChildren: true });
    expect(loaded).not.toHaveProperty("splits");
    expect(await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), noStart)).toMatchObject({ status: "refused", reason: "parent_has_children" });
    expect(await executorRuns(workItemId)).toBe(0);
    expect(await kidsOf(workItemId)).toEqual(before);
    expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [workItemId])).rows[0]!.stage).toBe("spec_ready");
  });

  /** A split parent, approved (children made), then re-specced to a single pull request (version 2 has no table). */
  async function respecced(): Promise<{ a: SeedRefs; workItemId: string; kids: { id: string; planned_pr_key: string }[] }> {
    const { a, workItemId } = await specReady(SPLIT);
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    await admin.query(
      `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 2, 'v2', encode(sha256(convert_to('v2', 'UTF8')), 'hex'), 'agent', '{}'::jsonb)`,
      [a.accountId, workItemId],
    );
    return { a, workItemId, kids: await kidsOf(workItemId) };
  }

  it.each(["merged", "closed_unmerged", "closed"])("a re-spec to one pull request when every child is %s is not refused for its children: the load does not flag them and the build start goes on", async (stage) => {
    const { a, workItemId, kids } = await respecced();
    await admin.query("UPDATE work_items SET stage = $2 WHERE parent_id = $1", [workItemId, stage]);
    expect(await moduleOf().advanceLoadItem(a.accountId, workItemId)).not.toHaveProperty("hasChildren");
    const out = await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), noStart).catch((e: unknown) => ({ status: "threw", reason: String(e) }));
    expect(out).not.toMatchObject({ reason: "parent_has_children" });
    expect(await kidsOf(workItemId)).toEqual(kids);
  });

  it("a re-spec with one child still live is refused for its children, even when the other child is closed", async () => {
    const { a, workItemId } = await respecced();
    await admin.query("UPDATE work_items SET stage = 'closed' WHERE parent_id = $1 AND planned_pr_key = 'page-a'", [workItemId]);
    expect(await moduleOf().advanceLoadItem(a.accountId, workItemId)).toMatchObject({ hasChildren: true });
    expect(await startBuildForItem(writerPool, a.accountId, workItemId, randomUUID(), noStart)).toMatchObject({ status: "refused", reason: "parent_has_children" });
  });

  it("the panel path: publish through the real panel step (split), the person's approval through the route, then the sweep: both children reach started", async () => {
    const a = await account();
    const { workItemId } = await discussingItem(writerPool, a.accountId, { title: "Two pages", body: "Document both pages.", category: "feature", repoId: a.repoId });
    await admin.query("UPDATE work_items SET gh_number = $2, repo_id = $3 WHERE id = $1", [workItemId, nextNumber++, a.repoId]);
    // The triage step takes a panel item straight to Discussing, so the definer (Triaged only) cannot attach the envelope here: the envelope is written by the real writer and linked by the fixture.
    const envelopeId = await withTenant(appPool, a.accountId, a.userId, async (c) => (await writeEnvelopeVersion(c, { accountId: a.accountId, scope: "item", repoId: a.repoId, amountUsd: 20, estimateUsd: null, marginPct: null, minAmountUsd: PRICE })).envelopeId);
    await admin.query("UPDATE work_items SET envelope_id = $2 WHERE id = $1", [workItemId, envelopeId]);
    const writer = new FixtureWriter(admin, a.accountId);
    writer.output = () => ({ summary: "s", spec: "1. Page A exists.\n2. Page B exists.", acceptance_files: ["docs/a.md", "docs/b.md"], planned_prs: ROWS });
    const deps = { pool: writerPool, accountId: a.accountId, runner: new FixtureRunner(admin, a.accountId), writer, trigger: async () => undefined };
    expect(await runSpecStep(deps, { workItemId })).toMatchObject({ status: "published", version: 1 });
    // A replay of the publish step makes no second anchor.
    await runSpecStep(deps, { workItemId });
    expect(await pinnedRuns(workItemId)).toBe(1);

    const res = await approveByRoute(a, workItemId);
    expect([res.status, res.status === 202 ? "" : await res.text(), (await admin.query("SELECT role, status FROM agent_runs WHERE work_item_id = $1", [workItemId])).rows]).toEqual([202, "", expect.anything()]);
    const kids = await kidsOf(workItemId);
    expect(kids.map((k) => k.planned_pr_key)).toEqual(["page-a", "page-b"]);
    const sweep = sweepOf();
    expect(await sweep.gateChild(a.accountId, kids[0]!.id)).toEqual({ outcome: "started" });
    expect(await sweep.gateChild(a.accountId, kids[1]!.id)).toEqual({ outcome: "started" });
    expect(await executorRuns(workItemId)).toBe(0);
  });

  // ---- the repository's build slot is held ------------------------------------------------------------------------------------------------------
  /** Another item holding the repository's only build slot (a pull request open for it). */
  async function occupySlot(a: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'pr_opened', $4)", [id, a.accountId, a.repoId, nextNumber++]);
    return id;
  }
  /** The real perform of the approval the route filed for `workItemId`, with the real slot reading; only the workflow starter is recorded. */
  async function performFiled(_a: SeedRefs, workItemId: string): Promise<{ outcome: unknown; started: AdvanceStartArgs[] }> {
    const started: AdvanceStartArgs[] = [];
    const m = createAdvanceModule(writerPool, {
      starter: null as never, resolveRunSeat: async () => ({ ok: true }) as never, startAdvance: async (args) => void started.push(args), triage: null, registry: {} as never,
      buildWaitReason: readBuildWaitReason,
    });
    const filed = (await admin.query<{ id: string }>("SELECT id FROM run_action_requests WHERE target_id = $1 AND kind = 'advance_work_item' AND state = 'accepted' ORDER BY created_at DESC LIMIT 1", [workItemId])).rows[0]!;
    const facade = createRunActionFacade(writerPool, {} as never);
    expect(await facade.claimRunAction(filed.id, 600)).not.toBeNull();
    const outcome = (await m.performAdvanceWorkItem(filed.id) as { outcome: unknown }).outcome;
    await facade.settleRunAction(filed.id, { state: "done", outcome: outcome as never }); // the request is performed, as the worker's loop leaves it
    return { outcome, started };
  }
  const waitFacts = async (id: string) => (await admin.query("SELECT code FROM work_item_driver_events WHERE work_item_id = $1 AND kind IN ('stage_waiting', 'build_waiting')", [id])).rows;

  it("slot held: a split parent's approval settles started with no wait fact (it takes no slot), and the children are launched by the sweep as they are with a free slot", async () => {
    const { a, workItemId } = await specReady(SPLIT);
    await occupySlot(a);
    // The slot reading itself says the parent would wait, so only the split guard keeps the false wait off the card.
    expect(await readBuildWaitReason(writerPool, a.accountId, workItemId)).not.toBeNull();
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    const { outcome, started } = await performFiled(a, workItemId);
    expect(outcome).toEqual({ work_item_id: workItemId, advance: "started" });
    expect(started).toHaveLength(1);
    expect(await waitFacts(workItemId)).toEqual([]);
    expect(await executorRuns(workItemId)).toBe(0);

    // The launch gate does not look at the slot: both children are launched (a request each), and each takes its turn at the slot inside its own workflow.
    const kids = await kidsOf(workItemId);
    const sweep = sweepOf();
    for (const k of kids) expect(await sweep.gateChild(a.accountId, k.id)).toEqual({ outcome: "started" });
    for (const k of kids) {
      const r = await performFiled(a, k.id);
      expect(r.outcome).toMatchObject({ work_item_id: k.id, advance: "waiting" });
      expect(r.started).toHaveLength(1);
      expect(await executorRuns(k.id)).toBe(0);
    }
    // A repeat pass launches nothing new: one request each.
    for (const k of kids) {
      expect(await sweep.gateChild(a.accountId, k.id)).toEqual({ outcome: "replayed" });
      expect((await admin.query("SELECT 1 FROM run_action_requests WHERE target_id = $1 AND kind = 'advance_work_item'", [k.id])).rows).toHaveLength(1);
    }
  });

  it("slot held: a Spec that plans one pull request still waits for the slot, so the split guard skips only a parent", async () => {
    const { a, workItemId } = await specReady(ONE);
    await occupySlot(a);
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    const { outcome } = await performFiled(a, workItemId);
    expect(outcome).toMatchObject({ advance: "waiting" });
    expect(await waitFacts(workItemId)).toHaveLength(1);
  });

  it("slot free: a split parent settles started, as before", async () => {
    const { a, workItemId } = await specReady(SPLIT);
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    expect((await performFiled(a, workItemId)).outcome).toEqual({ work_item_id: workItemId, advance: "started" });
    expect(await waitFacts(workItemId)).toEqual([]);
  });

  // ---- the slot wake covers a planned child whose workflow ended ----------------------------------------------------------------------------------
  /** A held slot, the split parent approved through the route, both children launched by the real sweep and settled `waiting` by the real perform. */
  async function waitingChildren(): Promise<{ a: SeedRefs; workItemId: string; holder: string; kids: { id: string; planned_pr_key: string }[] }> {
    const { a, workItemId } = await specReady(SPLIT);
    const holder = await occupySlot(a);
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    await performFiled(a, workItemId);
    const kids = await kidsOf(workItemId);
    for (const k of kids) {
      expect(await sweepOf().gateChild(a.accountId, k.id)).toEqual({ outcome: "started" });
      expect((await performFiled(a, k.id)).outcome).toMatchObject({ advance: "waiting" });
    }
    return { a, workItemId, holder, kids };
  }
  /** The child workflows ended (timeout or crash): their waiting facts are old and no run lives. */
  const orphan = (ids: string[]) => admin.query("UPDATE work_item_driver_events SET created_at = now() - interval '1 hour' WHERE work_item_id = ANY($1::uuid[]) AND kind = 'stage_waiting'", [ids]);
  const wakeEntry = PARKED_STAGE_REGISTRY.build!;
  /** The real stage-resume sweep. `takesSlot`: a started workflow moves its item to PR opened, the way the real one takes the slot. */
  function wake(started: AdvanceStartArgs[], takesSlot: boolean) {
    return createStageResume(writerPool, {
      resolveRunSeat: async () => {
        throw new Error("the slot wake never asks for a seat");
      },
      startAdvance: async (args) => {
        started.push(args);
        if (takesSlot) await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [args.workItemId]);
      },
      buildWaitReason: (accountId, id) => readBuildWaitReason(writerPool, accountId, id),
      log: () => undefined,
    });
  }
  const freeSlot = async (a: SeedRefs, id: string) => void (await withTenant(appPool, a.accountId, (c) => recordStage(c, { workItemId: id, toStage: "merged", at: new Date(), source: "webhook", sourceRef: `t:${randomUUID()}` })));
  const mineOf = (started: AdvanceStartArgs[], a: SeedRefs) => started.filter((s) => s.accountId === a.accountId);
  const cardOf = (a: SeedRefs, id: string) => getWorkItemActivity({ pool: appPool, principal: { accountId: a.accountId, userId: a.userId, role: "owner" } }, id);

  it("slot held, parent approved, child workflows gone: a freed slot starts exactly one child, a repeat pass none, and the second child when the first leaves the slot", async () => {
    const { a, holder, kids } = await waitingChildren();
    await orphan(kids.map((k) => k.id));
    const started: AdvanceStartArgs[] = [];
    await wake(started, true).sweepParkedStages([wakeEntry]);
    expect(mineOf(started, a)).toEqual([]); // still held: nothing starts
    await freeSlot(a, holder);
    await wake(started, true).sweepParkedStages([wakeEntry]);
    expect(mineOf(started, a)).toHaveLength(1);
    const first = mineOf(started, a)[0]!;
    expect(kids.map((k) => k.id)).toContain(first.workItemId);
    const approval = (await admin.query<{ id: string }>("SELECT id FROM run_action_requests WHERE target_id = $1 AND kind = 'advance_work_item'", [first.workItemId])).rows[0]!.id;
    expect(first).toMatchObject({ userId: a.userId, actionId: approval, specVersion: 1 });
    // A repeat pass: the first child holds the slot, the second is not started beside it.
    await wake(started, true).sweepParkedStages([wakeEntry]);
    expect(mineOf(started, a)).toHaveLength(1);
    expect(Number((await admin.query("SELECT count(*) AS n FROM work_item_driver_events WHERE work_item_id = $1 AND dedupe_key LIKE 'slotwake:%'", [first.workItemId])).rows[0].n)).toBe(1);
    // The first child's pull request merges: the slot frees and the second child starts, once.
    await freeSlot(a, first.workItemId);
    await wake(started, true).sweepParkedStages([wakeEntry]);
    await wake(started, true).sweepParkedStages([wakeEntry]);
    const all = mineOf(started, a).map((s) => s.workItemId);
    expect(all).toHaveLength(2);
    expect(new Set(all)).toEqual(new Set(kids.map((k) => k.id)));
  });

  it("one start per repository per pass, even when the slot looks free for the second child", async () => {
    const { a, holder, kids } = await waitingChildren();
    await orphan(kids.map((k) => k.id));
    await freeSlot(a, holder);
    const started: AdvanceStartArgs[] = [];
    await wake(started, false).sweepParkedStages([wakeEntry]); // this starter takes no slot, so only the repository rule holds the second child back
    expect(mineOf(started, a)).toHaveLength(1);
  });

  it("two passes at the same moment start the child once: the once-only claim", async () => {
    const { a, holder, kids } = await waitingChildren();
    await orphan(kids.map((k) => k.id));
    await freeSlot(a, holder);
    const started: AdvanceStartArgs[] = [];
    await Promise.all([wake(started, false).sweepParkedStages([wakeEntry]), wake(started, false).sweepParkedStages([wakeEntry])]);
    expect(mineOf(started, a)).toHaveLength(1);
  });

  it("the card says a waiting child starts by itself, and the wake does it", async () => {
    const { a, kids } = await waitingChildren();
    const n = (await cardOf(a, kids[0]!.id)).notice!;
    expect(n).toMatchObject({ kind: "build_slot_wait", autoStart: true });
    expect(buildWaitSentence(n.reason!, n.holder ?? null, n.autoStart !== false)).toContain("starts by itself");
  });

  it("a child with no launch request never starts, and its card says a person has to act", async () => {
    const { a, workItemId } = await specReady(SPLIT);
    const holder = await occupySlot(a);
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    const [kid] = await kidsOf(workItemId);
    // Its waiting fact exists, with no launch behind it.
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'build', 'one_build_per_repo_until_d598', 0, $3)", [a.accountId, kid!.id, randomUUID()]);
    expect((await cardOf(a, kid!.id)).notice).toMatchObject({ kind: "build_slot_wait", autoStart: false });
    await orphan([kid!.id]);
    await freeSlot(a, holder);
    const started: AdvanceStartArgs[] = [];
    await wake(started, true).sweepParkedStages([wakeEntry]);
    expect(mineOf(started, a)).toEqual([]);
  });

  it("only a child counts a waiting launch as its approval: an ordinary item at Spec ready whose request settled waiting is not started", async () => {
    const { a, workItemId } = await specReady(ONE);
    const holder = await occupySlot(a);
    expect((await approveByRoute(a, workItemId)).status).toBe(202);
    expect((await performFiled(a, workItemId)).outcome).toMatchObject({ advance: "waiting" });
    await orphan([workItemId]);
    await freeSlot(a, holder);
    const started: AdvanceStartArgs[] = [];
    await wake(started, true).sweepParkedStages([wakeEntry]);
    expect(mineOf(started, a)).toEqual([]);
  });

  it("a child whose parent planned a newer Spec version after the launch is not started under the old launch", async () => {
    const { a, kids, holder } = await waitingChildren();
    await orphan(kids.map((k) => k.id));
    await admin.query("UPDATE spec_versions SET created_at = now() + interval '1 minute' WHERE id IN (SELECT planned_pr_spec_version_id FROM work_items WHERE id = ANY($1::uuid[]))", [kids.map((k) => k.id)]);
    await freeSlot(a, holder);
    const started: AdvanceStartArgs[] = [];
    await wake(started, true).sweepParkedStages([wakeEntry]);
    expect(mineOf(started, a)).toEqual([]);
  });
});
