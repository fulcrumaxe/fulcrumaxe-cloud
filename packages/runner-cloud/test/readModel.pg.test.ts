import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { RUNNER_OFFLINE_AFTER_SECONDS, classifyRunner, getRunWaitReason, getRunnerStates, listRunners, type RunnerFacts } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const facts = (over: Partial<RunnerFacts> = {}): RunnerFacts => ({ revokedAt: null, protocolVersion: 3, lastSeenAt: ago(5), busy: false, ...over });

describe("classifyRunner (criterion 13, one state each)", () => {
  it("is online_idle for a runner heard from recently with nothing running", () => {
    expect(classifyRunner(facts(), NOW, 3)).toBe("online_idle");
  });
  it("is busy while it holds a running run", () => {
    expect(classifyRunner(facts({ busy: true }), NOW, 3)).toBe("busy");
  });
  it("is offline after 120 seconds without a request, and not at exactly 120", () => {
    expect(RUNNER_OFFLINE_AFTER_SECONDS).toBe(120);
    expect(classifyRunner(facts({ lastSeenAt: ago(120) }), NOW, 3)).toBe("online_idle");
    expect(classifyRunner(facts({ lastSeenAt: ago(121) }), NOW, 3)).toBe("offline");
    expect(classifyRunner(facts({ lastSeenAt: null }), NOW, 3)).toBe("offline");
    expect(classifyRunner(facts({ lastSeenAt: ago(500), busy: true }), NOW, 3)).toBe("offline");
  });
  it("is outdated below N-1 and not at N-1, with the cloud's own constant when none is injected", () => {
    expect(classifyRunner(facts({ protocolVersion: 1 }), NOW, 3)).toBe("outdated");
    expect(classifyRunner(facts({ protocolVersion: 2 }), NOW, 3)).toBe("online_idle");
    expect(classifyRunner(facts({ protocolVersion: 0 }), NOW)).toBe("online_idle");
    expect(classifyRunner(facts({ protocolVersion: null }), NOW, 3)).toBe("online_idle");
  });
  it("is revoked whatever else is true", () => {
    expect(classifyRunner(facts({ revokedAt: ago(1), protocolVersion: 0, lastSeenAt: null, busy: true }), NOW, 3)).toBe("revoked");
  });
  it("puts outdated above offline, so a stale old runner says to upgrade", () => {
    expect(classifyRunner(facts({ protocolVersion: 1, lastSeenAt: ago(900) }), NOW, 3)).toBe("outdated");
  });
});

