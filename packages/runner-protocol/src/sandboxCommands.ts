/**
 * D#587 B-7b: the cloud-to-runner side of sandbox management. A person asks to stop or delete one sandbox, or to reap the stopped ones; the cloud signs one
 * closed command for one runner, the claim reply carries it, and the runner acks it on its next claim.
 * It is signed with the job signer's key and `key_id` scheme over `canonicalJson`, under its own purpose string, so a signature made over a job, an
 * engine command or anything else the key signs can never verify as a sandbox command. The signature binds the command to one runner (`runner_id`), to
 * one use (`nonce`) and to a short life (`exp`). The runner checks the signature, the expiry, the nonce and the name pattern before it touches anything.
 * The run-job schema is not widened: this is not a job and does not run in a sandbox.
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalJson, JobSignatureError, type JobKeyring } from "./jobSignature.js";

/** Signed inside every command. */
export const SANDBOX_COMMAND_PURPOSE = "sandbox_command_v1" as const;
export const SANDBOX_COMMAND_KINDS = ["stop_sandbox", "delete_sandbox", "reap_sandboxes"] as const;
export type SandboxCommandKind = (typeof SANDBOX_COMMAND_KINDS)[number];
/** The longest a command lives after it was issued, in seconds (the cloud's table holds the same bound). */
export const SANDBOX_COMMAND_MAX_LIFE_S = 600;
/** How many commands one claim reply carries, and how many acks one claim carries. */
export const SANDBOX_COMMANDS_PER_CLAIM = 5;
export const SANDBOX_COMMAND_REFUSALS = ["name_unknown", "in_use", "unsupported", "failed"] as const;
export const SANDBOX_COMMAND_OUTCOMES = ["applied", "refused"] as const;

/** The sandbox id pattern the VM helper accepts. The same text as `SANDBOX_NAME_PATTERN` in messages.ts (which imports this file, so it cannot be imported here); a test holds the two together. */
export const SANDBOX_COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NONCE = z.string().uuid();
/** The base shape. `name` is required for every kind but `reap_sandboxes`, and never present on that one. */
export const SandboxCommand = z
  .object({
    purpose: z.literal(SANDBOX_COMMAND_PURPOSE),
    runner_id: z.string().uuid(),
    kind: z.enum(SANDBOX_COMMAND_KINDS),
    name: z.string().regex(SANDBOX_COMMAND_NAME_PATTERN).optional(),
    nonce: NONCE,
    exp: z.string().datetime(),
  })
  .strict()
  .superRefine((cmd, ctx) => {
    if ((cmd.kind === "reap_sandboxes") !== (cmd.name === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a name goes with stop and delete, and with nothing else", path: ["name"] });
  });
export type SandboxCommand = z.infer<typeof SandboxCommand>;

/** A command with its signature over `canonicalJson(command)`; `key_id` only picks which trusted key to check it with. */
export const SignedSandboxCommand = z.object({ command: SandboxCommand, key_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type SignedSandboxCommand = z.infer<typeof SignedSandboxCommand>;

/** One ack, riding on the next claim: what became of the command with this nonce. A refusal names its reason; an applied one names none. */
export const SandboxCommandAck = z
  .object({ nonce: NONCE, outcome: z.enum(SANDBOX_COMMAND_OUTCOMES), refusal: z.enum(SANDBOX_COMMAND_REFUSALS).optional() })
  .strict()
  .superRefine((ack, ctx) => {
    if ((ack.outcome === "refused") !== (ack.refusal !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a refused ack names its reason and an applied one names none", path: ["refusal"] });
  });
export type SandboxCommandAck = z.infer<typeof SandboxCommandAck>;
export const SandboxCommandAcks = z.array(SandboxCommandAck).max(SANDBOX_COMMANDS_PER_CLAIM * 4);
export const SignedSandboxCommands = z.array(SignedSandboxCommand).max(SANDBOX_COMMANDS_PER_CLAIM);

/** Signs `command` with the cloud's signing key. `key_id` must name that key. */
export function signSandboxCommand(commandToSign: SandboxCommand, keyId: string, privateKey: KeyObject): SignedSandboxCommand {
  const parsed = SandboxCommand.parse(commandToSign);
  return SignedSandboxCommand.parse({ command: parsed, key_id: keyId, signature: sign(null, Buffer.from(canonicalJson(parsed), "utf8"), privateKey).toString("base64url") });
}

/**
 * Verifies a signed command for the runner `runnerId` and returns it. Throws `JobSignatureError` and nothing else: `bad_signature` for any change to the signed
 * bytes or a command signed for another runner, `expired` once `exp` has passed or when it lies further ahead than a command may live.
 */
export function verifySandboxCommand(signed: unknown, keyring: JobKeyring, runnerId: string, now: Date = new Date()): SandboxCommand {
  try {
    if (typeof signed !== "object" || signed === null || Array.isArray(signed)) throw new JobSignatureError("malformed", "the signed command is not an object");
    const record = signed as Record<string, unknown>;
    if (record["signature"] === undefined || record["signature"] === null || record["signature"] === "") throw new JobSignatureError("missing_signature", "the command carries no signature");
    const parsed = SignedSandboxCommand.safeParse(signed);
    if (!parsed.success) throw new JobSignatureError("malformed", "the command does not match the command schema");
    const { command: cmd, key_id, signature } = parsed.data;
    const entry = Object.hasOwn(keyring, key_id) ? keyring[key_id] : undefined;
    if (entry === undefined) throw new JobSignatureError("unknown_key_id", "the command names a key this runner does not trust");
    const publicKey = typeof (entry as KeyObject).export === "function" ? (entry as KeyObject) : createPublicKey({ key: entry as { kty: "OKP"; crv: "Ed25519"; x: string }, format: "jwk" });
    if (!verify(null, Buffer.from(canonicalJson(cmd), "utf8"), publicKey, Buffer.from(signature, "base64url"))) throw new JobSignatureError("bad_signature", "the signature does not match the command");
    if (cmd.runner_id.toLowerCase() !== runnerId.toLowerCase()) throw new JobSignatureError("bad_signature", "the command was signed for another runner");
    const exp = Date.parse(cmd.exp);
    if (exp <= now.getTime()) throw new JobSignatureError("expired", "the command has expired");
    if (exp > now.getTime() + SANDBOX_COMMAND_MAX_LIFE_S * 1000 + 60_000) throw new JobSignatureError("expired", "the command lives longer than a command may");
    return cmd;
  } catch (error) {
    if (error instanceof JobSignatureError) throw error;
    throw new JobSignatureError("malformed", "the signed command could not be checked");
  }
}
