import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedAccount as seedFullAccount } from "@fx/db/test/helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { CAPACITY_SETTING_DEFAULTS } from "../src/advance/capacityQueue.js";
import { capacityAlertText, createCapacityPort } from "../src/advance/capacityPort.js";
import { CAPACITY_WAIT } from "../src/advance/reservationPauses.js";

/**
 * [pg] D#483 S5-k3b-2c: the port the worker's gate asks (cases 4 to 6 of C23 item 3), the single depth alert (S5k3b-12), and the lease/poll line-up. The gate's own path through
 * a real start is packages/worker/test/capacityGate.pg.test.ts.
 */
const h = pgHarness();

async function account(items: number) {
  const accountId = randomUUID();
  const refs = await seedFullAccount(h.admin, accountId);
  await h.admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1`, [accountId]);
  const ids = [refs.workItemId];
  for (let i = 1; i < items; i++) {
    const id = randomUUID();
    await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [id, accountId, refs.repoId]);
    ids.push(id);
  }
  return { accountId, repoId: refs.repoId, items: ids };
}
const asks = (accountId: string, item: string) =>
  h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'build', 'waiting_for_capacity', $3)`, [accountId, item, randomUUID()]);
const inUse = async (): Promise<number> => Number((await h.admin.query("SELECT o_slots_in_use AS n FROM capacity_queue_state('hosted_sandbox')")).rows[0].n);

beforeEach(async () => {
  await h.admin.query(`DELETE FROM capacity_queue`);
  await h.admin.query(`DELETE FROM capacity_queue_settings`);
});

describe("the capacity port [pg]", () => {
  it("S5k3b-12: with the depth setting at 20 the 21st waiting entry raises ONE alert (not one per entry) and is queued as normal", async () => {
    const a = await account(23);
    const full = await inUse();
    const alert = vi.fn(async () => undefined);
    const port = createCapacityPort({ pool: h.runWriterPool, slotTotal: () => full, alert });
    for (let i = 0; i < 22; i++) {
      // the item has asked before (it writes the fact on every ask), so its entry counts as soon as it exists
      await asks(a.accountId, a.items[i]!);
      expect(await port.admit({ accountId: a.accountId, repoId: a.repoId, workItemId: a.items[i]!, runKind: "executor" })).toEqual({ kind: "wait" });
      if (i < CAPACITY_SETTING_DEFAULTS.alertDepth) expect(alert).not.toHaveBeenCalled();
    }
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(capacityAlertText(21, 20));
    // a second ask of an item already in line is no new entry and no new alert
    await port.admit({ accountId: a.accountId, repoId: a.repoId, workItemId: a.items[0]!, runKind: "executor" });
    expect(alert).toHaveBeenCalledTimes(1);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM capacity_queue WHERE ended_at IS NULL")).rows[0].n).toBe(22);
  });

  it("the alert (exactly one, at the 21st) counts an entry whose item has not yet written its first waiting fact (a new entry is not asking yet), and a failing sink never changes the answer", async () => {
    const a = await account(21);
    const full = await inUse();
    const onAlertError = vi.fn();
    const port = createCapacityPort({ pool: h.runWriterPool, slotTotal: () => full, alert: async () => { throw new Error("sink down"); }, onAlertError });
    const answers: string[] = [];
    for (let i = 0; i < 21; i++) {
      answers.push((await port.admit({ accountId: a.accountId, repoId: a.repoId, workItemId: a.items[i]!, runKind: "executor" })).kind);
      await asks(a.accountId, a.items[i]!);
    }
    expect(new Set(answers)).toEqual(new Set(["wait"]));
    expect(onAlertError).toHaveBeenCalledTimes(1);
  });

  it("cases 4 to 6: a direct start with room and nobody waiting; a queue place when full (a second ask keeps it); a held claim is consumed; a missing slot total counts nothing", async () => {
    const a = await account(2);
    const [x, y] = a.items as [string, string];
    let total = (await inUse()) + 1;
    const port = createCapacityPort({ pool: h.runWriterPool, slotTotal: () => total });
    const who = (w: string) => ({ accountId: a.accountId, repoId: a.repoId, workItemId: w, runKind: "executor" });
    expect(await port.admit(who(x))).toEqual({ kind: "start" });
    expect((await h.admin.query("SELECT 1 FROM capacity_queue")).rowCount).toBe(0);
    total = await inUse(); // full
    expect(await port.holds(a.accountId, x)).toBe(false);
    expect(await port.admit(who(x))).toEqual({ kind: "wait" });
    expect(await port.holds(a.accountId, x)).toBe(true);
    const placed = (await h.admin.query("SELECT id, enqueued_at FROM capacity_queue")).rows[0];
    expect(await port.admit(who(x))).toEqual({ kind: "wait" });
    expect((await h.admin.query("SELECT id, enqueued_at FROM capacity_queue")).rows).toEqual([placed]);
    // room, but someone is waiting: the second item queues behind the first and does not jump the line
    await asks(a.accountId, x);
    total += 1;
    expect(await port.admit(who(y))).toEqual({ kind: "wait" });
    // the first item's ask takes the room it was waiting for
    expect(await port.admit(who(x))).toMatchObject({ kind: "claimed", entryId: placed.id, attempt: 1 });
    // and a held claim is consumed without a second claim pass
    expect(await port.admit(who(x))).toMatchObject({ kind: "claimed", entryId: placed.id });
    // no figure in plan data: the gate counts nothing
    const none = createCapacityPort({ pool: h.runWriterPool, slotTotal: () => { throw new Error("no figure"); } });
    expect(await none.admit(who(y))).toEqual({ kind: "start" });
    expect(await none.claimPass()).toBe(0);
  });
});

describe("the lease and the poll line up (C23 item 9)", () => {
  it("CAPACITY_SETTING_DEFAULTS.leaseSeconds >= 2 x CAPACITY_POLL_MS / 1000, so a claim covers two asks of a live waiter", () => {
    const source = readFileSync(new URL("../../../apps/web/workflows/workItemAdvance.ts", import.meta.url), "utf8");
    const poll = Number(/const CAPACITY_POLL_MS = ([0-9_]+);/.exec(source)?.[1]?.replace(/_/g, ""));
    expect(poll).toBe(60_000);
    expect(CAPACITY_SETTING_DEFAULTS.leaseSeconds).toBeGreaterThanOrEqual((2 * poll) / 1000);
  });

  it("the worker's gate and the pipeline name the wait reason the same way", () => {
    const gate = readFileSync(new URL("../../worker/src/capacityGate.ts", import.meta.url), "utf8");
    expect(gate).toContain(`export const CAPACITY_WAIT = "${CAPACITY_WAIT}";`);
  });

  it("S5k3b-11: no source file but the gate refuses a start on slot exhaustion (the wait reason is returned from this one worker file, and no other worker or pipeline source builds it from a count)", () => {
    const files = ["../../worker/src/advance.ts", "../../worker/src/checkFix.ts", "../src/advance/build.ts", "../src/advance/stageStarts.ts"];
    for (const f of files) expect(readFileSync(new URL(f, import.meta.url), "utf8"), f).not.toMatch(/slotsInUse|headroom\s*[<=]+\s*0|hostedSandboxSlotTotal/);
  });
});
