import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENGINE_EVENTS_BODY_MAX_BYTES,
  ENGINE_EVENT_KINDS,
  ENGINE_FORBIDDEN_KEYS,
  ENGINE_ROLES,
  EngineEvent,
  EngineEventsAcceptedReply,
  EngineEventsErrorReply,
  EngineEventsMessage,
  EngineRole,
  EngineUsage,
  PLAN_SNAPSHOT_MAX_BYTES,
  ROADMAP_STATUSES,
  engineSeqOrderViolation,
  hasForbiddenEngineKey,
  isForbiddenEngineKey,
  parseEngineEventsMessage,
} from "../src/engineEvents.js";
import { CURRENT_PROTOCOL_VERSION, ENGINE_BRIDGE_MIN_PROTOCOL, HelloMessage, engineBridgeAllowed, MIN_SUPPORTED_PROTOCOL_VERSION } from "../src/messages.js";
import { ENGINE_BRIDGE_CAPABILITY, RUNNER_CAPABILITIES } from "../src/job.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "engine-events");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const valid = (name: string): Record<string, any> => JSON.parse(readFileSync(join(FIXTURES, "valid", `${name}.json`), "utf8"));
const IID = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const ok = (event: unknown) => EngineEvent.safeParse(event).success;
const SESSION = { engine_instance_id: IID, repo_gh_id: 77, engine_version: "1.2.3" };
const merged = (seq: number) => ({ ...valid("merged"), seq });

describe("protocol 20", () => {
  it("is the current version, with the capability, and never cuts an older runner off", () => {
    expect(CURRENT_PROTOCOL_VERSION).toBe(27);
    expect(ENGINE_BRIDGE_MIN_PROTOCOL).toBe(20);
    expect(RUNNER_CAPABILITIES).toContain("engine_bridge_v1");
    expect(ENGINE_BRIDGE_CAPABILITY).toBe("engine_bridge_v1");
    const hello = (protocol_version: number, capabilities?: string[]) => HelloMessage.safeParse({ protocol_version, binary_version: "0.1.0", model_auth_present: true, isolation: "host_sandbox", capabilities }).success;
    for (let version = MIN_SUPPORTED_PROTOCOL_VERSION; version <= 20; version++) expect(hello(version), String(version)).toBe(true);
    expect(hello(20, ["engine_bridge_v1"])).toBe(true);
    expect(hello(20, ["engine_bridge_v2"])).toBe(false);
    expect(hello(5, ["engine_bridge_v1"])).toBe(false);
    expect(hello(19, ["engine_bridge_v1"])).toBe(false);
    expect(hello(19, ["wake_v1"])).toBe(true);
    expect(hello(5, [])).toBe(true);
    const sent = (protocol_version: number, capabilities?: string[]) => ({ protocol_version, capabilities });
    expect([5, 19, 20].map((v) => engineBridgeAllowed(sent(v, ["engine_bridge_v1"])))).toEqual([false, false, true]);
    expect(engineBridgeAllowed(sent(20))).toBe(false);
    expect(engineBridgeAllowed(sent(20, ["wake_v1"]))).toBe(false);
  });
});

