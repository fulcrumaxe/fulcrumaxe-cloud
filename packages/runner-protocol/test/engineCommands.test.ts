import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMMAND_REFUSALS,
  ENGINE_ASK_CHOICES,
  ENGINE_COMMAND_KINDS,
  ENGINE_COMMAND_MAX_LIFE_S,
  ENGINE_COMMAND_OUTCOMES,
  ENGINE_DECISION_TYPES,
  ENGINE_NOTE_MAX,
  ENGINE_SPEC_TAGS,
  EngineCommand,
  EngineCommandAck,
  EngineCommandsPullReply,
  EngineCommandsPullRequest,
  EngineControl,
  EngineDecideReply,
  EngineDecideRequest,
  EngineNote,
  SETTABLE_DIAL_CLASSES,
  SPAWNABLE_ROLES,
  SettableDialClass,
  CommandRefusal,
  SignedEngineCommand,
  type EngineCommandKind,
  type EngineCommandOf,
  SpawnableRole,
  signEngineCommand,
  verifyEngineCommand,
  MAX_CLOCK_SKEW_S,
} from "../src/engineCommands.js";
import { JobSignatureError, canonicalJson, type JobSignatureErrorCode } from "../src/jobSignature.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const keyring = { "job-key-1": publicKey };
const NOW = new Date("2026-11-16T15:00:00Z");
const U1 = "0b9b3a52-6c1e-4c53-9d5f-1f3f2a6f7a10";
const U2 = "5d0c6f0e-2a54-4f3b-8d1e-7a9c2b3d4e5f";
const U3 = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const ARGS: Record<string, unknown> = {
  start_day: {},
  pause_loop: {},
  resume_loop: {},
  answer_ask: { ask_id: "0123456789abcdef", choice: "approve", note: "go ahead" },
  set_dial: { dial_class: "agent.spawn", level: 3, ttl: "for_today" },
  request_spawn: { role: "code-reviewer", discussion: 842 },
  stop_agent: { agent_id: "a0e5cfdaaf80bf298" },
};
const command = (kind: string, over: Record<string, unknown> = {}) => ({ v: 1, purpose: "engine_command_v1", command_id: U1, command_seq: 1, runner_id: U2, repo_gh_id: 77, kind, args: ARGS[kind], issued_by: U3, issued_at: "2026-11-16T14:59:00.000Z", expires_at: "2026-11-16T15:04:00.000Z", halt_epoch: 0, ...over });
const ok = (value: unknown) => EngineCommand.safeParse(value).success;
const code = (run: () => unknown): JobSignatureErrorCode | "returned" => {
  try {
    run();
    return "returned";
  } catch (error) {
    if (!(error instanceof JobSignatureError)) throw error;
    return error.code;
  }
};

