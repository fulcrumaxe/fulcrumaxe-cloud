/**
 * D#845 ON-1: machine commands, the signed commands about the machine itself rather than one repo's engine. Today there are two, for the Claude sign-in link: `claude_login_start` and
 * `claude_login_code`. They travel on the engine command channel's signing rules (the job signer's key and `key_id`, `canonicalJson`, a life of at most 600 s, the same clock-skew bound)
 * but have no `repo_gh_id`, no `command_seq` and no `halt_epoch`: they are not about a repo, and one is only ever acted on once because its `request_id` names a single login request.
 * Their own purpose string keeps a signature made over any other command, job or sandbox command from verifying as one.
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { ENGINE_COMMAND_MAX_LIFE_S, MAX_CLOCK_SKEW_S } from "./engineCommands.js";
import { canonicalJson, JobSignatureError, type JobKeyring } from "./jobSignature.js";

export const MACHINE_COMMAND_PURPOSE = "machine_command_v1" as const;
export const MACHINE_COMMAND_KINDS = ["claude_login_start", "claude_login_code"] as const;
export type MachineCommandKind = (typeof MACHINE_COMMAND_KINDS)[number];

/**
 * The one URL a Claude sign-in report may carry: https, on claude.ai or console.anthropic.com, at most 2,000 characters in all, a path from a short safe set (so no space, no control character,
 * no quote, no angle bracket and no `javascript:`), and nothing after it. The pattern is the spec's, anchored.
 */
export const CLAUDE_AUTH_URL_PATTERN = /^https:\/\/(claude\.ai|console\.anthropic\.com)\/[A-Za-z0-9/_\-.?=&%]{1,2000}$/;
export const ClaudeAuthUrl = z.string().max(2000).regex(CLAUDE_AUTH_URL_PATTERN);

const strict = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
const BASE = {
  v: z.literal(1),
  purpose: z.literal(MACHINE_COMMAND_PURPOSE),
  command_id: z.string().uuid(),
  runner_id: z.string().uuid(),
  issued_by: z.string().uuid(),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
};
const command = <K extends MachineCommandKind>(kind: K) => strict({ ...BASE, kind: z.literal(kind), args: strict({ request_id: z.string().uuid() }) });

export const MachineCommand = z.discriminatedUnion("kind", [command("claude_login_start"), command("claude_login_code")]).superRefine((cmd, ctx) => {
  const life = Date.parse(cmd.expires_at) - Date.parse(cmd.issued_at);
  if (!(life > 0 && life <= ENGINE_COMMAND_MAX_LIFE_S * 1000)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a command lives 1 ms to 600 s", path: ["expires_at"] });
});
export type MachineCommand = z.infer<typeof MachineCommand>;

export const SignedMachineCommand = strict({ command: MachineCommand, key_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export type SignedMachineCommand = z.infer<typeof SignedMachineCommand>;

/** Signs `commandToSign` with the cloud's signing key. `key_id` must name that key. */
export function signMachineCommand(commandToSign: MachineCommand, keyId: string, privateKey: KeyObject): SignedMachineCommand {
  const parsed = MachineCommand.parse(commandToSign);
  return SignedMachineCommand.parse({ command: parsed, key_id: keyId, signature: sign(null, Buffer.from(canonicalJson(parsed), "utf8"), privateKey).toString("base64url") });
}

/** Verifies a signed machine command for the runner `runnerId` and returns it. Throws `JobSignatureError` and nothing else (`bad_signature` for a changed byte or another runner, `expired` past `expires_at` or when `issued_at` is more than `MAX_CLOCK_SKEW_S` ahead). */
export function verifyMachineCommand(signed: unknown, keyring: JobKeyring, runnerId: string, now: Date = new Date()): MachineCommand {
  try {
    if (typeof signed !== "object" || signed === null || Array.isArray(signed)) throw new JobSignatureError("malformed", "the signed command is not an object");
    const record = signed as Record<string, unknown>;
    if (record["signature"] === undefined || record["signature"] === null || record["signature"] === "") throw new JobSignatureError("missing_signature", "the command carries no signature");
    const parsed = SignedMachineCommand.safeParse(signed);
    if (!parsed.success) throw new JobSignatureError("malformed", "the command does not match the machine command schema");
    const { command: cmd, key_id, signature } = parsed.data;
    const entry = Object.hasOwn(keyring, key_id) ? keyring[key_id] : undefined;
    if (entry === undefined) throw new JobSignatureError("unknown_key_id", "the command names a key this runner does not trust");
    const publicKey = typeof (entry as KeyObject).export === "function" ? (entry as KeyObject) : createPublicKey({ key: entry as { kty: "OKP"; crv: "Ed25519"; x: string }, format: "jwk" });
    if (!verify(null, Buffer.from(canonicalJson(cmd), "utf8"), publicKey, Buffer.from(signature, "base64url"))) throw new JobSignatureError("bad_signature", "the signature does not match the command");
    if (cmd.runner_id.toLowerCase() !== runnerId.toLowerCase()) throw new JobSignatureError("bad_signature", "the command was signed for another runner");
    if (Date.parse(cmd.expires_at) <= now.getTime()) throw new JobSignatureError("expired", "the command has expired");
    if (Date.parse(cmd.issued_at) > now.getTime() + MAX_CLOCK_SKEW_S * 1000) throw new JobSignatureError("expired", "the command was issued in the future");
    return cmd;
  } catch (error) {
    if (error instanceof JobSignatureError) throw error;
    throw new JobSignatureError("malformed", "the signed command could not be checked");
  }
}
