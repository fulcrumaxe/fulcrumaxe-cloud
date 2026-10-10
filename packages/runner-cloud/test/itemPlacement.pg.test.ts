import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { auditPlacementChange, cancelPendingRunsOnLeftSide, type Placement } from "../src/index.js";
import { harness, type Harness } from "./helpers.js";

describe("item placement: the item-scoped cancel and its audit row [pg] (D#599 PL-1)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  async function repo(f: F2Fixture, mode: string): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'Acme', 'widgets', $4)", [id, f.accountId, Math.floor(Math.random() * 1e12), mode]);
    return id;
  }
  async function item(f: F2Fixture, repoId: string, placement: Placement | null): Promise<string> {
    const id = randomUUID();
    await h.admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, placement) VALUES ($1, $2, $3, 'feature', 'internal', $4)", [id, f.accountId, repoId, placement]);
    return id;
  }
  async function run(f: F2Fixture, repoId: string, itemId: string, side: Placement, status = "pending"): Promise<string> {
    const id = randomUUID();
    await h.admin.query(
      "INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id) VALUES ($1, $2, 'code-reviewer', $3, $4, $5, $6, $7)",
      [id, f.accountId, side === "runner" ? "runner" : "production", status, side === "runner" ? "runner_local" : "sandbox", repoId, itemId],
    );
    return id;
  }
  const status = async (id: string) => (await h.admin.query("SELECT status FROM agent_runs WHERE id = $1", [id])).rows[0].status as string;
  const moves = async (id: string) => (await h.admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.status_changed' ORDER BY seq", [id])).rows.map((r) => r.payload);
  const domain = async (id: string) => (await h.admin.query("SELECT payload FROM domain_events WHERE subject_id = $1 AND type = 'run.status_changed'", [id])).rows.map((r) => r.payload);
  const audits = async (itemId: string) => (await h.admin.query("SELECT actor, payload FROM audit_log WHERE action = 'work_item.placement.changed' AND payload ->> 'item_id' = $1 ORDER BY created_at, id", [itemId])).rows;
  const setPlacement = (itemId: string, placement: Placement | null) => h.admin.query("UPDATE work_items SET placement = $2 WHERE id = $1", [itemId, placement]);

  it("cancels the item's queued runs on the side it left, with the events a status move writes and the reason placement_changed; running runs and other items' runs stay", async () => {
    const f = await seedF2(h.admin);
    const g = await repo(f, "runner_local");
    const mine = await item(f, g, "runner");
    const other = await item(f, g, "runner");
    const queued = [await run(f, g, mine, "runner"), await run(f, g, mine, "runner")];
    const running = await run(f, g, mine, "runner", "running");
    const sandbox = await run(f, g, mine, "cloud");
    const neighbour = await run(f, g, other, "runner");
    await setPlacement(mine, "cloud"); // the placement is stored first, in the same transaction in production
    const ids = await withTenant(h.appPool, f.accountId, f.o1, async (client) => {
      const moved = await cancelPendingRunsOnLeftSide(client, { accountId: f.accountId, itemId: mine, leaving: "runner" });
      await auditPlacementChange(client, { itemId: mine, from: "runner", to: "cloud", cancelledRuns: moved.length });
      return moved;
    });
    expect([...ids].sort()).toEqual([...queued].sort());
    for (const r of queued) {
      expect(await status(r)).toBe("cancelled");
      expect(await moves(r)).toEqual([{ from: "pending", to: "cancelled", failureReason: "placement_changed" }]);
      expect(await domain(r)).toEqual([{ runId: r, from: "pending", to: "cancelled" }]);
    }
    for (const [r, want] of [[running, "running"], [sandbox, "pending"], [neighbour, "pending"]] as const) {
      expect(await status(r), r).toBe(want);
      expect(await moves(r)).toEqual([]);
    }
    expect(await audits(mine)).toEqual([{ actor: f.o1, payload: { item_id: mine, from: "runner", to: "cloud", cancelled_runs: 2 } }]);
  });

  it("undo: setting the item back to the repo default cancels the queued runs of the side the repo default is not, and the audit row has null as the new value", async () => {
    const f = await seedF2(h.admin);
    const g = await repo(f, "runner_local");
    const id = await item(f, g, "cloud");
    const box = await run(f, g, id, "cloud");
    const onRunner = await run(f, g, id, "runner");
    await setPlacement(id, null);
    await withTenant(h.appPool, f.accountId, f.a1, async (client) => {
      const moved = await cancelPendingRunsOnLeftSide(client, { accountId: f.accountId, itemId: id, leaving: "cloud" });
      expect(moved).toEqual([box]);
      await auditPlacementChange(client, { itemId: id, from: "cloud", to: null, cancelledRuns: 1 });
    });
    expect(await status(box)).toBe("cancelled");
    expect(await status(onRunner)).toBe("pending");
    expect(await audits(id)).toEqual([{ actor: f.a1, payload: { item_id: id, from: "cloud", to: null, cancelled_runs: 1 } }]);
  });

  it("a member is refused (42501) and nothing is written: the transaction leaves every run pending and no event or audit row", async () => {
    const f = await seedF2(h.admin);
    const g = await repo(f, "runner_local");
    const id = await item(f, g, "cloud");
    const queued = await run(f, g, id, "runner");
    await expect(
      withTenant(h.appPool, f.accountId, f.m1, (client) => cancelPendingRunsOnLeftSide(client, { accountId: f.accountId, itemId: id, leaving: "runner" })),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await status(queued)).toBe("pending");
    expect(await moves(queued)).toEqual([]);
    expect(await audits(id)).toEqual([]);
  });

  it("a later failure in the same transaction rolls the cancel back with it (the audit refuses a count the change cannot explain)", async () => {
    const f = await seedF2(h.admin);
    const g = await repo(f, "runner_local");
    const id = await item(f, g, "cloud");
    const queued = await run(f, g, id, "runner");
    await setPlacement(id, "cloud");
    await expect(
      withTenant(h.appPool, f.accountId, f.o1, async (client) => {
        await cancelPendingRunsOnLeftSide(client, { accountId: f.accountId, itemId: id, leaving: "runner" });
        await auditPlacementChange(client, { itemId: id, from: "cloud", to: "cloud", cancelledRuns: 1 });
      }),
    ).rejects.toMatchObject({ code: "22023" });
    expect(await status(queued)).toBe("pending");
    expect(await moves(queued)).toEqual([]);
    expect(await audits(id)).toEqual([]);
  });
});