describe("EngineCommand", () => {
  it("parses every kind with its own args", () => {
    expect(ENGINE_COMMAND_KINDS).toHaveLength(7);
    for (const kind of ENGINE_COMMAND_KINDS) expect(EngineCommand.parse(command(kind)), kind).toEqual(command(kind));
  });

  it("refuses an unknown kind and args that belong to another kind", () => {
    expect(ok(command("kill_everything"))).toBe(false);
    expect(ok({ ...command("start_day"), kind: "halt" })).toBe(false);
    for (const kind of ENGINE_COMMAND_KINDS) for (const from of ENGINE_COMMAND_KINDS) {
      if (from !== kind && JSON.stringify(ARGS[from]) !== JSON.stringify(ARGS[kind])) expect(ok(command(kind, { args: ARGS[from] })), `${kind} with ${from} args`).toBe(false);
    }
    expect(ok(command("start_day", { args: { extra: 1 } }))).toBe(false);
    expect(ok(command("answer_ask", { args: { ...(ARGS["answer_ask"] as object), extra: 1 } }))).toBe(false);
    expect(ok(command("start_day", { args: undefined }))).toBe(false);
  });

  it("is strict on the envelope and checks each field", () => {
    expect(ok(command("start_day", { extra: 1 }))).toBe(false);
    for (const key of ["v", "command_id", "command_seq", "runner_id", "repo_gh_id", "kind", "args", "issued_by", "issued_at", "expires_at", "halt_epoch"]) {
      const { [key]: _gone, ...rest } = command("start_day") as Record<string, unknown>;
      expect(ok(rest), key).toBe(false);
    }
    expect(ok(command("start_day", { v: 2 }))).toBe(false);
    for (const field of ["command_id", "runner_id", "issued_by"]) expect(ok(command("start_day", { [field]: "nope" })), field).toBe(false);
    for (const command_seq of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) expect(ok(command("start_day", { command_seq })), String(command_seq)).toBe(false);
    for (const repo_gh_id of [0, 1.5, "7"]) expect(ok(command("start_day", { repo_gh_id })), String(repo_gh_id)).toBe(false);
    for (const halt_epoch of [-1, 1.5, 2_147_483_648]) expect(ok(command("start_day", { halt_epoch })), String(halt_epoch)).toBe(false);
    expect(ok(command("start_day", { halt_epoch: 0, command_seq: 1 }))).toBe(true);
    for (const field of ["issued_at", "expires_at"]) expect(ok(command("start_day", { [field]: "tomorrow" })), field).toBe(false);
  });

  it("refuses a life over 600 s, and one that is not positive", () => {
    const at = (life: number) => ok(command("start_day", { expires_at: new Date(Date.parse("2026-11-16T14:59:00.000Z") + life).toISOString() }));
    expect(at(ENGINE_COMMAND_MAX_LIFE_S * 1000)).toBe(true);
    expect(at(ENGINE_COMMAND_MAX_LIFE_S * 1000 + 1)).toBe(false);
    expect(at(1)).toBe(true);
    expect(at(0)).toBe(false);
    expect(at(-1000)).toBe(false);
  });

  it("holds answer_ask to a closed choice, a 16-hex ask id and a clean note of at most 500 characters", () => {
    const answer = (args: Record<string, unknown>) => ok(command("answer_ask", { args: { ask_id: "0123456789abcdef", choice: "decline", ...args } }));
    expect([...ENGINE_ASK_CHOICES]).toEqual(["approve", "decline", "defer"]);
    for (const choice of ENGINE_ASK_CHOICES) expect(answer({ choice }), choice).toBe(true);
    for (const choice of ["yes", "Approve", "", undefined, 1]) expect(answer({ choice }), String(choice)).toBe(false);
    for (const ask_id of ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "x"]) expect(answer({ ask_id }), ask_id).toBe(false);
    expect(answer({ note: "a".repeat(ENGINE_NOTE_MAX) })).toBe(true);
    expect(answer({ note: "a".repeat(ENGINE_NOTE_MAX + 1) })).toBe(false);
    expect(answer({ note: "" })).toBe(true);
    expect(answer({ note: 5 })).toBe(false);
  });

  it("refuses a note with any C0 or C1 control character or bidirectional control", () => {
    const refused = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => 0x7f + i), 0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    for (const point of refused) expect(EngineNote.safeParse(`ab${String.fromCodePoint(point)}cd`).success, `U+${point.toString(16)}`).toBe(false);
    expect(EngineNote.safeParse("ab\ud800cd").success).toBe(false);
    for (const point of [0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xe0001, 0xe0020, 0xe007f]) expect(EngineNote.safeParse(`ab${String.fromCodePoint(point)}cd`).success, `U+${point.toString(16)}`).toBe(false);
    for (const fine of ["plain words, 123", "café", "日本語", "ok \u{1F44D}", "a b"]) expect(EngineNote.safeParse(fine).success, fine).toBe(true);
  });

  it("holds set_dial to the eight settable classes, a level of 1 to 5 and a closed ttl", () => {
    const dial = (args: Record<string, unknown>) => ok(command("set_dial", { args: { dial_class: "docs.write", level: 2, ttl: "none", ...args } }));
    expect([...SETTABLE_DIAL_CLASSES]).toEqual(["docs.write", "tests.add", "deps.bump", "agent.spawn", "merge.standard", "merge.fast-path", "memory.write", "archive.move"]);
    for (const dial_class of SETTABLE_DIAL_CLASSES) expect(dial({ dial_class }), dial_class).toBe(true);
    for (const dial_class of ["sandbox.modify", "methodology.change", "external.system", "intent.generate", "cost.spend", "Docs.write", "", "docs"]) expect(dial({ dial_class }), dial_class).toBe(false);
    for (const level of [1, 2, 3, 4, 5]) expect(dial({ level }), String(level)).toBe(true);
    for (const level of [0, 6, -1, 2.5, "3"]) expect(dial({ level }), String(level)).toBe(false);
    for (const ttl of ["for_today", "none"]) expect(dial({ ttl })).toBe(true);
    for (const ttl of ["forever", "", undefined]) expect(dial({ ttl }), String(ttl)).toBe(false);
  });

  it("holds request_spawn to the eleven spawnable roles and a positive discussion", () => {
    const spawn = (args: Record<string, unknown>) => ok(command("request_spawn", { args: { role: "executor", discussion: 1, ...args } }));
    expect(SPAWNABLE_ROLES).toHaveLength(11);
    for (const role of SPAWNABLE_ROLES) expect(spawn({ role }), role).toBe(true);
    for (const role of ["researcher", "debater", "other", "explore", "Executor", ""]) expect(spawn({ role }), role).toBe(false);
    expect(SpawnableRole.safeParse("researcher").success).toBe(false);
    for (const discussion of [0, -1, 1.5, "1", 2_147_483_648]) expect(spawn({ discussion }), String(discussion)).toBe(false);
  });

  it("exports the closed enums and the narrowed types", () => {
    expect(SettableDialClass.safeParse("cost.spend").success).toBe(false);
    expect(SettableDialClass.safeParse("memory.write").success).toBe(true);
    expect(CommandRefusal.safeParse("ceiling").success).toBe(true);
    expect(CommandRefusal.safeParse("nope").success).toBe(false);
    const kind: EngineCommandKind = "set_dial";
    const parsed = EngineCommand.parse(command(kind)) as EngineCommandOf<"set_dial">;
    expect(parsed.args.level).toBe(3);
  });

  it("holds stop_agent to an agent id", () => {
    const stop = (agent_id: unknown) => ok(command("stop_agent", { args: { agent_id } }));
    expect(stop("abc_DEF-123")).toBe(true);
    for (const bad of ["", "a b", "a".repeat(65), "a/b", 5]) expect(stop(bad), String(bad)).toBe(false);
  });
});