describe("the event catalogue", () => {
  const validNames = readdirSync(join(FIXTURES, "valid")).map((f) => f.replace(/\.json$/, ""));

  it("has a valid fixture for every kind, and every fixture parses as its own kind", () => {
    const seen = new Set<string>();
    for (const name of validNames) {
      const parsed = EngineEvent.parse(valid(name));
      seen.add(parsed.kind);
      expect(parsed).toEqual(valid(name));
    }
    expect([...seen].sort()).toEqual([...ENGINE_EVENT_KINDS].sort());
  });

  it("refuses an unknown kind and a kind with another kind's fields", () => {
    expect(ok({ ...valid("merged"), kind: "merge_done" })).toBe(false);
    expect(ok({ ...valid("merged"), kind: "merge_lane" })).toBe(false);
    expect(ok({ ...valid("merge_lane"), closes: true })).toBe(false);
  });

  it("refuses any extra key, on the envelope and on every kind", () => {
    for (const name of validNames) {
      expect(ok({ ...valid(name), zz_extra: 1 }), name).toBe(false);
    }
  });

  it("refuses a missing envelope field", () => {
    for (const key of ["v", "engine_instance_id", "seq", "ts", "kind"]) {
      const { [key]: _gone, ...rest } = valid("merged");
      expect(ok(rest), key).toBe(false);
    }
  });

  it("checks v, seq, ts and engine_instance_id", () => {
    expect(ok({ ...valid("merged"), v: 2 })).toBe(false);
    for (const seq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) expect(ok({ ...valid("merged"), seq }), String(seq)).toBe(false);
    expect(ok({ ...valid("merged"), seq: 0 })).toBe(true);
    expect(ok({ ...valid("merged"), seq: Number.MAX_SAFE_INTEGER })).toBe(true);
    for (const ts of ["yesterday", "2026-11-16", "2026-11-16T15:00:00", 1760000000, null]) expect(ok({ ...valid("merged"), ts }), String(ts)).toBe(false);
    for (const engine_instance_id of ["not-a-uuid", "", 5, IID + "0"]) expect(ok({ ...valid("merged"), engine_instance_id }), String(engine_instance_id)).toBe(false);
  });

  it("keeps every kind's key list apart from the removed or renamed ones", () => {
    expect(ok({ ...valid("agent_started"), model_tier: "opus" })).toBe(false);
    for (const counter of ["open_prs", "needs_review", "needs_merge", "needs_fix", "queue_depth", "agents_spawned", "prs_merged"]) expect(ok({ ...valid("loop_tick"), [counter]: 1 }), counter).toBe(false);
    const snapshot = valid("plan_snapshot");
    expect(ok({ ...snapshot, roadmap: [{ ...snapshot.roadmap[0], merged_prs: 1 }] })).toBe(false);
    const { ask_kind, ...noKind } = valid("ask_raised");
    expect(ok(noKind)).toBe(false);
    expect(ok({ ...noKind, kind: "ask_raised", source_kind: ask_kind })).toBe(false);
  });
});

describe("free text and computed figures are refused at any depth", () => {
  const EVERY = [...ENGINE_FORBIDDEN_KEYS, "total_tokens", "total_", "total_usd"];

  it("refuses each forbidden key on the envelope, on a nested object and inside a list, in any case", () => {
    for (const key of EVERY) {
      for (const spelled of [key, key.toUpperCase(), key[0]!.toUpperCase() + key.slice(1)]) {
        expect(ok({ ...valid("merged"), [spelled]: "x" }), spelled).toBe(false);
        if (spelled !== "output") expect(ok({ ...valid("agent_stopped"), usage: { ...valid("agent_stopped").usage, [spelled]: 1 } }), `usage.${spelled}`).toBe(false);
        expect(ok({ ...valid("plan_snapshot"), items: [{ discussion: 1, ordinal: 0, state: "planned", [spelled]: "x" }] }), `items.${spelled}`).toBe(false);
        expect(ok({ ...valid("plan_snapshot"), roadmap: [{ row_key: "A", status: "done", planned_prs: 1, [spelled]: 1 }] }), `roadmap.${spelled}`).toBe(false);
        expect(hasForbiddenEngineKey({ a: [{ b: { [spelled]: 1 } }] }), `scan ${spelled}`).toBe(true);
        expect(hasForbiddenEngineKey({ usage: { [spelled]: 1 } }), `usage scan ${spelled}`).toBe(spelled !== "output");
        expect(isForbiddenEngineKey(spelled)).toBe(true);
      }
    }
  });

  it("names the 14 keys and the total_ prefix, and accepts the real field names that only look close", () => {
    expect([...ENGINE_FORBIDDEN_KEYS].sort()).toEqual(["body", "branch", "content", "cost", "cost_usd", "description", "message", "output", "path", "price", "prompt", "text", "title", "usd"]);
    for (const fine of ["tokens", "usage", "cache_read", "duration_s", "model", "discussion", "totals", "subtotal", "paths", "outputs", "costly"]) expect(isForbiddenEngineKey(fine), fine).toBe(false);
  });

  it("answers with one fixed line that names neither the value nor the event", () => {
    const secret = "SECRET-VALUE-1234";
    const result = EngineEvent.safeParse({ ...valid("agent_stopped"), message: secret });
    expect(result.success).toBe(false);
    const text = JSON.stringify(result.success ? null : result.error.issues);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("agent_stopped");
    expect(result.success ? 0 : result.error.issues).toHaveLength(1);
  });

  it("lets `output` stand only as the token count inside usage", () => {
    expect(ok(valid("agent_stopped"))).toBe(true);
    expect(ok({ ...valid("agent_stopped"), usage: { ...valid("agent_stopped").usage, output: "some text" } })).toBe(false);
    expect(ok({ ...valid("agent_stopped"), usage: { ...valid("agent_stopped").usage, output: { output: 1 } } })).toBe(false);
    expect(ok({ ...valid("agent_stopped"), other: { output: 1 } })).toBe(false);
    expect(ok({ ...valid("plan_snapshot"), items: [{ discussion: 1, ordinal: 0, state: "planned", usage: { output: 1 } }] })).toBe(false);
  });

  it("usage.output is accepted, a top-level output is refused, and output anywhere else is refused", () => {
    expect(ok({ ...valid("tick_ended"), usage: { input: 1, output: 0, cache_read: 0, cache_write: 0 } })).toBe(true);
    expect(ok({ ...valid("agent_stopped"), usage: { ...valid("agent_stopped").usage, output: 7 } })).toBe(true);
    expect(ok({ ...valid("tick_ended"), output: 7 })).toBe(false);
    expect(ok({ ...valid("tick_ended"), usage: { ...valid("tick_ended").usage, nested: { output: 1 } } })).toBe(false);
    expect(ok({ ...valid("plan_snapshot"), roadmap: [{ row_key: "A", status: "done", planned_prs: 1, output: 1 }] })).toBe(false);
    expect(ok({ ...valid("engine_heartbeat"), source_ages_s: { output: 1 } })).toBe(false);
  });

  it("refuses a value nested deeper or wider than any real event", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 12; i++) deep = { a: deep };
    expect(hasForbiddenEngineKey(deep)).toBe(true);
    expect(hasForbiddenEngineKey(Array.from({ length: 21_000 }, () => ({ a: 1 })))).toBe(true);
    expect(ok({ ...valid("merged"), extra: deep })).toBe(false);
  });
});

