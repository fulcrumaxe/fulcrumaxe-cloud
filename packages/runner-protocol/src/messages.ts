/**
 * The messages a runner sends to the cloud. Every schema is strict, and none has a field that could carry a
 * credential (test/messages.test.ts walks every schema). The fields are the smallest set the protocol needs; a later
 * change may add a field but never remove or rename one.
 */
import { z } from "zod";
import { MAX_ENVELOPE_INPUT_BYTES } from "./envelope.js";
import { SESSION_ID_PATTERN } from "./job.js";

/** The isolation tiers a runner can report. Display only. There is no "none". */
export const ISOLATION_TIERS = ["microvm", "vm_container", "container", "host_sandbox"] as const;
export const IsolationTier = z.enum(ISOLATION_TIERS);
export type IsolationTier = z.infer<typeof IsolationTier>;

/** Where the model credential lives. A mode, never a secret. */
export const CREDENTIAL_MODES = ["subscription", "api_key"] as const;
export const CredentialMode = z.enum(CREDENTIAL_MODES);
export type CredentialMode = z.infer<typeof CredentialMode>;

const uuid = z.string().uuid();
/** Every integer on the wire is a safe integer, so arithmetic on it is exact. */
const safeInt = z.number().int().safe();
const leaseGeneration = safeInt.min(0);

/** An Ed25519 public key as a JWK (RFC 8037). Strict parsing refuses the private member `d`. */
export const Ed25519PublicJwk = z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type Ed25519PublicJwk = z.infer<typeof Ed25519PublicJwk>;

/** At most this many events travel in one `events` message. */
export const MAX_EVENTS_PER_BATCH = 100;

/** What a runner may say about its progress: metadata only, with no field for model text, tool output or file content. */
export const LOCAL_ONLY_EVENT_TYPES = ["tool_use", "file_changed", "command_exit", "usage", "usage_limit_reached", "credential_mismatch"] as const;

export const LocalOnlyEvent = z
  .object({
    seq: safeInt.min(0),
    ts: z.string().datetime(),
    type: z.enum(LOCAL_ONLY_EVENT_TYPES),
    tool_name: z.string().regex(/^[A-Za-z0-9_:.-]{1,64}$/).optional(),
    file_path: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
    exit_code: safeInt.optional(),
    duration_ms: safeInt.min(0).optional(),
    // Display only; the cloud settles no money against it. `input` and `output` count model tokens (the name avoids
    // the word G1 reserves for credentials).
    usage: z.object({ input: safeInt.min(0).optional(), output: safeInt.min(0).optional(), usd: z.number().min(0).finite().optional() }).strict().optional(),
  })
  .strict();
export type LocalOnlyEvent = z.infer<typeof LocalOnlyEvent>;

export const HelloMessage = z
  .object({
    protocol_version: safeInt.min(1),
    binary_version: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/),
    // Whether a model login is present. Never an email, organisation or account name.
    model_auth_present: z.boolean(),
    isolation: IsolationTier,
  })
  .strict();

/** A claim carries nothing: the signature identifies the runner and the cloud reads its scope from its own row. */
export const ClaimMessage = z.object({}).strict();

export const HeartbeatMessage = z.object({ run_id: uuid, lease_generation: leaseGeneration }).strict();

export const EventsMessage = z.object({ run_id: uuid, lease_generation: leaseGeneration, events: z.array(LocalOnlyEvent).min(1).max(MAX_EVENTS_PER_BATCH) }).strict();

/** The deepest nesting `agentOutput` may have. Real envelopes are a few levels deep. */
export const MAX_AGENT_OUTPUT_DEPTH = 32;

/**
 * True when `value` nests no deeper than `maxDepth` and serialises to at most `maxBytes` characters. Depth is measured
 * first, with an explicit stack, because `JSON.stringify` overflows the stack at a few thousand levels: hostile input
 * must give a failed check, never an exception.
 */
export function isBoundedJson(value: unknown, maxDepth: number, maxBytes: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (typeof node !== "object" || node === null) continue;
    if (depth > maxDepth) return false;
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push([child, depth + 1]);
  }
  try {
    return JSON.stringify(value).length <= maxBytes;
  } catch {
    // fx-swallow-ok: input that cannot be serialised is, by design, a failed check
    return false;
  }
}

/** `done` is a hint. The cloud checks GitHub itself; `agentOutput` is stored as advisory only. */
export const DoneMessage = z
  .object({
    run_id: uuid,
    lease_generation: leaseGeneration,
    // D#6 R3b (C12 section 2.8; additive under C8 section 6): the Claude Code session the run ended in, so a fix round can resume it.
    session_id: z.string().regex(SESSION_ID_PATTERN).optional(),
    agentOutput: z
      .record(z.unknown())
      .refine((value) => isBoundedJson(value, MAX_AGENT_OUTPUT_DEPTH, MAX_ENVELOPE_INPUT_BYTES), { message: "agentOutput is too large or too deeply nested" })
      .optional(),
  })
  .strict();

/** A registration code is `fxrr_` and 32 to 128 letters or digits. The cap keeps a hostile body from reaching the hash. */
export const REGISTRATION_CODE_PATTERN = /^fxrr_[A-Za-z0-9]{32,128}$/;

export const RegisterMessage = z.object({ code: z.string().max(133).regex(REGISTRATION_CODE_PATTERN), public_key_jwk: Ed25519PublicJwk }).strict();

/** The new key. The request itself is signed by the old key. */
export const RotateMessage = z.object({ public_key_jwk: Ed25519PublicJwk }).strict();

export const RevokeMessage = z.object({ reason: z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).optional() }).strict();

/** The complete set of runner-to-cloud messages. A test pins these keys. */
export const RUNNER_MESSAGES = {
  hello: HelloMessage,
  claim: ClaimMessage,
  heartbeat: HeartbeatMessage,
  events: EventsMessage,
  done: DoneMessage,
  register: RegisterMessage,
  rotate: RotateMessage,
  revoke: RevokeMessage,
} as const;

export type RunnerMessageName = keyof typeof RUNNER_MESSAGES;
export type RunnerMessage<N extends RunnerMessageName> = z.infer<(typeof RUNNER_MESSAGES)[N]>;