describe("signing", () => {
  const signed = () => signEngineCommand(EngineCommand.parse(command("pause_loop")), "job-key-1", privateKey);

  it("verifies a command signed with the job signer's key scheme", () => {
    expect(verifyEngineCommand(signed(), keyring, NOW)).toEqual(command("pause_loop"));
    expect(verifyEngineCommand(JSON.parse(JSON.stringify(signed())), keyring, NOW)).toEqual(command("pause_loop"));
  });

  it("answers bad_signature for a flipped byte anywhere in the canonical JSON", () => {
    const base = signed();
    const text = canonicalJson(base.command);
    for (let i = 0; i < text.length; i++) {
      const flipped = text.slice(0, i) + String.fromCharCode(text.charCodeAt(i) ^ 1) + text.slice(i + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(flipped);
      } catch {
        continue;
      }
      const result = code(() => verifyEngineCommand({ ...base, command: parsed }, keyring, NOW));
      expect(["bad_signature", "malformed"], `byte ${i}`).toContain(result);
    }
    const tampered = (change: Record<string, unknown>) => code(() => verifyEngineCommand({ ...base, command: { ...base.command, ...change } }, keyring, NOW));
    expect(tampered({ runner_id: U1 })).toBe("bad_signature");
    expect(tampered({ repo_gh_id: 78 })).toBe("bad_signature");
    expect(tampered({ halt_epoch: 1 })).toBe("bad_signature");
    expect(tampered({ command_seq: 2 })).toBe("bad_signature");
    expect(tampered({ expires_at: "2026-11-16T15:09:00.000Z" })).toBe("bad_signature");
    expect(tampered({ kind: "resume_loop" })).toBe("bad_signature");
  });

  it("refuses a command issued ahead of the verifier's clock by more than the skew", () => {
    const at = (issued: number) =>
      signEngineCommand(EngineCommand.parse(command("pause_loop", { issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + 300_000).toISOString() })), "job-key-1", privateKey);
    const now = NOW.getTime();
    expect(MAX_CLOCK_SKEW_S).toBe(60);
    expect(code(() => verifyEngineCommand(at(now + MAX_CLOCK_SKEW_S * 1000), keyring, NOW))).toBe("returned");
    expect(code(() => verifyEngineCommand(at(now + MAX_CLOCK_SKEW_S * 1000 + 1), keyring, NOW))).toBe("expired");
    expect(code(() => verifyEngineCommand(at(now + 3_600_000), keyring, NOW))).toBe("expired");
    expect(code(() => verifyEngineCommand(at(now - 1000), keyring, NOW))).toBe("returned");
  });

  it("never verifies a signature made for anything but a command (domain separation)", () => {
    const body = EngineCommand.parse(command("pause_loop"));
    const withoutPurpose: Record<string, unknown> = { ...body };
    delete withoutPurpose["purpose"];
    const stripped = sign(null, Buffer.from(canonicalJson(withoutPurpose), "utf8"), privateKey).toString("base64url");
    expect(code(() => verifyEngineCommand({ command: withoutPurpose, key_id: "job-key-1", signature: stripped }, keyring, NOW))).toBe("malformed");
    expect(code(() => verifyEngineCommand({ command: body, key_id: "job-key-1", signature: stripped }, keyring, NOW))).toBe("bad_signature");
    // a job-shaped payload signed with the same key never passes as a command
    const jobLike = { v: 1, key_id: "job-key-1", repo: "o/r", task: "x" };
    const jobSig = sign(null, Buffer.from(canonicalJson(jobLike), "utf8"), privateKey).toString("base64url");
    expect(code(() => verifyEngineCommand({ command: jobLike, key_id: "job-key-1", signature: jobSig }, keyring, NOW))).toBe("malformed");
    expect(code(() => verifyEngineCommand({ command: { ...body, purpose: "job_v1" }, key_id: "job-key-1", signature: stripped }, keyring, NOW))).toBe("malformed");
    expect(ok(command("pause_loop", { purpose: undefined }))).toBe(false);
  });

  it("answers bad_signature for another key's signature and for a swapped key id", () => {
    const base = signed();
    expect(code(() => verifyEngineCommand(signEngineCommand(EngineCommand.parse(command("pause_loop")), "job-key-1", other.privateKey), keyring, NOW))).toBe("bad_signature");
    expect(code(() => verifyEngineCommand(base, { "job-key-1": other.publicKey }, NOW))).toBe("bad_signature");
    expect(code(() => verifyEngineCommand({ ...base, key_id: "job-key-2" }, { ...keyring, "job-key-2": other.publicKey }, NOW))).toBe("bad_signature");
  });

  it("refuses an unknown key id, a missing or malformed signature, a bad shape and an expired command", () => {
    const base = signed();
    expect(code(() => verifyEngineCommand({ ...base, key_id: "nobody" }, keyring, NOW))).toBe("unknown_key_id");
    expect(code(() => verifyEngineCommand({ ...base, key_id: "__proto__" }, keyring, NOW))).toBe("unknown_key_id");
    expect(code(() => verifyEngineCommand({ ...base, key_id: "constructor" }, keyring, NOW))).toBe("unknown_key_id");
    const { signature: _gone, ...unsigned } = base;
    expect(code(() => verifyEngineCommand(unsigned, keyring, NOW))).toBe("missing_signature");
    expect(code(() => verifyEngineCommand({ ...base, signature: "" }, keyring, NOW))).toBe("missing_signature");
    expect(code(() => verifyEngineCommand({ ...base, signature: "short" }, keyring, NOW))).toBe("malformed");
    expect(code(() => verifyEngineCommand({ ...base, extra: 1 }, keyring, NOW))).toBe("malformed");
    for (const junk of [null, "x", 5, [], undefined]) expect(code(() => verifyEngineCommand(junk, keyring, NOW)), String(junk)).toBe("malformed");
    expect(code(() => verifyEngineCommand(base, keyring, new Date("2026-11-16T15:04:00.000Z")))).toBe("expired");
    expect(code(() => verifyEngineCommand(base, keyring, new Date("2026-11-16T15:03:59.999Z")))).toBe("returned");
  });

  it("will not sign a command that breaks the schema, and takes a JWK as well as a key object", () => {
    expect(() => signEngineCommand(command("pause_loop", { expires_at: "2027-01-01T00:00:00.000Z" }) as never, "job-key-1", privateKey)).toThrow();
    const jwk = publicKey.export({ format: "jwk" }) as { kty: "OKP"; crv: "Ed25519"; x: string };
    expect(verifyEngineCommand(signed(), { "job-key-1": jwk }, NOW)).toEqual(command("pause_loop"));
    expect(SignedEngineCommand.safeParse(signed()).success).toBe(true);
  });
});

