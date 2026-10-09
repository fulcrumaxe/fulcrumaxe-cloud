import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { LOCAL_AUTO_MERGE_COPY_SHA256, setExecutionMode } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

const NAME = "Acme/widgets";
type Visibility = "private" | "public" | "unknown" | "throw";

describe("execution mode and the auto-merge opt-in [pg] (criterion 4, C12 section 5, C14 section 2)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  async function repo(f: F2Fixture, mode = "runner_local"): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'Acme', 'widgets', $4)", [
      id,
      f.accountId,
      Math.floor(Math.random() * 1e12),
      mode,
    ]);
    return id;
  }
  const asked: string[] = [];
  const call = (f: F2Fixture, userId: string, repoId: string, body: unknown, visibility: Visibility = "private") =>
    respond(() =>
      setExecutionMode(
        h.deps({
          repoVisibility: async (_a, r) => {
            asked.push(r);
            if (visibility === "throw") throw new Error("down");
            return visibility;
          },
        }),
        { accountId: f.accountId, userId },
        repoId,
        body,
      ),
    );
  const row = async (id: string) => (await h.admin.query("SELECT execution_mode FROM repos WHERE id = $1", [id])).rows[0].execution_mode as string;
  const optedIn = async (id: string) => (await h.admin.query("SELECT 1 FROM repo_local_review_optins WHERE repo_id = $1", [id])).rowCount === 1;
  const audits = async (f: F2Fixture) => (await h.admin.query("SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'repo.%' ORDER BY created_at, action DESC", [f.accountId])).rows;
  const code = (res: { body: unknown }) => (res.body as { error: { code: string } }).error.code;
  const ON = (name: unknown = NAME, sha: unknown = LOCAL_AUTO_MERGE_COPY_SHA256) => ({ auto_merge: true, confirm_repo: name, copy_sha256: sha });
  const ONLY = (fields: Record<string, unknown>) => ({ auto_merge: true, ...fields });

  it("pins the hash to the wording the server ships", () => {
    expect(LOCAL_AUTO_MERGE_COPY_SHA256).toBe(createHash("sha256").update(COPY.localAutoMerge).digest("hex"));
  });

  describe("turning auto-merge on", () => {
    it("with the repo's exact name and the shipped wording's hash: on, with one audit row that carries the hash", async () => {
      const f = await fresh();
      const id = await repo(f);
      const res = await call(f, f.a1, id, ON());
      expect(res).toMatchObject({ status: 200, body: { execution_mode: "runner_local", auto_merge: true, changed: true } });
      expect(await optedIn(id)).toBe(true);
      expect(await audits(f)).toEqual([{ actor: f.a1, action: "repo.local_review_auto_merge.enabled", payload: { repo_id: id, copy_sha256: LOCAL_AUTO_MERGE_COPY_SHA256 } }]);
    });

    it("a wrong name, a missing name and another repo's name: 400 confirmation_mismatch, no row change, no audit row", async () => {
      const f = await fresh();
      const id = await repo(f);
      const other = await repo(f);
      for (const typed of ["acme/widgets", "Acme/widgets ", " Acme/widgets", "Acme/gadgets", "widgets", "", null, 5, `${other}`]) {
        const res = await call(f, f.o1, id, ONLY({ confirm_repo: typed, copy_sha256: LOCAL_AUTO_MERGE_COPY_SHA256 }));
        expect(res.status, String(typed)).toBe(400);
        expect(code(res)).toBe("confirmation_mismatch");
      }
      expect((await call(f, f.o1, id, { auto_merge: true, copy_sha256: LOCAL_AUTO_MERGE_COPY_SHA256 })).status).toBe(400);
      expect(await optedIn(id)).toBe(false);
      expect(await audits(f)).toEqual([]);
    });

    it("a repo with no stored name can never be confirmed", async () => {
      const f = await fresh();
      const id = await repo(f);
      await h.admin.query("UPDATE repos SET gh_owner = NULL, gh_name = NULL WHERE id = $1", [id]);
      expect((await call(f, f.o1, id, ON("null/null"))).status).toBe(400);
      expect((await call(f, f.o1, id, ON(""))).status).toBe(400);
    });

    it("a stale or malformed copy hash: 409 copy_changed, nothing written", async () => {
      const f = await fresh();
      const id = await repo(f);
      for (const sha of [createHash("sha256").update("older wording").digest("hex"), "abc", 7, LOCAL_AUTO_MERGE_COPY_SHA256.toUpperCase()]) {
        const res = await call(f, f.o1, id, ONLY({ confirm_repo: NAME, copy_sha256: sha }));
        expect(res.status).toBe(409);
        expect(code(res)).toBe("copy_changed");
      }
      expect(code(await call(f, f.o1, id, ONLY({ confirm_repo: NAME })))).toBe("copy_changed");
      expect(await optedIn(id)).toBe(false);
      expect(await audits(f)).toEqual([]);
    });

    it("the name is reported before the hash", async () => {
      const f = await fresh();
      const id = await repo(f);
      expect(code(await call(f, f.o1, id, ON("nope", "stale")))).toBe("confirmation_mismatch");
    });

    it("a member gets 403, even with the right name and hash; a stranger from another account gets 403 too", async () => {
      const f = await fresh();
      const g = await fresh();
      const id = await repo(f);
      expect((await call(f, f.m1, id, ON())).status).toBe(403);
      expect((await call(f, g.o1, id, ON())).status).toBe(403);
      expect(await optedIn(id)).toBe(false);
      expect(await audits(f)).toEqual([]);
    });

    it("a repo on the sandbox: 409 not_runner_local; another account's repo and an unknown id: 404", async () => {
      const f = await fresh();
      const g = await fresh();
      const sandbox = await repo(f, "sandbox");
      expect(code(await call(f, f.o1, sandbox, ON()))).toBe("not_runner_local");
      const theirs = await repo(g);
      expect((await call(f, f.o1, theirs, ON())).status).toBe(404);
      expect((await call(f, f.o1, randomUUID(), ON())).status).toBe(404);
      expect((await call(f, f.o1, "nope", ON())).status).toBe(404);
    });

    it("turning it on twice changes nothing the second time and writes no second audit row", async () => {
      const f = await fresh();
      const id = await repo(f);
      await call(f, f.a1, id, ON());
      expect(await call(f, f.a1, id, ON())).toMatchObject({ status: 200, body: { auto_merge: true, changed: false } });
      expect(await audits(f)).toHaveLength(1);
    });
  });

  describe("turning auto-merge off", () => {
    it("an owner or admin turns it off with no name asked, and one audit row records it; a member gets 403", async () => {
      const f = await fresh();
      const id = await repo(f);
      await call(f, f.o1, id, ON());
      expect((await call(f, f.m1, id, { auto_merge: false })).status).toBe(403);
      expect(await optedIn(id)).toBe(true);
      expect(await call(f, f.a2, id, { auto_merge: false })).toMatchObject({ status: 200, body: { auto_merge: false, changed: true } });
      expect(await optedIn(id)).toBe(false);
      const log = await audits(f);
      expect(log.map((r) => r.action)).toEqual(["repo.local_review_auto_merge.enabled", "repo.local_review_auto_merge.disabled"]);
      expect(log[1]).toMatchObject({ actor: f.a2 });
    });

    it("rejects a body that mixes the shapes or carries unknown keys", async () => {
      const f = await fresh();
      const id = await repo(f);
      for (const body of [{ auto_merge: false, confirm_repo: NAME }, { auto_merge: "yes" }, {}, [], null, { mode: "sandbox", auto_merge: true }, { auto_merge: true, account_id: f.accountId }]) {
        expect((await call(f, f.o1, id, body)).status, JSON.stringify(body)).toBe(400);
      }
    });
  });

  describe("changing the mode", () => {
    it("needs the typed name both ways, and a wrong one writes nothing", async () => {
      const f = await fresh();
      const id = await repo(f, "sandbox");
      expect(code(await call(f, f.o1, id, { mode: "runner_local", confirm_repo: "Acme/gadgets" }))).toBe("confirmation_mismatch");
      expect(code(await call(f, f.o1, id, { mode: "runner_local" }))).toBe("confirmation_mismatch");
      expect(await row(id)).toBe("sandbox");
      expect(await audits(f)).toEqual([]);
      expect(await call(f, f.o1, id, { mode: "runner_local", confirm_repo: NAME })).toMatchObject({ status: 200, body: { execution_mode: "runner_local", auto_merge: false, changed: true } });
      expect(await row(id)).toBe("runner_local");
      expect(code(await call(f, f.o1, id, { mode: "sandbox" }))).toBe("confirmation_mismatch");
      expect(await row(id)).toBe("runner_local");
    });

    it("an owner or admin only: a member gets 403 and nothing changes", async () => {
      const f = await fresh();
      const id = await repo(f, "sandbox");
      expect((await call(f, f.m1, id, { mode: "runner_local", confirm_repo: NAME })).status).toBe(403);
      expect(await row(id)).toBe("sandbox");
    });

    it("refuses runner_verified and unknown modes before touching anything", async () => {
      const f = await fresh();
      const id = await repo(f, "sandbox");
      expect(code(await call(f, f.o1, id, { mode: "runner_verified", confirm_repo: NAME }))).toBe("mode_not_available");
      expect((await call(f, f.o1, id, { mode: "container", confirm_repo: NAME })).status).toBe(400);
      expect(await row(id)).toBe("sandbox");
    });

    it("never puts a public repo, or one whose visibility cannot be read, on a runner; writes nothing", async () => {
      const f = await fresh();
      const id = await repo(f, "sandbox");
      for (const [seen, want] of [["public", "public_repo"], ["unknown", "repo_visibility_unknown"], ["throw", "repo_visibility_unknown"]] as const) {
        const res = await call(f, f.o1, id, { mode: "runner_local", confirm_repo: NAME }, seen);
        expect(res.status).toBe(409);
        expect(code(res)).toBe(want);
      }
      const noPort = await respond(() => setExecutionMode(h.deps(), { accountId: f.accountId, userId: f.o1 }, id, { mode: "runner_local", confirm_repo: NAME }));
      expect(code(noPort)).toBe("repo_visibility_unknown");
      expect(await row(id)).toBe("sandbox");
      expect(await audits(f)).toEqual([]);
    });

    it("does not ask GitHub when the repo is already there or is leaving a runner, and a same-mode request changes nothing", async () => {
      const f = await fresh();
      const id = await repo(f);
      asked.length = 0;
      expect(await call(f, f.o1, id, { mode: "runner_local", confirm_repo: NAME })).toMatchObject({ status: 200, body: { changed: false } });
      expect(await call(f, f.o1, id, { mode: "sandbox", confirm_repo: NAME }, "public")).toMatchObject({ status: 200, body: { execution_mode: "sandbox", changed: true } });
      expect(asked).toEqual([]);
    });

    it("leaving runner_local while the opt-in is on turns both off in one transaction, with an audit row for each, and it comes back off", async () => {
      const f = await fresh();
      const id = await repo(f);
      await call(f, f.o1, id, ON());
      expect(await call(f, f.a1, id, { mode: "sandbox", confirm_repo: NAME })).toMatchObject({ status: 200, body: { execution_mode: "sandbox", auto_merge: false, changed: true } });
      expect(await row(id)).toBe("sandbox");
      expect(await optedIn(id)).toBe(false);
      const log = await audits(f);
      expect(log.map((r) => r.action)).toEqual(["repo.local_review_auto_merge.enabled", "repo.local_review_auto_merge.disabled", "repo.execution_mode.changed"]);
      expect(log[2]).toEqual({ actor: f.a1, action: "repo.execution_mode.changed", payload: { repo_id: id, from: "runner_local", to: "sandbox", auto_merge_turned_off: true, cancelled_runs: 0 } });
      await call(f, f.a1, id, { mode: "runner_local", confirm_repo: NAME });
      expect(await row(id)).toBe("runner_local");
      expect(await optedIn(id)).toBe(false);
    });

    it("is atomic: if the audit write fails, the opt-in is not left off and the mode is not left changed", async () => {
      const f = await fresh();
      const id = await repo(f);
      await call(f, f.o1, id, ON());
      await h.admin.query("CREATE OR REPLACE FUNCTION tai_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'repo.execution_mode.changed' THEN RAISE EXCEPTION 'blocked' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$");
      await h.admin.query("CREATE TRIGGER tai_block_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION tai_block_audit()");
      try {
        await expect(setExecutionMode(h.deps(), { accountId: f.accountId, userId: f.o1 }, id, { mode: "sandbox", confirm_repo: NAME })).rejects.toBeDefined();
      } finally {
        await h.admin.query("DROP TRIGGER tai_block_audit ON audit_log");
        await h.admin.query("DROP FUNCTION tai_block_audit()");
      }
      expect(await row(id)).toBe("runner_local");
      expect(await optedIn(id)).toBe(true);
    });
  });

  describe("leaving runner_local cancels the repo's queued runner runs (C24 section 2)", () => {
    const HOUR = 3_600_000;
    /** A runner run of the repo. `claimableAfter` makes it a follow-up waiting for its time; `job: false` is a run whose job was never written. */
    async function run(f: F2Fixture, repoId: string, o: { status?: string; job?: boolean; claimableAfter?: number; mode?: string } = {}): Promise<string> {
      const id = randomUUID();
      await h.admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, claimable_after)
         VALUES ($1, $2, 'code-reviewer', 'runner', $3, $7, $4, $5::jsonb, $6)`,
        [
          id,
          f.accountId,
          o.status ?? "pending",
          repoId,
          o.job === false ? null : JSON.stringify({ job: { expires_at: new Date(Date.now() + 72 * HOUR).toISOString() }, signature: "x" }),
          o.claimableAfter ? new Date(o.claimableAfter) : null,
          o.mode ?? "runner_local",
        ],
      );
      return id;
    }
    const status = async (id: string) => (await h.admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0].status as string;
    const moves = async (id: string) => (await h.admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [id])).rows.map((r) => r.payload);
    const domain = async (id: string) => (await h.admin.query("SELECT payload FROM domain_events WHERE subject_id = $1 AND type = 'run.status_changed'", [id])).rows.map((r) => r.payload);
    const leave = (f: F2Fixture, repoId: string, userId = f.o1) => call(f, userId, repoId, { mode: "sandbox", confirm_repo: NAME });

    it("in the switch's transaction, cancels pending runs including jobless ones and follow-ups waiting on claimable_after; running runs and other repos' runs are left alone", async () => {
      const f = await fresh();
      const id = await repo(f);
      const other = await repo(f);
      const plain = await run(f, id);
      const jobless = await run(f, id, { job: false });
      const followUp = await run(f, id, { claimableAfter: Date.now() + 20 * HOUR });
      const running = await run(f, id, { status: "running" });
      const done = await run(f, id, { status: "succeeded" });
      const elsewhere = await run(f, other);
      const res = await leave(f, id);
      expect(res).toMatchObject({ status: 200, body: { execution_mode: "sandbox", changed: true, cancelled_runs: 3 } });
      for (const r of [plain, jobless, followUp]) {
        expect(await status(r)).toBe("cancelled");
        expect(await moves(r)).toEqual([{ from: "pending", to: "cancelled", failureReason: "execution_mode_changed" }]);
        expect(await domain(r)).toEqual([{ runId: r, from: "pending", to: "cancelled" }]);
      }
      expect(await status(running)).toBe("running");
      expect(await status(done)).toBe("succeeded");
      expect(await status(elsewhere)).toBe("pending");
      for (const r of [running, done, elsewhere]) expect(await moves(r)).toEqual([]);
    });

    it("records the count on the audit row: 0 when nothing was queued", async () => {
      const f = await fresh();
      const id = await repo(f);
      const a = await run(f, id);
      const b = await run(f, id);
      const empty = await repo(f);
      expect(await leave(f, id)).toMatchObject({ body: { cancelled_runs: 2 } });
      expect(await leave(f, empty)).toMatchObject({ body: { cancelled_runs: 0 } });
      expect([await status(a), await status(b)]).toEqual(["cancelled", "cancelled"]);
      const log = (await audits(f)).filter((r) => r.action === "repo.execution_mode.changed");
      expect(log.map((r) => r.payload.cancelled_runs).sort()).toEqual([0, 2]);
      expect(log.find((r) => r.payload.repo_id === id)?.payload).toEqual({ repo_id: id, from: "runner_local", to: "sandbox", auto_merge_turned_off: false, cancelled_runs: 2 });
    });

    // D#6 R5b-1 (C26 section 3, C38): the repo is put in runner_verified directly (the route cannot set it yet); the route then moves it.
    it("a repo on runner_verified moving to runner_local cancels nothing: the verified run stays pending, and the audit row says 0", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_verified");
      const queued = await run(f, id, { mode: "runner_verified" });
      expect(await call(f, f.o1, id, { mode: "runner_local", confirm_repo: NAME })).toMatchObject({ status: 200, body: { execution_mode: "runner_local", changed: true, cancelled_runs: 0 } });
      expect(await status(queued)).toBe("pending");
      expect(await moves(queued)).toEqual([]);
      const log = (await audits(f)).filter((r) => r.action === "repo.execution_mode.changed");
      expect(log.map((r) => r.payload)).toEqual([{ repo_id: id, from: "runner_verified", to: "runner_local", auto_merge_turned_off: false, cancelled_runs: 0 }]);
    });

    it("a repo on runner_verified moving to sandbox cancels its pending verified runs with execution_mode_changed, and the audit row records the old mode", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_verified");
      const verified = await run(f, id, { mode: "runner_verified" });
      const local = await run(f, id);
      const running = await run(f, id, { status: "running", mode: "runner_verified" });
      expect(await leave(f, id)).toMatchObject({ status: 200, body: { execution_mode: "sandbox", changed: true, cancelled_runs: 2 } });
      for (const r of [verified, local]) {
        expect(await status(r)).toBe("cancelled");
        expect(await moves(r)).toEqual([{ from: "pending", to: "cancelled", failureReason: "execution_mode_changed" }]);
      }
      expect(await status(running)).toBe("running");
      const log = (await audits(f)).filter((r) => r.action === "repo.execution_mode.changed");
      expect(log.map((r) => r.payload)).toEqual([{ repo_id: id, from: "runner_verified", to: "sandbox", auto_merge_turned_off: false, cancelled_runs: 2 }]);
    });

    it("a refused switch (wrong name, a member, runner_verified) cancels nothing", async () => {
      const f = await fresh();
      const id = await repo(f);
      const queued = await run(f, id);
      expect(code(await call(f, f.o1, id, { mode: "sandbox", confirm_repo: "Acme/gadgets" }))).toBe("confirmation_mismatch");
      expect((await call(f, f.m1, id, { mode: "sandbox", confirm_repo: NAME })).status).toBe(403);
      expect(code(await call(f, f.o1, id, { mode: "runner_verified", confirm_repo: NAME }))).toBe("mode_not_available");
      expect(await status(queued)).toBe("pending");
      expect(await row(id)).toBe("runner_local");
    });

    it("a switch to the same mode, and a switch onto a runner, cancel nothing", async () => {
      const f = await fresh();
      const id = await repo(f);
      const queued = await run(f, id);
      expect(await call(f, f.o1, id, { mode: "runner_local", confirm_repo: NAME })).toMatchObject({ body: { changed: false, cancelled_runs: 0 } });
      expect(await status(queued)).toBe("pending");
      const sandbox = await repo(f, "sandbox");
      expect(await call(f, f.o1, sandbox, { mode: "runner_local", confirm_repo: NAME })).toMatchObject({ body: { changed: true, cancelled_runs: 0 } });
    });

    it("switching back to runner_local restores nothing", async () => {
      const f = await fresh();
      const id = await repo(f);
      const queued = await run(f, id);
      await leave(f, id);
      expect(await call(f, f.o1, id, { mode: "runner_local", confirm_repo: NAME })).toMatchObject({ body: { execution_mode: "runner_local", cancelled_runs: 0 } });
      expect(await status(queued)).toBe("cancelled");
      expect(await moves(queued)).toHaveLength(1);
    });

    it("is atomic: if recording the audit row fails, the runs are still pending and the mode is unchanged", async () => {
      const f = await fresh();
      const id = await repo(f);
      const queued = await run(f, id);
      await h.admin.query("CREATE OR REPLACE FUNCTION tai_block_audit2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'repo.execution_mode.changed' THEN RAISE EXCEPTION 'blocked' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$");
      await h.admin.query("CREATE TRIGGER tai_block_audit2 BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION tai_block_audit2()");
      try {
        await expect(setExecutionMode(h.deps(), { accountId: f.accountId, userId: f.o1 }, id, { mode: "sandbox", confirm_repo: NAME })).rejects.toBeDefined();
      } finally {
        await h.admin.query("DROP TRIGGER tai_block_audit2 ON audit_log");
        await h.admin.query("DROP FUNCTION tai_block_audit2()");
      }
      expect(await status(queued)).toBe("pending");
      expect(await moves(queued)).toEqual([]);
      expect(await row(id)).toBe("runner_local");
    });
  });
});
