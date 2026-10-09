import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JobSchema, SignedJobSchema } from "../src/job.js";
import { CREDENTIAL_MODES, DETAILS_OF_RUN_ENDED, INT4_MAX, ISOLATION_TIERS, LOCAL_ONLY_EVENT_TYPES, LocalOnlyEvent, MAX_AGENT_OUTPUT_DEPTH, MAX_EVENTS_PER_BATCH, RUNNER_MESSAGES, SANDBOX_UNAVAILABLE_REASONS, type RunnerMessageName } from "../src/messages.js";
import { CREDENTIAL_NAME, G1_ALLOWLIST, fieldPaths, g1Violations, nonStrictObjects } from "./helpers/schemaWalk.js";

const UUID = "0f8a4c2e-9d1b-4e7a-8c35-6a1f2b3c4d5e";
const JWK = { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" };
const EVENT = { seq: 0, ts: "2026-10-04T12:00:00.000Z", type: "tool_use", tool_name: "Edit", file_path: "src/a.ts" };

/** One valid message of each kind. */
const VALID: Record<RunnerMessageName, unknown> = {
  hello: { protocol_version: 1, binary_version: "0.1.0", model_auth_present: true, isolation: "container" },
  claim: {},
  heartbeat: { run_id: UUID, lease_generation: 3 },
  git_ticket: { run_id: UUID, lease_generation: 3 },
  events: { run_id: UUID, lease_generation: 3, events: [EVENT] },
  done: { run_id: UUID, lease_generation: 3, agentOutput: { verdict: "pass" } },
  register: { code: `fxrr_${"A1".repeat(16)}`, public_key_jwk: JWK },
  rotate: { public_key_jwk: JWK },
  revoke: { reason: "laptop lost" },
};

describe("the runner-to-cloud messages", () => {
  it("are exactly hello, claim, heartbeat, git_ticket, events, done, register, rotate and revoke", () => {
    expect(Object.keys(RUNNER_MESSAGES).sort()).toEqual(["claim", "done", "events", "git_ticket", "heartbeat", "hello", "register", "revoke", "rotate"]);
  });

  it("accept a valid message of each kind", () => {
    for (const [name, schema] of Object.entries(RUNNER_MESSAGES)) {
      expect(schema.safeParse(VALID[name as RunnerMessageName]).success, name).toBe(true);
    }
  });

  it("each rejects one extra unknown key", () => {
    for (const [name, schema] of Object.entries(RUNNER_MESSAGES)) {
      const message = { ...(VALID[name as RunnerMessageName] as object), unexpected: 1 };
      expect(schema.safeParse(message).success, name).toBe(false);
    }
  });

  it("are strict at every depth", () => {
    for (const [name, schema] of Object.entries(RUNNER_MESSAGES)) expect(nonStrictObjects(schema), name).toEqual([]);
    expect(nonStrictObjects(JobSchema)).toEqual([]);
    expect(nonStrictObjects(SignedJobSchema)).toEqual([]);
    // The walker sees a loose schema.
    expect(nonStrictObjects(z.object({ a: z.object({ b: z.string() }).strict() }))).toEqual(["$"]);
  });

  it("reject an extra key inside a nested object too", () => {
    expect(RUNNER_MESSAGES.events.safeParse({ ...(VALID.events as object), events: [{ ...EVENT, extra: 1 }] }).success).toBe(false);
    expect(RUNNER_MESSAGES.register.safeParse({ ...(VALID.register as object), public_key_jwk: { ...JWK, d: "private-half" } }).success).toBe(false);
  });
});

describe("G1: no credential channel", () => {
  it("no field in any message or in the job has a credential-looking name, except the allowlist", () => {
    const schemas: Array<[string, z.ZodTypeAny]> = [...Object.entries(RUNNER_MESSAGES), ["job", JobSchema], ["signed_job", SignedJobSchema]];
    for (const [name, schema] of schemas) expect(g1Violations(schema), name).toEqual([]);
  });

  it("the allowlist is exactly public_key_jwk, keyid, model_auth_present and credential_mode", () => {
    expect([...G1_ALLOWLIST].sort()).toEqual(["credential_mode", "keyid", "model_auth_present", "public_key_jwk"]);
  });

  it("the walk does find a credential-looking field", () => {
    const bad = z.object({ api_key: z.string(), nested: z.array(z.object({ authToken: z.string(), model_auth_present: z.boolean(), cookie: z.string().optional() })) });
    expect(g1Violations(bad).sort()).toEqual(["api_key", "nested.authToken", "nested.cookie"]);
    expect(CREDENTIAL_NAME.test("auth_present")).toBe(false);
    expect(fieldPaths(bad)).toContain("nested.model_auth_present");
  });

  it("credential_mode, wherever a schema has it, is the closed enum subscription | api_key", () => {
    expect([...CREDENTIAL_MODES]).toEqual(["subscription", "api_key"]);
    // D#6 R3b (A2): the job no longer carries it; the messages that do (and the DB rows) keep the allowlist entry.
    const holders = [...Object.entries(RUNNER_MESSAGES), ["job", JobSchema] as const].filter(([, schema]) => fieldPaths(schema as z.ZodTypeAny).includes("credential_mode"));
    expect(holders.map(([name]) => name)).not.toContain("job");
    for (const mode of ["", "none", "oauth", "free text", "SUBSCRIPTION", null, 5]) expect(z.enum(CREDENTIAL_MODES).safeParse(mode).success, String(mode)).toBe(false);
  });
});

describe("hello", () => {
  it("carries model_auth_present as a boolean and has no email, organisation or account name", () => {
    const keys = Object.keys(RUNNER_MESSAGES.hello.shape).sort();
    expect(keys).toEqual(["binary_version", "isolation", "model_auth_present", "protocol_version"]);
    expect(RUNNER_MESSAGES.hello.safeParse({ ...(VALID.hello as object), model_auth_present: "yes" }).success).toBe(false);
    for (const extra of ["email", "org", "organization", "account_name", "account"]) {
      expect(RUNNER_MESSAGES.hello.safeParse({ ...(VALID.hello as object), [extra]: "x" }).success, extra).toBe(false);
    }
  });

  it("keeps protocol_version inside a Postgres integer, so an out-of-range value is a refused message and never a database error", () => {
    const hello = (protocol_version: number) => RUNNER_MESSAGES.hello.safeParse({ ...(VALID.hello as object), protocol_version });
    expect(INT4_MAX).toBe(2 ** 31 - 1);
    expect(hello(INT4_MAX).success).toBe(true);
    for (const bad of [INT4_MAX + 1, 2 ** 31, 2 ** 53 - 1, Number.MAX_SAFE_INTEGER, 0, -1, 1.5]) expect(hello(bad).success, String(bad)).toBe(false);
  });

  it("isolation is one of the four tiers and never none", () => {
    expect([...ISOLATION_TIERS]).toEqual(["microvm", "vm_container", "container", "host_sandbox"]);
    for (const tier of ISOLATION_TIERS) expect(RUNNER_MESSAGES.hello.safeParse({ ...(VALID.hello as object), isolation: tier }).success, tier).toBe(true);
    for (const bad of ["none", "", "host", "Container"]) expect(RUNNER_MESSAGES.hello.safeParse({ ...(VALID.hello as object), isolation: bad }).success, bad).toBe(false);
  });
});

describe("LocalOnlyEvent", () => {
  it("carries the agent build on an engine_version event, and only a plain dotted version fits", () => {
    expect(LOCAL_ONLY_EVENT_TYPES).toContain("engine_version");
    expect(LocalOnlyEvent.safeParse({ ...EVENT, type: "engine_version", engine_version: "2.1.289" }).success).toBe(true);
    for (const bad of ["2.1", "2.1.289 (Claude Code)", "v2.1.289", "2.1.289\nsecret", "", "1".repeat(300)]) {
      expect(LocalOnlyEvent.safeParse({ ...EVENT, type: "engine_version", engine_version: bad }).success, bad).toBe(false);
    }
  });

  it("includes usage_limit_reached and credential_mismatch in its type enum", () => {
    expect(LOCAL_ONLY_EVENT_TYPES).toContain("usage_limit_reached");
    expect(LOCAL_ONLY_EVENT_TYPES).toContain("credential_mismatch");
    for (const type of ["usage_limit_reached", "credential_mismatch"]) expect(LocalOnlyEvent.safeParse({ ...EVENT, type }).success, type).toBe(true);
    expect(LocalOnlyEvent.safeParse({ ...EVENT, type: "anything_else" }).success).toBe(false);
  });

  it("has only the Spec's fields, and reset_at (D#6 R2b-3, comment 27 item 7)", () => {
    expect(Object.keys(LocalOnlyEvent.innerType().shape).sort()).toEqual(["detail", "duration_ms", "engine_version", "exit_code", "file_path", "reason", "reset_at", "seq", "size_mb", "tool_name", "ts", "type", "usage"]);
  });

  it("takes a reset time on usage_limit_reached only, as an ISO timestamp", () => {
    const limit = { ...EVENT, type: "usage_limit_reached" };
    expect(LocalOnlyEvent.safeParse({ ...limit, reset_at: "2026-10-04T17:00:00.000Z" }).success).toBe(true);
    expect(LocalOnlyEvent.safeParse(limit).success).toBe(true);
    for (const bad of ["tomorrow", "2026-10-04", "", 5]) expect(LocalOnlyEvent.safeParse({ ...limit, reset_at: bad }).success, String(bad)).toBe(false);
    for (const type of LOCAL_ONLY_EVENT_TYPES.filter((t) => t !== "usage_limit_reached")) {
      expect(LocalOnlyEvent.safeParse({ ...EVENT, type, reset_at: "2026-10-04T17:00:00.000Z" }).success, type).toBe(false);
    }
  });

  describe("run_ended (D#6 R4a-2, C24 section 1)", () => {
    const ended = { ...EVENT, type: "run_ended" };
    it("is a local-only event type, with exactly the seven reasons", () => {
      expect(LOCAL_ONLY_EVENT_TYPES).toContain("run_ended");
      expect(Object.keys(DETAILS_OF_RUN_ENDED).sort()).toEqual(["agent_failed", "job_refused", "push_rejected", "repo_not_private", "runner_setup", "runner_shutdown", "wall_clock"]);
    });

    it("takes each reason, and for the two reasons with a closed detail set, each of that set's codes", () => {
      for (const reason of Object.keys(DETAILS_OF_RUN_ENDED)) expect(LocalOnlyEvent.safeParse({ ...ended, reason }).success, reason).toBe(true);
      expect(DETAILS_OF_RUN_ENDED.job_refused).toEqual(["job_signature_invalid", "run_id_mismatch", "duplicate_job", "unknown_role", "task_prompt_hash_mismatch", "role_card_hash_mismatch", "role_tools_mismatch", "continues_wrong_role", "review_sha_missing", "review_wrong_role", "sandbox_allowance_forbidden"]);
      expect(DETAILS_OF_RUN_ENDED.runner_setup).toEqual(["sandbox_unavailable", "claude_binary_missing", "claude_version_unsupported", "claude_flags_unsupported", "auth_missing", "bad_start_options", "no_init_line", "permission_mode_forced", "continuation_branch_missing", "other", "git_proxy_unpinned", "git_ticket_refused", "path_a_no_mirror", "clone_limited", "push_too_large", "push_incomplete", "model_unsupported", "push_ref_refused", "snapshot_refused", "push_failed", "mirror_failed", "mirror_dir_insecure", "git_version_unsupported", "workspace_failed", "workspace_git_refused", "head_not_from_base", "sandbox_stub_committed", "review_sha_not_in_mirror"]);
      for (const [reason, details] of Object.entries(DETAILS_OF_RUN_ENDED)) {
        for (const detail of details) expect(LocalOnlyEvent.safeParse({ ...ended, reason, detail }).success, `${reason}/${detail}`).toBe(true);
      }
    });

    it("refuses a reason outside the set, and a run_ended with no reason", () => {
      for (const bad of ["credential_mismatch", "usage_limit", "", "JOB_REFUSED", 3]) expect(LocalOnlyEvent.safeParse({ ...ended, reason: bad }).success, String(bad)).toBe(false);
      expect(LocalOnlyEvent.safeParse(ended).success).toBe(false);
    });

    it("refuses a detail outside its reason's set, and any detail on a reason that has none", () => {
      expect(LocalOnlyEvent.safeParse({ ...ended, reason: "job_refused", detail: "auth_missing" }).success).toBe(false);
      expect(LocalOnlyEvent.safeParse({ ...ended, reason: "runner_setup", detail: "duplicate_job" }).success).toBe(false);
      expect(LocalOnlyEvent.safeParse({ ...ended, reason: "runner_setup", detail: "free text from an error message" }).success).toBe(false);
      for (const reason of ["agent_failed", "repo_not_private", "wall_clock", "runner_shutdown", "push_rejected"]) {
        expect(LocalOnlyEvent.safeParse({ ...ended, reason, detail: "other" }).success, reason).toBe(false);
        expect(LocalOnlyEvent.safeParse({ ...ended, reason, detail: "duplicate_job" }).success, reason).toBe(false);
      }
    });

    it("push_rejected and continuation_branch_missing (C25 section 1.4): the first takes no detail, the second only under runner_setup", () => {
      expect(LocalOnlyEvent.safeParse({ ...ended, reason: "push_rejected" }).success).toBe(true);
      expect(LocalOnlyEvent.safeParse({ ...ended, reason: "runner_setup", detail: "continuation_branch_missing" }).success).toBe(true);
      for (const reason of ["job_refused", "push_rejected", "agent_failed"]) expect(LocalOnlyEvent.safeParse({ ...ended, reason, detail: "continuation_branch_missing" }).success, reason).toBe(false);
    });

    it("refuses reason and detail on every other event type", () => {
      for (const type of LOCAL_ONLY_EVENT_TYPES.filter((t) => t !== "run_ended")) {
        expect(LocalOnlyEvent.safeParse({ ...EVENT, type, reason: "agent_failed" }).success, `${type} reason`).toBe(false);
        expect(LocalOnlyEvent.safeParse({ ...EVENT, type, detail: "other" }).success, `${type} detail`).toBe(false);
      }
    });

    it("refuses a reset time on a run_ended", () => {
      expect(LocalOnlyEvent.safeParse({ ...ended, reason: "agent_failed", reset_at: "2026-10-04T17:00:00.000Z" }).success).toBe(false);
    });
  });

  describe("taken_over (D#6 R4a-7)", () => {
    const taken = { seq: 0, ts: EVENT.ts, type: "taken_over" };

    it("is a local-only event type that carries a timestamp and nothing else", () => {
      expect(LOCAL_ONLY_EVENT_TYPES).toContain("taken_over");
      expect(LocalOnlyEvent.safeParse(taken).success).toBe(true);
      const extras: Record<string, unknown> = {
        tool_name: "Read", file_path: "a.ts", exit_code: 0, duration_ms: 1, engine_version: "2.1.289", usage: { input: 1 }, reset_at: "2026-10-04T17:00:00.000Z", reason: "agent_failed", detail: "other",
      };
      for (const [key, value] of Object.entries(extras)) expect(LocalOnlyEvent.safeParse({ ...taken, [key]: value }).success, key).toBe(false);
    });

    it("needs a real timestamp and a sequence number, like every event", () => {
      expect(LocalOnlyEvent.safeParse({ type: "taken_over", seq: 0 }).success).toBe(false);
      expect(LocalOnlyEvent.safeParse({ ...taken, ts: "not a time" }).success).toBe(false);
    });
  });

  it("has no message that starts, attaches to or types into a session: the cloud cannot drive a runner's agent or its tmux", () => {
    const names = Object.keys(RUNNER_MESSAGES);
    expect(names.sort()).toEqual(["claim", "done", "events", "git_ticket", "heartbeat", "hello", "register", "revoke", "rotate"]);
    expect(names.filter((n) => /attach|session|tmux|terminal|input|keys|takeover|take_over|start|exec|command/i.test(n))).toEqual([]);
    // And no message has a field that could carry something to type or run.
    const fields = Object.values(RUNNER_MESSAGES).flatMap((schema) => Object.keys((schema as unknown as { shape?: Record<string, unknown> }).shape ?? {}));
    expect(fields.filter((f) => /command|keys|stdin|input|attach|tmux|exec|script/i.test(f))).toEqual([]);
  });

  it("refuses model text, tool output, file content or a message under any name", () => {
    for (const key of ["text", "output", "content", "message", "stdout", "diff", "body"]) {
      expect(LocalOnlyEvent.safeParse({ ...EVENT, [key]: "anything" }).success, key).toBe(false);
      expect(RUNNER_MESSAGES.events.safeParse({ ...(VALID.events as object), events: [{ ...EVENT, [key]: "anything" }] }).success, key).toBe(false);
    }
  });

  it("bounds tool_name and file_path", () => {
    expect(LocalOnlyEvent.safeParse({ ...EVENT, tool_name: "a".repeat(64) }).success).toBe(true);
    expect(LocalOnlyEvent.safeParse({ ...EVENT, tool_name: "a".repeat(65) }).success).toBe(false);
    for (const bad of ["has space", "semi;colon", "new\nline", "", "tool/slash"]) expect(LocalOnlyEvent.safeParse({ ...EVENT, tool_name: bad }).success, bad).toBe(false);
    expect(LocalOnlyEvent.safeParse({ ...EVENT, file_path: "a".repeat(512) }).success).toBe(true);
    expect(LocalOnlyEvent.safeParse({ ...EVENT, file_path: "a".repeat(513) }).success).toBe(false);
    for (const bad of ["a\nb", "a\u0000b", "a\u001fb", "a\u007fb", ""]) expect(LocalOnlyEvent.safeParse({ ...EVENT, file_path: bad }).success, JSON.stringify(bad)).toBe(false);
  });

  it("an events message holds 1 to 100 events", () => {
    const withEvents = (n: number) => ({ ...(VALID.events as object), events: Array.from({ length: n }, (_, seq) => ({ ...EVENT, seq })) });
    expect(MAX_EVENTS_PER_BATCH).toBe(100);
    expect(RUNNER_MESSAGES.events.safeParse(withEvents(100)).success).toBe(true);
    expect(RUNNER_MESSAGES.events.safeParse(withEvents(101)).success).toBe(false);
    expect(RUNNER_MESSAGES.events.safeParse(withEvents(0)).success).toBe(false);
  });
});

describe("the other messages", () => {
  it("register takes only a registration code and an Ed25519 public key", () => {
    expect(Object.keys(RUNNER_MESSAGES.register.shape).sort()).toEqual(["code", "public_key_jwk"]);
    for (const code of ["", "fxrr_short", "abc", `fxrr_${"A".repeat(31)}`, `fxat_${"A".repeat(40)}`, `fxrr_${"A".repeat(32)}!`]) {
      expect(RUNNER_MESSAGES.register.safeParse({ ...(VALID.register as object), code }).success, code).toBe(false);
    }
    for (const jwk of [{ ...JWK, kty: "RSA" }, { ...JWK, crv: "P-256" }, { kty: "OKP", crv: "Ed25519" }, { ...JWK, x: "short" }]) {
      expect(RUNNER_MESSAGES.register.safeParse({ ...(VALID.register as object), public_key_jwk: jwk }).success, JSON.stringify(jwk)).toBe(false);
    }
  });

  it("heartbeat, events and done carry the run id and lease generation", () => {
    for (const name of ["heartbeat", "events", "done"] as const) {
      expect(RUNNER_MESSAGES[name].safeParse({ ...(VALID[name] as object), lease_generation: -1 }).success, name).toBe(false);
      expect(RUNNER_MESSAGES[name].safeParse({ ...(VALID[name] as object), run_id: "not-a-uuid" }).success, name).toBe(false);
      expect(RUNNER_MESSAGES[name].safeParse({ ...(VALID[name] as object), run_id: undefined }).success, name).toBe(false);
    }
  });

  it("claim is empty, or names one closed sandbox reason (C16 section 1.3), and revoke's reason is short, printable text", () => {
    expect(RUNNER_MESSAGES.claim.safeParse({}).success).toBe(true);
    for (const reason of SANDBOX_UNAVAILABLE_REASONS) expect(RUNNER_MESSAGES.claim.safeParse({ sandbox_unavailable: reason }).success, reason).toBe(true);
    for (const bad of ["", "sandbox_unavailable", "bwrap missing", "bwrap_missing\nx", 1, null, true]) expect(RUNNER_MESSAGES.claim.safeParse({ sandbox_unavailable: bad }).success, String(bad)).toBe(false);
    expect(SANDBOX_UNAVAILABLE_REASONS).toEqual(["bwrap_missing", "socat_missing", "userns_disabled", "apparmor_userns_restricted", "probe_failed_other"]);
    expect(RUNNER_MESSAGES.revoke.safeParse({}).success).toBe(true);
    expect(RUNNER_MESSAGES.revoke.safeParse({ reason: "x".repeat(201) }).success).toBe(false);
    expect(RUNNER_MESSAGES.revoke.safeParse({ reason: "a\nb" }).success).toBe(false);
  });

  it("done may carry the session id (D#6 R3b, additive under C8 section 6): optional, a bounded identifier, and old messages still parse", () => {
    const done = (extra: object) => RUNNER_MESSAGES.done.safeParse({ run_id: UUID, lease_generation: 3, ...extra }).success;
    expect(done({})).toBe(true);
    expect(done({ session_id: "7f0c1d2e-aaaa-bbbb-cccc-0123456789ab" })).toBe(true);
    for (const bad of ["", "a b", "s;ls", "x".repeat(129), 5, null]) expect(done({ session_id: bad }), String(bad)).toBe(false);
    // Additive: every key the message had before is still there.
    expect(Object.keys(RUNNER_MESSAGES.done.shape).sort()).toEqual(["agentOutput", "lease_generation", "run_id", "session_id"]);
  });

  it("done's advisory agentOutput is bounded", () => {
    expect(RUNNER_MESSAGES.done.safeParse({ ...(VALID.done as object), agentOutput: { big: "x".repeat(300 * 1024) } }).success).toBe(false);
    expect(RUNNER_MESSAGES.done.safeParse({ run_id: UUID, lease_generation: 0 }).success).toBe(true);
  });
});

describe("hostile input fails closed (D#6 R2a follow-ups 1, 2 and 4)", () => {
  const nested = (levels: number): Record<string, unknown> => {
    let value: Record<string, unknown> = {};
    for (let i = 0; i < levels; i++) value = { a: value };
    return value;
  };
  const done = (agentOutput: unknown): boolean => RUNNER_MESSAGES.done.safeParse({ run_id: UUID, lease_generation: 0, agentOutput }).success;

  it("done refuses deep nesting with a failed parse, never a thrown stack overflow", () => {
    expect(done(nested(MAX_AGENT_OUTPUT_DEPTH - 1))).toBe(true);
    expect(done(nested(MAX_AGENT_OUTPUT_DEPTH + 1))).toBe(false);
    expect(() => done(nested(20_000))).not.toThrow();
    expect(done(nested(20_000))).toBe(false);
    let arrays: unknown = [];
    for (let i = 0; i < 20_000; i++) arrays = [arrays];
    expect(done({ a: arrays })).toBe(false);
  });

  it("numbers are finite and safe integers", () => {
    const ev = (extra: object): boolean => LocalOnlyEvent.safeParse({ ...EVENT, ...extra }).success;
    expect(ev({ usage: { usd: 0.5 } })).toBe(true);
    for (const usd of [Infinity, -Infinity, NaN]) expect(ev({ usage: { usd } }), String(usd)).toBe(false);
    const huge = Number.MAX_SAFE_INTEGER + 2;
    expect(ev({ seq: Number.MAX_SAFE_INTEGER })).toBe(true);
    for (const extra of [{ seq: huge }, { exit_code: huge }, { exit_code: -huge }, { duration_ms: huge }, { usage: { input: huge } }, { usage: { output: huge } }]) {
      expect(ev(extra), JSON.stringify(extra)).toBe(false);
    }
    expect(RUNNER_MESSAGES.heartbeat.safeParse({ run_id: UUID, lease_generation: huge }).success).toBe(false);
    expect(RUNNER_MESSAGES.hello.safeParse({ ...(VALID.hello as object), protocol_version: huge }).success).toBe(false);
  });

  it("a registration code has a maximum length", () => {
    const register = (code: string): boolean => RUNNER_MESSAGES.register.safeParse({ code, public_key_jwk: JWK }).success;
    expect(register(`fxrr_${"a".repeat(128)}`)).toBe(true);
    expect(register(`fxrr_${"a".repeat(129)}`)).toBe(false);
    expect(register(`fxrr_${"a".repeat(1_000_000)}`)).toBe(false);
  });
});


describe("usage event cache counts (D#6 R2b-5a E7, additive under C8 section 6)", () => {
  const usageEvent = (usage: object) => ({ seq: 3, ts: "2026-10-04T12:00:00.000Z", type: "usage" as const, usage });

  it("accepts cache_read and cache_write when present, and an older runner's event without them", () => {
    expect(LocalOnlyEvent.safeParse(usageEvent({ input: 1000, output: 200, cache_read: 5000, cache_write: 300, usd: 0.5 })).success).toBe(true);
    expect(LocalOnlyEvent.safeParse(usageEvent({ input: 1000, output: 200, usd: 0.5 })).success).toBe(true);
    expect(LocalOnlyEvent.safeParse(usageEvent({ input: 1000, output: 200 })).success).toBe(true);
  });

  it("refuses a negative, fractional, non-finite or out-of-range count and any other key", () => {
    for (const bad of [{ cache_read: -1 }, { cache_write: 1.5 }, { cache_read: Infinity }, { cache_write: 1_000_000_000_001 }, { input: 1_000_000_000_001 }, { cache: 1 }]) {
      expect(LocalOnlyEvent.safeParse(usageEvent(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    expect(LocalOnlyEvent.safeParse(usageEvent({ cache_read: 1_000_000_000_000 })).success).toBe(true);
  });
});
