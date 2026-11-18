import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { ENGINE_EVENTS_PATH, engineSeqInOrder, ingestEngineEvents, parseEngineBatch, toResponse, type EngineUsageSubject, type RunnerHttpRequest } from "../src/index.js";
import { harness, newKey, registerKey, signed, type Harness, type TestKey } from "./helpers.js";

const GH = 424242;
const T = "2026-11-16T10:00:00.000Z";

/** [pg] Engine bridge EB-4: the ingest route against the real definer (migration 1027). */
describe("engine events ingest [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let B: SeedRefs;
  let key: TestKey;
  let runnerId: string;
  let instance: string;
  let usageCalls: EngineUsageSubject[][];

  const merged = (seq: number, instanceId = instance) => ({ v: 1, seq, ts: T, kind: "merged", engine_instance_id: instanceId, pr: seq + 1, closes: false });
  const batch = (events: object[], over: { instanceId?: string; gh?: number } = {}) => ({
    session: { engine_instance_id: over.instanceId ?? instance, repo_gh_id: over.gh ?? GH, engine_version: "1.2.3" },
    events,
  });
  const post = async (body: unknown, k: TestKey = key) => {
    const r = await toResponse(() => ingestEngineEvents(h.deps({ engineUsage: { record: async (_c, i) => void usageCalls.push([...i.subjects]) } }), signed(k, ENGINE_EVENTS_PATH, body)));
    return r as { status: number; body: Record<string, unknown> };
  };
  const rows = async (table: string, accountId = A.accountId) => Number((await h.admin.query(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].n);
  const setup = async (o: { watch?: boolean; ticked?: boolean; mode?: string; allowed?: boolean } = {}) => {
    await h.admin.query(`DELETE FROM engine_sessions WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM engine_repo_quota WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM domain_events WHERE account_id = $1 AND type = 'engine.changed'`, [A.accountId]);
    await h.admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM engine_bridge_settings WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, $2)`, [A.accountId, o.watch ?? true]);
    if (o.ticked ?? true) await h.admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [A.accountId, A.repoId]);
    await h.admin.query(`UPDATE repos SET execution_mode = $2, gh_repo_id = $3 WHERE id = $1`, [A.repoId, o.mode ?? "runner_local", GH]);
    await h.admin.query(`UPDATE runners SET allowed_repo_ids = $2::uuid[], revoked_at = NULL WHERE id = $1`, [runnerId, o.allowed === false ? [] : [A.repoId]]);
  };

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
    usageCalls = [];
    await setup();
  });

  it("stores a batch, answers accepted and the last seq, and a replay of it is 409 with nothing stored twice", async () => {
    const res = await post(batch([merged(0), merged(1), merged(2)]));
    expect(res).toMatchObject({ status: 200, body: { accepted: 3, duplicates: 0, last_accepted_seq: 2 } });
    expect(await rows("engine_events")).toBe(3);
    const stored = (await h.admin.query(`SELECT body FROM engine_events ORDER BY seq`)).rows[0].body;
    expect(stored).toEqual({ pr: 1, closes: false });
    expect(await post(batch([merged(1), merged(2)]))).toMatchObject({ status: 409, body: { error: "seq_not_increasing", last_accepted_seq: 2 } });
    expect(await rows("engine_events")).toBe(3);
  });

  it("refuses in order, each with nothing written: bad signature, watch off, repo not enabled, instance of another runner", async () => {
    const body = batch([merged(0)]);
    expect((await post(body, newKey())).status).toBe(401);
    await setup({ watch: false });
    expect(await post(body)).toMatchObject({ status: 403, body: { error: "engine_bridge_off" } });
    await setup({ ticked: false });
    expect(await post(body)).toMatchObject({ status: 403, body: { error: "engine_repo_not_enabled" } });
    await setup({ mode: "sandbox" });
    expect(await post(body)).toMatchObject({ status: 403, body: { error: "engine_repo_not_enabled" } });
    await setup({ allowed: false });
    expect(await post(body)).toMatchObject({ status: 403, body: { error: "engine_repo_not_enabled" } });
    await setup();
    expect(await post(batch([merged(0)], { gh: GH + 1 }))).toMatchObject({ status: 403, body: { error: "engine_repo_not_enabled" } });
    expect(await rows("engine_sessions")).toBe(0);
    expect(await rows("engine_events")).toBe(0);
    // Another runner of the same account sending an instance the first runner already owns.
    expect((await post(body)).status).toBe(200);
    const key2 = newKey();
    const runner2 = await registerKey(h.admin, A.accountId, A.userId, key2);
    await h.admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1`, [runner2, A.repoId]);
    expect(await post(batch([merged(1)]), key2)).toMatchObject({ status: 409, body: { error: "engine_instance_other_runner" } });
    expect(await rows("engine_events")).toBe(1);
  });

  it("an event whose instance id differs from the batch's is refused 400, and nothing is stored (the runner-protocol schema's own rule)", async () => {
    expect((await post(batch([merged(0), merged(1, randomUUID())]))).status).toBe(400);
    const { engine_instance_id: _drop, ...bare } = merged(0);
    expect((await post(batch([bare]))).status).toBe(400);
    expect((await post(batch([merged(0, instance.toUpperCase())]))).status).toBe(400);
    expect((await post(batch([merged(0, instance.toUpperCase())], { instanceId: instance.toUpperCase() }))).status).toBe(200);
    expect(await rows("engine_events")).toBe(1);
    expect(() => parseEngineBatch(batch([merged(0, randomUUID())]))).toThrow();
  });

  it("parses with the runner-protocol exports: its seq_order answer, and a deeply nested body is a 400 and never a 500", async () => {
    expect(await post(batch([merged(1), merged(1)]))).toMatchObject({ status: 400, body: { error: { code: "seq_order" } } });
    let deep: unknown = 1;
    for (let i = 0; i < 2000; i++) deep = { x: deep };
    expect((await post(batch([{ ...merged(0), body_like: deep }]))).status).toBe(400);
    expect(await rows("engine_events")).toBe(0);
  });

  it("a plan chunk with an empty row_key is stored when it names its discussion (EB-1 accepts that)", async () => {
    const snap = (seq: number, discussion?: number) => ({ v: 1, seq, ts: T, kind: "plan_snapshot", engine_instance_id: instance, snapshot_id: "s1", chunk_index: 0, chunk_count: 1, plan_date: "2026-11-16", items: [], roadmap: [{ row_key: "", ...(discussion === undefined ? {} : { discussion }), status: "in_progress", planned_prs: 1 }] });
    expect((await post(batch([snap(0, 842)]))).status).toBe(200);
    expect((await post(batch([snap(1)]))).status).toBe(400);
    expect(await rows("engine_events")).toBe(1);
  });

  it("refuses a malformed batch: free-text and money keys, an unknown kind, an extra envelope key, out-of-order seqs, 101 events", async () => {
    for (const extra of [{ message: "hi" }, { usd: 1 }, { total_tokens: 1 }, { path: "/x" }, { unknown: 1 }]) {
      expect((await post(batch([{ ...merged(0), ...extra }]))).status, JSON.stringify(Object.keys(extra))).toBe(400);
    }
    expect((await post(batch([{ ...merged(0), kind: "made_up" }]))).status).toBe(400);
    expect((await post({ ...batch([merged(0)]), extra: 1 })).status).toBe(400);
    expect((await post(batch([merged(1), merged(1)]))).status).toBe(400);
    expect((await post(batch(Array.from({ length: 101 }, (_, i) => merged(i))))).status).toBe(400);
    expect(engineSeqInOrder([{ seq: 1 }, { seq: 2 }])).toBe(true);
    expect(engineSeqInOrder([{ seq: 2 }, { seq: 2 }])).toBe(false);
    expect(await rows("engine_events")).toBe(0);
  });

  it("records a gap and keeps it: 0..9 then 15..20 is one gap 10..14, and a late resend of 10..14 is 409", async () => {
    await post(batch(Array.from({ length: 10 }, (_, i) => merged(i))));
    expect((await post(batch(Array.from({ length: 6 }, (_, i) => merged(15 + i))))).status).toBe(200);
    const gaps = (await h.admin.query(`SELECT from_seq, to_seq, before_ts FROM engine_session_gaps`)).rows;
    expect(gaps.map((g) => [Number(g.from_seq), Number(g.to_seq)])).toEqual([[10, 14]]);
    expect(new Date(gaps[0].before_ts).toISOString()).toBe(T);
    expect((await post(batch(Array.from({ length: 5 }, (_, i) => merged(10 + i))))).status).toBe(409);
    expect(Number((await h.admin.query(`SELECT seq_gaps FROM engine_sessions`)).rows[0].seq_gaps)).toBe(1);
    expect(await rows("engine_session_gaps")).toBe(1);
  });

  it("a new instance id is a new session: seq starts again at 0 with no gap", async () => {
    await post(batch([merged(0), merged(1)]));
    const next = randomUUID();
    expect((await post(batch([merged(0, next)], { instanceId: next }))).status).toBe(200);
    expect(await rows("engine_sessions")).toBe(2);
    expect(await rows("engine_session_gaps")).toBe(0);
  });

  it("stores no more than 5000 events a session in one UTC day: the 5001st answers 429 and is not stored", async () => {
    for (let b = 0; b < 50; b++) expect((await post(batch(Array.from({ length: 100 }, (_, i) => merged(b * 100 + i))))).status).toBe(200);
    const res = await post(batch([merged(5000), merged(5001)]));
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "engine_event_quota" });
    expect(res.body.retry_after_s).toBeGreaterThan(0);
    expect(res.body.retry_after_s).toBeLessThanOrEqual(86400);
    expect(await rows("engine_events")).toBe(5000);
    // A batch that straddles the cap stores only what fits.
    await h.admin.query(`UPDATE engine_sessions SET quota_count = 4999`);
    await h.admin.query(`DELETE FROM engine_events WHERE seq = 4999`);
    await h.admin.query(`UPDATE engine_sessions SET last_seq = 4998`);
    expect((await post(batch([merged(4999), merged(5000)]))).status).toBe(429);
    expect(Number((await h.admin.query(`SELECT max(seq) AS m FROM engine_events`)).rows[0].m)).toBe(4999);
  });

  it("caps a (account, repo) at 20000 events a day across every session, so opening sessions cannot multiply the per-session cap", async () => {
    await post(batch([merged(0)]));
    const day = (await h.admin.query(`SELECT (now() AT TIME ZONE 'utc')::date AS d`)).rows[0].d;
    expect(Number((await h.admin.query(`SELECT quota_count FROM engine_repo_quota WHERE account_id = $1`, [A.accountId])).rows[0].quota_count)).toBe(1);
    await h.admin.query(`UPDATE engine_repo_quota SET quota_day = $2, quota_count = 19998 WHERE account_id = $1`, [A.accountId, day]);
    // A second session may store only what is left of the repo's day: 2 of 3.
    const second = randomUUID();
    const res = await post(batch([merged(0, second), merged(1, second), merged(2, second)], { instanceId: second }));
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "engine_event_quota" });
    expect(Number((await h.admin.query(`SELECT count(*) AS n FROM engine_events e JOIN engine_sessions s ON s.id = e.session_id WHERE s.engine_instance_id = $1`, [second])).rows[0].n)).toBe(2);
    expect(Number((await h.admin.query(`SELECT quota_count FROM engine_repo_quota WHERE account_id = $1`, [A.accountId])).rows[0].quota_count)).toBe(20000);
    // At the cap, a new session is refused before it exists: nothing is written, not even the session.
    const third = randomUUID();
    const sessionsBefore = await rows("engine_sessions");
    expect((await post(batch([merged(0, third)], { instanceId: third }))).status).toBe(429);
    expect(await rows("engine_sessions")).toBe(sessionsBefore);
    // The next UTC day starts the count again.
    await h.admin.query(`UPDATE engine_repo_quota SET quota_day = quota_day - 1 WHERE account_id = $1`, [A.accountId]);
    expect((await post(batch([merged(0, third)], { instanceId: third }))).status).toBe(200);
    expect(Number((await h.admin.query(`SELECT quota_count FROM engine_repo_quota WHERE account_id = $1`, [A.accountId])).rows[0].quota_count)).toBe(1);
  });

  it("refuses a runner of an account that is not active (401), and writes nothing", async () => {
    await h.admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [A.accountId]);
    try {
      expect((await post(batch([merged(0)]))).status).toBe(401);
    } finally {
      await h.admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [A.accountId]);
    }
    expect(await rows("engine_events")).toBe(0);
    expect(await rows("engine_sessions")).toBe(0);
  });

  it("keeps the runner's own facts in a bridge session of their own: a batch is all bridge events or none, and a session keeps its kind", async () => {
    const ev = (seq: number, kind: string, inst: string, f: object = {}) => ({ v: 1, seq, ts: T, kind, engine_instance_id: inst, ...f });
    const bridge = randomUUID();
    expect((await post(batch([ev(0, "bridge_heartbeat", bridge), ev(1, "bridge_dropped", bridge, { count: 2, reason: "schema" })], { instanceId: bridge }))).status).toBe(200);
    expect((await post(batch([merged(0), ev(1, "bridge_heartbeat", instance)]))).status).toBe(400);
    expect((await post(batch([merged(2, bridge)], { instanceId: bridge }))).status).toBe(400);
    expect((await post(batch([merged(0)]))).status).toBe(200);
    const kinds = (await h.admin.query(`SELECT engine_instance_id, session_kind FROM engine_sessions ORDER BY created_at`)).rows;
    expect(kinds.map((k) => [k.engine_instance_id, k.session_kind])).toEqual([[bridge, "bridge"], [instance, "engine"]]);
    expect(await rows("engine_events")).toBe(3);
  });

  it("writes exactly one engine.changed per batch that stored something, with no throttle, and none for a refused or replayed batch", async () => {
    const notes = async () => (await h.admin.query(`SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'engine.changed' ORDER BY seq`, [A.accountId])).rows.map((r) => r.payload);
    for (let b = 0; b < 5; b++) expect((await post(batch([merged(b * 2), merged(b * 2 + 1)]))).status).toBe(200);
    // Five batches back to back, with no wait between them: five notices, each naming its own batch's last seq, ids only.
    const first = await notes();
    expect(first.map((p) => p.last_seq)).toEqual([1, 3, 5, 7, 9]);
    expect(first.every((p) => Object.keys(p).sort().join() === "last_seq,panels,repo_id,session_id" && p.repo_id === A.repoId && JSON.stringify(p.panels) === '["stats"]')).toBe(true);
    expect((await post(batch([merged(0)]))).status).toBe(409);
    expect((await post(batch([merged(20), merged(20)]))).status).toBe(400);
    expect((await notes()).length).toBe(5);
  });

  it("builds the read model in the same transaction, and writes one engine.changed notice of ids only", async () => {
    const ev = (seq: number, kind: string, f: object) => ({ v: 1, seq, ts: T, kind, engine_instance_id: instance, ...f });
    const res = await post(
      batch([
        ev(0, "agent_started", { spawn_id: "toolu_1", role: "executor", background: false, isolation: "worktree", discussion: 7 }),
        ev(1, "agent_stopped", { agent_id: "ag-1", role: "executor", verdict: "pass", credential_mode: "subscription", duration_s: 5, pr: 9 }),
        ev(2, "agent_linked", { spawn_id: "toolu_1", agent_id: "ag-1" }),
        ev(3, "merge_lane", { pr: 9, state: "queued" }),
        ev(4, "merge_lane", { pr: 9, state: "merged" }),
        ev(5, "gate_receipt", { pr: 9, gate: "gate1", result: "pass", head_sha: "b".repeat(40) }),
        ev(6, "gate_receipt", { pr: 9, gate: "gate1", result: "pass", head_sha: "b".repeat(40) }),
        ev(7, "ask_raised", { ask_id: "0123456789abcdef", ask_kind: "other", source: "team_log" }),
        ev(8, "ask_cleared", { ask_id: "0123456789abcdef", how: "withdrawn" }),
        ev(9, "engine_heartbeat", { origin: "host", source_ages_s: { loop: 4 } }),
      ]),
    );
    expect(res.status).toBe(200);
    const agents = (await h.admin.query(`SELECT spawn_id, agent_id, verdict, stopped_at, discussion FROM engine_agents`)).rows;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ spawn_id: "toolu_1", agent_id: "ag-1", verdict: "pass", discussion: "7" });
    expect(agents[0].stopped_at).not.toBeNull();
    expect((await h.admin.query(`SELECT state FROM engine_lanes`)).rows).toEqual([{ state: "merged" }]);
    expect(await rows("engine_gate_receipts")).toBe(1);
    expect((await h.admin.query(`SELECT cleared_at, how FROM engine_asks`)).rows[0]).toMatchObject({ how: "withdrawn" });
    const s = (await h.admin.query(`SELECT last_seq, source_ages_s, last_heartbeat_at, last_heard_at FROM engine_sessions`)).rows[0];
    expect(Number(s.last_seq)).toBe(9);
    expect(s.source_ages_s).toEqual({ loop: 4 });
    expect(s.last_heartbeat_at).not.toBeNull();
    const notes = (await h.admin.query(`SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'engine.changed' AND payload->>'session_id' = (SELECT id::text FROM engine_sessions)`, [A.accountId])).rows;
    expect(notes).toHaveLength(1);
    expect(Object.keys(notes[0].payload).sort()).toEqual(["last_seq", "panels", "repo_id", "session_id"]);
    // The union of what the ten kinds touch (a stop with no usage still lists the agent as "not recorded" on the usage panel), in the closed set's order.
    expect(notes[0].payload.panels).toEqual(["agents", "lanes", "gates", "asks", "stats", "usage", "status"]);
  });

  const notices = async () => (await h.admin.query(`SELECT payload FROM domain_events WHERE account_id = $1 AND type = 'engine.changed' ORDER BY seq`, [A.accountId])).rows.map((r) => r.payload);
  const ev = (seq: number, kind: string, f: object) => ({ v: 1, seq, ts: T, kind, engine_instance_id: instance, ...f });

  it("two batches a second apart are two notices, each naming only its own batch's panels (insert-only, never merged into an open one)", async () => {
    expect((await post(batch([ev(0, "team_log_line", { line_id: "0123456789abcdef", actor_role: "team-lead", category: "starting" })]))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1000));
    expect((await post(batch([ev(1, "merge_lane", { pr: 5, state: "queued" })]))).status).toBe(200);
    const n = await notices();
    expect(n.map((p) => p.panels)).toEqual([["log"], ["lanes", "gates"]]);
    expect(n.map((p) => p.last_seq)).toEqual([0, 1]);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM domain_events WHERE account_id = $1 AND type = 'engine.changed'`, [A.accountId])).rows[0].n).toBe(2);
  });

  it("a usage-bearing tick names usage and a tick without usage does not; a plan chunk names plan; an ask names asks", async () => {
    const tick = (seq: number, usage: boolean) => ev(seq, "tick_ended", { tick_kind: "loop", credential_mode: "subscription", ...(usage ? { usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 } } : {}) });
    expect((await post(batch([tick(0, false)]))).status).toBe(200);
    expect((await post(batch([tick(1, true)]))).status).toBe(200);
    expect((await post(batch([ev(2, "plan_snapshot", { snapshot_id: "s1", chunk_index: 0, chunk_count: 1, plan_date: "2026-11-16", items: [], roadmap: [] })]))).status).toBe(200);
    expect((await post(batch([ev(3, "ask_raised", { ask_id: "0123456789abcdef", ask_kind: "other", source: "team_log" })]))).status).toBe(200);
    expect((await notices()).map((p) => p.panels)).toEqual([["status"], ["usage", "status"], ["plan"], ["asks"]]);
  });

  it("every notice names panels from the closed set, in its order, once each", async () => {
    expect((await post(batch([ev(0, "agent_started", { spawn_id: "toolu_9", role: "executor", background: true, isolation: "none" }), ev(1, "host_started", {}), ev(2, "loop_tick", { origin: "cron", duration_s: 1 })]))).status).toBe(200);
    expect((await post(batch([ev(3, "spawn_blocked", { role: "executor", reason: "budget" })]))).status).toBe(200);
    const closed = ["agents", "lanes", "gates", "asks", "log", "plan", "stats", "usage", "status"];
    const n = await notices();
    for (const p of n) {
      expect(p.panels.every((x: string) => closed.includes(x))).toBe(true);
      expect(new Set(p.panels).size).toBe(p.panels.length);
      expect(p.panels).toEqual(closed.filter((x) => p.panels.includes(x)));
    }
    expect(n.map((p) => p.panels)).toEqual([["agents", "stats", "status"], ["status"]]);
  });

  it("an idle engine, which sends one status upload every 5 minutes, writes at most 20 notices an hour, each naming status alone, and the ingest asks nothing more of the runner", async () => {
    // 13 uploads in an hour (one at start, then every 5 minutes): the runner's own bridge-timers test pins that schedule; here each one is posted and counted.
    for (let i = 0; i < 13; i++) expect((await post(batch([ev(i, "engine_heartbeat", { origin: "host" })]))).status).toBe(200);
    const n = await notices();
    expect(n.length).toBe(13);
    expect(n.length).toBeLessThanOrEqual(20);
    expect(n.every((p) => JSON.stringify(p.panels) === '["status"]')).toBe(true);
  });

  it("passes the tokens an agent or tick reported to the pricing port (never a dollar amount) and sets, not adds, a repeated stop", async () => {
    const stop = (seq: number, input: number) => ({ v: 1, seq, ts: T, kind: "agent_stopped", engine_instance_id: instance, agent_id: "ag-2", role: "executor", verdict: "done", credential_mode: "api_key", model: "sonnet-5", usage: { input, output: 2, cache_read: 0, cache_write: 0 } });
    await post(batch([stop(0, 10)]));
    await post(batch([stop(1, 10)]));
    expect(usageCalls[0]).toEqual([{ subject_kind: "agent", subject_id: "ag-2", model: "sonnet-5", input_tokens: "10", output_tokens: "2", cache_read_tokens: "0", cache_write_tokens: "0" }]);
    const u = (await h.admin.query(`SELECT input_tokens, source_seqs FROM engine_agent_usage`)).rows;
    expect(u).toHaveLength(1);
    expect(u[0].input_tokens).toBe("10");
    expect(u[0].source_seqs.map(Number)).toEqual([0, 1]);
    // A replay stores nothing, so nothing is priced.
    usageCalls = [];
    await post(batch([stop(1, 10)]));
    expect(usageCalls).toEqual([]);
  });

  it("an account never sees or writes another's rows: a runner of A posting for a repo of B is refused and writes nothing", async () => {
    await h.admin.query(`UPDATE repos SET gh_repo_id = $2 WHERE id = $1`, [B.repoId, GH + 7]);
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true) ON CONFLICT DO NOTHING`, [B.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [B.accountId, B.repoId]);
    expect(await post(batch([merged(0)], { gh: GH + 7 }))).toMatchObject({ status: 403, body: { error: "engine_repo_not_enabled" } });
    expect(await rows("engine_events", B.accountId)).toBe(0);
    expect(await rows("engine_sessions", B.accountId)).toBe(0);
  });

  it("a revoked runner is 401", async () => {
    await h.admin.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [runnerId]);
    expect((await post(batch([merged(0)]))).status).toBe(401);
  });

  it("caps the raw body at 256 KiB before anything is parsed: 257 KiB is 413, never reaching JSON.parse (an unparseable body would be 400)", async () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      const big: RunnerHttpRequest = signed(key, ENGINE_EVENTS_PATH, null, { rawBody: Buffer.alloc(257 * 1024, 32) });
      const res = await toResponse(() => ingestEngineEvents(h.deps(), big));
      expect(res.status).toBe(413);
      expect(parse).not.toHaveBeenCalled();
      const edge: RunnerHttpRequest = signed(key, ENGINE_EVENTS_PATH, null, { rawBody: Buffer.alloc(256 * 1024, 32) });
      expect((await toResponse(() => ingestEngineEvents(h.deps(), edge))).status).toBe(400);
    } finally {
      parse.mockRestore();
    }
  });
});
