import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPUTE_NOTICE_SENTENCES, foregroundBudgetUsd, getUsage, reserve, type ReserveParams } from "@fx/spend";
import { seedAccount as seedFullAccount } from "@fx/db/test/helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount } from "./build/helpers/seed.js";
import { startBuildForItem } from "../src/advance/buildTesting.js";
import { createCapacityPort } from "../src/advance/capacityPort.js";
import { readStartWaitNotice } from "../src/advance/capacityWait.js";
import { RESERVATION_PAUSE_SENTENCES, readReservationPause } from "../src/advance/reservationPauses.js";
import type { AdvanceRunPorts, AdvanceRunRequest } from "../src/advance/runPorts.js";

/**
 * D#483 S5-k3: the 80% compute notice and the tests that keep two limit rules apart.
 *
 *   rule 1  the customer's own limits may pause their work (the four named pauses of S5-k1; the notice here is only their early warning)
 *   rule 2  our own capacity never pauses, refuses or fails work: it queues (S5-k3b)
 *
 * What is here: S5k3-2 (the notice changes nothing about an item), the 100% half of S5k3-1 against the real `reserve()`, S5k3-4 (one retired
 * name is gone from every source file), S5k3-5 (the two reasons stay apart, switched on by S5-k3b) and S5k3-6 (each sentence has one home).
 * The 79 / 80 / 100% lines and the new-month clear (S5k3-1, S5k3-3) are over getUsage in packages/spend/test/computeNotice.test.ts.
 */
const h = pgHarness();

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sourceFiles = (): string[] =>
  execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter((f) => /\.(ts|tsx|js|mjs|cjs|sql|py|sh)$/.test(f));

async function account(): Promise<{ accountId: string; userId: string }> {
  const accountId = randomUUID();
  const userId = randomUUID();
  await seedAccount(h.admin, accountId);
  await h.admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
  await h.admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [accountId, userId]);
  return { accountId, userId };
}

async function item(accountId: string): Promise<string> {
  const repoId = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'sandbox', 'acme', $4)`, [repoId, accountId, Math.floor(Math.random() * 1_000_000_000), `w${repoId.slice(0, 8)}`]);
  const id = randomUUID();
  await h.admin.query(
    `INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage, priority)
     VALUES ($1, $2, $3, 'feature', 'running', 'internal', $4, 'spec_ready', 2)`,
    [id, accountId, repoId, Math.floor(Math.random() * 100_000) + 1],
  );
  await h.admin.query(
    `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind)
     VALUES ($1, $2, 1, 'Do the thing.', encode(sha256(convert_to('Do the thing.', 'UTF8')), 'hex'), 'system')`,
    [accountId, id],
  );
  return id;
}

/** Settled foreground compute worth `share` of the starter plan's cap, this month. */
async function spendShare(accountId: string, share: number): Promise<void> {
  const usd = Math.round(foregroundBudgetUsd("starter") * share * 1e4) / 1e4;
  const run = randomUUID();
  await h.admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'production', 'running')`, [run, accountId]);
  await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', $3, $2, 'foreground_compute')`, [accountId, run, usd]);
}

type Limits = Omit<ReserveParams, "accountId" | "runId" | "workItemId" | "workItemKind">;
const LIMITS: Limits = { plan: "starter", trigger: "foreground", estimateComputeUsd: 1 };