describe("pull and ack", () => {
  it("takes 1 to 10 repos, an after_seq for those repos only, and nothing else", () => {
    const pull = (body: unknown) => EngineCommandsPullRequest.safeParse(body).success;
    expect(pull({ repo_gh_ids: [7], after_seq: {} })).toBe(true);
    expect(pull({ repo_gh_ids: [7, 8], after_seq: { "7": 4, "8": 0 } })).toBe(true);
    expect(pull({ repo_gh_ids: [], after_seq: {} })).toBe(false);
    expect(pull({ repo_gh_ids: Array.from({ length: 10 }, (_, i) => i + 1), after_seq: {} })).toBe(true);
    expect(pull({ repo_gh_ids: Array.from({ length: 11 }, (_, i) => i + 1), after_seq: {} })).toBe(false);
    expect(pull({ repo_gh_ids: [7, 7], after_seq: {} })).toBe(false);
    expect(pull({ repo_gh_ids: [0], after_seq: {} })).toBe(false);
    expect(pull({ repo_gh_ids: [7], after_seq: { "9": 1 } })).toBe(false);
    expect(pull({ repo_gh_ids: [7], after_seq: { "7": -1 } })).toBe(false);
    expect(pull({ repo_gh_ids: [7], after_seq: { "07": 1 } })).toBe(false);
    expect(pull({ repo_gh_ids: [7], after_seq: { __proto__x: 1 } })).toBe(false);
    expect(pull({ repo_gh_ids: [7] })).toBe(false);
    expect(pull({ repo_gh_ids: [7], after_seq: {}, runner_id: U2 })).toBe(false);
  });

  it("answers up to 20 signed commands with the repos' controls", () => {
    const signed = signEngineCommand(EngineCommand.parse(command("pause_loop")), "job-key-1", privateKey);
    const control = { repo_gh_id: 7, halt_epoch: 2, halted: false, operate_enabled: true };
    expect(EngineCommandsPullReply.safeParse({ commands: [signed], controls: [control] }).success).toBe(true);
    expect(EngineCommandsPullReply.safeParse({ commands: [], controls: [] }).success).toBe(true);
    expect(EngineCommandsPullReply.safeParse({ commands: Array.from({ length: 20 }, () => signed), controls: [] }).success).toBe(true);
    expect(EngineCommandsPullReply.safeParse({ commands: Array.from({ length: 21 }, () => signed), controls: [] }).success).toBe(false);
    expect(EngineCommandsPullReply.safeParse({ commands: [], controls: Array.from({ length: 11 }, () => control) }).success).toBe(false);
    expect(EngineCommandsPullReply.safeParse({ commands: [{ command: command("pause_loop") }], controls: [] }).success).toBe(false);
    expect(EngineControl.safeParse({ ...control, extra: 1 }).success).toBe(false);
    for (const key of Object.keys(control)) {
      const { [key as keyof typeof control]: _gone, ...rest } = control;
      expect(EngineControl.safeParse(rest).success, key).toBe(false);
    }
  });

  it("takes an ack with a closed outcome and a closed refusal that goes with a refusal only", () => {
    const ack = (body: unknown) => EngineCommandAck.safeParse(body).success;
    expect([...ENGINE_COMMAND_OUTCOMES]).toEqual(["applied", "refused", "expired", "not_confirmed"]);
    expect(COMMAND_REFUSALS).toHaveLength(12);
    expect(ack({ outcome: "applied" })).toBe(true);
    expect(ack({ outcome: "not_confirmed" })).toBe(true);
    expect(ack({ outcome: "expired" })).toBe(true);
    expect(ack({ outcome: "expired", refusal: "expired" })).toBe(true);
    for (const refusal of COMMAND_REFUSALS) expect(ack({ outcome: "refused", refusal }), refusal).toBe(true);
    expect(ack({ outcome: "refused" })).toBe(false);
    expect(ack({ outcome: "applied", refusal: "halted" })).toBe(false);
    expect(ack({ outcome: "refused", refusal: "because" })).toBe(false);
    expect(ack({ outcome: "done" })).toBe(false);
    expect(ack({ outcome: "applied", detail: "x" })).toBe(false);
    expect(ack({})).toBe(false);
  });
});

