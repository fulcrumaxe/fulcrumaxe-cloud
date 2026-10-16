import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { foregroundBudgetUsd, reserve, type ReserveParams } from "@fx/spend";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount } from "./build/helpers/seed.js";
import { startBuildForItem } from "../src/advance/build.js";
import { readBuildWaitReason } from "../src/advance/buildSlots.js";
import { RESERVATION_PAUSE_SENTENCES, RESERVATION_PAUSE_WINDOW_SECONDS, readReservationPause, type ReservationPause } from "../src/advance/reservationPauses.js";
import type { AdvanceRunPorts, AdvanceRunRequest } from "../src/advance/runPorts.js";

/**
 * D#483 S5-k1 [pg]: named pauses for the reservation denials, over real rows. The denial comes from the REAL `reserve()` (not a canned string), so a
 * renamed or re-ordered denial in the spend package fails here. The fake run starter does what the real one does around it: the run row exists as
 * `pending` before the reservation, a denial ends it `refused_spend` with the denial as its reason, and a repeat of the same step key finds that
 * same run (the real starter's `claimed()`), which is why each later ask is a new attempt.
 */
const h = pgHarness();

async function account(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}

async function repo(accountId: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'sandbox', 'acme', $4)`, [id, accountId, Math.floor(Math.random() * 1_000_000_000), `w${id.slice(0, 8)}`]);
  return id;
}

async function item(accountId: string, repoId: string, o: { stage?: string; priority?: number } = {}): Promise<string> {
  const id = randomUUID();
  await h.admin.query(
    `INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage, priority)
     VALUES ($1, $2, $3, 'feature', 'running', 'internal', $4, $5, $6)`,
    [id, accountId, repoId, Math.floor(Math.random() * 100_000) + 1, o.stage ?? "spec_ready", o.priority ?? 2],
  );
  await h.admin.query(
    `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind)
     VALUES ($1, $2, 1, 'Do the thing.', encode(sha256(convert_to('Do the thing.', 'UTF8')), 'hex'), 'system')`,
    [accountId, id],
  );
  return id;
}

/** The worker's `build_waiting` fact for one poll. */
const fact = async (accountId: string, workItemId: string, code: string, ageSeconds = 0): Promise<void> => {
  await h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'build_waiting', $3, $4)`, [accountId, workItemId, code, randomUUID()]);
  if (ageSeconds > 0) await h.admin.query("UPDATE work_item_driver_events SET created_at = now() - make_interval(secs => $2::int) WHERE work_item_id = $1 AND code = $3", [workItemId, ageSeconds, code]);
};

type Limits = Omit<ReserveParams, "accountId" | "runId" | "workItemId" | "workItemKind">;

