import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { RunnerHttpError, draftRoute, issueProjectSetup, type RunnerCloudDeps } from "../src/index.js";
import { signMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { HELLO_PATH, runnerHello } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness } from "./helpers.js";

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

  describe("approve, review follow-ups", () => {
    const jobKeys = generateKeyPairSync("ed25519");
    /** A rig whose install can really be issued: a machine holding the placement, a release, the approver's login, a signer and a GitHub port. */
    async function installRig(pullRequests?: unknown) {
      const r = await rig();
      await h.admin.query("UPDATE users SET github_login = 'boss-login' WHERE id = $1", [r.f.o1]);
      const key = newKey();
      const runnerId = await registerKey(h.admin, r.f.accountId, r.f.o1, key);
      const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["project_setup_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" } })));
      expect(hello.status).toBe(200);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [r.repoId, r.f.accountId, runnerId]);
      await h.admin.query("INSERT INTO engine_releases (version, commit_sha, tarball_sha256, min_runner_protocol, published_by, published_at) VALUES ($1, $2, $3, 22, 'test', now())", [`9.${Math.floor(Math.random() * 90000)}.0`, "c".repeat(40), "e".repeat(64)]);
      const port = pullRequests ?? { defaultBranch: async () => "main", branchState: async () => ({ exists: true, headOid: "d".repeat(40), aheadBy: 0, defaultBranch: "main" }) };
      const over: Partial<RunnerCloudDeps> = { pullRequests: port as never, engineCommandSigner: async () => ({ keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", jobKeys.privateKey) }) as never };
      return { r, over };
    }
    const jobs = async (r: Rig) => (await h.admin.query<{ attempt: number; state: string }>("SELECT attempt, state FROM machine_jobs WHERE setup_id = $1 ORDER BY attempt", [r.setupId])).rows;

    it("two approves at once issue the install once: no second attempt, nothing superseded; the loser meets setup_phase", async () => {
      const { r, over } = await installRig();
      const settled = await Promise.allSettled([call(r, "POST", "approve", { version: 1 }, r.f.o1, r.setupId, over), call(r, "POST", "approve", { version: 1 }, r.f.a1, r.setupId, over)]);
      // The loser either meets the moved phase in its own transaction (a 409) or reports it beside its approval; never a second install.
      const won = settled.flatMap((x) => (x.status === "fulfilled" && (x.value.body as { install: unknown }).install !== null ? [x.value.body] : []));
      expect(won).toHaveLength(1);
      const loser = settled.find((x) => !(x.status === "fulfilled" && (x.value.body as { install: unknown }).install !== null))!;
      expect(loser.status === "rejected" ? [(loser.reason as RunnerHttpError).status, (loser.reason as RunnerHttpError).code] : (loser.value.body as { install_error: { code: string } }).install_error.code).toEqual(loser.status === "rejected" ? [409, "setup_phase"] : "setup_phase");
      const all = await jobs(r);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ attempt: 1 });
      expect(all[0]!.state).not.toBe("superseded");
      expect((await h.admin.query("SELECT phase, attempt FROM project_setups WHERE id = $1", [r.setupId])).rows[0]).toEqual({ phase: "install", attempt: 1 });
    });

    it("Approve's issue refuses once the install is out (409 setup_phase, one job kept); only the retry route's own call may issue again", async () => {
      const { r, over } = await installRig();
      expect((await call(r, "POST", "approve", { version: 1 }, r.f.o1, r.setupId, over)).body).toMatchObject({ install: { attempt: 1 } });
      await refused(issueProjectSetup(r.deps(over), as(r), r.setupId, { fromApprove: true }), 409, "setup_phase");
      expect(await jobs(r)).toEqual([{ attempt: 1, state: expect.not.stringMatching(/^superseded$/) }]);
    });

    it("a non-HTTP failure of the issuer after the commit is install_error beside the approval, not a 500, and leaks nothing of the error", async () => {
      const { r, over } = await installRig({ defaultBranch: async () => { throw new Error("secret boom"); }, branchState: async () => ({}) });
      const res = (await call(r, "POST", "approve", { version: 1 }, r.f.o1, r.setupId, over)).body as { approved: boolean; install: unknown; install_error: { code: string; message: string } };
      expect([res.approved, res.install, res.install_error.code]).toEqual([true, null, "install_error"]);
      expect(res.install_error.message).not.toContain("boom");
      expect((await draftRow(r.draftId)).status).toBe("approved");
    });

    it("an approve UPDATE that lands on no row writes no audit row and answers 409 setup_phase", async () => {
      const r = await rig({ plan: false });
      const fn = `fx_t_skip_${r.draftId.replaceAll("-", "")}`;
      await h.admin.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${r.draftId}' AND NEW.status = 'approved' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
      await h.admin.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON project_drafts FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      try {
        await refused(call(r, "POST", "approve", { version: 1 }), 409, "setup_phase");
      } finally {
        await h.admin.query(`DROP TRIGGER ${fn} ON project_drafts`);
        await h.admin.query(`DROP FUNCTION ${fn}()`);
      }
      expect((await draftRow(r.draftId)).status).toBe("draft");
      expect(await audits(r)).toEqual([]);
    });

    it("the PRD length counts code points like the column: 150000 astral characters (300000 UTF-16 units) approve", async () => {
      const r = await rig({ plan: false, prd: "\u{1F600}".repeat(150_000) });
      const res = (await call(r, "POST", "approve", { version: 1 })).body as { approved: boolean };
      expect(res.approved).toBe(true);
      expect((await draftRow(r.draftId)).status).toBe("approved");
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
      // A visibility that cannot be read is refused the same way, before any write.
      const unknown = await rig();
      const before = (await h.admin.query("SELECT updated_at FROM project_setups WHERE id = $1", [unknown.setupId])).rows[0].updated_at;
      await refused(call(unknown, "POST", "restart", null, unknown.f.o1, unknown.setupId, { repoVisibility: async () => "unknown" }), 409, "repo_visibility_unknown");
      expect((await draftRow(unknown.draftId)).status).toBe("draft");
      expect((await h.admin.query("SELECT phase, updated_at FROM project_setups WHERE id = $1", [unknown.setupId])).rows[0]).toEqual({ phase: "plan", updated_at: before });
      const r = await rig();
      // No survey ports are configured, so the start itself refuses 503 not_configured.
      await refused(call(r, "POST", "restart"), 503, "not_configured");
      expect((await draftRow(r.draftId)).status).toBe("draft");
      expect((await h.admin.query("SELECT phase, state FROM project_setups WHERE id = $1", [r.setupId])).rows[0]).toEqual({ phase: "plan", state: "ok" });
    });
  });
});