describe("every id field refuses one character outside its pattern", () => {
  const cases: [string, string, string, string][] = [
    ["AGENT_ID", "agent_linked", "agent_id", "a0e5-cfdaaf_80"],
    ["SPAWN_ID", "agent_linked", "spawn_id", "toolu_01AbC"],
    ["ASK_ID", "ask_cleared", "ask_id", "0123456789abcdef"],
    ["LINE_ID", "team_log_line", "line_id", "0123456789abcdef"],
    ["SHA", "gate_receipt", "head_sha", "a".repeat(40)],
    ["ROW_KEY", "checkin_tick", "name", "EB-1.x_y"],
    ["MODEL_ID", "agent_started", "model", "claude-sonnet-5-5"],
    ["snapshot_id", "plan_snapshot", "snapshot_id", "snap_01-A"],
  ];
  for (const [label, name, field, good] of cases) {
    it(`${label} (${name}.${field})`, () => {
      expect(ok({ ...valid(name), [field]: good })).toBe(true);
      for (const bad of [good + " ", good + "/", good + "\n", good + "é", " " + good, "", good + "x".repeat(70)])
        expect(ok({ ...valid(name), [field]: bad }), JSON.stringify(bad)).toBe(false);
      expect(ok({ ...valid(name), [field]: 5 })).toBe(false);
    });
  }

  it("holds each pattern's own edges", () => {
    const set = (name: string, field: string, value: unknown) => ok({ ...valid(name), [field]: value });
    expect(set("agent_linked", "agent_id", "a".repeat(64))).toBe(true);
    expect(set("agent_linked", "agent_id", "a".repeat(65))).toBe(false);
    expect(set("agent_linked", "spawn_id", "toolu_" + "A".repeat(64))).toBe(true);
    expect(set("agent_linked", "spawn_id", "toolu_" + "A".repeat(65))).toBe(false);
    expect(set("agent_linked", "spawn_id", "toolu_")).toBe(false);
    expect(set("ask_cleared", "ask_id", "0123456789ABCDEF")).toBe(false);
    expect(set("gate_receipt", "head_sha", "a".repeat(39))).toBe(false);
    expect(set("gate_receipt", "head_sha", "A".repeat(40))).toBe(false);
    expect(set("checkin_tick", "name", "a".repeat(48))).toBe(true);
    expect(set("checkin_tick", "name", "a".repeat(49))).toBe(false);
    expect(set("checkin_tick", "name", ".a")).toBe(false);
    expect(set("agent_started", "model", "a".repeat(64))).toBe(true);
    expect(set("agent_started", "model", "a".repeat(65))).toBe(false);
    expect(set("agent_started", "model", "Claude")).toBe(false);
    expect(set("agent_started", "model", ".claude")).toBe(false);
  });
});