/** The fake run starter does what the real one does around `reserve()`: the run row first, the real spend check, a denial ends the run `refused_spend`. */
class SpendPorts implements AdvanceRunPorts {
  readonly requests: AdvanceRunRequest[] = [];
  constructor(private readonly accountId: string, private readonly workItemId: string) {}
  async startRun(req: AdvanceRunRequest) {
    this.requests.push(req);
    const id = randomUUID();
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'pending')`, [id, this.accountId, this.workItemId]);
    const result = await reserve(h.runWriterPool, { ...LIMITS, accountId: this.accountId, runId: id, workItemId: this.workItemId, workItemKind: "feature" });
    if (result.decision === "deny") {
      await h.admin.query("UPDATE agent_runs SET status = 'refused_spend' WHERE id = $1", [id]);
      return { ok: false as const, reason: result.reason };
    }
    await h.admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [id]);
    return { ok: true as const, runId: id };
  }
  async outcome() {
    return { status: "running", done: false, envelope: null };
  }
  async cancel() {}
}

const row = async (id: string) => (await h.admin.query<{ stage: string; halted_at: Date | null }>("SELECT stage, halted_at FROM work_items WHERE id = $1", [id])).rows[0]!;
const facts = async (id: string) => (await h.admin.query("SELECT 1 FROM work_item_driver_events WHERE work_item_id = $1", [id])).rowCount ?? 0;
const noticeOf = async (m: { accountId: string; userId: string }) => (await getUsage({ pool: h.pureAppUserPool, principal: m })).compute_notice;

describe("S5k3-2: the notice is information, it never acts", () => {
  it("at 85% the notice shows, reading it changes nothing about the item, and a start still reserves and runs", async () => {
    const m = await account();
    const w = await item(m.accountId);
    await spendShare(m.accountId, 0.85);
    const before = await row(w);

    expect(await noticeOf(m)).toEqual({ code: "compute_allowance_80", message: COMPUTE_NOTICE_SENTENCES.compute_allowance_80 });
    expect(await row(w)).toEqual(before);
    expect(await facts(w)).toBe(0);
    expect(await readReservationPause(h.runWriterPool, m.accountId, w)).toBeNull();

    const out = await startBuildForItem(h.runWriterPool, m.accountId, w, randomUUID(), new SpendPorts(m.accountId, w));
    expect(out).toMatchObject({ status: "started" });
    // Admitted: a reservation exists, the run is running, nothing was halted, and no wait fact says the item was held.
    expect((await h.admin.query("SELECT 1 FROM spend_reservations WHERE account_id = $1 AND state = 'open'", [m.accountId])).rowCount).toBe(1);
    expect((await row(w)).halted_at).toBeNull();
    expect(await facts(w)).toBe(0);
  });

  it("S5k3-1 at 100%: the existing compute_cap_reached pause applies from the real denial, the item waits, and the notice is gone (replaced, not doubled)", async () => {
    const m = await account();
    const w = await item(m.accountId);
    await spendShare(m.accountId, 1);
    expect(await noticeOf(m)).toBeNull();
    const out = await startBuildForItem(h.runWriterPool, m.accountId, w, randomUUID(), new SpendPorts(m.accountId, w));
    expect(out).toEqual({ status: "refused", reason: "compute_cap_reached" });
    expect(await row(w)).toMatchObject({ stage: "spec_ready", halted_at: null });
    // The two sentences are different texts: one limit never reads as the other.
    expect(RESERVATION_PAUSE_SENTENCES.compute_cap_reached).not.toBe(COMPUTE_NOTICE_SENTENCES.compute_allowance_80);
  });
});

/**
 * S5k3-5 / S5k3b-8 belong to the capacity queue (S5-k3b). Until it is on main there is no queue to fill, so the fixtures ship switched off.
 * The S5-k3b executor sets this to true, and writes the full-slots half where it says so; a switched-on file with that half unwritten fails.
 */
const CAPACITY_QUEUE_ON = true;

describe.skipIf(!CAPACITY_QUEUE_ON)("S5k3-5: our capacity and the customer's allowance are two states (turns on with S5-k3b)", () => {
  it("allowance used and slots free: the item shows compute_cap_reached and has no queue entry", async () => {
    const m = await account();
    const w = await item(m.accountId);
    await spendShare(m.accountId, 1);
    const out = await startBuildForItem(h.runWriterPool, m.accountId, w, randomUUID(), new SpendPorts(m.accountId, w));
    expect(out).toEqual({ status: "refused", reason: "compute_cap_reached" });
    await h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'build_waiting', 'compute_cap_reached', $3)`, [m.accountId, w, randomUUID()]);
    expect(await readReservationPause(h.runWriterPool, m.accountId, w)).toBe("compute_cap_reached");
    expect((await h.admin.query("SELECT 1 FROM capacity_queue WHERE work_item_id = $1", [w])).rowCount).toBe(0);
  });

  it("allowance remaining and every slot full: the item shows waiting_for_capacity and never compute_cap_reached", async () => {
    // The full seed: a connected repository (an installation), so the entry is not skipped as "no longer connected".
    const accountId = randomUUID();
    const refs = await seedFullAccount(h.admin, accountId);
    const m = { accountId };
    const w = refs.workItemId;
    const { rows } = await h.admin.query("SELECT o_slots_in_use AS n FROM capacity_queue_state('hosted_sandbox')");
    const full = Number(rows[0].n);
    const port = createCapacityPort({ pool: h.runWriterPool, slotTotal: () => full });
    const repoId = refs.repoId;
    expect(await port.admit({ accountId: m.accountId, repoId, workItemId: w, runKind: "executor" })).toEqual({ kind: "wait" });
    await h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'build', 'waiting_for_capacity', $3)`, [m.accountId, w, randomUUID()]);
    expect(await readReservationPause(h.runWriterPool, m.accountId, w)).toBeNull();
    const notice = await readStartWaitNotice(h.pureAppUserPool, m.accountId, w);
    expect(notice).toMatchObject({ kind: "capacity", wait: { place: 1 } });
    expect(JSON.stringify(notice)).not.toContain("compute_cap_reached");
  });

  it("both at once: the customer's own limit wins (checked first), so the item shows compute_cap_reached and holds no place in line", async () => {
    const m = await account();
    const w = await item(m.accountId);
    await spendShare(m.accountId, 1);
    const out = await startBuildForItem(h.runWriterPool, m.accountId, w, randomUUID(), new SpendPorts(m.accountId, w));
    expect(out).toEqual({ status: "refused", reason: "compute_cap_reached" });
    await h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'build_waiting', 'compute_cap_reached', $3)`, [m.accountId, w, randomUUID()]);
    expect(await readStartWaitNotice(h.pureAppUserPool, m.accountId, w)).toEqual({ kind: "limit", pause: "compute_cap_reached" });
    expect((await h.admin.query("SELECT 1 FROM capacity_queue WHERE work_item_id = $1", [w])).rowCount).toBe(0);
  });
});

