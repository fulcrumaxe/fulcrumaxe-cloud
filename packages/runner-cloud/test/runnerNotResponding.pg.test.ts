import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WAIT_LINES, waitText } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { nextGhInstallationId } from "@fx/db/test/helpers/seed.js";
import { getRunWait, listRunners, waitReasonOf, type RawRun } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

/**
 * [pg] D#6 PING-CONSUMERS R1-b: the wait reason `runner_not_responding`, and the fleet screen reading "Not responding" from the same SQL rule. Every
 * fixture is read through both the fleet and the wait reason on one clock, so the two cannot disagree (acceptance 10), and the reason is checked at
 * its place in the order (acceptance 7).
 */
const NOW = new Date("2026-10-24T12:00:00.000Z");
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

describe("runner_not_responding and the fleet read one rule [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const wakeKey = () => Buffer.alloc(32, 7);
  const deps = (gate = true) => h.deps({ now: () => NOW, ...(gate ? { wakeKey } : {}) });

  async function repoOf(f: F2Fixture): Promise<string> {
    const installationId = randomUUID();
    await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')", [installationId, f.accountId, nextGhInstallationId()]);
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, 'team')", [id, f.accountId, installationId]);
    return id;
  }
  async function runner(f: F2Fixture, repo: string, o: { seen: number; wake?: boolean; mode?: "api_key" | "subscription" }): Promise<string> {
    const id = await insertRunner(h.admin, f.accountId, f.a1, { credentialMode: o.mode ?? "api_key" });
    await h.admin.query("UPDATE runners SET last_seen_at = $2, protocol_version = 3, allowed_repo_ids = ARRAY[$3::uuid] WHERE id = $1", [id, ago(o.seen), repo]);
    if (o.wake !== false) await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, ARRAY['wake_v1'])", [id, f.accountId]);
    return id;
  }
  async function pending(f: F2Fixture, repo: string, since: number, o: { initiatedBy?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    await h.admin.query(
      "INSERT INTO agent_runs (id, account_id, role, runtime, status, dispatch_repo_id, initiated_by, claimable_since) VALUES ($1, $2, 'executor', 'runner', 'pending', $3, $4, $5)",
      [id, f.accountId, repo, o.initiatedBy === undefined ? f.a1 : o.initiatedBy, ago(since)],
    );
    return id;
  }
  async function fleet(f: F2Fixture, gate = true): Promise<Map<string, { state: string; state_note: string | null }>> {
    const res = await respond(() => listRunners(deps(gate), { accountId: f.accountId, userId: f.o1 }));
    return new Map((res.body as { runners: Array<{ id: string; state: string; state_note: string | null }> }).runners.map((r) => [r.id, r]));
  }
  const waitOf = async (f: F2Fixture, run: string, gate = true) => (await getRunWait(deps(gate), f.accountId, run)).reason;

  const cases: Array<{ name: string; build: (f: F2Fixture, repo: string) => Promise<{ runners: string[]; run: string }>; fleetNotResponding: boolean; reason: string | null; gate?: boolean }> = [
    {
      name: "the only covering runner left work unanswered for 90 s",
      build: async (f, repo) => ({ runners: [await runner(f, repo, { seen: 600 })], run: await pending(f, repo, 90) }),
      fleetNotResponding: true,
      reason: "runner_not_responding",
    },
    {
      name: "the work is 89 s old: not yet",
      build: async (f, repo) => ({ runners: [await runner(f, repo, { seen: 600 })], run: await pending(f, repo, 89) }),
      fleetNotResponding: false,
      reason: null,
    },
    {
      name: "the runner answered after the work became claimable",
      build: async (f, repo) => ({ runners: [await runner(f, repo, { seen: 30 })], run: await pending(f, repo, 200) }),
      fleetNotResponding: false,
      reason: null,
    },
    {
      name: "a second covering runner answers: the run is not waiting on a runner, though the first is flagged",
      build: async (f, repo) => ({ runners: [await runner(f, repo, { seen: 600 }), await runner(f, repo, { seen: 30 })], run: await pending(f, repo, 200) }),
      fleetNotResponding: true,
      reason: null,
    },
    {
      name: "nobody is there by the plain rule: the old reason, not this one",
      build: async (f, repo) => ({ runners: [await runner(f, repo, { seen: 4000 })], run: await pending(f, repo, 200) }),
      fleetNotResponding: false,
      reason: "waiting_for_runner",
    },
    {
      name: "wake gate closed: every runner claims each minute, so a quiet one is simply offline",
      gate: false,
      build: async (f, repo) => ({ runners: [await runner(f, repo, { seen: 600 })], run: await pending(f, repo, 200) }),
      fleetNotResponding: false,
      reason: "waiting_for_runner",
    },
    {
      name: "an older runner (no wake grant) is left to the 120 s window",
      build: async (f, repo) => ({ runners: [await runner(f, repo, { seen: 100, wake: false })], run: await pending(f, repo, 200) }),
      fleetNotResponding: false,
      reason: null,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: the fleet and the wait reason agree`, async () => {
      const f = await seedF2(h.admin);
      const repo = await repoOf(f);
      const { runners, run } = await c.build(f, repo);
      const rows = await fleet(f, c.gate ?? true);
      const flagged = runners.some((id) => rows.get(id)!.state === "not_responding");
      expect(flagged).toBe(c.fleetNotResponding);
      const reason = await waitOf(f, run, c.gate ?? true);
      expect(reason).toBe(c.reason);
      // The one thing the two screens must agree on: when the only runners there are flagged, the run says so, and never otherwise.
      if (runners.length === 1) expect(flagged).toBe(reason === "runner_not_responding");
    });
  }

  it("the reason comes after the approval stage, so a run that needs a click is told that first", async () => {
    const f = await seedF2(h.admin);
    const repo = await repoOf(f);
    await runner(f, repo, { seen: 600, mode: "subscription" });
    const run = await pending(f, repo, 200, { initiatedBy: null });
    expect(await waitOf(f, run)).toBe("waiting_for_approval");
  });

  it("the sentence is plain words, written once, and the person is told what to check", () => {
    const text = waitText("runner_not_responding", null);
    expect(text).toBe("Your runner isn't picking up work. Check that the machine is on and fx-runner is running.");
    expect(text).toMatch(/^[A-Z][^_]+$/);
    expect(Object.values(WAIT_LINES)).toContain(text);
  });

  it("waitReasonOf: not responding only when nobody counts as there and one runner is there but quiet", () => {
    const row = (o: Partial<RawRun>): RawRun => ({
      id: "r", work_item_id: null, role: "executor", dispatch_repo_id: "x", created_at: NOW, status: "pending", runtime: "runner", initiated_by: null, approved_by: "u",
      own_reason: null, parent_reason: null, claimable_after: null, runnable_without_approval: true, needs_approval_possible: false, runner_online: false,
      runner_slot_free: true, slot_limited_by: null, ...o,
    });
    expect(waitReasonOf(row({ runner_present_unanswering: true }), NOW)).toBe("runner_not_responding");
    expect(waitReasonOf(row({ runner_present_unanswering: false }), NOW)).toBe("waiting_for_runner");
    expect(waitReasonOf(row({}), NOW)).toBe("waiting_for_runner");
    expect(waitReasonOf(row({ runner_online: true, runner_present_unanswering: true }), NOW)).toBeNull();
    expect(waitReasonOf(row({ runner_present_unanswering: true, parent_reason: "runner_lost" }), NOW)).toBe("runner_lost_retrying");
    expect(waitReasonOf(row({ runner_present_unanswering: true, parent_reason: "usage_limit", claimable_after: new Date(NOW.getTime() + 3_600_000) }), NOW)).toBe("paused_usage_limit");
  });
});