describe("numbers, usage and credentials", () => {
  it("refuses a number outside its range", () => {
    for (const [name, field, bad] of [["merged", "pr", 0], ["merged", "pr", 2_147_483_648], ["merged", "discussion", -1], ["merged", "pr", 1.5], ["merged", "pr", "7"], ["loop_tick", "duration_s", -1], ["loop_tick", "duration_s", 2_678_401], ["loop_tick", "duration_s", 1.5], ["halt_applied", "halt_epoch", -1], ["halt_applied", "survivors", 1.5], ["bridge_dropped", "count", -1]] as const)
      expect(ok({ ...valid(name), [field]: bad }), `${name}.${field}=${bad}`).toBe(false);
    expect(ok({ ...valid("loop_tick"), duration_s: 2_678_400 })).toBe(true);
    expect(ok({ ...valid("loop_tick"), duration_s: undefined })).toBe(false);
  });

  it("holds usage to four required safe integers, and its closed object", () => {
    const usage = { input: 1, output: 2, cache_read: 3, cache_write: 4 };
    expect(EngineUsage.safeParse(usage).success).toBe(true);
    expect(EngineUsage.safeParse({ ...usage, input: 1_000_000_000_000 }).success).toBe(true);
    for (const key of Object.keys(usage)) {
      expect(EngineUsage.safeParse({ ...usage, [key]: -1 }).success, `${key} -1`).toBe(false);
      expect(EngineUsage.safeParse({ ...usage, [key]: 1_000_000_000_001 }).success, `${key} over`).toBe(false);
      expect(EngineUsage.safeParse({ ...usage, [key]: 1.5 }).success, `${key} .5`).toBe(false);
      expect(EngineUsage.safeParse({ ...usage, [key]: Number.MAX_SAFE_INTEGER + 1 }).success, `${key} unsafe`).toBe(false);
      const { [key]: _gone, ...rest } = usage as Record<string, number>;
      expect(EngineUsage.safeParse(rest).success, `${key} missing`).toBe(false);
    }
    expect(EngineUsage.safeParse({ ...usage, other: 1 }).success).toBe(false);
    expect(ok({ ...valid("agent_stopped"), usage: {} })).toBe(false);
  });

  it("requires credential_mode on a stop and on a tick end, and takes usage as optional", () => {
    for (const name of ["agent_stopped", "tick_ended"]) {
      const { credential_mode: _gone, ...without } = valid(name);
      expect(ok(without), `${name} without`).toBe(false);
      expect(ok({ ...valid(name), credential_mode: "oauth" }), `${name} oauth`).toBe(false);
      expect(ok({ ...valid(name), credential_mode: "api_key" }), `${name} api_key`).toBe(true);
      const { usage: _u, ...noUsage } = valid(name);
      expect(ok(noUsage), `${name} no usage`).toBe(true);
    }
    expect(ok({ ...valid("agent_stopped"), usage: null })).toBe(false);
  });

  it("takes a model on a start, a stop and a tick end", () => {
    for (const name of ["agent_started", "agent_stopped", "tick_ended"]) expect(ok({ ...valid(name), model: "claude-opus-5" }), name).toBe(true);
  });
});

