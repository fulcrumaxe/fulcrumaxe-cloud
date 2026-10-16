import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount } from "./build/helpers/seed.js";
import { listSlotWaiters } from "../src/advance/buildSlots.js";
import { RESERVATION_PAUSE_WINDOW_SECONDS, readReservationPause } from "../src/advance/reservationPauses.js";

/**
 * D#483 S5k1b-8 and S5k1b-9 [pg]: the stage-aware reader over real rows. The latest waiting fact of either kind counts, a `build_waiting` row written by the S5-k1 code
 * still gives its pause, and a fact of one stage is never read as another stage's wait.
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

async function item(accountId: string, repoId: string, stage: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage, priority) VALUES ($1, $2, $3, 'feature', 'running', 'internal', $4, $5, 2)`, [id, accountId, repoId, Math.floor(Math.random() * 100_000) + 1, stage]);
  return id;
}

/** The S5-k1 code's fact: kind build_waiting, no stage. */
const oldFact = async (accountId: string, workItemId: string, code: string): Promise<void> => {
  await h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'build_waiting', $3, $4)`, [accountId, workItemId, code, randomUUID()]);
};

const newFact = async (accountId: string, workItemId: string, stage: "build" | "classify" | "spec", code: string): Promise<void> => {
  await withTenant(h.runWriterPool, accountId, async (client) => {
    await recordDriverEvent(client, accountId, { workItemId, kind: "stage_waiting", stage, code, attempt: 0, dedupeKey: randomUUID() });
  });
};

const age = (workItemId: string, seconds: number): Promise<unknown> => h.admin.query("UPDATE work_item_driver_events SET created_at = now() - make_interval(secs => $2::int) WHERE work_item_id = $1", [workItemId, seconds]);

describe("the waiting reader: both kinds, one stage at a time", () => {
  it("S5k1b-8: a build_waiting row from the S5-k1 code still gives its pause", async () => {
    const a = await account();
    const w = await item(a, await repo(a), "spec_ready");
    await oldFact(a, w, "item_cap_reached");
    expect(await readReservationPause(h.runWriterPool, a, w)).toBe("item_cap_reached");
  });

  it("S5k1b-8: a newer stage_waiting row wins over an older build_waiting one, and an older stage_waiting loses to a newer build_waiting", async () => {
    const a = await account();
    const w = await item(a, await repo(a), "spec_ready");
    await oldFact(a, w, "item_cap_reached");
    await newFact(a, w, "build", "compute_cap_reached");
    expect(await readReservationPause(h.runWriterPool, a, w)).toBe("compute_cap_reached");
    await oldFact(a, w, "account_budget_reached");
    expect(await readReservationPause(h.runWriterPool, a, w)).toBe("account_budget_reached");
  });

  it("the pause window is 45 minutes: a fact 44 minutes old counts, one 46 minutes old does not", async () => {
    expect(RESERVATION_PAUSE_WINDOW_SECONDS).toBe(45 * 60);
    const a = await account();
    const w = await item(a, await repo(a), "spec_ready");
    await newFact(a, w, "build", "run_limit_below_estimate");
    await age(w, 44 * 60);
    expect(await readReservationPause(h.runWriterPool, a, w)).toBe("run_limit_below_estimate");
    await age(w, 46 * 60);
    expect(await readReservationPause(h.runWriterPool, a, w)).toBeNull();
  });

  it("S5k1b-9: a classify fact on a triaged item is a classify pause and not a build pause, and a build fact on a Spec ready item is the reverse", async () => {
    const a = await account();
    const r = await repo(a);
    const triaged = await item(a, r, "triaged");
    const ready = await item(a, r, "spec_ready");
    await newFact(a, triaged, "classify", "account_budget_reached");
    await newFact(a, ready, "build", "compute_cap_reached");
    expect(await readReservationPause(h.runWriterPool, a, triaged, "classify")).toBe("account_budget_reached");
    expect(await readReservationPause(h.runWriterPool, a, triaged, "build")).toBeNull();
    expect(await readReservationPause(h.runWriterPool, a, ready, "build")).toBe("compute_cap_reached");
    expect(await readReservationPause(h.runWriterPool, a, ready, "classify")).toBeNull();
    // A fact of the wrong stage on an item sitting where another stage waits is not read at all.
    await newFact(a, ready, "classify", "item_cap_reached");
    expect(await readReservationPause(h.runWriterPool, a, ready, "classify")).toBeNull();
  });

  it("S5k1b-9: the slot-waiter query for stage build does not return a classify waiter, and the one for classify does not return a build waiter (two stages, one account)", async () => {
    const a = await account();
    const r = await repo(a);
    const me = await item(a, r, "spec_ready");
    const buildWaiter = await item(a, r, "spec_ready");
    const classifyWaiter = await item(a, r, "triaged");
    await newFact(a, buildWaiter, "build", "waiting_for_build_slot_repo");
    await newFact(a, classifyWaiter, "classify", "waiting_for_build_slot_repo");
    const ids = async (stage: "build" | "classify"): Promise<string[]> =>
      withTenant(h.runWriterPool, a, async (client) => (await listSlotWaiters(client, a, me, stage)).map((x) => x.id)).then((x) => x.sort());
    expect(await ids("build")).toEqual([buildWaiter]);
    expect(await ids("classify")).toEqual([classifyWaiter]);
  });

  it("a spend pause is not a slot wait: an item paused for a limit holds no slot back", async () => {
    const a = await account();
    const r = await repo(a);
    const me = await item(a, r, "spec_ready");
    const paused = await item(a, r, "spec_ready");
    await newFact(a, paused, "build", "account_budget_reached");
    expect(await withTenant(h.runWriterPool, a, async (client) => (await listSlotWaiters(client, a, me, "build")).length)).toBe(0);
  });

  it("the store refuses a stage_waiting row with no stage, an unknown stage, or a stage on another kind", async () => {
    const a = await account();
    const w = await item(a, await repo(a), "spec_ready");
    const insert = (kind: string, stage: string | null, code: string | null) =>
      h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, stage, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6)`, [a, w, kind, code, stage, randomUUID()]);
    await expect(insert("stage_waiting", null, "item_cap_reached")).rejects.toThrow();
    await expect(insert("stage_waiting", "nonsense", "item_cap_reached")).rejects.toThrow();
    await expect(insert("stage_waiting", "build", null)).rejects.toThrow();
    await expect(insert("build_refused", "build", "x")).rejects.toThrow();
    await expect(insert("stage_waiting", "panel", "item_cap_reached")).resolves.toBeDefined();
  });
});
