import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { plannedFixture, row, type PlannedFixture, type PlannedOptions } from "@fx/db/test/helpers/plannedChildren.js";
import { approveSubItem } from "@fx/core/src/decisions/approveSubItem.js";
import { readChildLaunch, type ChildLaunchDeps } from "@fx/core/src/decisions/childLaunch.js";
import { setStackParent } from "@fx/core/src/work-items/stackParent.js";
import { childEnvelopeRoom } from "@fx/spend";
import { createAutoStartSweep } from "../src/autoStartSweep.js";

/**
 * [pg] D#598 P3d: a planned PR child with ONE open dependency whose pull request is open starts at once and is stacked on it (`stack_parent_id`), through the real
 * launch paths (the dial's `gateChild`, a person's Approve) against the real 0944 functions. Every other case waits, as before, with the sentence for why.
 * Each test seeds its own account.
 */
const LOGIN = "fx_child_stack_test";
const PRICE = 1;
const THREE = [row("a", "Alpha"), row("b", "Beta"), row("c", "Gamma", ["a", "b"])];

describe("a planned PR child stacks on its open dependency at launch [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;

  const room: ChildLaunchDeps["room"] = async (client, input) => {
    const r = await childEnvelopeRoom(client, { accountId: input.accountId, envelopeId: input.envelopeId, childId: input.childId, firstRunUsd: PRICE });
    return { fits: r.fits, remainingUsd: r.remainingUsd, priceUsd: PRICE };
  };
  const child: ChildLaunchDeps = { buildSupported: true, room };
  let sweep: ReturnType<typeof createAutoStartSweep>;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    sweep = createAutoStartSweep({ receiptPool, firstRunUsd: async () => PRICE, child, warn: () => {} });
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), appPool.end()]);
  });

  const fixture = (o: PlannedOptions = {}) => plannedFixture(admin, appPool, { envelopeUsd: 20, dial: "act", ...o });
  const setStage = (id: string, stage: string) => admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [id, stage]);
  const linkOf = async (id: string) => (await admin.query("SELECT stack_parent_id FROM work_items WHERE id = $1", [id])).rows[0].stack_parent_id as string | null;
  const requests = async (id: string) => Number((await admin.query("SELECT count(*) n FROM run_action_requests WHERE target_id = $1 AND kind = 'advance_work_item'", [id])).rows[0].n);
  const card = (f: PlannedFixture, key: string, person = false) =>
    withTenant(receiptPool, f.t.accountId, (c) => readChildLaunch(c, { accountId: f.t.accountId, childId: f.kids[key]!, person, deps: { room } }));
  const approve = (f: PlannedFixture, key: string) => approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.t.userId }, child }, { workItemId: f.parent, key });
  const HELD = { outcome: "held_by_rule", code: "waiting_on_planned_pr" };

  it("no open dependency: no link, the child builds from main (a child with none, and one whose dependency merged)", async () => {
    const f = await fixture();
    expect(await sweep.gateChild(f.t.accountId, f.kids.api)).toEqual({ outcome: "started" });
    expect(await linkOf(f.kids.api)).toBeNull();
    await setStage(f.kids.api, "merged");
    expect(await sweep.gateChild(f.t.accountId, f.kids.ui)).toEqual({ outcome: "started" });
    expect(await linkOf(f.kids.ui)).toBeNull();
  });

  it("one open dependency with an open pull request: it launches at once and is stacked on that sibling, for each stage that has a pull request", async () => {
    for (const stage of ["pr_opened", "changes_requested", "review_passed"]) {
      const f = await fixture();
      await setStage(f.kids.api, stage);
      expect(await card(f, "ui")).toMatchObject({ code: null, warning: null });
      expect(await sweep.gateChild(f.t.accountId, f.kids.ui)).toEqual({ outcome: "started" });
      expect(await linkOf(f.kids.ui), stage).toBe(f.kids.api);
      expect(await requests(f.kids.ui)).toBe(1);
    }
  });

  it("a dependency with no pull request yet: the child waits with its own sentence, then stacks once the pull request opens (it does not wait for the merge)", async () => {
    const f = await fixture();
    for (const stage of ["triaged", "in_progress"]) {
      await setStage(f.kids.api, stage);
      expect(await sweep.gateChild(f.t.accountId, f.kids.ui)).toEqual(HELD);
      expect(await card(f, "ui")).toMatchObject({ code: "waiting_on_planned_pr", sentence: "Waiting for The API to open its pull request." });
      expect(await linkOf(f.kids.ui)).toBeNull();
    }
    await setStage(f.kids.api, "pr_opened");
    expect(await sweep.gateChild(f.t.accountId, f.kids.ui)).toEqual({ outcome: "started" });
    expect(await linkOf(f.kids.ui)).toBe(f.kids.api);
  });

  it("a halted dependency is never stacked on (the halt marker is read): the child waits for the merge", async () => {
    const f = await fixture();
    await setStage(f.kids.api, "pr_opened");
    await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = halt_epoch + 1 WHERE id = $1", [f.kids.api, randomUUID()]);
    expect(await sweep.gateChild(f.t.accountId, f.kids.ui)).toEqual(HELD);
    expect(await card(f, "ui")).toMatchObject({ code: "waiting_on_planned_pr", sentence: "Waits for The API to merge." });
    expect(await linkOf(f.kids.ui)).toBeNull();
    expect(await requests(f.kids.ui)).toBe(0);
  });

  it("a dependency in a person's hands, or closed, is not stacked on either", async () => {
    for (const stage of ["needs_human", "closed_unmerged"]) {
      const f = await fixture();
      await setStage(f.kids.api, stage);
      expect(await sweep.gateChild(f.t.accountId, f.kids.ui), stage).toEqual(HELD);
      expect(await linkOf(f.kids.ui)).toBeNull();
    }
  });

  it("two or more open dependencies: it waits with the one-parent sentence until only one is open, then stacks on that one", async () => {
    const f = await fixture({ table: THREE });
    await setStage(f.kids.a, "pr_opened");
    await setStage(f.kids.b, "pr_opened");
    expect(await sweep.gateChild(f.t.accountId, f.kids.c)).toEqual(HELD);
    expect(await card(f, "c")).toMatchObject({ code: "waiting_on_planned_pr", sentence: "Waiting for Alpha to merge before it can build on Beta." });
    expect(await linkOf(f.kids.c)).toBeNull();
    await setStage(f.kids.a, "merged");
    expect(await sweep.gateChild(f.t.accountId, f.kids.c)).toEqual({ outcome: "started" });
    expect(await linkOf(f.kids.c)).toBe(f.kids.b);
  });

  it("a cycle is never linked: the child waits for the merge, and setStackParent refuses the same pair at the data", async () => {
    const f = await fixture();
    await setStage(f.kids.api, "pr_opened");
    // Crafted pair: the sibling is already stacked on the child, so stacking the child on it would close a loop.
    await admin.query("UPDATE work_items SET stack_parent_id = $2 WHERE id = $1", [f.kids.api, f.kids.ui]);
    expect(await card(f, "ui")).toMatchObject({ code: "waiting_on_planned_pr", sentence: "Waits for The API to merge." });
    expect(await sweep.gateChild(f.t.accountId, f.kids.ui)).toEqual(HELD);
    await expect(withTenant(appPool, f.t.accountId, f.t.userId, (c) => setStackParent(c, { workItemId: f.kids.ui, stackParentId: f.kids.api }))).rejects.toMatchObject({ code: "cycle" });
    expect(await linkOf(f.kids.ui)).toBeNull();
  });

  it("a person's Approve stacks the same way; a person who starts a child out of order gets no link", async () => {
    const f = await fixture({ dial: "ask" });
    await setStage(f.kids.api, "pr_opened");
    expect(await approve(f, "ui")).toMatchObject({ childLaunchedId: f.kids.ui });
    expect(await linkOf(f.kids.ui)).toBe(f.kids.api);

    const g = await fixture({ dial: "ask" });
    expect(await approve(g, "ui")).toMatchObject({ childLaunchedId: g.kids.ui });
    expect(await linkOf(g.kids.ui)).toBeNull();

    // Two open dependencies, one with a pull request: a person's early start still builds from main (one parent only).
    const h = await fixture({ dial: "ask", table: THREE });
    await setStage(h.kids.a, "pr_opened");
    expect(await approve(h, "c")).toMatchObject({ childLaunchedId: h.kids.c });
    expect(await linkOf(h.kids.c)).toBeNull();
  });

  it("a link the child already has is kept", async () => {
    const f = await fixture({ table: THREE });
    await setStage(f.kids.a, "pr_opened");
    await setStage(f.kids.b, "merged");
    await admin.query("UPDATE work_items SET stack_parent_id = $2 WHERE id = $1", [f.kids.c, f.kids.b]);
    expect(await sweep.gateChild(f.t.accountId, f.kids.c)).toEqual({ outcome: "started" });
    expect(await linkOf(f.kids.c)).toBe(f.kids.b);
  });

  it("three passes at once launch it once and write one link (separate connections)", async () => {
    const f = await fixture();
    await setStage(f.kids.api, "pr_opened");
    const outcomes = (await Promise.all([sweep.gateChild(f.t.accountId, f.kids.ui), sweep.gateChild(f.t.accountId, f.kids.ui), sweep.gateChild(f.t.accountId, f.kids.ui)])).map((r) => r.outcome).sort();
    expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
    expect(await linkOf(f.kids.ui)).toBe(f.kids.api);
    expect(await requests(f.kids.ui)).toBe(1);
  });

  describe("the sibling stops being stackable between the check and the link", () => {
    const halt = (id: string) => admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = halt_epoch + 1 WHERE id = $1", [id, randomUUID()]);
    const receipts = async (accountId: string) => Number((await admin.query("SELECT count(*) n FROM decision_receipts WHERE account_id = $1", [accountId])).rows[0].n);
    /** Deps whose room check halts the sibling: it runs after the blocker was read and before the link. */
    const haltingDeps = (siblingId: string): ChildLaunchDeps => ({ buildSupported: true, room: async (client, input) => { await halt(siblingId); return room(client, input); } });

    it("the dial refuses, and rolls back the receipt and the request (no start from main with the dependency unmerged)", async () => {
      const f = await fixture();
      await setStage(f.kids.api, "pr_opened");
      const racing = createAutoStartSweep({ receiptPool, firstRunUsd: async () => PRICE, child: haltingDeps(f.kids.api), warn: () => {} });
      const before = await receipts(f.t.accountId);
      expect(await racing.gateChild(f.t.accountId, f.kids.ui)).toEqual(HELD);
      expect(await requests(f.kids.ui)).toBe(0);
      expect(await receipts(f.t.accountId)).toBe(before);
      expect(await linkOf(f.kids.ui)).toBeNull();
    });

    it("a parent's approval refuses the same way", async () => {
      const f = await fixture({ dial: "ask" });
      await setStage(f.kids.api, "pr_opened");
      const before = await receipts(f.t.accountId);
      await expect(approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.t.userId }, child: haltingDeps(f.kids.api) }, { workItemId: f.parent, key: "ui", viaParentApproval: true }))
        .rejects.toMatchObject({ name: "SubItemApprovalError", code: "waiting_on_planned_pr" });
      expect(await requests(f.kids.ui)).toBe(0);
      expect(await receipts(f.t.accountId)).toBe(before);
      expect(await linkOf(f.kids.ui)).toBeNull();
    });

    it("a person's own early start from the card is not held", async () => {
      const f = await fixture({ dial: "ask" });
      await setStage(f.kids.api, "pr_opened");
      expect(await approveSubItem({ pool: receiptPool, principal: { accountId: f.t.accountId, userId: f.t.userId }, child: haltingDeps(f.kids.api) }, { workItemId: f.parent, key: "ui" })).toMatchObject({ childLaunchedId: f.kids.ui });
      expect(await linkOf(f.kids.ui)).toBeNull();
    });
  });

  it("no sentence prints null, undefined or an id, whatever the siblings' titles", async () => {
    const f = await fixture({ table: THREE });
    await admin.query("UPDATE work_items SET title = NULL WHERE id = ANY($1)", [[f.kids.a, f.kids.b]]);
    const s = (await card(f, "c")).sentence!;
    expect(s).toBe("Waiting for another planned PR to merge before it can build on another planned PR.");
    expect(s).not.toMatch(/null|undefined|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});
