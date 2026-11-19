import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ENGINE_COMMAND_KINDS, ENGINE_COMMAND_MIN_PROTOCOL, EngineCommand, commandSendableTo, signEngineCommand, watchUntilAcceptable, verifyEngineCommand, watchBeforeWithinHighWater,
} from "../src/engineCommands.js";
import { ENGINE_EVENT_CLASSES, ENGINE_EVENT_KINDS, EngineEvent, buildEventsAcceptedReply, EngineEventsAcceptedReply } from "../src/engineEvents.js";
import { CURRENT_PROTOCOL_VERSION, HelloMessage, MACHINE_ONBOARDING_MIN_PROTOCOL, WATCH_MIN_PROTOCOL } from "../src/messages.js";
import { JobSignatureError } from "../src/jobSignature.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const ISSUED = "2026-11-19T10:00:00.000Z";
const at = (s: number) => new Date(Date.parse(ISSUED) + s * 1000).toISOString();
const watch = (args: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ v: 1, purpose: "engine_command_v1", command_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10", command_seq: 1, runner_id: "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f", repo_gh_id: 77, kind: "watch", args, issued_by: "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", issued_at: ISSUED, expires_at: at(300), halt_epoch: 0, ...over });
const ok = (value: unknown) => EngineCommand.safeParse(value).success;

describe("watch command", () => {
  it("is a command kind, with repo_gh_id in the signed base", () => {
    expect(ENGINE_COMMAND_KINDS).toContain("watch");
    expect(ok(watch({ until: at(60) }))).toBe(true);
    const noRepo = watch({ until: at(60) }) as Record<string, unknown>;
    delete noRepo["repo_gh_id"];
    expect(ok(noRepo)).toBe(false);
    expect(ok(watch({ until: at(60) }, { repo_gh_id: 0 }))).toBe(false);
  });

  it("takes only until and before", () => {
    expect(ok(watch({}))).toBe(false);
    expect(ok(watch({ until: at(60), extra: 1 }))).toBe(false);
    expect(ok(watch({ until: "soon" }))).toBe(false);
    expect(ok({ ...watch({ until: at(60) }), kind: "start_day" })).toBe(false);
  });

  it("accepts until from 1 ms to 600 s ahead of the issue time, and nothing else", () => {
    expect(ok(watch({ until: at(600) }))).toBe(true);
    expect(ok(watch({ until: new Date(Date.parse(ISSUED) + 1).toISOString() }))).toBe(true);
    expect(ok(watch({ until: new Date(Date.parse(ISSUED) + 600_001).toISOString() }))).toBe(false);
    expect(ok(watch({ until: ISSUED }))).toBe(false);
    expect(ok(watch({ until: at(-1) }))).toBe(false);
  });

  it("accepts a before seq from 0 to 2^53-1 and refuses anything else", () => {
    for (const before of [0, 1, Number.MAX_SAFE_INTEGER]) expect(ok(watch({ until: at(60), before })), String(before)).toBe(true);
    for (const before of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", null]) expect(ok(watch({ until: at(60), before })), String(before)).toBe(false);
    expect(ok(watch({ until: at(60) }))).toBe(true);
  });

  it("holds before to the repo's high-water seq", () => {
    expect(watchBeforeWithinHighWater(0, 0)).toBe(true);
    expect(watchBeforeWithinHighWater(120, 120)).toBe(true);
    expect(watchBeforeWithinHighWater(121, 120)).toBe(false);
    expect(watchBeforeWithinHighWater(-1, 120)).toBe(false);
    expect(watchBeforeWithinHighWater(1.5, 120)).toBe(false);
  });

  it("is signed: a changed byte fails and the right key verifies", () => {
    const signed = signEngineCommand(EngineCommand.parse(watch({ until: at(60) })), "job-key-1", privateKey);
    const now = new Date(ISSUED);
    expect(verifyEngineCommand(signed, keyring, now).kind).toBe("watch");
    const moved = { ...signed, command: { ...signed.command, args: { until: at(120) } } };
    expect(() => verifyEngineCommand(moved, keyring, now)).toThrowError(JobSignatureError);
    expect(() => verifyEngineCommand({ ...signed, command: { ...signed.command, repo_gh_id: 78 } }, keyring, now)).toThrowError(JobSignatureError);
  });

  it("is never sent below protocol 23, and a v22 hello still validates", () => {
    expect(WATCH_MIN_PROTOCOL).toBe(23);
    expect(CURRENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(WATCH_MIN_PROTOCOL);
    expect(MACHINE_ONBOARDING_MIN_PROTOCOL).toBe(22);
    expect(commandSendableTo("watch", 22)).toBe(false);
    expect(commandSendableTo("watch", 1)).toBe(false);
    expect(commandSendableTo("watch", 23)).toBe(true);
    expect(commandSendableTo("watch", 24)).toBe(true);
    for (const kind of ENGINE_COMMAND_KINDS.filter((k) => k !== "watch")) expect(commandSendableTo(kind, 20), kind).toBe(true);
    expect(Object.keys(ENGINE_COMMAND_MIN_PROTOCOL)).toEqual(["watch"]);
    const hello = (protocol_version: number) => HelloMessage.safeParse({ protocol_version, binary_version: "0.1.0", model_auth_present: true, isolation: "host_sandbox" }).success;
    expect(hello(22)).toBe(true);
    expect(hello(23)).toBe(true);
  });
});

describe("slim_status and the ingest reply", () => {
  const slim = (over: Record<string, unknown> = {}) => ({ v: 1, engine_instance_id: "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10", seq: 3, ts: "2026-11-19T10:00:00.000Z", kind: "slim_status", sources: { bridge: 0, host: null, engine: 86400 }, reason: "unwatched", ...over });
  it("takes null or 0 to 86400 s for each source and the one reason", () => {
    expect(EngineEvent.safeParse(slim()).success).toBe(true);
    for (const age of [86401, -1, 1.5, "3", undefined]) expect(EngineEvent.safeParse(slim({ sources: { bridge: 1, host: 1, engine: age } })).success, String(age)).toBe(false);
    expect(EngineEvent.safeParse(slim({ reason: "watched" })).success).toBe(false);
    expect(EngineEvent.safeParse(slim({ sources: { bridge: 1, host: 1, engine: 1, plan: 1 } })).success).toBe(false);
  });

  it("carries watch_until on the ingest reply, optional and an ISO time", () => {
    const base = { accepted: 1, duplicates: 0, last_accepted_seq: 4 };
    expect(EngineEventsAcceptedReply.safeParse(base).success).toBe(true);
    expect(EngineEventsAcceptedReply.safeParse({ ...base, watch_until: ISSUED }).success).toBe(true);
    expect(EngineEventsAcceptedReply.safeParse({ ...base, watch_until: "later" }).success).toBe(false);
  });
});

describe("event classes", () => {
  it("puts every kind in exactly one bucket", () => {
    const all = Object.values(ENGINE_EVENT_CLASSES).flat() as string[];
    expect([...all].sort()).toEqual([...ENGINE_EVENT_KINDS].sort());
    expect(new Set(all).size).toBe(all.length);
  });
  it("pins all three buckets in full, so moving a kind fails", () => {
    expect([...ENGINE_EVENT_CLASSES.always_on].sort()).toEqual(["agent_linked", "agent_started", "agent_stopped", "ask_cleared", "ask_raised", "bridge_dropped", "gate_receipt", "halt_applied", "host_started", "host_stopped", "merge_lane", "merged", "slim_status", "spawn_blocked", "tick_ended", "usage_tick"]);
    expect([...ENGINE_EVENT_CLASSES.on_demand].sort()).toEqual(["checkin_tick", "compaction_detected", "loop_tick", "plan_snapshot", "team_log_line", "tick_started"]);
    expect([...ENGINE_EVENT_CLASSES.replaced_by_slim].sort()).toEqual(["bridge_heartbeat", "engine_heartbeat", "host_heartbeat"]);
  });
  it("keeps usage_tick always on and the three heartbeats replaced by slim", () => {
    expect(ENGINE_EVENT_CLASSES.always_on).toContain("usage_tick");
    expect([...ENGINE_EVENT_CLASSES.replaced_by_slim].sort()).toEqual(["bridge_heartbeat", "engine_heartbeat", "host_heartbeat"]);
  });
});

describe("watchUntilAcceptable", () => {
  const NOW = new Date(ISSUED);
  const cmd = (s: number) => ({ args: { until: at(s) } });
  it("takes an until in the runner's future, at most 600 s ahead of its own clock", () => {
    expect(watchUntilAcceptable(cmd(1), NOW)).toBe(true);
    expect(watchUntilAcceptable(cmd(600), NOW)).toBe(true);
    expect(watchUntilAcceptable(cmd(601), NOW)).toBe(false);
    expect(watchUntilAcceptable(cmd(0), NOW)).toBe(false);
    expect(watchUntilAcceptable(cmd(-1), NOW)).toBe(false);
  });
  it("judges by the runner's clock under plus or minus 60 s of skew", () => {
    const fast = new Date(Date.parse(ISSUED) + 60_000);
    const slow = new Date(Date.parse(ISSUED) - 60_000);
    expect(watchUntilAcceptable(cmd(600), fast)).toBe(true);
    expect(watchUntilAcceptable(cmd(60), fast)).toBe(false);
    expect(watchUntilAcceptable(cmd(61), fast)).toBe(true);
    expect(watchUntilAcceptable(cmd(600), slow)).toBe(false);
    expect(watchUntilAcceptable(cmd(540), slow)).toBe(true);
  });
});

describe("buildEventsAcceptedReply", () => {
  const base = { accepted: 1, duplicates: 0, last_accepted_seq: 4 };
  it("drops watch_until below protocol 23 and keeps it from 23", () => {
    expect(buildEventsAcceptedReply(base, ISSUED, 22)).toEqual(base);
    expect(buildEventsAcceptedReply(base, ISSUED, 23)).toEqual({ ...base, watch_until: ISSUED });
    expect(buildEventsAcceptedReply(base, undefined, 23)).toEqual(base);
  });
});
