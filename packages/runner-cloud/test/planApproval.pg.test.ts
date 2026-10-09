import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { APPROVALS_LIMIT, approveRun, getPlanApprovalDial, getRunWaitReason, listApprovals, listRunners, setPlanApprovalDial, setPlanConsent } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

/**
 * [pg] D#6 R2b-4a (C30 section 3 and C31 section 4): the read model with the dial and the consent, the approvals list, the repo-coverage
 * check on approval, the consent route and the runner-run dial route. Real definers and real row security throughout.
 */
describe("runner-run approval and the dial [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const NOW = new Date();
  const deps = () => h.deps({ now: () => NOW });
  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);

  const installations = new Map<string, string>();
  async function newRepo(f: F2Fixture, owner = "acme", name: string | null = `app-${randomUUID().slice(0, 8)}`): Promise<string> {
    let installationId = installations.get(f.accountId);
    if (!installationId) {
      installationId = randomUUID();
      await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team')", [installationId, f.accountId]);
      installations.set(f.accountId, installationId);
    }
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, 'team', $4, $5, 'runner_local')", [id, f.accountId, installationId, owner, name]);
    return id;
  }
  async function runner(f: F2Fixture, by: string, repos: string[], o: { mode?: string; revoked?: boolean } = {}): Promise<string> {
    const id = await insertRunner(h.admin, f.accountId, by, { credentialMode: o.mode ?? "subscription" });
    await h.admin.query("UPDATE runners SET last_seen_at = $2, protocol_version = 1, allowed_repo_ids = $3::uuid[], revoked_at = $4 WHERE id = $1", [id, new Date(NOW.getTime() - 5000), repos, o.revoked ? new Date(NOW.getTime() - 1000) : null]);
    return id;
  }
  async function run(f: F2Fixture, repo: string, o: { status?: string; initiatedBy?: string | null; approvedBy?: string | null; role?: string; createdAt?: Date; workItemId?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, initiated_by, approved_by, work_item_id, created_at)
       VALUES ($1, $2, $3, 'runner', $4, 'runner_local', $5, $6, $7, $8, $9)`,
      [id, f.accountId, o.role ?? "executor", o.status ?? "pending", repo, o.initiatedBy ?? null, o.approvedBy ?? null, o.workItemId ?? null, o.createdAt ?? new Date(NOW.getTime() - 60_000)],
    );
    return id;
  }
  const reason = (f: F2Fixture, id: string) => getRunWaitReason(deps(), f.accountId, id);
  const consent = (f: F2Fixture, by: string, runnerId: string, granted: boolean) => respond(() => setPlanConsent(deps(), { accountId: f.accountId, userId: by }, runnerId, { granted }));
  const dialRow = (f: F2Fixture, repo: string, disposition: string) =>
    h.admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
       VALUES ($1, $2, 'runner_run_on_member_plan', $3, (SELECT COALESCE(max(version), 0) + 1 FROM decision_settings WHERE repo_id = $2 AND decision_type = 'runner_run_on_member_plan'), $4)`,
      [f.accountId, repo, disposition, f.o1],
    );
  type Approvals = { approvals: Array<{ run_id: string; work_item_id: string | null; role: string; repo_name: string; created_at: string; approvers: Array<{ id: string; name: string }>; can_approve: boolean }> };
  const approvals = (f: F2Fixture, userId: string) => respond(() => listApprovals(deps(), { accountId: f.accountId, userId }));

  describe("the wait reason (C30 acceptance 1, C31 acceptance 4 and 8)", () => {
    it("a pending run with no starter and no approver reads waiting_for_approval when only a covering subscription runner exists; so does one a teammate started", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      await runner(f, f.a1, [repo]);
      expect(await reason(f, await run(f, repo))).toBe("waiting_for_approval");
      expect(await reason(f, await run(f, repo, { initiatedBy: f.m1 }))).toBe("waiting_for_approval");
      // the registrant's own run needs nothing
      expect(await reason(f, await run(f, repo, { initiatedBy: f.a1 }))).toBeNull();
    });

    it("a runner that does not list the run's repo cannot take it, so it neither makes the run runnable nor makes it wait for approval", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const other = await newRepo(f);
      await runner(f, f.a2, [other], { mode: "api_key" });
      await runner(f, f.a1, [other]);
      expect(await reason(f, await run(f, repo))).toBe("waiting_for_runner");
      await runner(f, f.a1, [repo]);
      expect(await reason(f, await run(f, repo))).toBe("waiting_for_approval");
    });

    it("follows the consent and the dial: consent on and dial announce or act is about to be claimed; ask, withdrawn or no consent waits for a click", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const mine = await runner(f, f.a1, [repo]);
      const id = await run(f, repo);
      expect(await reason(f, id)).toBe("waiting_for_approval");
      expect((await consent(f, f.a1, mine, true)).status).toBe(200);
      expect(await reason(f, id)).toBeNull();
      await dialRow(f, repo, "ask");
      expect(await reason(f, id)).toBe("waiting_for_approval");
      await dialRow(f, repo, "act");
      expect(await reason(f, id)).toBeNull();
      await consent(f, f.a1, mine, false);
      expect(await reason(f, id)).toBe("waiting_for_approval");
    });

    it("a run someone approved reads waiting_for_runner once their runner is revoked or drops the repo, and the button does not come back (derived, nothing stored)", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const mine = await runner(f, f.a1, [repo]);
      const id = await run(f, repo, { approvedBy: f.a1 });
      expect(await reason(f, id)).toBeNull();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [mine]);
      expect(await reason(f, id)).toBe("waiting_for_runner");
    });

    it("a retried run is a new run with no approver: the cancelled approved one reads null and the new one waits for approval again (C30 acceptance 9)", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      await runner(f, f.a1, [repo]);
      const cancelled = await run(f, repo, { status: "cancelled", approvedBy: f.a1 });
      const retried = await run(f, repo);
      expect(await reason(f, cancelled)).toBeNull();
      expect(await reason(f, retried)).toBe("waiting_for_approval");
      expect((await h.admin.query("SELECT approved_by FROM agent_runs WHERE id = $1", [retried])).rows[0].approved_by).toBeNull();
    });

    it("the run starter code never writes approved_by, so a retry or a pipeline run is created unapproved by construction", async () => {
      const { readFileSync } = await import("node:fs");
      const insert = readFileSync(new URL("../../runner/src/runStatusWriter.ts", import.meta.url), "utf8");
      expect(insert).not.toMatch(/approved_by|approvedBy/);
    });
  });

  describe("GET /api/runners/approvals (C30 acceptance 3)", () => {
    it("lists the run with the registrant's name as an approver; can_approve is true for the registrant only; another account sees nothing", async () => {
      const f = await fresh();
      const g = await fresh();
      const repo = await newRepo(f, "acme", "widgets");
      await h.admin.query("UPDATE users SET name = 'Ada Admin' WHERE id = $1", [f.a1]);
      await runner(f, f.a1, [repo]);
      const id = await run(f, repo, { role: "code-reviewer" });
      const mine = (await approvals(f, f.a1)).body as Approvals;
      expect(mine.approvals).toEqual([
        { run_id: id, work_item_id: null, role: "code-reviewer", repo_name: "acme/widgets", created_at: expect.any(String), approvers: [{ id: f.a1, name: "Ada Admin" }], can_approve: true },
      ]);
      const theirs = (await approvals(f, f.m1)).body as Approvals;
      expect(theirs.approvals.map((a) => [a.run_id, a.can_approve])).toEqual([[id, false]]);
      expect(theirs.approvals[0]!.approvers).toEqual([{ id: f.a1, name: "Ada Admin" }]);
      expect(((await approvals(g, g.o1)).body as Approvals).approvals).toEqual([]);
      expect((await approvals(f, g.o1)).status).toBe(403);
    });

    it("never shows a null, empty or id-like name: a member with no name and no GitHub login shows the fallback", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      await h.admin.query("UPDATE users SET name = NULL, github_login = NULL WHERE id = $1", [f.a1]);
      await runner(f, f.a1, [repo]);
      await run(f, repo);
      const entry = ((await approvals(f, f.m1)).body as Approvals).approvals[0]!;
      expect(entry.approvers[0]!.name).toBe("A team member");
      for (const text of [entry.role, entry.repo_name, ...entry.approvers.map((a) => a.name)]) {
        expect(typeof text).toBe("string");
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(/^(null|undefined)$/);
      }
    });

    it("lists only runs that are waiting for approval: not approved ones, not ones a consenting runner will take, not another repo's without a covering runner", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const lonely = await newRepo(f);
      const sub = await runner(f, f.a1, [repo]);
      const waiting = await run(f, repo);
      await run(f, repo, { approvedBy: f.a1 });
      await run(f, lonely);
      await run(f, repo, { status: "running" });
      expect(((await approvals(f, f.m1)).body as Approvals).approvals.map((a) => a.run_id)).toEqual([waiting]);
      await consent(f, f.a1, sub, true);
      expect(((await approvals(f, f.m1)).body as Approvals).approvals).toEqual([]);
    });

    it("is newest first and capped at 50, and the cap does not hide a waiting run behind other pending ones", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      await runner(f, f.a1, [repo]);
      const ids: string[] = [];
      for (let i = 0; i < APPROVALS_LIMIT + 3; i++) ids.push(await run(f, repo, { createdAt: new Date(NOW.getTime() - (APPROVALS_LIMIT + 10 - i) * 1000) }));
      const body = (await approvals(f, f.m1)).body as Approvals;
      expect(body.approvals).toHaveLength(APPROVALS_LIMIT);
      expect(body.approvals[0]!.run_id).toBe(ids[ids.length - 1]);
      expect(body.approvals.map((a) => a.created_at)).toEqual([...body.approvals.map((a) => a.created_at)].sort().reverse());
    });

    it("answers with cache-control: no-store", async () => {
      const f = await fresh();
      expect((await listApprovals(deps(), { accountId: f.accountId, userId: f.m1 })).headers).toEqual({ "cache-control": "no-store" });
    });
  });

  describe("approving needs a runner that covers the repo (C30 acceptance 4)", () => {
    const approve = (f: F2Fixture, userId: string, runId: string) => respond(() => approveRun(deps(), { accountId: f.accountId, userId }, runId));
    const approvedBy = async (id: string) => (await h.admin.query("SELECT approved_by FROM agent_runs WHERE id = $1", [id])).rows[0].approved_by;

    it("409 runner_not_for_repo for a member whose only subscription runner does not list the repo; approved_by stays NULL; then the registrant who covers it gets 200", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const other = await newRepo(f);
      await runner(f, f.a2, [other]);
      await runner(f, f.a1, [repo]);
      const id = await run(f, repo, { initiatedBy: f.m1 });
      const refused = await approve(f, f.a2, id);
      expect(refused).toMatchObject({ status: 409, body: { error: { code: "runner_not_for_repo" } } });
      expect(await approvedBy(id)).toBeNull();
      expect(await approve(f, f.a1, id)).toMatchObject({ status: 200, body: { approved: true, changed: true } });
      expect(await approvedBy(id)).toBe(f.a1);
    });

    it("counts only a live runner: a revoked covering runner does not let its registrant approve (they have another that does not cover)", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const other = await newRepo(f);
      await runner(f, f.a1, [repo], { revoked: true });
      await runner(f, f.a1, [other]);
      expect((await approve(f, f.a1, await run(f, repo))).status).toBe(409);
    });

    it("keeps the earlier answers: 403 for a member with no subscription runner at all, and an api_key runner does not count as one", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      await runner(f, f.a2, [repo], { mode: "api_key" });
      const id = await run(f, repo);
      expect((await approve(f, f.m2, id)).status).toBe(403);
      expect((await approve(f, f.a2, id)).status).toBe(403);
      expect(await approvedBy(id)).toBeNull();
    });
  });

  describe("POST /api/runners/:id/plan-consent (C31 acceptance 1, 6)", () => {
    const body = (f: F2Fixture, userId: string, runnerId: string, input: unknown) => respond(() => setPlanConsent(deps(), { accountId: f.accountId, userId }, runnerId, input));

    it("200 for the registrant, with the new state; GET /api/runners shows it, and can_change_plan_consent only on the caller's own runner", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const mine = await runner(f, f.m1, [repo]);
      const theirs = await runner(f, f.m2, [repo]);
      const res = await body(f, f.m1, mine, { granted: true });
      expect(res).toMatchObject({ status: 200, body: { plan_consent: { granted: true }, changed: true } });
      const at = (res.body as { plan_consent: { changed_at: string } }).plan_consent.changed_at;
      expect(Date.parse(at)).not.toBeNaN();
      const list = async (userId: string) => ((await respond(() => listRunners(deps(), { accountId: f.accountId, userId }))).body as { runners: Array<{ id: string; plan_consent: { granted: boolean; changed_at: string | null }; can_change_plan_consent: boolean }> }).runners;
      const asM1 = await list(f.m1);
      expect(asM1.find((r) => r.id === mine)).toMatchObject({ plan_consent: { granted: true, changed_at: at }, can_change_plan_consent: true });
      expect(asM1.find((r) => r.id === theirs)).toMatchObject({ plan_consent: { granted: false, changed_at: null }, can_change_plan_consent: false });
      // an owner sees the same state, and cannot change it
      expect((await list(f.o1)).find((r) => r.id === mine)).toMatchObject({ plan_consent: { granted: true }, can_change_plan_consent: false });
    });

    it("403 for an owner, for an admin and for another member, and nothing is written; 404 for a revoked, unknown or malformed runner id", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const mine = await runner(f, f.m1, [repo]);
      for (const user of [f.o1, f.a1, f.m2]) expect((await body(f, user, mine, { granted: true })).status, user).toBe(403);
      expect((await h.admin.query("SELECT 1 FROM runner_plan_consents WHERE runner_id = $1", [mine])).rowCount).toBe(0);
      const revoked = await runner(f, f.m1, [repo], { revoked: true });
      for (const id of [revoked, randomUUID(), "nope"]) expect((await body(f, f.m1, id, { granted: true })).status, id).toBe(404);
    });

    it("a revoked runner shows consent off, and a user outside the account is refused", async () => {
      const f = await fresh();
      const g = await fresh();
      const repo = await newRepo(f);
      const mine = await runner(f, f.m1, [repo]);
      await body(f, f.m1, mine, { granted: true });
      expect((await body(f, g.o1, mine, { granted: true })).status).toBe(403);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [mine]);
      const runners = ((await respond(() => listRunners(deps(), { accountId: f.accountId, userId: f.m1 }))).body as { runners: Array<{ plan_consent: { granted: boolean }; can_change_plan_consent: boolean }> }).runners;
      expect(runners[0]).toMatchObject({ plan_consent: { granted: false }, can_change_plan_consent: false });
    });

    it("400 for anything but exactly { granted: boolean }", async () => {
      const f = await fresh();
      const mine = await runner(f, f.m1, [await newRepo(f)]);
      for (const bad of [null, [], "yes", {}, { granted: "true" }, { granted: 1 }, { granted: true, extra: 1 }, { Granted: true }]) {
        expect((await body(f, f.m1, mine, bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect((await h.admin.query("SELECT 1 FROM runner_plan_consents WHERE runner_id = $1", [mine])).rowCount).toBe(0);
    });

    it("withdrawing what was never on and granting what is on change nothing", async () => {
      const f = await fresh();
      const mine = await runner(f, f.m1, [await newRepo(f)]);
      expect((await body(f, f.m1, mine, { granted: false })).body).toMatchObject({ changed: false, plan_consent: { granted: false, changed_at: null } });
      await body(f, f.m1, mine, { granted: true });
      expect((await body(f, f.m1, mine, { granted: true })).body).toMatchObject({ changed: false });
      expect((await h.admin.query("SELECT 1 FROM runner_plan_consents WHERE runner_id = $1", [mine])).rowCount).toBe(1);
    });
  });

  describe("GET and PUT /api/runners/repos/:id/plan-approval-dial (C31 acceptance 7)", () => {
    const get = (f: F2Fixture, userId: string, repo: string) => respond(() => getPlanApprovalDial(deps(), { accountId: f.accountId, userId }, repo));
    const put = (f: F2Fixture, userId: string, repo: string, input: unknown) => respond(() => setPlanApprovalDial(deps(), { accountId: f.accountId, userId }, repo, input));
    const rows = async (repo: string) => (await h.admin.query("SELECT disposition, preset, version, changed_by FROM decision_settings WHERE repo_id = $1 AND decision_type = 'runner_run_on_member_plan' ORDER BY version", [repo])).rows;
    const audits = async (f: F2Fixture) => (await h.admin.query("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'decision_dial_changed'", [f.accountId])).rows.map((r) => r.payload);

    it("reads the default (announce, source default, no version) for any member, and says who can change it", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const expected = { repo_id: repo, decision_type: "runner_run_on_member_plan", disposition: "announce", source: "default", preset: null, version: null };
      expect((await get(f, f.m1, repo)).body).toEqual({ ...expected, can_change: false });
      expect((await get(f, f.o1, repo)).body).toEqual({ ...expected, can_change: true });
      expect((await get(f, f.a1, repo)).body).toMatchObject({ can_change: true });
    });

    it("an owner or admin writes a new attributed version with its audit row, and the GET shows it (the saved value round-trips)", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const first = await put(f, f.o1, repo, { disposition: "ask" });
      expect(first).toMatchObject({ status: 200, body: { disposition: "ask", source: "override", preset: null, version: 1, can_change: true } });
      const second = await put(f, f.a1, repo, { preset: "autonomous" });
      expect(second).toMatchObject({ status: 200, body: { disposition: "act", source: "preset", preset: "autonomous", version: 2 } });
      expect(await rows(repo)).toEqual([
        { disposition: "ask", preset: null, version: 1, changed_by: f.o1 },
        { disposition: "act", preset: "autonomous", version: 2, changed_by: f.a1 },
      ]);
      expect((await get(f, f.m1, repo)).body).toMatchObject({ disposition: "act", source: "preset", version: 2, can_change: false });
      expect(await audits(f)).toEqual([
        { actor: f.o1, decision_type: "runner_run_on_member_plan", repo_id: repo, previous: null, new: "ask" },
        { actor: f.a1, decision_type: "runner_run_on_member_plan", repo_id: repo, previous: "ask", new: "act" },
      ]);
    });

    it("the three presets write ask, announce and act", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      for (const [preset, disposition] of [["cautious", "ask"], ["balanced", "announce"], ["autonomous", "act"]] as const) {
        expect((await put(f, f.o1, repo, { preset })).body).toMatchObject({ disposition, preset });
      }
    });

    it("a member who is neither owner nor admin gets 403 and no row or audit is written", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      expect((await put(f, f.m1, repo, { disposition: "act" })).status).toBe(403);
      expect(await rows(repo)).toEqual([]);
      expect(await audits(f)).toEqual([]);
    });

    it("404 for an unknown or malformed repo, 403 for a user outside the account, 400 for a body that is not exactly one known value", async () => {
      const f = await fresh();
      const g = await fresh();
      const repo = await newRepo(f);
      expect((await get(f, f.o1, randomUUID())).status).toBe(404);
      expect((await get(f, f.o1, "nope")).status).toBe(404);
      expect((await put(f, f.o1, randomUUID(), { disposition: "ask" })).status).toBe(404);
      expect((await get(f, g.o1, repo)).status).toBe(403);
      expect((await put(f, g.o1, repo, { disposition: "ask" })).status).toBe(403);
      for (const bad of [null, [], {}, "ask", { disposition: "maybe" }, { preset: "moderate" }, { disposition: "ask", preset: "cautious" }, { disposition: "ask", extra: 1 }, { disposition: 1 }]) {
        expect((await put(f, f.o1, repo, bad)).status, JSON.stringify(bad)).toBe(400);
      }
      expect(await rows(repo)).toEqual([]);
    });

    it("a repo of another account is not found from this one", async () => {
      const f = await fresh();
      const g = await fresh();
      const theirs = await newRepo(g);
      expect((await get(f, f.o1, theirs)).status).toBe(404);
      expect((await put(f, f.o1, theirs, { disposition: "ask" })).status).toBe(404);
      expect(await rows(theirs)).toEqual([]);
    });
  });

  it("the copy the screens need is in COPY and not retyped", () => {
    expect(COPY.approvalAuto).toContain("{person}");
    expect(COPY.planConsentText).toContain("without asking each time");
  });
});