describe("roles, enums and the plan snapshot", () => {
  it("has 15 roles, any other role is `other`, and an unlisted name is refused", () => {
    expect(ENGINE_ROLES).toHaveLength(15);
    expect(new Set(ENGINE_ROLES).size).toBe(15);
    expect(EngineRole.safeParse("explore").success).toBe(false);
    for (const [name, field] of [["agent_started", "role"], ["agent_stopped", "role"], ["spawn_blocked", "role"], ["team_log_line", "actor_role"]] as const) {
      for (const role of [...ENGINE_ROLES, "other"]) expect(ok({ ...valid(name), [field]: role }), `${name} ${role}`).toBe(true);
      for (const role of ["Explore", "explore", "Executor", "janitor", "", "team-lead "]) expect(ok({ ...valid(name), [field]: role }), `${name} ${role}`).toBe(false);
    }
    expect(ok({ ...valid("team_log_line"), actor_role: "team-lead" })).toBe(true);
    expect(ok({ ...valid("agent_started"), role: "team-lead" })).toBe(false);
  });

  it("refuses a value outside each closed enum", () => {
    for (const [name, field] of [["agent_started", "isolation"], ["agent_stopped", "verdict"], ["spawn_blocked", "reason"], ["merge_lane", "state"], ["gate_receipt", "gate"], ["gate_receipt", "result"], ["team_log_line", "category"], ["loop_tick", "origin"], ["checkin_tick", "origin"], ["engine_heartbeat", "origin"], ["ask_raised", "ask_kind"], ["ask_raised", "source"], ["ask_cleared", "how"], ["host_stopped", "reason"], ["tick_started", "tick_kind"], ["tick_ended", "outcome"], ["halt_applied", "method"], ["bridge_dropped", "reason"]] as const)
      expect(ok({ ...valid(name), [field]: "free text here" }), `${name}.${field}`).toBe(false);
  });

  it("takes the real roadmap statuses, a keyed or key-less row, and refuses the old ones", () => {
    expect([...ROADMAP_STATUSES]).toEqual(["not_started", "in_progress", "done", "blocked", "deferred", "split", "removed", "superseded"]);
    const snap = (roadmap: unknown) => ({ ...valid("plan_snapshot"), roadmap });
    for (const status of ROADMAP_STATUSES) expect(ok(snap([{ row_key: "p6.2_a-b", status, planned_prs: 0 }])), status).toBe(true);
    for (const status of ["planned", "dropped", "Done", "", "unknown"]) expect(ok(snap([{ row_key: "A", status, planned_prs: 0 }])), status).toBe(false);
    expect(ok(snap([{ row_key: "", discussion: 900, status: "done", planned_prs: 1 }]))).toBe(true);
    expect(ok(snap([{ row_key: "", status: "done", planned_prs: 1 }]))).toBe(false);
    expect(ok(snap([{ status: "done", planned_prs: 1 }]))).toBe(false);
    for (const row_key of ["-x", ".x", "a b", "a".repeat(49), "a/b"]) expect(ok(snap([{ row_key, status: "done", planned_prs: 1 }])), row_key).toBe(false);
    expect(ok(snap([{ row_key: "a".repeat(48), status: "done", planned_prs: 1 }]))).toBe(true);
  });

  it("is chunked: all three chunk fields are required and the index is below the count", () => {
    const snap = valid("plan_snapshot");
    for (const key of ["snapshot_id", "chunk_index", "chunk_count"]) {
      const { [key]: _gone, ...rest } = snap;
      expect(ok(rest), key).toBe(false);
    }
    expect(ok({ ...snap, chunk_index: 1, chunk_count: 2 })).toBe(true);
    expect(ok({ ...snap, chunk_index: 2, chunk_count: 2 })).toBe(false);
    expect(ok({ ...snap, chunk_index: 0, chunk_count: 0 })).toBe(false);
    expect(ok({ ...snap, chunk_index: -1 })).toBe(false);
    expect(ok({ ...snap, chunk_index: 100, chunk_count: 101 })).toBe(false);
  });

  it("holds 500 roadmap rows and 300 items per event, and 64 KiB in all", () => {
    const row = { row_key: "A", status: "done", planned_prs: 1 };
    const item = { discussion: 1, ordinal: 0, state: "planned" };
    const snap = valid("plan_snapshot");
    expect(ok({ ...snap, roadmap: Array.from({ length: 500 }, () => row) })).toBe(true);
    expect(ok({ ...snap, roadmap: Array.from({ length: 501 }, () => row) })).toBe(false);
    expect(ok({ ...snap, items: Array.from({ length: 300 }, () => item) })).toBe(true);
    expect(ok({ ...snap, items: Array.from({ length: 301 }, () => item) })).toBe(false);
    const fat = { ...snap, items: Array.from({ length: 300 }, () => ({ discussion: 2_000_000_000, ordinal: 2_000_000_000, state: "in_progress" })), roadmap: Array.from({ length: 500 }, () => ({ row_key: "k".repeat(48), discussion: 2_000_000_000, status: "in_progress", planned_prs: 2_000_000_000 })) };
    expect(Buffer.byteLength(JSON.stringify(fat))).toBeGreaterThan(PLAN_SNAPSHOT_MAX_BYTES);
    expect(ok(fat)).toBe(false);
    expect(PLAN_SNAPSHOT_MAX_BYTES).toBe(65_536);
  });
});

