import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { RunnerHttpError, draftRoute, type RunnerCloudDeps } from "../src/index.js";
import { harness, type Harness } from "./helpers.js";

const row = (key: string, over: Record<string, unknown> = {}) => ({ row_key: key, title: `Row ${key}`, summary: "s", size: "S", depends_on: [], keep: true, ...over });

/** [pg] D#845 ON-11a: the plan draft routes, as the person: tenant scoping, owner/admin writes, the version lock, the approve gate (standard and public), the audit row and the plan-coverage gate. */
describe("plan draft [pg]", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); });
  afterAll(() => h.close());

  interface Rig { f: F2Fixture; repoId: string; setupId: string; draftId: string; deps: (over?: Partial<RunnerCloudDeps>) => RunnerCloudDeps }
  async function rig(o: { phase?: string; roadmap?: unknown[]; prd?: string; plan?: boolean; visibility?: "private" | "public" } = {}): Promise<Rig> {
    const f = await seedF2(h.admin);
    const repoId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'widgets', 'runner_local')", [repoId, f.accountId, Math.floor(Math.random() * 1e12)]);
    const setupId = randomUUID();
    await h.admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, phase, state, created_by) VALUES ($1, $2, $3, 'existing', $4, 'ok', $5)", [setupId, f.accountId, repoId, o.phase ?? "plan", f.o1]);
    const draftId = randomUUID();
    await h.admin.query("INSERT INTO project_drafts (id, account_id, repo_id, setup_id, source, prd_md, roadmap, version) VALUES ($1, $2, $3, $4, 'survey', $5, $6::jsonb, 1)", [draftId, f.accountId, repoId, setupId, o.prd ?? "# PRD", JSON.stringify(o.roadmap ?? [row("A"), row("B", { depends_on: ["A"] })])]);
    if (o.plan !== false) await h.admin.query("UPDATE accounts SET engine_quantity = 3, stripe_subscription_status = 'active' WHERE id = $1", [f.accountId]);
    return { f, repoId, setupId, draftId, deps: (over = {}) => h.deps({ repoVisibility: async () => o.visibility ?? "private", ...over }) };
  }
  const as = (r: Rig, userId = r.f.o1) => ({ accountId: r.f.accountId, userId });
  const call = (r: Rig, method: "GET" | "PUT" | "POST", action: string | null, body: unknown = null, who = r.f.o1, setupId = r.setupId, over: Partial<RunnerCloudDeps> = {}) => draftRoute(r.deps(over), as(r, who), method, setupId, action, body);
  async function refused(p: Promise<unknown>, status: number, code: string): Promise<RunnerHttpError> {
    const error = await p.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerHttpError);
    expect([(error as RunnerHttpError).status, (error as RunnerHttpError).code]).toEqual([status, code]);
    return error as RunnerHttpError;
  }
  const draftRow = async (id: string) => (await h.admin.query("SELECT status, version, approved_by, setup_id, prd_md FROM project_drafts WHERE id = $1", [id])).rows[0];
  const audits = async (r: Rig) => (await h.admin.query("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'project.plan_approved'", [r.f.accountId])).rows.map((x) => x.payload);

  describe("tenant scoping", () => {
    it("reads and writes nothing of another account's setup (404), and a second repo's draft of the same account never shows", async () => {
      const a = await rig();
      const b = await rig();
      for (const [method, action] of [["GET", null], ["PUT", null], ["POST", "approve"], ["POST", "discard"], ["POST", "blank"], ["POST", "restart"]] as const) {
        await refused(draftRoute(b.deps(), as(b), method, a.setupId, action, method === "POST" && action !== "approve" ? null : { version: 1, prd_md: "x", roadmap: [] }), 404, "not_found");
        await refused(call(a, method, action, method === "POST" && action !== "approve" ? null : { version: 1, prd_md: "x", roadmap: [] }, b.f.o1), 403, "forbidden");
      }
      expect((await draftRow(a.draftId)).status).toBe("draft");
      // The same account's second repo and setup: its draft is the one its own setup reads.
      const other = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'other', 'runner_local')", [other, a.f.accountId, Math.floor(Math.random() * 1e12)]);
      const otherSetup = randomUUID();
      await h.admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, phase, state, created_by) VALUES ($1, $2, $3, 'existing', 'plan', 'ok', $4)", [otherSetup, a.f.accountId, other, a.f.o1]);
      await h.admin.query("INSERT INTO project_drafts (account_id, repo_id, setup_id, source, prd_md, roadmap, version) VALUES ($1, $2, $3, 'survey', 'OTHER', '[]'::jsonb, 9)", [a.f.accountId, other, otherSetup]);
      const mine = (await call(a, "GET", null)).body as { draft: { id: string } };
      expect(mine.draft.id).toBe(a.draftId);
      const theirs = (await call(a, "GET", null, null, a.f.o1, otherSetup)).body as { draft: { prd_md: string } };
      expect(theirs.draft.prd_md).toBe("OTHER");
      // An earlier, finished setup of the same repo holds a draft with a higher number: it is never the current setup's.
      const old = randomUUID();
      await h.admin.query("INSERT INTO project_setups (id, account_id, repo_id, kind, phase, state, created_by) VALUES ($1, $2, $3, 'existing', 'done', 'ok', $4)", [old, a.f.accountId, a.repoId, a.f.o1]);
      await h.admin.query("INSERT INTO project_drafts (account_id, repo_id, setup_id, source, prd_md, roadmap, version) VALUES ($1, $2, $3, 'survey', 'OLD', '[]'::jsonb, 5)", [a.f.accountId, a.repoId, old]);
      expect(((await call(a, "GET", null)).body as { draft: { id: string } }).draft.id).toBe(a.draftId);
      // The same calls through the RLS-bypassing login: the queries' own account predicates alone keep another account's setup out.
      const bypass = { ...b.deps(), appUserPool: h.adminPool };
      for (const [method, action] of [["GET", null], ["PUT", null], ["POST", "approve"], ["POST", "discard"], ["POST", "blank"]] as const) {
        await refused(draftRoute(bypass, as(b), method, a.setupId, action, method === "POST" && action !== "approve" ? null : { version: 1, prd_md: "x", roadmap: [] }), 404, "not_found");
      }
      expect(await draftRow(a.draftId)).toMatchObject({ status: "draft", version: 1 });
      // The RLS-bypassing view: another account's id finds none of this account's drafts.
      expect((await h.admin.query("SELECT 1 FROM project_drafts WHERE account_id = $1 AND id = $2", [b.f.accountId, a.draftId])).rowCount).toBe(0);
    });
  });

  describe("read and edit", () => {
    it("any member reads, with review_mode; an unknown or public repo is public mode", async () => {
      const r = await rig();
      const body = (await call(r, "GET", null, r.f.m1)).body as { review_mode: string; draft: { version: number; roadmap: unknown[] }; setup: { phase: string } };
      expect([body.review_mode, body.draft.version, body.draft.roadmap.length, body.setup.phase]).toEqual(["standard", 1, 2, "plan"]);
      const pub = await rig({ visibility: "public" });
      expect(((await call(pub, "GET", null)).body as { review_mode: string }).review_mode).toBe("public");
      const unknown = await rig();
      expect(((await draftRoute(unknown.deps({ repoVisibility: async () => "unknown" }), as(unknown), "GET", unknown.setupId, null, null)).body as { review_mode: string }).review_mode).toBe("public");
    });

    it("a member cannot write (403); an owner's edit makes the next version and a stale one is 409 draft_conflict with the current version; bad shapes are 400 and write nothing", async () => {
      const r = await rig();
      await refused(call(r, "PUT", null, { version: 1, prd_md: "x", roadmap: [] }, r.f.m1), 403, "forbidden");
      expect((await call(r, "PUT", null, { version: 1, prd_md: "# New", roadmap: [row("A")] }, r.f.a1)).body).toEqual({ version: 2 });
      const stale = await refused(call(r, "PUT", null, { version: 1, prd_md: "late", roadmap: [] }), 409, "draft_conflict");
      expect(stale.extra).toEqual({ version: 2 });
      for (const body of [{ version: 2, prd_md: "x", roadmap: [{ row_key: "a" }] }, { version: 2, prd_md: "x".repeat(200_001), roadmap: [] }, { version: 2, prd_md: "a\0b", roadmap: [] }, { version: "2", prd_md: "x", roadmap: [] }, [], null]) {
        await refused(call(r, "PUT", null, body), 400, "invalid_message");
      }
      expect(await draftRow(r.draftId)).toMatchObject({ version: 2, prd_md: "# New" });
    });
  });

  describe("approve", () => {
    it("is for an owner or admin only; writes the approved version, the setup and one audit row; and answers the gate when the plan does not cover (nothing issued)", async () => {
      const r = await rig({ plan: false });
      await refused(call(r, "POST", "approve", { version: 1 }, r.f.m1), 403, "forbidden");
      expect((await draftRow(r.draftId)).status).toBe("draft");
      const res = (await call(r, "POST", "approve", { version: 1 }, r.f.a1)).body as Record<string, unknown>;
      expect(res).toMatchObject({ approved: true, draft_id: r.draftId, version: 1, review_mode: "standard", install: null, gate: { code: "plan_required" }, install_error: null });
      expect(await draftRow(r.draftId)).toMatchObject({ status: "approved", approved_by: r.f.a1, setup_id: r.setupId });
      expect(await audits(r)).toEqual([{ setup_id: r.setupId, repo_id: r.repoId, draft_id: r.draftId, version: 1, review_mode: "standard", reviewed_count: 0, kept_count: 2 }]);
      await refused(call(r, "PUT", null, { version: 1, prd_md: "x", roadmap: [] }), 409, "setup_phase");
    });

    it("with coverage it tries the install; one that cannot be issued is reported beside the approval, and approving again writes no second audit row", async () => {
      const r = await rig();
      const res = (await call(r, "POST", "approve", { version: 1 })).body as { gate: unknown; install_error: { code: string } };
      expect(res.gate).toBeNull();
      expect(res.install_error.code).toBe("not_configured");
      const again = (await call(r, "POST", "approve", {})).body as { approved: boolean; version: number };
      expect([again.approved, again.version]).toEqual([true, 1]);
      expect(await audits(r)).toHaveLength(1);
    });

    it("refuses a stale version, no kept row, a PRD out of range and a kept row that depends on a dropped one, and writes nothing", async () => {
      const cases: Array<[Parameters<typeof rig>[0], Record<string, unknown>, number, string, unknown]> = [
        [{}, { version: 7 }, 409, "draft_conflict", { version: 1 }],
        [{ roadmap: [row("A", { keep: false })] }, { version: 1 }, 409, "plan_invalid", { reason: "no_kept_rows" }],
        [{ prd: "" }, { version: 1 }, 409, "plan_invalid", { reason: "prd_length" }],
        [{ roadmap: [row("A", { keep: false }), row("B", { depends_on: ["A"] })] }, { version: 1 }, 409, "plan_invalid", { reason: "dependency_dropped" }],
      ];
      for (const [o, body, status, code, extra] of cases) {
        const r = await rig(o);
        expect((await refused(call(r, "POST", "approve", body), status, code)).extra).toEqual(extra);
        expect((await draftRow(r.draftId)).status).toBe("draft");
        expect(await audits(r)).toEqual([]);
      }
    });

    it("on a public repo it also needs every row (kept or dropped) and the PRD read: 409 plan_not_reviewed with the count, then it passes and the audit row says so", async () => {
      const r = await rig({ visibility: "public", roadmap: [row("A"), row("B", { keep: false })] });
      expect((await refused(call(r, "POST", "approve", { version: 1 }), 400, "invalid_message")).code).toBe("invalid_message");
      expect((await refused(call(r, "POST", "approve", { version: 1, reviewed_row_keys: ["A"], prd_reviewed: true }), 409, "plan_not_reviewed")).extra).toEqual({ missing: 1 });
      expect((await refused(call(r, "POST", "approve", { version: 1, reviewed_row_keys: ["A", "B", "Z"], prd_reviewed: false }), 409, "plan_not_reviewed")).extra).toEqual({ missing: 2 });
      expect((await draftRow(r.draftId)).status).toBe("draft");
      await call(r, "POST", "approve", { version: 1, reviewed_row_keys: ["B", "A"], prd_reviewed: true });
      expect(await audits(r)).toEqual([expect.objectContaining({ review_mode: "public", reviewed_count: 2, kept_count: 1 })]);
    });
  });

  describe("discard, write my own and start over", () => {
    it("discard throws the open draft away (owner or admin); a blank draft replaces it, sets the setup to the plan step and numbers the next version", async () => {
      const r = await rig();
      await refused(call(r, "POST", "discard", null, r.f.m1), 403, "forbidden");
      await call(r, "POST", "discard");
      expect((await draftRow(r.draftId)).status).toBe("discarded");
      await refused(call(r, "GET", null), 404, "not_found");
      await call(r, "POST", "blank", null, r.f.a1);
      const got = (await call(r, "GET", null)).body as { draft: { source: string; version: number; prd_md: string; roadmap: unknown[] } };
      expect([got.draft.source, got.draft.version, got.draft.prd_md, got.draft.roadmap]).toEqual(["blank", 2, "", []]);
      await call(r, "POST", "blank");
      expect(((await call(r, "GET", null)).body as { draft: { version: number } }).draft.version).toBe(3);
    });

    it("write my own works from the survey step of a repo with no survey, and is refused while a survey runs or after approval", async () => {
      const r = await rig({ phase: "survey" });
      await h.admin.query("DELETE FROM project_drafts WHERE id = $1", [r.draftId]);
      await call(r, "POST", "blank");
      expect((await h.admin.query("SELECT phase FROM project_setups WHERE id = $1", [r.setupId])).rows[0].phase).toBe("plan");
      const run = randomUUID();
      const live = await rig({ phase: "survey" });
      await h.admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, 'project-surveyor', 'runner', 'running', 'runner_local', $3)", [run, live.f.accountId, live.repoId]);
      await h.admin.query("UPDATE project_setups SET survey_run_id = $2, state = 'started' WHERE id = $1", [live.setupId, run]);
      await refused(call(live, "POST", "blank"), 409, "survey_running");
      const done = await rig({ plan: false });
      await call(done, "POST", "approve", { version: 1 });
      await refused(call(done, "POST", "blank"), 409, "setup_phase");
    });

    it("start over on a public repo is refused before anything is written; when the survey cannot start, the draft and the plan step are put back", async () => {
      const pub = await rig({ visibility: "public" });
      await refused(call(pub, "POST", "restart"), 409, "public_repo");
      expect((await draftRow(pub.draftId)).status).toBe("draft");
      const r = await rig();
      // No survey ports are configured, so the start itself refuses 503 not_configured.
      await refused(call(r, "POST", "restart"), 503, "not_configured");
      expect((await draftRow(r.draftId)).status).toBe("draft");
      expect((await h.admin.query("SELECT phase, state FROM project_setups WHERE id = $1", [r.setupId])).rows[0]).toEqual({ phase: "plan", state: "ok" });
    });
  });
});