describe("decide", () => {
  const request = (over: Record<string, unknown> = {}, subject: Record<string, unknown> = {}) => ({ repo_gh_id: 7, decision_type: "engine_spawn", request_key: "spawn:842:executor", subject: { discussion: 842, role: "executor", ...subject }, ...over });
  const ok = (body: unknown) => EngineDecideRequest.safeParse(body).success;

  it("takes the three decision types and a request key of the closed alphabet", () => {
    for (const decision_type of ENGINE_DECISION_TYPES) expect(ok(request({ decision_type })), decision_type).toBe(true);
    for (const decision_type of ["engine_kill", "", "engine_Spawn"]) expect(ok(request({ decision_type })), decision_type).toBe(false);
    expect(ok(request({ request_key: "a".repeat(128) }))).toBe(true);
    for (const request_key of ["a".repeat(129), "", "a b", "a/b", "a.b", "é"]) expect(ok(request({ request_key })), request_key).toBe(false);
    expect(ok(request({ repo_gh_id: 0 }))).toBe(false);
    expect(ok(request({ command_id: U1 }))).toBe(true);
    expect(ok(request({ command_id: "x" }))).toBe(false);
    expect(ok(request({ extra: 1 }))).toBe(false);
  });

  it("holds the subject closed, with the spec tag", () => {
    expect([...ENGINE_SPEC_TAGS]).toEqual(["feature", "critical", "small", "bug", "doc", "process", "other"]);
    for (const tag of ENGINE_SPEC_TAGS) expect(ok(request({ decision_type: "engine_spec_ready" }, { tag })), tag).toBe(true);
    for (const tag of ["Feature", "[Feature]", "epic", "", 1, null]) expect(ok(request({}, { tag })), String(tag)).toBe(false);
    expect(ok(request({}, { tag: undefined }))).toBe(true);
    expect(ok({ ...request(), subject: {} })).toBe(true);
    expect(ok({ ...request(), subject: undefined })).toBe(false);
    expect(ok(request({}, { title: "x" }))).toBe(false);
    expect(ok(request({}, { branch: "x" }))).toBe(false);
    expect(ok(request({}, { head_sha: "a".repeat(40), pr: 9 }))).toBe(true);
    for (const head_sha of ["a".repeat(39), "A".repeat(40), "g".repeat(40)]) expect(ok(request({}, { head_sha })), head_sha).toBe(false);
    for (const role of [...SPAWNABLE_ROLES, "other"]) expect(ok(request({}, { role })), role).toBe(true);
    for (const role of ["researcher", "janitor"]) expect(ok(request({}, { role })), role).toBe(false);
    for (const field of ["discussion", "pr"]) for (const bad of [0, -1, 1.5, "1"]) expect(ok(request({}, { [field]: bad })), `${field}=${bad}`).toBe(false);
  });

  it("answers in a closed reply", () => {
    const reply = { disposition: "ask", receipt_id: U1, ask_id: U2, answered: null, halted: false };
    expect(EngineDecideReply.safeParse(reply).success).toBe(true);
    expect(EngineDecideReply.safeParse({ ...reply, receipt_id: null, ask_id: null, answered: "approve" }).success).toBe(true);
    expect(EngineDecideReply.safeParse({ ...reply, answered: "defer" }).success).toBe(false);
    expect(EngineDecideReply.safeParse({ ...reply, disposition: "deny" }).success).toBe(false);
    expect(EngineDecideReply.safeParse({ ...reply, ask_id: "0123456789abcdef" }).success).toBe(false);
    expect(EngineDecideReply.safeParse({ ...reply, extra: 1 }).success).toBe(false);
    const { halted: _gone, ...noHalted } = reply;
    expect(EngineDecideReply.safeParse(noHalted).success).toBe(false);
  });
});