class SpendPorts implements AdvanceRunPorts {
  readonly requests: AdvanceRunRequest[] = [];
  private readonly keys = new Map<string, string>();
  constructor(
    private readonly accountId: string,
    private readonly workItemId: string,
    /** What the spend check is given; a test changes it to model the person raising a limit (or the month rolling over). */
    public limits: Limits,
  ) {}
  async startRun(req: AdvanceRunRequest) {
    this.requests.push(req);
    const held = this.keys.get(req.step);
    if (held !== undefined) return { ok: true as const, runId: held };
    const id = randomUUID();
    this.keys.set(req.step, id);
    await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'pending')`, [id, this.accountId, this.workItemId]);
    const result = await reserve(h.runWriterPool, { ...this.limits, accountId: this.accountId, runId: id, workItemId: this.workItemId, workItemKind: "feature" });
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

const stageOf = async (id: string): Promise<{ stage: string; halted_at: Date | null }> => (await h.admin.query<{ stage: string; halted_at: Date | null }>("SELECT stage, halted_at FROM work_items WHERE id = $1", [id])).rows[0]!;
const runs = async (workItemId: string): Promise<Array<{ status: string }>> => (await h.admin.query<{ status: string }>("SELECT status FROM agent_runs WHERE work_item_id = $1 ORDER BY created_at", [workItemId])).rows;
const reservations = async (accountId: string): Promise<number> => (await h.admin.query("SELECT 1 FROM spend_reservations WHERE account_id = $1", [accountId])).rowCount ?? 0;

/** One fixture per denial: how to make the real spend check deny, and how the person (or the calendar) clears it. */
interface Case {
  pause: ReservationPause;
  denial: string;
  /** Seeds the state the denial needs; returns the limits that deny. */
  deny(accountId: string, workItemId: string): Promise<Limits>;
  /** The limits after the person raised the limit (or the month turned). */
  cleared(denying: Limits): Limits;
  /** State the clearing changes in the database, when it is not a limit (the credits connection reading ok again). */
  onClear?(accountId: string): Promise<void>;
}

const priorRun = async (accountId: string, workItemId: string | null): Promise<string> => {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [id, accountId, workItemId]);
  return id;
};

const CASES: Case[] = [
  {
    pause: "account_budget_reached",
    denial: "model_budget_exceeded",
    async deny(accountId) {
      const prior = await priorRun(accountId, null);
      await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', 45, $2, 'model')`, [accountId, prior]);
      return { plan: "starter", estimateModelUsd: 10, monthlyModelBudgetUsd: 50, perSpawnCapUsd: 40 };
    },
    cleared: (l) => ({ ...l, monthlyModelBudgetUsd: 500 }),
  },
  {
    pause: "compute_cap_reached",
    denial: "compute_cap_exceeded",
    async deny(accountId) {
      const prior = await priorRun(accountId, null);
      await h.admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'compute', 'sandbox', $3, $2, 'foreground_compute')`, [accountId, prior, foregroundBudgetUsd("starter") - 5]);
      return { plan: "starter", trigger: "foreground", estimateComputeUsd: 10 };
    },
    // The month turns: last month's spend no longer counts.
    cleared: (l) => ({ ...l, now: new Date(Date.now() + 40 * 24 * 3600 * 1000) }),
  },
  {
    pause: "item_cap_reached",
    denial: "work_item_cap_exceeded",
    async deny() {
      return { plan: "starter", estimateModelUsd: 2, monthlyModelBudgetUsd: 600, perSpawnCapUsd: 40, featureCapUsd: 1 };
    },
    cleared: (l) => ({ ...l, featureCapUsd: 100 }),
  },
  {
    pause: "run_limit_below_estimate",
    denial: "per_spawn_cap_exceeded",
    async deny() {
      return { plan: "starter", estimateModelUsd: 50, monthlyModelBudgetUsd: 600, perSpawnCapUsd: 40 };
    },
    cleared: (l) => ({ ...l, perSpawnCapUsd: 60 }),
  },
  {
    // D#483 S5-k2: the customer's own model credits ran out. The state is the one the worker writes (broken, credits_exhausted); the real reserve() reads it.
    pause: "model_credits_exhausted",
    denial: "model_credits_exhausted",
    async deny(accountId) {
      await h.admin.query(
        `INSERT INTO model_connections (account_id, provider, key_ciphertext, key_nonce, wrapped_dek, kek_version, key_fingerprint, status, last_error_code)
         VALUES ($1, 'ai_gateway', $2, $3, $4, 1, $5, 'broken', 'credits_exhausted')`,
        [accountId, Buffer.from("ciphertext"), Buffer.from("nonce"), Buffer.from("wrapped"), `fp-${randomUUID()}`],
      );
      return { plan: "starter", estimateModelUsd: 10, monthlyModelBudgetUsd: 600, perSpawnCapUsd: 40 };
    },
    // Credits come back and the reconcile pass reads the connection ok: no limit changes, no person acts.
    cleared: (l) => l,
    async onClear(accountId) {
      await h.admin.query(`UPDATE model_connections SET status = 'ok', last_error_code = NULL WHERE account_id = $1`, [accountId]);
    },
  },
];

describe.each(CASES)("S5k: $denial becomes $pause", (c) => {
  it("S5k-1: the real denial gives the item that pause and its sentence, reserves nothing, and changes nothing about the item", async () => {
    const a = await account();
    const r = await repo(a);
    const w = await item(a, r);
    const ports = new SpendPorts(a, w, await c.deny(a, w));
    const approval = randomUUID();

    const out = await startBuildForItem(h.runWriterPool, a, w, approval, ports);
    expect(out).toEqual({ status: "refused", reason: c.pause });
    // The run the denied start left is terminal and was never reserved; the item did not move and was not halted.
    expect(await runs(w)).toEqual([{ status: "refused_spend" }]);
    expect(await reservations(a)).toBe(0);
    expect(await stageOf(w)).toMatchObject({ stage: "spec_ready", halted_at: null });

    // The worker leaves one build_waiting fact per ask; the pause is read from it.
    await fact(a, w, out.status === "refused" ? out.reason : "");
    const pause = await readReservationPause(h.runWriterPool, a, w);
    expect(pause).toBe(c.pause);
    expect(RESERVATION_PAUSE_SENTENCES[pause!]).toMatch(/[A-Za-z]/);
    // The pause is not a slot wait.
    expect(await readBuildWaitReason(h.runWriterPool, a, w)).toBeNull();
  });

  it("S5k-2: clearing the denial lets the next ask (a new attempt) reserve and start the run, with no person action, and the pause is gone", async () => {
    const a = await account();
    const r = await repo(a);
    const w = await item(a, r);
    const denying = await c.deny(a, w);
    const ports = new SpendPorts(a, w, denying);
    const approval = randomUUID();
    expect(await startBuildForItem(h.runWriterPool, a, w, approval, ports)).toEqual({ status: "refused", reason: c.pause });
    await fact(a, w, c.pause);

    // Still denied: the next ask is a new attempt, denied again, and leaves its own run.
    expect(await startBuildForItem(h.runWriterPool, a, w, approval, ports, { spendAttempt: 1 })).toEqual({ status: "refused", reason: c.pause });
    expect(await runs(w)).toEqual([{ status: "refused_spend" }, { status: "refused_spend" }]);

    ports.limits = c.cleared(denying);
    await c.onClear?.(a);
    const started = await startBuildForItem(h.runWriterPool, a, w, approval, ports, { spendAttempt: 2 });
    expect(started).toMatchObject({ status: "started" });
    expect(await stageOf(w)).toMatchObject({ stage: "in_progress", halted_at: null });
    expect((await runs(w)).map((x) => x.status)).toEqual(["refused_spend", "refused_spend", "running"]);
    expect(await reservations(a)).toBe(1);
    // The item left the start stage, so the fact no longer reads as a pause.
    expect(await readReservationPause(h.runWriterPool, a, w)).toBeNull();
    // Each ask had its own key: the first is the key it always had, the later ones carry the attempt.
    const base = ports.requests[0]!.step;
    expect(ports.requests.map((q) => q.step)).toEqual([base, `${base}:s1`, `${base}:s2`]);
  });

  it("S5k-3: a denial never writes halted_at, never changes the stage, and a person's halt stays a separate thing", async () => {
    const a = await account();
    const r = await repo(a);
    const w = await item(a, r);
    const ports = new SpendPorts(a, w, await c.deny(a, w));
    await startBuildForItem(h.runWriterPool, a, w, randomUUID(), ports);
    const transitions = await h.admin.query("SELECT 1 FROM work_item_transitions WHERE work_item_id = $1 AND to_stage <> 'spec_ready'", [w]);
    expect(transitions.rowCount).toBe(0);
    expect(await stageOf(w)).toMatchObject({ stage: "spec_ready", halted_at: null });

    // A halt is the person's own state: it ends the pause reading, and the pause never sets it.
    await fact(a, w, c.pause);
    expect(await readReservationPause(h.runWriterPool, a, w)).toBe(c.pause);
    await h.admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1", [w, randomUUID()]);
    expect(await readReservationPause(h.runWriterPool, a, w)).toBeNull();
  });
});

describe("S5k: the pause is derived, never stamped", () => {
  it("a stale fact, a newer different fact, another account's item and an item at another stage are not a pause", async () => {
    const a = await account();
    const other = await account();
    const r = await repo(a);
    const stale = await item(a, r);
    await fact(a, stale, "item_cap_reached", RESERVATION_PAUSE_WINDOW_SECONDS + 60);
    expect(await readReservationPause(h.runWriterPool, a, stale)).toBeNull();

    const replaced = await item(a, r);
    await fact(a, replaced, "account_budget_reached", 120);
    await fact(a, replaced, "waiting_for_build_slot_repo");
    expect(await readReservationPause(h.runWriterPool, a, replaced)).toBeNull();

    const live = await item(a, r);
    await fact(a, live, "compute_cap_reached");
    expect(await readReservationPause(h.runWriterPool, a, live)).toBe("compute_cap_reached");
    // RLS: another account reads nothing for this item.
    expect(await readReservationPause(h.runWriterPool, other, live)).toBeNull();

    const building = await item(a, r, { stage: "in_progress" });
    await fact(a, building, "compute_cap_reached");
    expect(await readReservationPause(h.runWriterPool, a, building)).toBeNull();

    // Build again for an item at Needs a person is a start stage too.
    const again = await item(a, r, { stage: "needs_human" });
    await fact(a, again, "run_limit_below_estimate");
    expect(await readReservationPause(h.runWriterPool, a, again)).toBe("run_limit_below_estimate");
  });

  it("an item paused for a limit holds no build slot back from the item behind it", async () => {
    const a = await account();
    const r = await repo(a);
    const ahead = await item(a, r, { priority: 1 });
    const behind = await item(a, r, { priority: 3 });
    // A slot wait ahead makes the one behind give way ...
    await fact(a, ahead, "waiting_for_build_slot_repo");
    expect(await readBuildWaitReason(h.runWriterPool, a, behind)).toBe("one_build_per_repo_until_d598");
    // ... a spend pause ahead does not.
    const a2 = await account();
    const r2 = await repo(a2);
    const ahead2 = await item(a2, r2, { priority: 1 });
    const behind2 = await item(a2, r2, { priority: 3 });
    await fact(a2, ahead2, "account_budget_reached");
    expect(await readBuildWaitReason(h.runWriterPool, a2, behind2)).toBeNull();
  });

  it("account_not_active keeps its existing refusal and is not a pause", async () => {
    const a = await account();
    const r = await repo(a);
    const w = await item(a, r);
    const ports: AdvanceRunPorts = {
      async startRun() {
        return { ok: false as const, reason: "account_not_active" };
      },
      async outcome() {
        return { status: "running", done: false, envelope: null };
      },
      async cancel() {},
    };
    expect(await startBuildForItem(h.runWriterPool, a, w, randomUUID(), ports)).toEqual({ status: "refused", reason: "start_account_not_active" });
  });
});
