import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { ENGINE_EVENTS_PATH, ingestEngineEvents, toResponse } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

const GH = 515151;
const T = "2026-11-16T10:00:00.000Z";

/** [pg] Engine bridge EB-7: plan snapshots through the real ingest door (migration 1027's definer, 1032's assembling trigger), under the definer's own row policies. */
describe("engine plan snapshots through ingest [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let B: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  let instance: string;
  let seq: number;

  const plan = (n: number, snap: string, index: number, count: number, over: Record<string, unknown> = {}) => ({
    v: 1, seq: n, ts: T, kind: "plan_snapshot", engine_instance_id: instance,
    plan_date: "2026-11-16", snapshot_id: snap, chunk_index: index, chunk_count: count,
    items: [{ discussion: 10 + index, ordinal: index, state: "planned" }],
    roadmap: [{ row_key: `${snap}-${index}`, status: "in_progress", planned_prs: 1 }],
    ...over,
  });
  const batch = (events: object[]) => ({ session: { engine_instance_id: instance, repo_gh_id: GH, engine_version: "1.2.3" }, events });
  const post = async (events: object[], k: TestKey = key) =>
    (await toResponse(() => ingestEngineEvents(h.deps(), signed(k, ENGINE_EVENTS_PATH, batch(events))))) as { status: number; body: Record<string, unknown> };
  const n = async (table: string, accountId = A.accountId) => Number((await h.admin.query(`SELECT count(*) AS c FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].c);
  const latest = async () => (await h.admin.query(`SELECT items, roadmap, plan_date::text AS d FROM engine_plan_snapshots WHERE account_id = $1 ORDER BY received_at DESC LIMIT 1`, [A.accountId])).rows[0];

  beforeAll(async () => {
    h = await harness();
    A = await seedAccount(h.admin, randomUUID());
    B = await seedAccount(h.admin, randomUUID());
    key = newKey();
    runnerId = await registerKey(h.admin, A.accountId, A.userId, key);
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    instance = randomUUID();
    seq = 0;
    await h.admin.query(`DELETE FROM engine_sessions WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM engine_bridge_settings WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [A.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [A.accountId, A.repoId]);
    await h.admin.query(`UPDATE repos SET execution_mode = 'runner_local', gh_repo_id = $2 WHERE id = $1`, [A.repoId, GH]);
    await h.admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[], revoked_at = NULL WHERE id = $1`, [runnerId, A.repoId]);
  });

  it("chunks that arrive in different batches are stored whole as one snapshot, and the events stay in the log", async () => {
    expect((await post([plan(seq++, "s1", 0, 3), plan(seq++, "s1", 1, 3)])).status).toBe(200);
    expect(await n("engine_plan_snapshots")).toBe(0);
    expect(await n("engine_plan_chunks")).toBe(2);
    expect((await post([plan(seq++, "s1", 2, 3)])).status).toBe(200);
    expect(await n("engine_plan_snapshots")).toBe(1);
    expect(await n("engine_plan_chunks")).toBe(0);
    expect(await n("engine_events")).toBe(3);
    const row = await latest();
    expect(row.items.map((i: { discussion: number }) => i.discussion)).toEqual([10, 11, 12]);
    expect(row.roadmap.map((r: { row_key: string }) => r.row_key)).toEqual(["s1-0", "s1-1", "s1-2"]);
  });

  it("a replayed batch stores nothing twice and changes no snapshot", async () => {
    expect((await post([plan(0, "r1", 0, 1)])).status).toBe(200);
    expect(await post([plan(0, "r1", 0, 1)])).toMatchObject({ status: 409, body: { error: "seq_not_increasing" } });
    expect(await n("engine_plan_snapshots")).toBe(1);
    expect(await n("engine_events")).toBe(1);
  });

  it("a snapshot with an extra key, a free-text key or over 64 KiB is refused 400 and stored nowhere, with its siblings in the batch", async () => {
    const big = Array.from({ length: 300 }, (_, i) => ({ discussion: i + 1, ordinal: i, state: "planned" }));
    const huge = Array.from({ length: 500 }, (_, i) => ({ row_key: `K${i}-${"x".repeat(47 - String(i).length - 1)}`, status: "done", planned_prs: 1 }));
    const bads = [
      plan(1, "e1", 0, 1, { items: [{ discussion: 1, ordinal: 0, state: "planned", note: "x" }] }),
      plan(1, "e2", 0, 1, { roadmap: [{ row_key: "a", status: "done", message: "hi" }] }),
      plan(1, "e3", 0, 1, { extra: 1 }),
      plan(1, "e4", 0, 1, { items: [{ discussion: 1, ordinal: 0, state: "unknown" }] }),
      plan(1, "e5", 0, 1, { roadmap: [{ row_key: "a", status: "wip" }] }),
      plan(1, "e6", 0, 1, { items: big, roadmap: huge, pad: "y".repeat(70000) }),
    ];
    for (const bad of bads) {
      expect((await post([plan(0, "ok", 0, 1), bad])).status, JSON.stringify(Object.keys(bad))).toBe(400);
    }
    expect(await n("engine_events")).toBe(0);
    expect(await n("engine_plan_snapshots")).toBe(0);
    expect(await n("engine_plan_chunks")).toBe(0);
  });

  it("a maximum-size chunk (300 items and 500 roadmap rows) is stored whole; one item or one row over is a 400 and never a 500, and stores nothing, siblings included", async () => {
    const items = (m: number) => Array.from({ length: m }, (_, i) => ({ discussion: i + 1, ordinal: i, state: "planned" }));
    const roadmap = (m: number) => Array.from({ length: m }, (_, i) => ({ row_key: `K${i}-${"x".repeat(30)}`, status: "done", planned_prs: 1 }));
    expect((await post([plan(0, "max", 0, 1, { items: items(300), roadmap: roadmap(500) })])).status).toBe(200);
    const row = await latest();
    expect(row.items).toHaveLength(300);
    expect(row.roadmap).toHaveLength(500);
    expect(await n("engine_plan_chunks")).toBe(0);
    for (const [name, over] of [["items", { items: items(301), roadmap: [] }], ["roadmap", { items: [], roadmap: roadmap(501) }]] as const) {
      const res = await post([plan(1, `over-${name}`, 0, 1, over)]);
      expect(res.status, name).toBe(400);
    }
    expect(await n("engine_events")).toBe(1);
    expect(await n("engine_plan_snapshots")).toBe(1);
    expect(await n("engine_plan_chunks")).toBe(0);
  });

  it("a partial snapshot after a whole one leaves the whole one stored", async () => {
    expect((await post([plan(0, "w", 0, 1), plan(1, "p", 0, 2)])).status).toBe(200);
    const row = await latest();
    expect(row.roadmap.map((r: { row_key: string }) => r.row_key)).toEqual(["w-0"]);
    expect(await n("engine_plan_chunks")).toBe(1);
  });

  it("cross-tenant: a runner of account A posting a snapshot for account B's repo gets 403 and nothing is written anywhere", async () => {
    await h.admin.query(`UPDATE repos SET execution_mode = 'runner_local', gh_repo_id = $2 WHERE id = $1`, [B.repoId, GH + 1]);
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true) ON CONFLICT (account_id) DO UPDATE SET watch_enabled = true`, [B.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [B.accountId, B.repoId]);
    const res = await toResponse(() => ingestEngineEvents(h.deps(), signed(key, ENGINE_EVENTS_PATH, { session: { engine_instance_id: instance, repo_gh_id: GH + 1, engine_version: "1.2.3" }, events: [plan(0, "x", 0, 1)] })));
    expect(res).toMatchObject({ status: 403 });
    for (const t of ["engine_events", "engine_plan_snapshots", "engine_plan_chunks"]) {
      expect(await n(t, B.accountId), t).toBe(0);
      expect(await n(t, A.accountId), t).toBe(0);
    }
  });
});