describe("S5k3-4: the retired infrastructure stop name is in no source file", () => {
  // Built from pieces so this file does not hold the name it forbids.
  const NAME = ["infra", "budget", "stop"].join("_");

  it("the matcher finds the name in a fixture (so a clean scan means something)", () => {
    expect(`reason: "${NAME}"`.includes(NAME)).toBe(true);
  });

  it("no tracked source file contains it", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    const hits = files.filter((f) => readFileSync(path.join(REPO_ROOT, f), "utf8").includes(NAME));
    expect(hits).toEqual([]);
  });
});

describe("S5k3-6: each sentence is read from one table, never retyped in a component", () => {
  const SENTENCES: Record<string, string> = {
    ...Object.fromEntries(Object.entries(RESERVATION_PAUSE_SENTENCES).map(([k, v]) => [`pause:${k}`, v])),
    ...Object.fromEntries(Object.entries(COMPUTE_NOTICE_SENTENCES).map(([k, v]) => [`notice:${k}`, v])),
  };
  const TABLES = new Set(["packages/pipeline/src/advance/reservationPauses.ts", "packages/spend/src/computeNotice.ts"]);
  const isTestFile = (f: string): boolean => /(^|\/)(test|tests|e2e|archive|__tests__)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f);

  it("the six pause sentences and the notice sentence are all present, and none is empty", () => {
    expect(Object.keys(SENTENCES)).toHaveLength(7);
    for (const v of Object.values(SENTENCES)) expect(v.length).toBeGreaterThan(20);
  });

  it("each appears in its own table file and in no other non-test source file", () => {
    const files = sourceFiles().filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !isTestFile(f));
    expect(files.length).toBeGreaterThan(500);
    for (const [name, sentence] of Object.entries(SENTENCES)) {
      const owners = files.filter((f) => readFileSync(path.join(REPO_ROOT, f), "utf8").includes(sentence));
      expect(owners, `${name} must live in one table file`).toHaveLength(1);
      expect(TABLES.has(owners[0]!), `${name} lives in ${owners[0]}`).toBe(true);
    }
  });
});
