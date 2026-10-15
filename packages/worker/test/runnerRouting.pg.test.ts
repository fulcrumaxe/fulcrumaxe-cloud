import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PREFER_HOLD_MAX_SECONDS, RUNNER_HANDOFF_MIN_PROTOCOL_VERSION, RUNNER_ONLINE_SECONDS } from "@fx/runner";
import { sha256Text, signJob, type ClaimCapacity, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { HANDOFF_PROTOCOL_VERSION } from "@fx/runner-cloud";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";

/**
 * [pg] D#605 FL-4: routing rules in the claim, through the real facade, the real definers and a real run-writer login. The clock is injected; a run's
 * `claimable_since` and a runner's last poll are set directly, so every instant is fixed and nothing waits.
 */
describe("routing rules in the runner claim [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let clock = T0;
  let A: SeedRefs;
  let facade: RunnerClaimFacade;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  beforeEach(async () => {
    clock = T0;
    await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE runtime = 'runner' AND status IN ('running', 'pending')`);
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
  });

  const iso = (ms: number) => new Date(ms).toISOString();
  interface RunnerOpts {
    mode?: string;
    registeredBy?: string;
    facts?: { os?: string; arch?: string; engine?: string };
    labels?: string[];
    /** ms before the clock this runner was last heard; undefined = just now. */
    seenAgo?: number;
    protocol?: number;
    repos?: string[];
    stamp?: number;
  }
  async function runner(o: RunnerOpts = {}): Promise<string> {
    const id = await insertRunner(admin, A.accountId, o.registeredBy ?? A.userId, { credentialMode: o.mode ?? "api_key" });
    await admin.query(
      "UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = ARRAY['executor','code-reviewer'], last_seen_at = $3::timestamptz, protocol_version = $4 WHERE id = $1",
      [id, o.repos ?? [A.repoId], iso(T0 - (o.seenAgo ?? 0)), o.protocol ?? RUNNER_HANDOFF_MIN_PROTOCOL_VERSION],
    );
    if (o.facts) {
      await admin.query("INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, $3, $4, 16, 8, $5)", [id, A.accountId, o.facts.os ?? "linux", o.facts.arch ?? "x64", o.facts.engine ?? "os_sandbox"]);
    }
    if (o.labels) await admin.query("INSERT INTO runner_settings (runner_id, account_id, labels) VALUES ($1, $2, $3::text[]) ON CONFLICT (runner_id) DO UPDATE SET labels = EXCLUDED.labels", [id, A.accountId, o.labels]);
    if (o.stamp !== undefined) await admin.query("INSERT INTO runner_claim_stamps (runner_id, account_id, last_claim_at) VALUES ($1, $2, $3::timestamptz)", [id, A.accountId, iso(o.stamp)]);
    return id;
  }
  async function user(): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    return id;
  }
  /** A pending runner run with a real signed job. */
  async function pending(o: { role?: string; initiatedBy?: string | null; claimableSince?: number; createdAt?: number; requiresEngine?: "microvm"; workItem?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: A.repoId, owner: "acme", name: "app", private: true },
      role: (o.role ?? "executor") as Job["role"],
      mode: "local",
      spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: null,
      ...(o.requiresEngine ? { requires_engine: o.requiresEngine } : {}),
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: iso(T0 - 1000),
      expires_at: iso(T0 + 72 * 3_600_000),
      key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by, created_at, claimable_since)
       VALUES ($1, $2, $3, $4, 'runner', 'pending', 'runner_local', $5, $6::jsonb, $7, $8::timestamptz, $9::timestamptz)`,
      [id, A.accountId, o.workItem === false ? null : A.workItemId, job.role, A.repoId, JSON.stringify(signJob(job, key)), o.initiatedBy === undefined ? A.userId : o.initiatedBy, iso(o.createdAt ?? T0 - 5000), iso(o.claimableSince ?? T0 - 5000)],
    );
    return id;
  }
  const json = (routing: unknown) => (routing === null ? null : JSON.stringify(routing));
  const routeRepo = (routing: unknown) => admin.query("UPDATE repos SET runner_routing = $2::jsonb WHERE id = $1", [A.repoId, json(routing)]);
  const routeItem = (routing: unknown) => admin.query("UPDATE work_items SET runner_routing = $2::jsonb WHERE id = $1", [A.workItemId, json(routing)]);
  /** Moves the clock and keeps the runner heard from a second before it, so a hold is tested on its own timer and not on the online window. */
  const tick = async (to: number, ...heard: string[]) => {
    clock = to;
    for (const id of heard) await admin.query("UPDATE runners SET last_seen_at = $2::timestamptz WHERE id = $1", [id, iso(to - 1000)]);
  };
  const status = async (id: string) => (await admin.query("SELECT status, runner_id FROM agent_runs WHERE id = $1", [id])).rows[0];
  const claim = (runnerId: string, capacity?: ClaimCapacity) => facade.claimRunnerRun({ accountId: A.accountId, runnerId, ...(capacity ? { capacity } : {}) });

  it("the handoff version gate the hold reads is the one the handoff route enforces", () => {
    expect(RUNNER_HANDOFF_MIN_PROTOCOL_VERSION).toBe(HANDOFF_PROTOCOL_VERSION);
  });

  describe("requirements", () => {
    it("AC1: a run requiring os=macos is idle for the linux runner and taken by the macOS runner", async () => {
      const mac = await runner({ facts: { os: "macos", arch: "arm64" } });
      const linux = await runner({ facts: { os: "linux" } });
      await routeRepo({ require: { os: "macos" } });
      const id = await pending();
      expect((await claim(linux)).kind).toBe("idle");
      expect((await status(id)).status).toBe("pending");
      expect(await claim(mac)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("a runner that reported no facts meets no os, arch or engine requirement, and one with no rules claims as before", async () => {
      const bare = await runner();
      const id = await pending();
      await routeRepo({ require: { arch: "arm64" } });
      expect((await claim(bare)).kind).toBe("idle");
      await routeRepo({ require: { engine: "os_sandbox" } });
      expect((await claim(bare)).kind).toBe("idle");
      await routeRepo(null);
      expect(await claim(bare)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("arch, engine and labels are each matched against the polling runner, and every label must be present", async () => {
      const full = await runner({ facts: { os: "linux", arch: "arm64", engine: "microvm" }, labels: ["gpu", "nix"] });
      const partial = await runner({ facts: { os: "linux", arch: "arm64", engine: "microvm" }, labels: ["gpu"] });
      const id = await pending();
      await routeRepo({ require: { arch: "arm64", engine: "microvm", labels: ["gpu", "nix"] } });
      expect((await claim(partial)).kind).toBe("idle");
      expect(await claim(full)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("heavy_labels bind only a heavy run: a light reviewer run goes to a runner without the label, an executor run does not", async () => {
      const plain = await runner();
      await routeRepo({ require: { heavy_labels: ["bigbox"] } });
      const heavy = await pending({ role: "executor" });
      expect((await claim(plain)).kind).toBe("idle");
      expect((await status(heavy)).status).toBe("pending");
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [heavy]);
      const light = await pending({ role: "code-reviewer" });
      expect(await claim(plain)).toMatchObject({ kind: "claimed", runId: light });
    });

    it("the item's value replaces the repo's per key, and keys the item does not name still come from the repo", async () => {
      const linux = await runner({ facts: { os: "linux", arch: "x64" } });
      const id = await pending();
      await routeRepo({ require: { os: "macos", arch: "arm64" } });
      await routeItem({ require: { os: "linux" } });
      // os now comes from the item (linux) but arch still from the repo (arm64): the x64 runner is refused.
      expect((await claim(linux)).kind).toBe("idle");
      await routeItem({ require: { os: "linux", arch: "x64" } });
      expect(await claim(linux)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("AC7: a job needing a VM is never taken by an os_sandbox runner, whatever the routing says, and a microvm runner takes it", async () => {
      const plain = await runner({ facts: { engine: "os_sandbox" } });
      const vm = await runner({ facts: { engine: "microvm" } });
      const noFacts = await runner();
      const id = await pending({ requiresEngine: "microvm" });
      // A person-set rule asking for os_sandbox cannot clear it, and a rule asking for nothing does not either.
      for (const rule of [null, { require: { engine: "os_sandbox" } }, { require: { engine: "microvm" } }]) {
        await routeRepo(rule);
        await routeItem(rule);
        expect((await claim(plain)).kind).toBe("idle");
        expect((await claim(noFacts)).kind).toBe("idle");
      }
      await routeRepo(null);
      await routeItem(null);
      expect(await claim(vm)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("a rule naming a requirement no runner meets leaves the run pending, claimable once the rule is cleared (the undo path)", async () => {
      const r = await runner({ facts: { os: "linux" } });
      const id = await pending();
      await routeRepo({ require: { os: "macos" } });
      expect((await claim(r)).kind).toBe("idle");
      await routeRepo(null);
      expect(await claim(r)).toMatchObject({ kind: "claimed", runId: id });
    });
  });

  describe("the existing filters stay the hard gate", () => {
    it("AC2: a subscription runner whose registrant did not start or approve a run never claims it, even when prefer names it first and every requirement matches", async () => {
      const teammate = await user();
      const sub = await runner({ mode: "subscription", facts: { os: "macos" }, labels: ["mine"] });
      await routeRepo({ require: { os: "macos", labels: ["mine"] }, prefer: [sub] });
      const id = await pending({ initiatedBy: teammate });
      expect((await claim(sub)).kind).toBe("idle");
      expect((await status(id)).status).toBe("pending");
      // Control: the same runner takes a run its registrant started.
      const own = await pending({ initiatedBy: A.userId });
      expect(await claim(sub)).toMatchObject({ kind: "claimed", runId: own });
    });

    it("a rule never makes a runner claim a repo outside its scope", async () => {
      const outside = await runner({ repos: [randomUUID()], facts: { os: "macos" } });
      await routeRepo({ require: { os: "macos" }, prefer: [outside] });
      await pending();
      expect((await claim(outside)).kind).toBe("idle");
    });
  });

  describe("prefer is a hold", () => {
    it("AC3: Laptop does not take a run preferring Desktop (online); after Desktop polls and leaves it, Laptop's next poll does", async () => {
      const desktop = await runner({ seenAgo: 5000 });
      const laptop = await runner({ seenAgo: 1000 });
      await routeRepo({ prefer: [desktop] });
      const id = await pending({ claimableSince: T0 - 20_000 });
      expect((await claim(laptop)).kind).toBe("idle");
      expect((await status(id)).status).toBe("pending");
      // Desktop polled at T0 - 10 s, after the run became claimable, and did not take it.
      await admin.query("INSERT INTO runner_claim_stamps (runner_id, account_id, last_claim_at) VALUES ($1, $2, $3::timestamptz)", [desktop, A.accountId, iso(T0 - 10_000)]);
      expect(await claim(laptop)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("a stamp from before the run became claimable does not end the hold", async () => {
      const desktop = await runner({ seenAgo: 5000, stamp: T0 - 60_000 });
      const laptop = await runner();
      await routeRepo({ prefer: [desktop] });
      await pending({ claimableSince: T0 - 20_000 });
      expect((await claim(laptop)).kind).toBe("idle");
    });

    it("the preferred runner itself is not held by its own preference", async () => {
      const desktop = await runner();
      const laptop = await runner();
      await routeRepo({ prefer: [desktop, laptop] });
      const id = await pending({ claimableSince: T0 - 1000 });
      expect(await claim(desktop)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("ranks: the second-ranked runner is held by the first, and the first is held by nobody", async () => {
      const first = await runner();
      const second = await runner();
      const third = await runner();
      await routeRepo({ prefer: [first, second] });
      await pending({ claimableSince: T0 - 1000 });
      expect((await claim(third)).kind).toBe("idle");
      expect((await claim(second)).kind).toBe("idle");
    });

    it.each<[string, RunnerOpts]>([
      ["offline (heard from longer ago than RUNNER_ONLINE_SECONDS)", { seenAgo: (RUNNER_ONLINE_SECONDS + 10) * 1000 }],
      ["below the handoff protocol version", { protocol: HANDOFF_PROTOCOL_VERSION - 1 }],
      ["not covering the run's repo", { repos: [randomUUID()] }],
    ])("AC4: a run preferring a Desktop that is %s is claimable by Laptop on its first poll", async (_name, over) => {
      const desktop = await runner(over);
      const laptop = await runner();
      await routeRepo({ prefer: [desktop] });
      const id = await pending({ claimableSince: T0 - 1000 });
      expect(await claim(laptop)).toMatchObject({ kind: "claimed", runId: id });
    });

    it.each([
      ["paused", "UPDATE runner_settings SET paused_at = now() WHERE runner_id = $1"],
      ["draining", "UPDATE runner_settings SET draining = true WHERE runner_id = $1"],
      ["removed", "UPDATE runners SET revoked_at = now() WHERE id = $1"],
    ])("a %s preferred runner holds nothing (a removed one is dropped at read time)", async (_name, sql) => {
      const desktop = await runner({ labels: [] });
      const laptop = await runner();
      await routeRepo({ prefer: [desktop] });
      await admin.query(sql, [desktop]);
      const id = await pending({ claimableSince: T0 - 1000 });
      expect(await claim(laptop)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("a preferred runner full for the run's class holds nothing, and one with a free slot does", async () => {
      const desktop = await runner();
      const laptop = await runner();
      await admin.query("INSERT INTO runner_capacity (runner_id, account_id, declared, light_limit, heavy_limit) VALUES ($1, $2, true, 2, 1)", [desktop, A.accountId]);
      await routeRepo({ prefer: [desktop] });
      const id = await pending({ claimableSince: T0 - 1000 });
      expect((await claim(laptop)).kind).toBe("idle");
      // Desktop's one heavy slot is now taken by a running executor run: full for the heavy class.
      await admin.query(
        "INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, runner_id, lease_generation, lease_expires_at, started_at) VALUES ($1, $2, 'executor', 'runner', 'running', 'runner_local', $3, 1, now() + interval '1 hour', now())",
        [randomUUID(), A.accountId, desktop],
      );
      expect(await claim(laptop)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("AC4: a preferred Desktop that is online but never polls is skipped at claimable_since + 120 s, and not 1 ms before", async () => {
      const desktop = await runner({ seenAgo: 1000 });
      const laptop = await runner();
      await routeRepo({ prefer: [desktop] });
      const id = await pending({ claimableSince: T0 });
      await tick(T0 + PREFER_HOLD_MAX_SECONDS * 1000 - 1, desktop, laptop);
      expect((await claim(laptop)).kind).toBe("idle");
      await tick(T0 + PREFER_HOLD_MAX_SECONDS * 1000, desktop, laptop);
      expect(await claim(laptop)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("AC5: the hold runs from claimable_since, not created_at: an old run requeued at T is held until T + 120 s", async () => {
      const desktop = await runner({ seenAgo: 1000 });
      const laptop = await runner();
      await routeRepo({ prefer: [desktop] });
      // created ten minutes ago; became claimable again just now.
      const id = await pending({ createdAt: T0 - 600_000, claimableSince: T0 });
      expect((await claim(laptop)).kind).toBe("idle");
      await tick(T0 + 119_000, desktop, laptop);
      expect((await claim(laptop)).kind).toBe("idle");
      await tick(T0 + 120_000, desktop, laptop);
      expect(await claim(laptop)).toMatchObject({ kind: "claimed", runId: id });
    });

    it("a usage-limit follow-up is held from the moment it becomes claimable (claimable_after), not from when it was made", async () => {
      const desktop = await runner({ seenAgo: 1000 });
      const laptop = await runner();
      await routeRepo({ prefer: [desktop] });
      const id = await pending({ claimableSince: T0 - 600_000 });
      await admin.query("UPDATE agent_runs SET claimable_after = $2::timestamptz WHERE id = $1", [id, iso(T0 - 10_000)]);
      // claimable since T0 - 10 s: the 120 s hold is still running even though the run was made ten minutes ago.
      expect((await claim(laptop)).kind).toBe("idle");
    });

    it("a held run does not use up the poll's attempts: a run behind six held ones is taken in the same poll", async () => {
      const desktop = await runner({ seenAgo: 1000 });
      const laptop = await runner();
      // The item prefers Desktop, so its six (older) runs are held; the seventh has no item and the repo has no rule.
      await routeItem({ prefer: [desktop] });
      for (let i = 0; i < 6; i++) await pending({ createdAt: T0 - 100_000 - i, claimableSince: T0 - 1000 });
      const free = await pending({ createdAt: T0 - 1, claimableSince: T0 - 1000, workItem: false });
      expect(await claim(laptop)).toMatchObject({ kind: "claimed", runId: free });
    });
  });
});
