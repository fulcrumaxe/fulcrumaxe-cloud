import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { allowanceSetSha256, parseAllowanceSet, type AllowanceEntry } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { getSandboxAllowances, setExecutionMode, setSandboxAllowances } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

const NAME = "Acme/widgets";
const WHY = "needed by a step of check.sh, proved by a denial";
const entry = (kind: AllowanceEntry["kind"], value: string, access: AllowanceEntry["access"]): AllowanceEntry => ({ kind, value, access, reason: WHY });
const NPM = entry("domain", "registry.npmjs.org", "connect");
const STORE = entry("path", "/nix/store", "read");
const SET = { entries: [NPM, STORE], command_timeout_s: 900 };

/** D#6 R7a (C35): the admin-uploaded allowance set, its approval and its undo paths, against a real database. */
describe("sandbox allowances [pg] (C35 section 3.4, C15 section 4)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  async function repo(f: F2Fixture, mode = "runner_local"): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'Acme', 'widgets', $4)", [id, f.accountId, Math.floor(Math.random() * 1e12), mode]);
    return id;
  }
  const put = (f: F2Fixture, userId: string, repoId: string, body: unknown) => respond(() => setSandboxAllowances(h.deps(), { accountId: f.accountId, userId }, repoId, body));
  const get = (f: F2Fixture, userId: string, repoId: string) => respond(() => getSandboxAllowances(h.deps(), { accountId: f.accountId, userId }, repoId));
  const stored = async (repoId: string) => (await h.admin.query("SELECT version, set_aside, set_sha256, command_timeout_s, entries FROM repo_runner_sandbox_allowances WHERE repo_id = $1 ORDER BY version", [repoId])).rows;
  const audits = async (f: F2Fixture) => (await h.admin.query("SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'repo.runner_sandbox_allowances.%' ORDER BY created_at, id", [f.accountId])).rows;
  const code = (res: { body: unknown }) => (res.body as { error: { code: string } }).error.code;
  const ok = (set: unknown = SET, name: unknown = NAME) => ({ set, confirm_repo: name });

  describe("approving a set", () => {
    it("stores what the admin sent with its hash, answers it back, and writes one audit row that carries the hash", async () => {
      const f = await fresh();
      const id = await repo(f);
      const parsed = parseAllowanceSet(SET);
      if (!parsed.ok) throw new Error("fixture set refused");
      const sha = allowanceSetSha256(parsed.set);
      const res = await put(f, f.o1, id, ok());
      expect(res).toMatchObject({ status: 200, body: { repo_id: id, in_use: true, set_aside: false, changed: true, can_change: true, approved: { version: 1, command_timeout_s: 900, set_sha256: sha } } });
      // Stored sorted (domain before path), so the same set always has the same hash.
      expect((res.body as { approved: { entries: AllowanceEntry[] } }).approved.entries.map((e) => e.kind)).toEqual(["domain", "path"]);
      expect(await stored(id)).toMatchObject([{ version: 1, set_aside: false, set_sha256: sha, command_timeout_s: 900 }]);
      expect(await audits(f)).toEqual([{ actor: f.o1, action: "repo.runner_sandbox_allowances.approved", payload: { repo_id: id, version: 1, set_sha256: sha, entry_count: 2, command_timeout_s: 900, previous_set_sha256: null } }]);
    });

    it("an admin may approve; the same set again writes nothing and says changed: false", async () => {
      const f = await fresh();
      const id = await repo(f);
      await put(f, f.o1, id, ok());
      expect(await put(f, f.a1, id, ok({ ...SET, entries: [STORE, NPM] }))).toMatchObject({ status: 200, body: { changed: false, approved: { version: 1 } } });
      expect(await audits(f)).toHaveLength(1);
    });

    it("a wrong, missing or other repo's name is 400 confirmation_mismatch and writes nothing", async () => {
      const f = await fresh();
      const id = await repo(f);
      for (const typed of ["acme/widgets", "Acme/widgets ", " Acme/widgets", "Acme/gadgets", "widgets", "", null, 5, id]) {
        const res = await put(f, f.o1, id, ok(SET, typed));
        expect(res.status, String(typed)).toBe(400);
        expect(code(res)).toBe("confirmation_mismatch");
      }
      expect(code(await put(f, f.o1, id, { set: SET }))).toBe("confirmation_mismatch");
      expect(await stored(id)).toEqual([]);
      expect(await audits(f)).toEqual([]);
    });

    it("a repo with no stored name can never be confirmed", async () => {
      const f = await fresh();
      const id = await repo(f);
      await h.admin.query("UPDATE repos SET gh_owner = NULL, gh_name = NULL WHERE id = $1", [id]);
      expect((await put(f, f.o1, id, ok(SET, "null/null"))).status).toBe(400);
      expect((await put(f, f.o1, id, ok(SET, ""))).status).toBe(400);
    });

    it("a member gets 403, even with the right name; a stranger from another account gets 403 too; nothing is written", async () => {
      const f = await fresh();
      const g = await fresh();
      const id = await repo(f);
      expect((await put(f, f.m1, id, ok())).status).toBe(403);
      expect((await put(f, g.o1, id, ok())).status).toBe(403);
      expect(await stored(id)).toEqual([]);
      expect(await audits(f)).toEqual([]);
    });

    it("an unknown repo, another account's repo and a malformed id are 404", async () => {
      const f = await fresh();
      const g = await fresh();
      const theirs = await repo(g);
      expect((await put(f, f.o1, randomUUID(), ok())).status).toBe(404);
      expect((await put(f, f.o1, theirs, ok())).status).toBe(404);
      expect((await put(f, f.o1, "nope", ok())).status).toBe(404);
      expect(await stored(theirs)).toEqual([]);
    });

    it("a set with entries is for a repo on a runner (409); a sandbox repo takes none", async () => {
      const f = await fresh();
      const id = await repo(f, "sandbox");
      expect(code(await put(f, f.o1, id, ok()))).toBe("not_runner_local");
      expect(await stored(id)).toEqual([]);
    });

    it("the name is reported before the mode, the role before the name, and the body shape before both", async () => {
      const f = await fresh();
      const id = await repo(f, "sandbox");
      expect(code(await put(f, f.o1, id, ok(SET, "nope")))).toBe("confirmation_mismatch");
      expect((await put(f, f.m1, id, ok(SET, "nope"))).status).toBe(403);
      expect((await put(f, f.m1, id, { nonsense: 1 })).status).toBe(400);
    });

    it.each([
      ["home directory", entry("path", "/home/ian/.cache", "read"), "path_home"],
      ["a credential directory", entry("path", "/opt/x/.ssh", "read"), "path_credential"],
      ["/etc", entry("path", "/etc", "read"), "path_system"],
      ["the root", entry("path", "/", "read"), "path_malformed"],
      ["the Nix daemon socket", entry("path", "/nix/var/nix/daemon-socket/socket", "read"), "path_socket"],
      ["a docker socket", entry("path", "/var/run/docker.sock", "read"), "path_socket"],
      ["a write to the store", entry("path", "/nix/store", "write"), "path_write_outside_tmp"],
      ["a wildcard domain", entry("domain", "*.npmjs.org", "connect"), "domain_wildcard"],
      ["a bare IP", entry("domain", "93.184.216.34", "connect"), "domain_address"],
      ["the metadata address", entry("domain", "169.254.169.254", "connect"), "domain_address"],
      ["a private name", entry("domain", "db.internal", "connect"), "domain_private"],
      ["a loopback target", entry("loopback", "10.0.0.1", "bind"), "loopback_value"],
    ] as const)("refuses %s with 400 sandbox_allowance_refused, naming the reason and the entry, and writes nothing", async (_name, bad, reason) => {
      const f = await fresh();
      const id = await repo(f);
      const res = await put(f, f.o1, id, ok({ entries: [NPM, bad], command_timeout_s: 900 }));
      expect(res.status).toBe(400);
      expect(code(res)).toBe("sandbox_allowance_refused");
      expect(res.body).toMatchObject({ reason, index: 1 });
      expect(await stored(id)).toEqual([]);
      expect(await audits(f)).toEqual([]);
    });

    it("the floor is checked before the name: a refused set is refused whatever is typed", async () => {
      const f = await fresh();
      const id = await repo(f);
      expect(code(await put(f, f.o1, id, ok({ entries: [entry("path", "/home/x", "read")], command_timeout_s: 60 }, "wrong")))).toBe("sandbox_allowance_refused");
    });

    it("rejects an unknown key, a missing set, a non-object, a missing timeout and a timeout over 1800", async () => {
      const f = await fresh();
      const id = await repo(f);
      for (const body of [{}, [], null, "x", { set: SET, extra: 1 }, { confirm_repo: NAME }, { set: SET, confirm_repo: NAME, account_id: f.accountId }]) {
        expect((await put(f, f.o1, id, body)).status, JSON.stringify(body)).toBe(400);
      }
      for (const set of [{ entries: [NPM] }, { entries: [NPM], command_timeout_s: 1801 }, { entries: [NPM], command_timeout_s: 0 }, { entries: [NPM, NPM], command_timeout_s: 60 }]) {
        expect(code(await put(f, f.o1, id, ok(set))), JSON.stringify(set)).toBe("sandbox_allowance_refused");
      }
      expect(await stored(id)).toEqual([]);
    });
  });

  describe("the empty set and the undo paths", () => {
    it("an empty set needs no name and is allowed on a sandbox repo; it writes an audit row; a timeout with it is refused", async () => {
      const f = await fresh();
      const id = await repo(f, "sandbox");
      expect(await put(f, f.a1, id, { set: { entries: [] } })).toMatchObject({ status: 200, body: { changed: true, in_use: false, approved: { version: 1, entries: [], command_timeout_s: null } } });
      expect((await audits(f)).map((r) => r.payload)).toMatchObject([{ entry_count: 0, command_timeout_s: null }]);
      expect(code(await put(f, f.a1, id, { set: { entries: [], command_timeout_s: 60 } }))).toBe("sandbox_allowance_refused");
      expect(await put(f, f.a1, id, { set: { entries: [] } })).toMatchObject({ status: 200, body: { changed: false } });
    });

    it("a smaller set, then the empty set, replace what was approved from the next job; history stays on record", async () => {
      const f = await fresh();
      const id = await repo(f);
      await put(f, f.o1, id, ok());
      expect(await put(f, f.o1, id, ok({ entries: [NPM], command_timeout_s: 600 }))).toMatchObject({ body: { approved: { version: 2, command_timeout_s: 600 }, in_use: true } });
      // Approving an empty set (the safe direction) needs no name even on a repo that has a set.
      expect(await put(f, f.a2, id, { set: { entries: [] } })).toMatchObject({ body: { approved: { version: 3, entries: [] }, in_use: false } });
      expect((await stored(id)).map((r) => [r.version, r.entries.length])).toEqual([[1, 2], [2, 1], [3, 0]]);
      expect((await audits(f)).map((r) => r.payload.entry_count)).toEqual([2, 1, 0]);
    });

    it("leaving runner_local sets the approved set aside, in the same transaction; coming back needs a new approval", async () => {
      const f = await fresh();
      const id = await repo(f);
      await put(f, f.o1, id, ok());
      const mode = (body: unknown) => respond(() => setExecutionMode(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, id, body));
      expect(await mode({ mode: "sandbox", confirm_repo: NAME })).toMatchObject({ status: 200, body: { execution_mode: "sandbox", changed: true } });
      expect(await get(f, f.m1, id)).toMatchObject({ status: 200, body: { execution_mode: "sandbox", in_use: false, set_aside: true, approved: { version: 2, entries: [{}, {}] } } });
      expect((await stored(id)).map((r) => [r.version, r.set_aside])).toEqual([[1, false], [2, true]]);
      expect((await audits(f)).map((r) => r.action)).toEqual(["repo.runner_sandbox_allowances.approved", "repo.runner_sandbox_allowances.set_aside"]);
      expect(await mode({ mode: "runner_local", confirm_repo: NAME })).toMatchObject({ status: 200, body: { execution_mode: "runner_local" } });
      // Back on a runner, but the set is still set aside: it rides in no job until an admin approves it again.
      expect(await get(f, f.m1, id)).toMatchObject({ body: { execution_mode: "runner_local", in_use: false, set_aside: true } });
      expect(await put(f, f.o1, id, ok())).toMatchObject({ status: 200, body: { changed: true, in_use: true, set_aside: false, approved: { version: 3 } } });
    });

    it("a mode change on a repo with no allowances writes nothing extra", async () => {
      const f = await fresh();
      const id = await repo(f);
      await respond(() => setExecutionMode(h.deps(), { accountId: f.accountId, userId: f.o1 }, id, { mode: "sandbox", confirm_repo: NAME }));
      expect(await stored(id)).toEqual([]);
    });

    it("another repo's set is untouched when one repo leaves the runner", async () => {
      const f = await fresh();
      const a = await repo(f);
      const b = await repo(f);
      await put(f, f.o1, a, ok());
      await put(f, f.o1, b, ok());
      await respond(() => setExecutionMode(h.deps(), { accountId: f.accountId, userId: f.o1 }, a, { mode: "sandbox", confirm_repo: NAME }));
      expect((await stored(b)).map((r) => r.set_aside)).toEqual([false]);
    });
  });

  describe("a PUT racing the mode switch", () => {
    it("waits for the switch's row lock, then sees the new mode and refuses: no in-force set is left on a repo that is not on a runner", async () => {
      const f = await fresh();
      const id = await repo(f);
      // The switch, mid-transaction: it holds the repo row and has changed the mode, and has not committed.
      await h.admin.query("BEGIN");
      await h.admin.query("SELECT 1 FROM repos WHERE id = $1 FOR UPDATE", [id]);
      await h.admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [id]);
      let settled = false;
      const racing = put(f, f.o1, id, ok()).then((res) => ((settled = true), res));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled, "the PUT must wait for the switch").toBe(false);
      await h.admin.query("COMMIT");
      const res = await racing;
      expect(res.status).toBe(409);
      expect(code(res)).toBe("not_runner_local");
      expect(await stored(id)).toEqual([]);
    });
  });

  describe("reading", () => {
    it("any member reads the approved set (read-only: can_change is false); none yet is approved: null", async () => {
      const f = await fresh();
      const id = await repo(f);
      expect(await get(f, f.m1, id)).toMatchObject({ status: 200, body: { repo_id: id, approved: null, in_use: false, set_aside: false, can_change: false, limits: { max_entries: 64, max_command_timeout_s: 1800 } } });
      await put(f, f.o1, id, ok());
      expect(await get(f, f.m1, id)).toMatchObject({ body: { approved: { version: 1 }, in_use: true, can_change: false } });
      expect(await get(f, f.a1, id)).toMatchObject({ body: { can_change: true } });
    });

    it("another account's repo and an unknown id are 404; a stranger's read of this account's repo is refused", async () => {
      const f = await fresh();
      const g = await fresh();
      const id = await repo(f);
      expect((await get(f, f.m1, randomUUID())).status).toBe(404);
      expect((await get(g, g.m1, id)).status).toBe(404);
      expect((await get(f, g.o1, id)).status).toBe(403);
      expect((await get(f, f.m1, "nope")).status).toBe(404);
    });
  });

  describe("the cloud never reads the repository (C35)", () => {
    it("approving, reading and setting aside make no network call at all: a fetch that throws and a GitHub port that throws are never reached", async () => {
      const f = await fresh();
      const id = await repo(f);
      const fetchSpy = vi.fn(() => Promise.reject(new Error("no network call expected")));
      vi.stubGlobal("fetch", fetchSpy);
      let touched = 0;
      const trap = new Proxy({}, { get: () => { touched += 1; throw new Error("no GitHub call expected"); } });
      const deps = h.deps({ pullRequests: trap as never, repoVisibility: async () => { touched += 1; throw new Error("no visibility read expected"); } });
      try {
        const principal = { accountId: f.accountId, userId: f.o1 };
        expect((await respond(() => setSandboxAllowances(deps, principal, id, ok()))).status).toBe(200);
        expect((await respond(() => getSandboxAllowances(deps, principal, id))).status).toBe(200);
        // Leaving a runner reads no visibility and makes no GitHub call either.
        expect((await respond(() => setExecutionMode(deps, principal, id, { mode: "sandbox", confirm_repo: NAME }))).status).toBe(200);
        expect((await respond(() => setSandboxAllowances(deps, principal, id, { set: { entries: [] } }))).status).toBe(200);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(touched).toBe(0);
    });
  });
});
