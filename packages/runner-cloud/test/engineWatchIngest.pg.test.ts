import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { readEngineRepoFreshness } from "@fx/db/src/engineBridge.js";
import { CURRENT_PROTOCOL_VERSION, WATCH_MIN_PROTOCOL } from "@fulcrumaxe/runner-protocol";
import { ENGINE_EVENTS_PATH, HELLO_PATH, ingestEngineEvents, runnerHello, toResponse } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const GH = 515151;
const T = "2026-11-20T10:00:00.000Z";
/** A version-8 UUID: how a runner marks its detail session. */
const detailId = (): string => {
  const id = randomUUID();
  return `${id.slice(0, 14)}8${id.slice(15)}`;
};

/** [pg] D#845 watch mode at the ingest: `slim_status`, the detail session, held holes, and `watch_until` on the reply (migration 1043). */
describe("engine events ingest, watch mode [pg]", () => {
  let h: Harness;
  let A: SeedRefs;
  let B: SeedRefs;
  let key: TestKey;
  let runnerId: string;

  const ev = (instance: string, seq: number, kind: string, extra: Record<string, unknown> = {}) => ({ v: 1, seq, ts: T, kind, engine_instance_id: instance, ...extra });
  const tick = (instance: string, seq: number) => ev(instance, seq, "loop_tick", { origin: "cron", duration_s: 5 });
  const merged = (instance: string, seq: number) => ev(instance, seq, "merged", { pr: seq + 1, closes: false });
  const slim = (instance: string, seq: number, sources: unknown = { bridge: 0, host: null, engine: 42 }, extra: Record<string, unknown> = {}) => ev(instance, seq, "slim_status", { sources, reason: "unwatched", ...extra });
  const batch = (instance: string, events: object[]) => ({ session: { engine_instance_id: instance, repo_gh_id: GH, engine_version: "1.2.3" }, events });
  const post = async (instance: string, events: object[], k: TestKey = key) => (await toResponse(() => ingestEngineEvents(h.deps(), signed(k, ENGINE_EVENTS_PATH, batch(instance, events))))) as { status: number; body: Record<string, unknown> };
  const sessions = async () => (await h.admin.query(`SELECT engine_instance_id, session_kind, last_seq::int AS last_seq, seq_gaps, last_heartbeat_at FROM engine_sessions WHERE account_id = $1 ORDER BY created_at`, [A.accountId])).rows;
  const eventCount = async () => Number((await h.admin.query(`SELECT count(*) AS n FROM engine_events WHERE account_id = $1`, [A.accountId])).rows[0].n);
  const setProtocol = (v: number | null) => h.admin.query(`UPDATE runners SET protocol_version = $2 WHERE id = $1`, [runnerId, v]);

  beforeAll(async () => {
    h = await harness();
    A = await seedAccount(h.admin, randomUUID());
    B = await seedAccount(h.admin, randomUUID());
    key = newKey();
    runnerId = await registerKey(h.admin, A.accountId, A.userId, key);
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM engine_sessions WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM engine_repo_quota WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM engine_commands WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`DELETE FROM engine_bridge_settings WHERE account_id = $1`, [A.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [A.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [A.accountId, A.repoId]);
    await h.admin.query(`UPDATE repos SET execution_mode = 'runner_local', gh_repo_id = $2 WHERE id = $1`, [A.repoId, GH]);
    await h.admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[], revoked_at = NULL, protocol_version = 24 WHERE id = $1`, [runnerId, A.repoId]);
  });

  describe("the hello reply says whether this cloud takes watch mode (a two-way handshake)", () => {
    const WAKE_KEY = randomBytes(32);
    const hello = (protocol: number, capabilities: string[]) => ({ protocol_version: protocol, binary_version: "0.1.0", model_auth_present: true, isolation: "container", capabilities });
    const say = async (protocol: number, capabilities: string[]) => (await respond(() => runnerHello(h.deps({ wakeKey: () => WAKE_KEY }), signed(key, HELLO_PATH, hello(protocol, capabilities))))) as { status: number; body: Record<string, unknown> };
    /**
     * The hello reply as runners built before watch mode parse it, written out literally: `z.object({ protocol_version: int >= 1, wake: z.object({ token: string, poll_s: int, transport: "poll" }).strict().optional() }).strict()`.
     * Strict: any other key fails the whole parse, and the runner then drops the wake grant. (This package has no schema library of its own; the rule is the same.)
     */
    const oldStrictParse = (body: Record<string, unknown>): { ok: boolean; wake?: Record<string, unknown> } => {
      const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
      if (Object.keys(body).some((k) => k !== "protocol_version" && k !== "wake")) return { ok: false };
      if (!Number.isInteger(body.protocol_version) || (body.protocol_version as number) < 1) return { ok: false };
      if (body.wake === undefined) return { ok: true };
      const w = body.wake;
      if (!isObject(w) || Object.keys(w).some((k) => !["token", "poll_s", "transport"].includes(k)) || typeof w.token !== "string" || !Number.isInteger(w.poll_s) || w.transport !== "poll") return { ok: false };
      return { ok: true, wake: w };
    };

    it.each([WATCH_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION])("a runner at %s that did NOT declare watch_mode_v1 gets a reply the old strict schema accepts, with its wake grant intact", async (v) => {
      const res = await say(v, ["wake_v1"]);
      expect(res.status).toBe(200);
      const parsed = oldStrictParse(res.body);
      expect(parsed.ok, JSON.stringify(res.body)).toBe(true);
      expect(res.body).not.toHaveProperty("capabilities");
      expect(parsed.wake?.transport).toBe("poll");
      expect(res.body.protocol_version).toBe(CURRENT_PROTOCOL_VERSION);
    });

    it.each([WATCH_MIN_PROTOCOL, CURRENT_PROTOCOL_VERSION])("a runner at %s that declared watch_mode_v1 is told so: capabilities [watch_mode], and the wake grant is still there", async (v) => {
      const res = await say(v, ["wake_v1", "watch_mode_v1"]);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ protocol_version: CURRENT_PROTOCOL_VERSION, capabilities: ["watch_mode"], wake: { transport: "poll" } });
      expect(oldStrictParse(res.body).ok).toBe(false);
    });

    it("the declaration is stored with the runner's other capabilities (the closed list takes it)", async () => {
      await say(CURRENT_PROTOCOL_VERSION, ["wake_v1", "watch_mode_v1"]);
      const stored = (await h.admin.query(`SELECT capabilities FROM runner_capabilities WHERE runner_id = $1`, [runnerId])).rows[0].capabilities;
      expect(stored).toEqual(["wake_v1", "watch_mode_v1"]);
    });

    it("says nothing to a runner below the watch protocol, even one that declares it", async () => {
      for (const v of [1, WATCH_MIN_PROTOCOL - 1]) {
        const res = await say(v, ["watch_mode_v1"]).catch(() => undefined);
        // A hello below the watch protocol may be refused for declaring it; one that is taken never gets the field.
        if (res !== undefined && res.status === 200) expect(res.body).not.toHaveProperty("capabilities");
      }
    });

    it("follows the database too: a runner that declared it is still not told when the ingest cannot take it (no held column)", async () => {
      await h.admin.query("ALTER TABLE engine_session_gaps RENAME COLUMN held TO held_off");
      try {
        const res = await say(CURRENT_PROTOCOL_VERSION, ["wake_v1", "watch_mode_v1"]);
        expect(res.body.protocol_version).toBeGreaterThanOrEqual(WATCH_MIN_PROTOCOL);
        expect(res.body).not.toHaveProperty("capabilities");
      } finally {
        await h.admin.query("ALTER TABLE engine_session_gaps RENAME COLUMN held_off TO held");
      }
      expect((await say(CURRENT_PROTOCOL_VERSION, ["watch_mode_v1"])).body.capabilities).toEqual(["watch_mode"]);
    });
  });

  describe("slim_status", () => {
    it("is stored in the bridge session, counts as a heartbeat, and names only the status panel", async () => {
      const bridge = randomUUID();
      expect((await post(bridge, [slim(bridge, 0)])).status).toBe(200);
      const [s] = await sessions();
      expect(s).toMatchObject({ engine_instance_id: bridge, session_kind: "bridge", last_seq: 0 });
      expect(s.last_heartbeat_at).not.toBeNull();
      const stored = (await h.admin.query(`SELECT body FROM engine_events WHERE account_id = $1`, [A.accountId])).rows[0].body;
      expect(stored).toEqual({ sources: { bridge: 0, host: null, engine: 42 }, reason: "unwatched" });
      const panels = (await h.admin.query(`SELECT payload -> 'panels' AS p FROM domain_events WHERE account_id = $1 AND type = 'engine.changed'`, [A.accountId])).rows[0].p;
      expect(panels).toEqual(["status"]);
    });

    it.each([
      ["a missing source", { bridge: 0, host: null }],
      ["an extra source", { bridge: 0, host: null, engine: 1, other: 1 }],
      ["an age over a day", { bridge: 0, host: null, engine: 86_401 }],
      ["a negative age", { bridge: 0, host: -1, engine: 1 }],
      ["a fraction", { bridge: 0, host: 1.5, engine: 1 }],
      ["a string", { bridge: 0, host: "3", engine: 1 }],
    ])("refuses %s", async (_name, sources) => {
      const bridge = randomUUID();
      expect((await post(bridge, [slim(bridge, 0, sources)])).status).toBe(400);
      expect(await eventCount()).toBe(0);
    });

    it("refuses another reason or an extra key, and one that shares a batch with an engine event", async () => {
      const bridge = randomUUID();
      expect((await post(bridge, [slim(bridge, 0, undefined, { reason: "watched" })])).status).toBe(400);
      expect((await post(bridge, [slim(bridge, 0, undefined, { note: "x" })])).status).toBe(400);
      expect((await post(bridge, [slim(bridge, 0), merged(bridge, 1)])).status).toBe(400);
      expect(await eventCount()).toBe(0);
    });

    it("accepts the boundary ages 0 and 86400, and null for every source", async () => {
      const bridge = randomUUID();
      expect((await post(bridge, [slim(bridge, 0, { bridge: 0, host: 86_400, engine: null }), slim(bridge, 1, { bridge: 0, host: null, engine: null })])).status).toBe(200);
      expect(await eventCount()).toBe(2);
    });
  });

  describe("the detail session", () => {
    it("is a session of its own, marked by a version-8 instance id: the on-demand kinds and the heartbeats go in it, in seq order of its own", async () => {
      const d = detailId();
      const res = await post(d, [tick(d, 0), ev(d, 1, "team_log_line", { line_id: "0123456789abcdef", actor_role: "team-lead", category: "other" }), ev(d, 2, "engine_heartbeat", { origin: "host" })]);
      expect(res).toMatchObject({ status: 200, body: { accepted: 3, last_accepted_seq: 2 } });
      expect((await sessions())[0]).toMatchObject({ engine_instance_id: d, session_kind: "detail", last_seq: 2, seq_gaps: 0 });
    });

    it("takes those kinds only: an always-on kind, a bridge kind or a slim status refuses the whole batch", async () => {
      const d = detailId();
      for (const bad of [merged(d, 1), ev(d, 1, "bridge_heartbeat"), slim(d, 1)]) expect((await post(d, [tick(d, 0), bad])).status).toBe(400);
      expect(await eventCount()).toBe(0);
    });

    it("the engine's own session (a version-4 id) is untouched: the same kinds there are stored as before, as an engine session", async () => {
      const e = randomUUID();
      expect((await post(e, [tick(e, 0)])).status).toBe(200);
      expect((await sessions())[0]).toMatchObject({ session_kind: "engine" });
    });

    it("takes lower seqs in a later batch (a reader's load older), drops a seq it already holds, records no gap and keeps the highest seq as its mark", async () => {
      const d = detailId();
      expect((await post(d, [tick(d, 600), tick(d, 601), tick(d, 602)])).status).toBe(200);
      expect((await sessions())[0]).toMatchObject({ last_seq: 602, seq_gaps: 0 });
      // The first batch started at 600, not 0: nothing is missing in a detail session, whatever a catch-up left on the machine.
      expect(Number((await h.admin.query(`SELECT count(*) AS n FROM engine_session_gaps WHERE account_id = $1`, [A.accountId])).rows[0].n)).toBe(0);
      const older = await post(d, [tick(d, 500), tick(d, 501), tick(d, 601)]);
      expect(older).toMatchObject({ status: 200, body: { accepted: 2, duplicates: 1, last_accepted_seq: 601 } });
      expect((await sessions())[0]).toMatchObject({ last_seq: 602 });
      expect(await eventCount()).toBe(5);
      expect(Number((await h.admin.query(`SELECT count(*) AS n FROM engine_session_gaps WHERE account_id = $1`, [A.accountId])).rows[0].n)).toBe(0);
      // The same batch again stores nothing new.
      expect(await post(d, [tick(d, 500), tick(d, 501)])).toMatchObject({ status: 200, body: { accepted: 0, duplicates: 2 } });
    });

    it("a batch inside it must still increase", async () => {
      const d = detailId();
      expect((await post(d, [tick(d, 2), tick(d, 1)])).status).toBe(400);
    });

    it("the engine's session keeps its strict order: a replay is 409, and a hole is recorded", async () => {
      const e = randomUUID();
      await post(e, [merged(e, 0), merged(e, 5)]);
      expect(await post(e, [merged(e, 3)])).toMatchObject({ status: 409, body: { error: "seq_not_increasing", last_accepted_seq: 5 } });
      expect(Number((await h.admin.query(`SELECT count(*) AS n FROM engine_session_gaps WHERE account_id = $1`, [A.accountId])).rows[0].n)).toBe(1);
    });

    it("counts against the day's caps like any session, and is the runner's own: another runner of the account cannot write into its instance", async () => {
      const d = detailId();
      await post(d, [tick(d, 0)]);
      const key2 = newKey();
      const runner2 = await registerKey(h.admin, A.accountId, A.userId, key2);
      await h.admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[], protocol_version = 24 WHERE id = $1`, [runner2, A.repoId]);
      expect(await post(d, [tick(d, 1)], key2)).toMatchObject({ status: 409, body: { error: "engine_instance_other_runner" } });
    });
  });

  describe("holes in the engine's session when a runner holds events back", () => {
    const holes = async () => (await h.admin.query(`SELECT held FROM engine_session_gaps WHERE account_id = $1`, [A.accountId])).rows.map((r) => r.held);
    const freshness = () => readEngineRepoFreshness(h.admin, A.repoId, A.accountId);

    it("a runner at the watch protocol: the hole is recorded, flagged held, left out of the missing count and the gap list, and not in seq_gaps", async () => {
      const e = randomUUID();
      await post(e, [merged(e, 0), merged(e, 7)]);
      expect(await holes()).toEqual([true]);
      expect((await sessions())[0]).toMatchObject({ seq_gaps: 0 });
      expect(await freshness()).toMatchObject({ missing_events: 0, gaps: [] });
    });

    it("an older runner: the same hole is a real gap, shown and counted as before", async () => {
      await setProtocol(22);
      const e = randomUUID();
      await post(e, [merged(e, 0), merged(e, 7)]);
      expect(await holes()).toEqual([false]);
      expect((await sessions())[0]).toMatchObject({ seq_gaps: 1 });
      expect(await freshness()).toMatchObject({ missing_events: 6, gaps: [{ from_seq: 1, to_seq: 6 }] });
    });

    it("a hole in a runner's own bridge session is a real one even at the watch protocol", async () => {
      const bridge = randomUUID();
      await post(bridge, [slim(bridge, 0), slim(bridge, 4)]);
      expect(await holes()).toEqual([false]);
      expect(await freshness()).toMatchObject({ missing_events: 3 });
    });

    it("the source ages of a detail session's engine heartbeat reach the freshness read", async () => {
      const d = detailId();
      await post(d, [ev(d, 0, "engine_heartbeat", { origin: "host", source_ages_s: { loop: 12, team_log: 3 } })]);
      expect((await freshness())!.source_ages_s).toEqual({ loop: 12, team_log: 3 });
    });
  });

  describe("watch_until on the reply", () => {
    const watchCommand = async (over: { until?: Date; state?: string; runner?: string; repo?: string; account?: string; kind?: string } = {}) => {
      const until = over.until ?? new Date(Date.now() + 300_000);
      await h.admin.query(
        `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, state, delivered_at, acked_at, refusal)
         VALUES ($1, $2, $3, (SELECT COALESCE(max(command_seq), 0) + 1 FROM engine_commands WHERE runner_id = $2 AND repo_id = $3), $4, $5::jsonb, $6, now() - interval '10 seconds', now() + interval '500 seconds', $7,
                 CASE WHEN $7 IN ('delivered', 'applied', 'refused') THEN now() END, CASE WHEN $7 IN ('applied', 'refused') THEN now() END, CASE WHEN $7 = 'refused' THEN 'ceiling' END)`,
        [over.account ?? A.accountId, over.runner ?? runnerId, over.repo ?? A.repoId, over.kind ?? "watch", JSON.stringify(over.kind === "pause_loop" ? {} : { until: until.toISOString() }), A.userId, over.state ?? "applied"],
      );
      return until;
    };
    const reply = async () => {
      const e = randomUUID();
      const r = await post(e, [merged(e, 0)]);
      expect(r.status).toBe(200);
      return r.body;
    };

    it("is the furthest live watch the runner was sent for the batch's repo, in the reply", async () => {
      expect(await reply()).not.toHaveProperty("watch_until");
      const near = await watchCommand({ until: new Date(Date.now() + 120_000), state: "delivered" });
      const far = await watchCommand({ until: new Date(Date.now() + 480_000), state: "applied" });
      expect(near < far).toBe(true);
      expect((await reply()).watch_until).toBe(far.toISOString());
    });

    it("is not sent to a runner below the watch protocol, whose strict parse would refuse the key", async () => {
      await watchCommand();
      await setProtocol(22);
      expect(await reply()).not.toHaveProperty("watch_until");
      await setProtocol(null);
      expect(await reply()).not.toHaveProperty("watch_until");
      await setProtocol(23);
      expect(await reply()).toHaveProperty("watch_until");
    });

    it.each(["cancelled", "refused", "expired"])("is not sent for a watch that is %s", async (state) => {
      await h.admin.query(`ALTER TABLE engine_commands DISABLE TRIGGER USER`);
      try {
        await watchCommand({ state });
      } finally {
        await h.admin.query(`ALTER TABLE engine_commands ENABLE TRIGGER USER`);
      }
      expect(await reply()).not.toHaveProperty("watch_until");
    });

    it("is not sent for a watch that is already over, another kind of command, another repo's watch or another runner's", async () => {
      await watchCommand({ until: new Date(Date.now() - 5_000) });
      await watchCommand({ kind: "pause_loop" });
      const repo2 = (await h.admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'second', 'runner_local') RETURNING id`, [A.accountId, GH + 1])).rows[0]!.id;
      await watchCommand({ repo: repo2 });
      const key2 = newKey();
      const runner2 = await registerKey(h.admin, A.accountId, A.userId, key2);
      await watchCommand({ runner: runner2 });
      expect(await reply()).not.toHaveProperty("watch_until");
    });

    it("never carries another account's watch", async () => {
      const keyB = newKey();
      const runnerB = await registerKey(h.admin, B.accountId, B.userId, keyB);
      await h.admin.query(`UPDATE runners SET protocol_version = 24 WHERE id = $1`, [runnerB]);
      await h.admin.query(`INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, state, delivered_at)
                           VALUES ($1, $2, $3, 1, 'watch', $4::jsonb, $5, now(), now() + interval '500 seconds', 'delivered', now())`, [B.accountId, runnerB, B.repoId, JSON.stringify({ until: new Date(Date.now() + 300_000).toISOString() }), B.userId]);
      expect(await reply()).not.toHaveProperty("watch_until");
    });
  });
});