describe("the read model [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  const deps = (current = 3) => h.deps({ now: () => NOW, currentProtocolVersion: current });

  // The repo every run below is dispatched to, and the one every runner below may take unless a test says otherwise: a runner
  // counts as online for a run only for the run's own repo (the claim never hands a runner a run of another repo). A run's
  // dispatch_repo_id must name a repos row of its account, so the repos are real.
  const installations = new Map<string, string>();
  const mainRepos = new Map<string, string>();
  async function newRepo(f: F2Fixture): Promise<string> {
    let installationId = installations.get(f.accountId);
    if (!installationId) {
      installationId = randomUUID();
      await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team')", [installationId, f.accountId]);
      installations.set(f.accountId, installationId);
    }
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, 'team')", [id, f.accountId, installationId]);
    return id;
  }
  async function mainRepo(f: F2Fixture): Promise<string> {
    let id = mainRepos.get(f.accountId);
    if (!id) {
      id = await newRepo(f);
      mainRepos.set(f.accountId, id);
    }
    return id;
  }

  async function runner(f: F2Fixture, over: { by?: string; mode?: string; lastSeen?: Date | null; protocol?: number | null; revoked?: boolean; repos?: string[] } = {}): Promise<string> {
    const id = await insertRunner(h.admin, f.accountId, over.by ?? f.a1, { credentialMode: over.mode ?? "subscription" });
    await h.admin.query("UPDATE runners SET last_seen_at = $2, protocol_version = $3, binary_version = '0.9.1', revoked_at = $4, allowed_repo_ids = $5::uuid[] WHERE id = $1", [
      id,
      over.lastSeen === undefined ? ago(5) : over.lastSeen,
      over.protocol === undefined ? 3 : over.protocol,
      over.revoked ? ago(1) : null,
      over.repos ?? [await mainRepo(f)],
    ]);
    return id;
  }

  async function run(f: F2Fixture, over: { status?: string; runtime?: string; initiatedBy?: string | null; approvedBy?: string | null; parent?: string | null; runnerId?: string | null; leaseEnds?: Date | null; claimableAfter?: Date | null; repo?: string } = {}): Promise<string> {
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, initiated_by, approved_by, parent_run_id, runner_id, lease_expires_at, claimable_after, dispatch_repo_id)
       VALUES ($1, $2, 'executor', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, f.accountId, over.runtime ?? "runner", over.status ?? "pending", over.initiatedBy ?? null, over.approvedBy ?? null, over.parent ?? null, over.runnerId ?? null, over.leaseEnds ?? null, over.claimableAfter ?? null, over.repo ?? (await mainRepo(f))],
    );
    return id;
  }
  const reason = (f: F2Fixture, id: string, current = 3) => getRunWaitReason(deps(current), f.accountId, id);
  async function ended(f: F2Fixture, id: string, status: string, failureReason: string): Promise<void> {
    await h.admin.query("UPDATE agent_runs SET status = $2 WHERE id = $1", [id, status]);
    await h.admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [f.accountId, id, JSON.stringify({ from: "running", to: status, failureReason })]);
  }

  describe("getRunnerStates", () => {
    it("returns each runner exactly one of the five states", async () => {
      const f = await fresh();
      const idle = await runner(f);
      const busy = await runner(f);
      await run(f, { status: "running", runnerId: busy, leaseEnds: new Date(NOW.getTime() + 60_000) });
      const offline = await runner(f, { lastSeen: ago(300) });
      const outdated = await runner(f, { protocol: 1 });
      const revoked = await runner(f, { revoked: true });
      const states = new Map((await getRunnerStates(deps(), f.accountId)).map((r) => [r.id, r.state]));
      expect(states.size).toBe(5);
      expect(states.get(idle)).toBe("online_idle");
      expect(states.get(busy)).toBe("busy");
      expect(states.get(offline)).toBe("offline");
      expect(states.get(outdated)).toBe("outdated");
      expect(states.get(revoked)).toBe("revoked");
    });

    it("does not count a running run whose lease has run out as busy (the lease is lost at lease_expires_at)", async () => {
      const f = await fresh();
      const id = await runner(f);
      await run(f, { status: "running", runnerId: id, leaseEnds: NOW });
      expect((await getRunnerStates(deps(), f.accountId))[0]!.state).toBe("online_idle");
      await run(f, { status: "running", runnerId: id, leaseEnds: new Date(NOW.getTime() + 1) });
      expect((await getRunnerStates(deps(), f.accountId))[0]!.state).toBe("busy");
    });

    it("never shows another account's runner", async () => {
      const f = await fresh();
      const g = await fresh();
      await runner(g);
      expect(await getRunnerStates(deps(), f.accountId)).toEqual([]);
    });
  });

  describe("getRunWaitReason", () => {
    it("waiting_for_runner: pending, and no live runner (none, or only revoked or quiet ones)", async () => {
      const f = await fresh();
      const id = await run(f, { initiatedBy: f.m1 });
      expect(await reason(f, id)).toBe("waiting_for_runner");
      await runner(f, { mode: "api_key", revoked: true });
      await runner(f, { mode: "api_key", lastSeen: ago(500) });
      expect(await reason(f, id)).toBe("waiting_for_runner");
    });

    // The wait reason and the `runner.waiting` notice (worker) share one reading of "online for the repo": live, and the run's repo in the
    // runner's own list. An empty list is not "every repo": the claim hands such a runner nothing.
    it("waiting_for_runner: a live runner whose repo list leaves out the run's repo does not count; one that lists it does", async () => {
      const f = await fresh();
      const id = await run(f, { initiatedBy: f.m1 });
      const other = await runner(f, { mode: "api_key", repos: [await newRepo(f), await newRepo(f)] });
      expect(await reason(f, id)).toBe("waiting_for_runner");
      await h.admin.query("UPDATE runners SET allowed_repo_ids = allowed_repo_ids || $2::uuid WHERE id = $1", [other, await mainRepo(f)]);
      expect(await reason(f, id)).toBeNull();
    });

    it("waiting_for_runner: a live runner with an empty repo list does not count (the claim reads an empty list as no repo)", async () => {
      const f = await fresh();
      const id = await run(f, { initiatedBy: f.m1 });
      await runner(f, { mode: "api_key", repos: [] });
      expect(await reason(f, id)).toBe("waiting_for_runner");
    });

    it("waiting_for_runner: the repo that counts is the run's own, so a runner for repo B leaves a run of repo A waiting and takes one of B", async () => {
      const f = await fresh();
      const repoB = await newRepo(f);
      await runner(f, { mode: "api_key", repos: [repoB] });
      expect(await reason(f, await run(f, { initiatedBy: f.m1 }))).toBe("waiting_for_runner");
      expect(await reason(f, await run(f, { initiatedBy: f.m1, repo: repoB }))).toBeNull();
    });

    it("waiting_for_approval: only other people's subscription runners could take it, and nobody has approved", async () => {
      const f = await fresh();
      await runner(f, { by: f.a1, mode: "subscription" });
      const id = await run(f, { initiatedBy: f.m1 });
      expect(await reason(f, id)).toBe("waiting_for_approval");
    });

    it("is not waiting for approval once someone approved, when an api_key runner exists, or when the initiator's own runner exists", async () => {
      const f = await fresh();
      const sub = await runner(f, { by: f.a1, mode: "subscription" });
      expect(await reason(f, await run(f, { initiatedBy: f.m1, approvedBy: f.a1 }))).toBeNull();
      expect(await reason(f, await run(f, { initiatedBy: f.a1 }))).toBeNull();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [sub]);
      await runner(f, { by: f.a2, mode: "api_key" });
      expect(await reason(f, await run(f, { initiatedBy: f.m1 }))).toBeNull();
    });

    it("is not waiting for approval when no subscription runner exists at all (that is waiting_for_runner)", async () => {
      const f = await fresh();
      expect(await reason(f, await run(f, { initiatedBy: f.m1 }))).toBe("waiting_for_runner");
    });

    const later = new Date(NOW.getTime() + 3_600_000);
    const earlier = new Date(NOW.getTime() - 60_000);

    it("runner_lost_retrying and paused_usage_limit: a pending child of a run that failed that way (the follow-up step test, C22 section 5)", async () => {
      const f = await fresh();
      await runner(f, { mode: "api_key" });
      const lost = await run(f, { status: "running" });
      await ended(f, lost, "failed", "runner_lost");
      expect(await reason(f, await run(f, { parent: lost }))).toBe("runner_lost_retrying");
      const limited = await run(f, { status: "running" });
      await ended(f, limited, "failed", "usage_limit");
      expect(await reason(f, await run(f, { parent: limited, claimableAfter: later }))).toBe("paused_usage_limit");
      const other = await run(f, { status: "running" });
      await ended(f, other, "failed", "no_commit");
      expect(await reason(f, await run(f, { parent: other }))).toBeNull();
    });

    it("paused_usage_limit lasts until the child's own claimable_after: once it has passed, or when it is unset, the run waits like any other", async () => {
      const f = await fresh();
      await runner(f, { mode: "api_key" });
      // One follow-up per parent, so each case has its own failed parent.
      const child = async (claimableAfter: Date | null): Promise<string> => {
        const parent = await run(f, { status: "running" });
        await ended(f, parent, "failed", "usage_limit");
        return run(f, { parent, claimableAfter });
      };
      expect(await reason(f, await child(NOW))).toBeNull();
      expect(await reason(f, await child(earlier))).toBeNull();
      expect(await reason(f, await child(null))).toBeNull();
      expect(await reason(f, await child(new Date(NOW.getTime() + 1)))).toBe("paused_usage_limit");
    });

    it("the wait reason is the parent's last move to failed, not whichever event came last: a later event of another move changes nothing", async () => {
      const f = await fresh();
      await runner(f, { mode: "api_key" });
      const parent = await run(f, { status: "failed" });
      await h.admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [f.accountId, parent, JSON.stringify({ from: "running", to: "failed", failureReason: "runner_lost" })]);
      await h.admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 2, 'run.status_changed', $3::jsonb)`, [f.accountId, parent, JSON.stringify({ from: "failed", to: "running" })]);
      expect(await reason(f, await run(f, { parent }))).toBe("runner_lost_retrying");
    });

    it("a failed runner run whose last move to failed named another reason says nothing, whatever an earlier one said", async () => {
      const f = await fresh();
      await runner(f, { mode: "api_key" });
      const parent = await run(f, { status: "failed" });
      await h.admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [f.accountId, parent, JSON.stringify({ from: "running", to: "failed", failureReason: "runner_lost" })]);
      await h.admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 2, 'run.status_changed', $3::jsonb)`, [f.accountId, parent, JSON.stringify({ from: "failed", to: "failed", failureReason: "no_commit" })]);
      expect(await reason(f, await run(f, { parent }))).toBeNull();
    });

    it("a parent that failed with the reason but is no longer failed (moved on afterwards) does not make its child wait", async () => {
      const f = await fresh();
      await runner(f, { mode: "api_key" });
      const parent = await run(f, { status: "cancelled" });
      await h.admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [f.accountId, parent, JSON.stringify({ from: "running", to: "failed", failureReason: "runner_lost" })]);
      expect(await reason(f, await run(f, { parent }))).toBeNull();
    });

    it("a parent that is not a failed runner run does not make its child wait for a follow-up reason", async () => {
      const f = await fresh();
      await runner(f, { mode: "api_key" });
      // Same event payload, wrong run: a timed out run, a succeeded run, and a failed run that is not a runner run.
      for (const [status, runtime] of [["timed_out", "runner"], ["succeeded", "runner"], ["failed", "production"]] as const) {
        const parent = await run(f, { status: "running", runtime });
        await ended(f, parent, status, "runner_lost");
        expect(await reason(f, await run(f, { parent })), `${status}/${runtime}`).toBeNull();
      }
    });

    it("timed_out_waiting: a run that ended timed_out with queue_ttl, and not one that timed out for another reason", async () => {
      const f = await fresh();
      const queued = await run(f, { status: "pending" });
      await ended(f, queued, "timed_out", "queue_ttl");
      expect(await reason(f, queued)).toBe("timed_out_waiting");
      const slow = await run(f, { status: "running" });
      await ended(f, slow, "timed_out", "wall_clock");
      expect(await reason(f, slow)).toBeNull();
    });

    it("is null when a live runner is there to take the run, for a running or finished run, and for a run that is not a runner run", async () => {
      const f = await fresh();
      await runner(f, { mode: "api_key" });
      expect(await reason(f, await run(f, { initiatedBy: f.m1 }))).toBeNull();
      expect(await reason(f, await run(f, { status: "running" }))).toBeNull();
      expect(await reason(f, await run(f, { status: "succeeded" }))).toBeNull();
      expect(await reason(f, await run(f, { runtime: "production" }))).toBeNull();
    });

    it("answers null for a run of another account, and for no such run", async () => {
      const f = await fresh();
      const g = await fresh();
      const theirs = await run(g);
      expect(await reason(f, theirs)).toBeNull();
      expect(await reason(g, theirs)).toBe("waiting_for_runner");
      expect(await reason(f, randomUUID())).toBeNull();
    });
  });

  describe("GET /api/runners (criterion 16)", () => {
    const list = (f: F2Fixture, userId: string) => respond(() => listRunners(deps(), { accountId: f.accountId, userId }));
    type Body = { runners: Array<Record<string, unknown>>; copy: Record<string, string> };

    it("lets any member see the runners with their state, who registered them, and the copy strings", async () => {
      const f = await fresh();
      const id = await runner(f);
      await h.admin.query("UPDATE users SET name = 'Ada Admin' WHERE id = $1", [f.a1]);
      for (const user of [f.o1, f.a2, f.m1]) {
        const res = await list(f, user);
        expect(res.status).toBe(200);
        const body = res.body as Body;
        expect(body.runners).toEqual([
          { id, credential_mode: "subscription", registered_by: { id: f.a1, name: "Ada Admin" }, binary_version: "0.9.1", last_seen_at: ago(5).toISOString(), state: "online_idle", sandbox_unavailable: null },
        ]);
        expect(body.copy).toEqual({ usageLimits: COPY.usageLimits, approval: COPY.approval, runner: COPY.runner, localOnly: COPY.localOnly, sandboxUnavailable: COPY.sandboxUnavailable });
      }
    });

    it("shows a runner's stored sandbox reason for the screen, and nothing for a revoked runner (C16 section 1.3)", async () => {
      const f = await fresh();
      const id = await runner(f);
      await h.admin.query("INSERT INTO runner_sandbox_status (runner_id, account_id, reason) VALUES ($1, $2, 'userns_disabled')", [id, f.accountId]);
      expect(((await list(f, f.m1)).body as Body).runners[0]).toMatchObject({ sandbox_unavailable: "userns_disabled" });
      expect(((await list(f, f.m1)).body as Body).copy.sandboxUnavailable).toBe(COPY.sandboxUnavailable);
      expect(COPY.sandboxUnavailable).toContain("Sandbox not working on this machine");
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [id]);
      expect(((await list(f, f.m1)).body as Body).runners[0]).toMatchObject({ sandbox_unavailable: null, state: "revoked" });
    });

    it("returns none of the excluded fields: the key-set of a runner is exactly the seven, and no key, thumbprint, repo list or nonce appears anywhere", async () => {
      const f = await fresh();
      const id = await runner(f);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid] WHERE id = $1", [id, randomUUID()]);
      await h.admin.query("INSERT INTO runner_request_nonces (account_id, runner_id, nonce) VALUES ($1, $2, 'abcdefghijklmnopqrst')", [f.accountId, id]);
      const res = await list(f, f.m1);
      const body = res.body as Body;
      expect(Object.keys(body.runners[0]!).sort()).toEqual(["binary_version", "credential_mode", "id", "last_seen_at", "registered_by", "sandbox_unavailable", "state"]);
      const text = JSON.stringify(res.body);
      const row = (await h.admin.query("SELECT jkt, public_key_jwk, allowed_repo_ids FROM runners WHERE id = $1", [id])).rows[0];
      expect(text).not.toContain(row.jkt);
      expect(text).not.toContain(row.public_key_jwk.x);
      expect(text).not.toContain(row.allowed_repo_ids[0]);
      expect(text).not.toContain("abcdefghijklmnopqrst");
      for (const word of ["public_key_jwk", "jkt", "allowed_repo_ids", "nonce"]) expect(text).not.toContain(word);
    });

    it("shows nothing of another account to a member of this one, and refuses a user who is not a member at all", async () => {
      const f = await fresh();
      const g = await fresh();
      await runner(g);
      expect(((await list(f, f.m1)).body as Body).runners).toEqual([]);
      expect((await list(f, g.o1)).status).toBe(403);
      expect((await list(f, g.m1)).status).toBe(403);
    });

    it("shows a revoked runner as revoked, and a registrant with no name as a plain label, never null", async () => {
      const f = await fresh();
      await runner(f, { revoked: true });
      const body = (await list(f, f.o1)).body as Body;
      expect(body.runners[0]!.state).toBe("revoked");
      expect(JSON.stringify(body)).not.toMatch(/null.*registered_by|"name":null|undefined/);
      expect((body.runners[0]!.registered_by as { name: string }).name.length).toBeGreaterThan(0);
    });
  });
});