describe("EngineEventsMessage", () => {
  const message = (events: unknown[], session: unknown = SESSION) => ({ session, events });

  it("refuses a batch where any event names another engine instance than the session", () => {
    const other = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
    expect(EngineEventsMessage.safeParse(message([merged(1), merged(2)])).success).toBe(true);
    expect(EngineEventsMessage.safeParse(message([merged(1), { ...merged(2), engine_instance_id: other }])).success).toBe(false);
    expect(EngineEventsMessage.safeParse(message([{ ...merged(1), engine_instance_id: other }, merged(2)])).success).toBe(false);
    expect(EngineEventsMessage.safeParse(message([{ ...merged(1), engine_instance_id: other }], { ...SESSION, engine_instance_id: other })).success).toBe(true);
    expect(parseEngineEventsMessage(message([merged(1), { ...merged(2), engine_instance_id: other }]))).toEqual({ ok: false, error: "invalid_message" });
  });

  it("takes 1 to 100 events and refuses 0 and 101", () => {
    expect(EngineEventsMessage.safeParse(message([merged(1)])).success).toBe(true);
    expect(EngineEventsMessage.safeParse(message(Array.from({ length: 100 }, (_, i) => merged(i)))).success).toBe(true);
    expect(EngineEventsMessage.safeParse(message([])).success).toBe(false);
    expect(EngineEventsMessage.safeParse(message(Array.from({ length: 101 }, (_, i) => merged(i)))).success).toBe(false);
  });

  it("refuses a batch whose seq values do not strictly increase", () => {
    for (const seqs of [[1, 1], [2, 1], [1, 3, 2], [5, 6, 6]]) expect(EngineEventsMessage.safeParse(message(seqs.map(merged))).success, seqs.join()).toBe(false);
    expect(EngineEventsMessage.safeParse(message([merged(0), merged(1), merged(10)])).success).toBe(true);
  });

  it("exports the order check as a pure function, and maps the 400 reasons", () => {
    expect(engineSeqOrderViolation([])).toBeNull();
    expect(engineSeqOrderViolation([{ seq: 4 }])).toBeNull();
    expect(engineSeqOrderViolation([{ seq: 1 }, { seq: 2 }, { seq: 9 }])).toBeNull();
    expect(engineSeqOrderViolation([{ seq: 1 }, { seq: 1 }])).toBe(1);
    expect(engineSeqOrderViolation([{ seq: 1 }, { seq: 5 }, { seq: 4 }])).toBe(2);
    expect(parseEngineEventsMessage(message([merged(2), merged(1)]))).toEqual({ ok: false, error: "seq_order" });
    expect(parseEngineEventsMessage(message([merged(1), { ...merged(2), text: "x" }]))).toEqual({ ok: false, error: "invalid_message" });
    expect(parseEngineEventsMessage(message([{ ...merged(2), text: "x" }, merged(1)]))).toEqual({ ok: false, error: "invalid_message" });
    expect(parseEngineEventsMessage(message([]))).toEqual({ ok: false, error: "invalid_message" });
    expect(parseEngineEventsMessage("nope")).toEqual({ ok: false, error: "invalid_message" });
    expect(parseEngineEventsMessage(message([merged(1)]))).toMatchObject({ ok: true });
  });

  it("holds the session closed: uuid, repo id from 1, a three-part version, no extra key", () => {
    const good = (session: unknown) => EngineEventsMessage.safeParse(message([merged(1)], session)).success;
    expect(good(SESSION)).toBe(true);
    expect(good({ ...SESSION, engine_instance_id: "x" })).toBe(false);
    expect(good({ ...SESSION, repo_gh_id: 0 })).toBe(false);
    expect(good({ ...SESSION, repo_gh_id: 1.5 })).toBe(false);
    for (const engine_version of ["1.2", "1.2.3.4", "v1.2.3", "1.2.x", "1234567.0.0", ""]) expect(good({ ...SESSION, engine_version }), engine_version).toBe(false);
    expect(good({ ...SESSION, engine_version: "999999.999999.999999" })).toBe(true);
    expect(good({ ...SESSION, runner_id: IID })).toBe(false);
    expect(good(null)).toBe(false);
    expect(EngineEventsMessage.safeParse({ ...message([merged(1)]), account_id: IID }).success).toBe(false);
  });

  it("holds one request to 256 KiB", () => {
    const chunk = (seq: number) => ({ ...valid("plan_snapshot"), seq, items: Array.from({ length: 300 }, () => ({ discussion: 2_000_000_000, ordinal: 2_000_000_000, state: "in_progress" })), roadmap: Array.from({ length: 330 }, () => ({ row_key: "k".repeat(48), discussion: 2_000_000_000, status: "in_progress", planned_prs: 2_000_000_000 })) });
    expect(Buffer.byteLength(JSON.stringify(chunk(1)))).toBeLessThan(PLAN_SNAPSHOT_MAX_BYTES);
    const four = EngineEventsMessage.safeParse(message([1, 2, 3, 4].map(chunk)));
    const five = [1, 2, 3, 4, 5].map(chunk);
    expect(Buffer.byteLength(JSON.stringify(message(five)))).toBeGreaterThan(ENGINE_EVENTS_BODY_MAX_BYTES);
    expect(EngineEventsMessage.safeParse(message(five)).success).toBe(false);
    expect(four.success).toBe(Buffer.byteLength(JSON.stringify(message([1, 2, 3, 4].map(chunk)))) <= ENGINE_EVENTS_BODY_MAX_BYTES);
  });

  it("answers in closed replies", () => {
    expect(EngineEventsAcceptedReply.safeParse({ accepted: 3, duplicates: 1, last_accepted_seq: 9 }).success).toBe(true);
    expect(EngineEventsAcceptedReply.safeParse({ accepted: 0, duplicates: 0, last_accepted_seq: null }).success).toBe(true);
    expect(EngineEventsAcceptedReply.safeParse({ accepted: -1, duplicates: 0, last_accepted_seq: 1 }).success).toBe(false);
    expect(EngineEventsAcceptedReply.safeParse({ accepted: 1, duplicates: 0, last_accepted_seq: 1, extra: 1 }).success).toBe(false);
    for (const reply of [{ error: "seq_not_increasing", last_accepted_seq: 4 }, { error: "engine_bridge_off" }, { error: "engine_repo_not_enabled" }, { error: "engine_event_quota", retry_after_s: 60 }, { error: "seq_order" }, { error: "invalid_message" }])
      expect(EngineEventsErrorReply.safeParse(reply).success, JSON.stringify(reply)).toBe(true);
    for (const reply of [{ error: "engine_event_quota" }, { error: "engine_bridge_off", retry_after_s: 1 }, { error: "boom" }, { error: "seq_not_increasing" }])
      expect(EngineEventsErrorReply.safeParse(reply).success, JSON.stringify(reply)).toBe(false);
  });
  it("fails cleanly, never throws, on a value nested too deep to stringify", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = "leaf";
      for (let i = 0; i < depth; i++) value = { a: value };
      return value;
    };
    for (const depth of [2000, 3000, 5000, 20000]) {
      const deepEvent = message([merged(1), { ...merged(2), deep: nested(depth) }]);
      expect(() => EngineEventsMessage.safeParse(deepEvent), `depth ${depth}`).not.toThrow();
      expect(EngineEventsMessage.safeParse(deepEvent).success).toBe(false);
      expect(parseEngineEventsMessage(deepEvent)).toEqual({ ok: false, error: "invalid_message" });
      const deepEnvelope = { ...(message([merged(1)]) as object), extra: nested(depth) };
      expect(() => parseEngineEventsMessage(deepEnvelope), `envelope depth ${depth}`).not.toThrow();
      expect(parseEngineEventsMessage(deepEnvelope)).toEqual({ ok: false, error: "invalid_message" });
    }
  });
});
