import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { CLOUD_VERIFIED_COPY_SHA256, LOCAL_AUTO_MERGE_COPY_SHA256, getRepoMode, setExecutionMode } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

/** [pg] D#6 R5b-2b-iii (C40): the state-read route behind the repo mode picker. Real rows, real row security. */
describe("GET /api/runners/repos/:id/execution-mode [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  async function repo(f: F2Fixture, mode = "sandbox", owner: string | null = "Acme", name: string | null = "widgets"): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', $4, $5, $6)", [id, f.accountId, Math.floor(Math.random() * 1e12), owner, name, mode]);
    return id;
  }
  async function key(f: F2Fixture, status: string): Promise<void> {
    await h.admin.query("INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status) VALUES ($1, 'anthropic', $2, $3, $4, 1, $5, $6)", [
      f.accountId,
      Buffer.from("secret-ciphertext"),
      Buffer.from("n"),
      Buffer.from("w"),
      `fp-${randomUUID()}`,
      status,
    ]);
  }
  const get = (f: F2Fixture, userId: string, repoId: string) => respond(() => getRepoMode(h.deps(), { accountId: f.accountId, userId }, repoId));
  const body = (res: { body: unknown }) => res.body as Record<string, unknown>;

  it("answers the mode, the full name and the hash of the shipped cloud-verified wording; the hash is the sha256 of COPY.cloudVerified", async () => {
    const f = await fresh();
    const id = await repo(f, "runner_local");
    const res = await get(f, f.m1, id);
    expect(res.status).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("no-store");
    expect(body(res)).toMatchObject({ repo_id: id, execution_mode: "runner_local", full_name: "Acme/widgets", copy_sha256: CLOUD_VERIFIED_COPY_SHA256 });
    expect(body(res).copy_sha256).toBe(createHash("sha256").update(COPY.cloudVerified, "utf8").digest("hex"));
    expect((body(res).copy as Record<string, string>).cloudVerifiedHelp).toBe(COPY.cloudVerified);
    expect((body(res).copy as Record<string, string>).keyRequired).toBe(COPY.keyRequired);
  });

  it("answers whether local-review auto-merge is on, the hash of its wording and the wording; reading it back after turning it on", async () => {
    const f = await fresh();
    const id = await repo(f, "runner_local");
    const off = body(await get(f, f.m1, id));
    expect(off).toMatchObject({ auto_merge: false, auto_merge_copy_sha256: LOCAL_AUTO_MERGE_COPY_SHA256 });
    expect(off.auto_merge_copy_sha256).toBe(createHash("sha256").update(COPY.localAutoMerge, "utf8").digest("hex"));
    expect((off.copy as Record<string, string>).autoMergeWording).toBe(COPY.localAutoMerge);
    const on = await respond(() => setExecutionMode(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, id, { auto_merge: true, confirm_repo: "Acme/widgets", copy_sha256: LOCAL_AUTO_MERGE_COPY_SHA256 }));
    expect(on.status).toBe(200);
    expect(body(await get(f, f.m1, id)).auto_merge).toBe(true);
  });

  it("key_required is true with no key connected and with only a broken key", async () => {
    const f = await fresh();
    const id = await repo(f);
    expect(body(await get(f, f.o1, id)).key_required).toBe(true);
    await key(f, "broken");
    expect(body(await get(f, f.o1, id)).key_required).toBe(true);
  });

  it("key_required is false with an ok key or an unvalidated one, and says only a boolean: no key material is in the answer", async () => {
    for (const status of ["ok", "unvalidated"]) {
      const f = await fresh();
      const id = await repo(f);
      await key(f, status);
      const res = await get(f, f.a1, id);
      expect(body(res).key_required, status).toBe(false);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain("secret-ciphertext");
      expect(text).not.toContain("fp-");
      expect(text).not.toContain("anthropic");
    }
  });

  it("another account's key does not count", async () => {
    const f = await fresh();
    const other = await fresh();
    await key(other, "ok");
    expect(body(await get(f, f.o1, await repo(f))).key_required).toBe(true);
  });

  it("any member reads it; can_change is true for an owner and an admin only", async () => {
    const f = await fresh();
    const id = await repo(f);
    expect(body(await get(f, f.m1, id)).can_change).toBe(false);
    expect(body(await get(f, f.o1, id)).can_change).toBe(true);
    expect(body(await get(f, f.a1, id)).can_change).toBe(true);
  });

  it("a user who is not a member of the account gets 403 and nothing about the repo", async () => {
    const f = await fresh();
    const outsider = await fresh();
    const id = await repo(f);
    const res = await get(f, outsider.o1, id);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("widgets");
  });

  it("another account's repo is 404 for a member, and so are a malformed id and an id that does not exist", async () => {
    const f = await fresh();
    const other = await fresh();
    const theirs = await repo(other);
    expect((await get(f, f.o1, theirs)).status).toBe(404);
    expect((await get(f, f.o1, "not-a-uuid")).status).toBe(404);
    expect((await get(f, f.o1, randomUUID())).status).toBe(404);
  });

  it("a repo with no stored name has a null full_name, never the word null in a string", async () => {
    const f = await fresh();
    const id = await repo(f, "sandbox", null, null);
    expect(body(await get(f, f.o1, id)).full_name).toBeNull();
  });

  // D#767: the confirm step's three new facts (criteria 1-3).
  describe("pending_runner_runs and the allowance flags", () => {
    async function queuedRun(f: F2Fixture, repoId: string, status = "pending", runtime = "runner"): Promise<string> {
      const id = randomUUID();
      await h.admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, 'code-reviewer', $3, $4, $5, $6)", [id, f.accountId, runtime, status, runtime === "runner" ? "runner_local" : "sandbox", repoId]);
      return id;
    }
    async function approve(f: F2Fixture, repoId: string, entries: unknown[], opts: { setAside?: boolean; checkArgv?: string[] | null } = {}): Promise<void> {
      await h.admin.query(
        "INSERT INTO repo_runner_sandbox_allowances (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by, check_argv, check_dev_shell, check_timeout_s) VALUES ($1, $2, 1, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)",
        [f.accountId, repoId, JSON.stringify(entries), entries.length > 0 ? 60 : null, createHash("sha256").update(randomUUID()).digest("hex"), opts.setAside ?? false, f.o1, opts.checkArgv ?? null, opts.checkArgv ? true : null, opts.checkArgv ? 60 : null],
      );
    }

    it("counts only this repo's pending runner runs: 0 with none, excluding running, finished, sandbox-runtime and another repo's runs", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      const other = await repo(f, "runner_local");
      expect(body(await get(f, f.o1, id)).pending_runner_runs).toBe(0);
      const a = await queuedRun(f, id);
      const b = await queuedRun(f, id);
      await queuedRun(f, id, "running");
      await queuedRun(f, id, "succeeded");
      await queuedRun(f, id, "pending", "production");
      await queuedRun(f, other);
      expect(body(await get(f, f.o1, id)).pending_runner_runs).toBe(2);
      expect(body(await get(f, f.o1, other)).pending_runner_runs).toBe(1);
      expect([a, b]).toHaveLength(2);
    });

    it("another account's pending runner runs never count", async () => {
      const f = await fresh();
      const other = await fresh();
      const id = await repo(f, "runner_local");
      const theirs = await repo(other, "runner_local");
      await queuedRun(other, theirs);
      expect(body(await get(f, f.o1, id)).pending_runner_runs).toBe(0);
    });

    it("allowances_in_force and allowances_set_aside are both false with no approved row", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      expect(body(await get(f, f.o1, id))).toMatchObject({ allowances_in_force: false, allowances_set_aside: false });
    });

    it("an approved set with an entry, not set aside, is in force; set aside turns it off and flips allowances_set_aside", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      await approve(f, id, [{ kind: "env", value: "X", access: "read", reason: "r" }]);
      expect(body(await get(f, f.o1, id))).toMatchObject({ allowances_in_force: true, allowances_set_aside: false });
    });

    it("a check alone (no entries) is in force too", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      await approve(f, id, [], { checkArgv: ["npm", "test"] });
      expect(body(await get(f, f.o1, id))).toMatchObject({ allowances_in_force: true, allowances_set_aside: false });
    });

    it("a set aside row is never in force, and allowances_set_aside is true", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      await approve(f, id, [{ kind: "env", value: "X", access: "read", reason: "r" }], { setAside: true });
      expect(body(await get(f, f.o1, id))).toMatchObject({ allowances_in_force: false, allowances_set_aside: true });
    });

    it("an approved set with no entries and no check is not in force and not set aside", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      await approve(f, id, []);
      expect(body(await get(f, f.o1, id))).toMatchObject({ allowances_in_force: false, allowances_set_aside: false });
    });
  });

  // D#767: what the picker says before Apply is what the switch then does, read from the same rows, and the items stay.
  describe("the pre-switch facts match what the switch really does, and the repo's items keep their identity", () => {
    const sw = (f: F2Fixture, id: string, mode: string) => respond(() => setExecutionMode(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, id, { mode, confirm_repo: "Acme/widgets" }));
    async function pending(f: F2Fixture, repoId: string, mode: string, itemId: string | null = null): Promise<string> {
      const id = randomUUID();
      await h.admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, $3, 'executor', 'runner', 'pending', $4, $5)", [id, f.accountId, itemId, mode, repoId]);
      return id;
    }
    async function setForce(f: F2Fixture, repoId: string): Promise<void> {
      await h.admin.query(
        "INSERT INTO repo_runner_sandbox_allowances (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by) VALUES ($1, $2, 1, $3::jsonb, 60, $4, false, $5)",
        [f.accountId, repoId, JSON.stringify([{ kind: "env", value: "X", access: "read", reason: "r" }]), createHash("sha256").update(randomUUID()).digest("hex"), f.o1],
      );
    }

    it("pending_runner_runs equals the cancelled_runs the leave then reports, for runner_local and runner_verified runs alike", async () => {
      for (const mode of ["runner_local", "runner_verified"]) {
        const f = await fresh();
        const id = await repo(f, mode);
        await pending(f, id, mode);
        await pending(f, id, mode);
        const told = body(await get(f, f.o1, id)).pending_runner_runs;
        expect(told).toBe(2);
        expect(body(await sw(f, id, "sandbox"))).toMatchObject({ changed: true, cancelled_runs: told });
      }
    });

    it("a pending runner-runtime run that is not in a runner mode is not counted, because the leave does not cancel it", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      await pending(f, id, "runner_local");
      await pending(f, id, "sandbox");
      const told = body(await get(f, f.o1, id)).pending_runner_runs;
      expect(told).toBe(1);
      expect(body(await sw(f, id, "sandbox"))).toMatchObject({ cancelled_runs: told });
    });

    it("a move between the runner modes cancels nothing, whatever the picker counts", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      await pending(f, id, "runner_local");
      await key(f, "ok");
      const res = await respond(() => setExecutionMode(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, id, { mode: "runner_verified", confirm_repo: "Acme/widgets", copy_sha256: CLOUD_VERIFIED_COPY_SHA256 }));
      expect(body(res)).toMatchObject({ changed: true, cancelled_runs: 0 });
      expect(body(await get(f, f.o1, id)).pending_runner_runs).toBe(1);
    });

    it("items with a queued run and an approval keep their rows (same id, every column) and approvals through the cancel, and the run is the only thing that ends", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      const item = randomUUID();
      await h.admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, state) VALUES ($1, $2, $3, 'feature', 'internal', 'open')", [item, f.accountId, id]);
      await h.admin.query("INSERT INTO work_item_approvals (account_id, work_item_id, approved_by, source) VALUES ($1, $2, $3, 'work_item_approve')", [f.accountId, item, f.o1]);
      const run = await pending(f, id, "runner_local", item);
      const snap = async () => ({
        items: (await h.admin.query("SELECT * FROM work_items WHERE account_id = $1 ORDER BY id", [f.accountId])).rows,
        approvals: (await h.admin.query("SELECT * FROM work_item_approvals WHERE account_id = $1 ORDER BY id", [f.accountId])).rows,
      });
      const before = await snap();
      expect(body(await sw(f, id, "sandbox"))).toMatchObject({ cancelled_runs: 1 });
      expect(await snap()).toEqual(before);
      expect((await h.admin.query("SELECT status, work_item_id FROM agent_runs WHERE id = $1", [run])).rows[0]).toEqual({ status: "cancelled", work_item_id: item });
    });

    it("an approved set is in force on the runner, set aside by the leave, and still set aside (not carried) when the repo comes back", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      await setForce(f, id);
      expect(body(await get(f, f.o1, id))).toMatchObject({ allowances_in_force: true, allowances_set_aside: false });
      await sw(f, id, "sandbox");
      expect(body(await get(f, f.o1, id))).toMatchObject({ allowances_in_force: false, allowances_set_aside: true });
      await sw(f, id, "runner_local");
      expect(body(await get(f, f.o1, id))).toMatchObject({ execution_mode: "runner_local", allowances_in_force: false, allowances_set_aside: true });
    });

    it("a move between the runner modes keeps the set in force (nothing to re-approve there)", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      await setForce(f, id);
      await key(f, "ok");
      await respond(() => setExecutionMode(h.deps({ repoVisibility: async () => "private" }), { accountId: f.accountId, userId: f.o1 }, id, { mode: "runner_verified", confirm_repo: "Acme/widgets", copy_sha256: CLOUD_VERIFIED_COPY_SHA256 }));
      expect(body(await get(f, f.o1, id))).toMatchObject({ execution_mode: "runner_verified", allowances_in_force: true, allowances_set_aside: false });
    });
  });

  it("carries the four new COPY strings in the copy map", async () => {
    const f = await fresh();
    const id = await repo(f);
    const c = body(await get(f, f.o1, id)).copy as Record<string, string>;
    expect(c.leaveQueued).toBe(COPY.modeLeaveQueued);
    expect(c.leaveSetsAside).toBe(COPY.modeLeaveSetsAside);
    expect(c.leaveAutoMergeOff).toBe(COPY.modeLeaveAutoMergeOff);
    expect(c.needsReapproval).toBe(COPY.modeNeedsReapproval);
  });

  describe("runner_blocked: a repo on a runner is re-read live, and one that is not private now shows as blocked", () => {
    type Seen = "private" | "public" | "unknown" | "throw";
    function reader(answer: () => Seen) {
      const calls: Array<{ accountId: string; repoId: string }> = [];
      const repoVisibility = async (accountId: string, repoId: string) => {
        calls.push({ accountId, repoId });
        const seen = answer();
        if (seen === "throw") throw new Error("github down");
        return seen;
      };
      return { calls, repoVisibility };
    }
    const getWith = (f: F2Fixture, repoId: string, repoVisibility: (a: string, r: string) => Promise<"private" | "public" | "unknown">) =>
      respond(() => getRepoMode(h.deps({ repoVisibility }), { accountId: f.accountId, userId: f.m1 }, repoId));

    it.each([
      ["runner_local", "private", null],
      ["runner_local", "public", "public_repo"],
      ["runner_local", "unknown", "repo_visibility_unknown"],
      ["runner_local", "throw", "repo_visibility_unknown"],
      ["runner_verified", "private", null],
      ["runner_verified", "public", "public_repo"],
      ["runner_verified", "unknown", "repo_visibility_unknown"],
    ] as const)("a %s repo the read sees as %s answers runner_blocked %s, from one read of this repo", async (mode, seen, blocked) => {
      const f = await fresh();
      const id = await repo(f, mode);
      const r = reader(() => seen);
      const res = await getWith(f, id, r.repoVisibility);
      expect(res.status).toBe(200);
      expect(body(res).runner_blocked).toBe(blocked);
      expect(r.calls).toEqual([{ accountId: f.accountId, repoId: id }]);
    });

    it("a sandbox repo is never blocked and makes no visibility read, even when the repo is public", async () => {
      const f = await fresh();
      const id = await repo(f, "sandbox");
      const r = reader(() => "public");
      expect(body(await getWith(f, id, r.repoVisibility)).runner_blocked).toBeNull();
      expect(r.calls).toHaveLength(0);
    });

    it("no visibility port wired reads as unknown: a runner repo shows as blocked (fails closed)", async () => {
      const f = await fresh();
      expect(body(await get(f, f.m1, await repo(f, "runner_local"))).runner_blocked).toBe("repo_visibility_unknown");
    });

    it("a repo set to local-only while private that turns public later shows as blocked on the next read, and clears when private again", async () => {
      const f = await fresh();
      const id = await repo(f, "runner_local");
      let now: Seen = "private";
      const r = reader(() => now);
      expect(body(await getWith(f, id, r.repoVisibility)).runner_blocked).toBeNull();
      now = "public";
      const after = await getWith(f, id, r.repoVisibility);
      expect(body(after)).toMatchObject({ execution_mode: "runner_local", runner_blocked: "public_repo" });
      now = "private";
      expect(body(await getWith(f, id, r.repoVisibility)).runner_blocked).toBeNull();
      expect(r.calls).toHaveLength(3);
    });
  });
});
