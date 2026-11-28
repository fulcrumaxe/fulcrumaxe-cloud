/**
 * D#845 ON-1: machine commands, the signed commands about the machine itself rather than one repo's engine. There are three, for the Claude sign-in link: `claude_login_start`,
 * `claude_login_code` and (MC-8a) `claude_logout`, which names no request. They travel on the engine command channel's signing rules (the job signer's key and `key_id`, `canonicalJson`, a life of at most 600 s, the same clock-skew bound)
 * but have no `repo_gh_id`, no `command_seq` and no `halt_epoch`: they are not about a repo, and one is only ever acted on once because its `request_id` names a single login request.
 * Their own purpose string keeps a signature made over any other command, job or sandbox command from verifying as one.
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalJson, JobSignatureError, type JobKeyring } from "./jobSignature.js";

export const MACHINE_COMMAND_PURPOSE = "machine_command_v1" as const;
/** The same bounds as the engine commands' (engineCommands.ts, which cannot be imported here: it imports messages.ts, which needs this file; a test holds the two together). */
export const MACHINE_COMMAND_MAX_LIFE_S = 600;
export const MACHINE_COMMAND_MAX_CLOCK_SKEW_S = 60;
export const MACHINE_COMMAND_KINDS = ["claude_login_start", "claude_login_code", "claude_logout", "gh_login_start", "gh_logout"] as const;
export type MachineCommandKind = (typeof MACHINE_COMMAND_KINDS)[number];

/**
 * The one URL a Claude sign-in report may carry: https, on claude.com, claude.ai or console.anthropic.com, at most 2,000 characters in all, the one path the real CLI prints (`/cai/oauth/authorize?`, Ruling 52.10) followed by a query from a short safe set (so no space, no control
 * character, no quote, no angle bracket and no `javascript:`; `+` is in the set because the real URL's scope parameter uses it, Ruling 52.10), and nothing after it. The host stays anchored.
 */
export const CLAUDE_AUTH_URL_PATTERN = /^https:\/\/(claude\.com|claude\.ai|console\.anthropic\.com)\/cai\/oauth\/authorize\?[A-Za-z0-9/_\-.?=&%+]{1,2000}$/;
/** The one origin a sign-in link may point at (the host the real CLI prints). The report route checks the parsed origin against it as well as the pattern. */
export const CLAUDE_AUTH_ORIGIN = "https://claude.com" as const;
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

/** `claude_logout` names no request: it signs the machine out of Claude, whatever request signed it in. */
const logout = (kind: "claude_logout" | "gh_logout") => strict({ ...BASE, kind: z.literal(kind), args: strict({}) });

export const MachineCommand = z.discriminatedUnion("kind", [command("claude_login_start"), command("claude_login_code"), logout("claude_logout"), command("gh_login_start"), logout("gh_logout")]).superRefine((cmd, ctx) => {
  const life = Date.parse(cmd.expires_at) - Date.parse(cmd.issued_at);
  if (!(life > 0 && life <= MACHINE_COMMAND_MAX_LIFE_S * 1000)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a command lives 1 ms to 600 s", path: ["expires_at"] });
});
export type MachineCommand = z.infer<typeof MachineCommand>;

export const SignedMachineCommand = strict({ command: MachineCommand, key_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export type SignedMachineCommand = z.infer<typeof SignedMachineCommand>;

/** Signs `commandToSign` with the cloud's signing key. `key_id` must name that key. */
export function signMachineCommand(commandToSign: MachineCommand, keyId: string, privateKey: KeyObject): SignedMachineCommand {
  const parsed = MachineCommand.parse(commandToSign);
  return SignedMachineCommand.parse({ command: parsed, key_id: keyId, signature: sign(null, Buffer.from(canonicalJson(parsed), "utf8"), privateKey).toString("base64url") });
}

/** How many machine commands one claim reply carries, and how many acks one claim carries. */
export const MACHINE_COMMANDS_PER_CLAIM = 5;
export const MACHINE_COMMAND_REFUSALS = ["unsupported", "failed", "busy"] as const;
/** One ack, riding on the next claim: what became of the command with this id. A refused ack names its reason; an applied one names none. */
export const MachineCommandAck = strict({ command_id: z.string().uuid(), outcome: z.enum(["applied", "refused"]), refusal: z.enum(MACHINE_COMMAND_REFUSALS).optional() }).superRefine((ack, ctx) => {
  if ((ack.outcome === "refused") !== (ack.refusal !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a refused ack names its reason and an applied one names none", path: ["refusal"] });
});
export type MachineCommandAck = z.infer<typeof MachineCommandAck>;
export const MachineCommandAcks = z.array(MachineCommandAck).max(MACHINE_COMMANDS_PER_CLAIM * 4);
export const SignedMachineCommands = z.array(SignedMachineCommand).max(MACHINE_COMMANDS_PER_CLAIM);

/** The signed routes of one sign-in request: the runner reports the link and the outcome, and takes the person's code once. */
export const machineLoginReportPath = (requestId: string): string => `/api/runner/machine-login/${requestId}/report`;
export const machineLoginCodePath = (requestId: string): string => `/api/runner/machine-login/${requestId}/code`;
/** `auth_url` goes with `awaiting_code` and with nothing else; `failure_code` is a short word and only on `failed`. */
export const MachineLoginReport = strict({ state: z.enum(["awaiting_code", "done", "failed"]), auth_url: ClaudeAuthUrl.optional(), failure_code: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).optional() }).superRefine((r, ctx) => {
  if ((r.state === "awaiting_code") !== (r.auth_url !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "auth_url goes with awaiting_code and with nothing else", path: ["auth_url"] });
  if (r.failure_code !== undefined && r.state !== "failed") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "failure_code goes with failed only", path: ["failure_code"] });
});
export type MachineLoginReport = z.infer<typeof MachineLoginReport>;
/** What the person types: the one-time code the sign-in page shows. Letters, digits and a few separators, no space or control character. */
export const MachineLoginCode = z.string().regex(/^[A-Za-z0-9._~+/=#-]{1,512}$/);

/**
 * D#845 ON-19c: the GitHub sign-in relay. `gh auth login --web` prints a one-time code and the one device address; the runner relays exactly those two values and nothing else the CLI prints. The code is two groups of four
 * letters or digits (the 8 characters, as the real CLI printed `XXXX-XXXX` in the spike) and the address is the one URL, so a report that carries anything else is refused here, before it is stored.
 */
export const GH_DEVICE_URL = "https://github.com/login/device" as const;
export const GH_DEVICE_URL_PATTERN = /^https:\/\/github\.com\/login\/device$/;
export const GH_USER_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const ghLoginReportPath = (requestId: string): string => `/api/runner/machine-login/${requestId}/gh-report`;
/** The closed words a GitHub sign-in may fail with. `already_signed_in`: github.com already has an account on the machine (one account per machine keeps every sign-out unambiguous), so no second sign-in is started. `signout_failed`: the sign-out that undoes a sign-in the cloud no longer wants did not succeed. */
export const GH_LOGIN_FAILURE_CODES = ["unsupported_platform", "not_managed", "busy", "gh_missing", "start_failed", "already_signed_in", "bad_link", "no_link", "link_refused", "link_unsent", "login_failed", "timeout", "cancelled", "signout_failed"] as const;
export const GhLoginReport = strict({ state: z.enum(["awaiting_code", "done", "failed"]), device_url: z.string().regex(GH_DEVICE_URL_PATTERN).optional(), user_code: z.string().regex(GH_USER_CODE_PATTERN).optional(), failure_code: z.enum(GH_LOGIN_FAILURE_CODES).optional() }).superRefine((r, ctx) => {
  const both = r.device_url !== undefined && r.user_code !== undefined;
  const none = r.device_url === undefined && r.user_code === undefined;
  if (r.state === "awaiting_code" ? !both : !none) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "the address and the code go together, with awaiting_code only", path: ["device_url"] });
  if (r.failure_code !== undefined && r.state !== "failed") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "failure_code goes with failed only", path: ["failure_code"] });
});
export type GhLoginReport = z.infer<typeof GhLoginReport>;

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
    if (Date.parse(cmd.issued_at) > now.getTime() + MACHINE_COMMAND_MAX_CLOCK_SKEW_S * 1000) throw new JobSignatureError("expired", "the command was issued in the future");
    return cmd;
  } catch (error) {
    if (error instanceof JobSignatureError) throw error;
    throw new JobSignatureError("malformed", "the signed command could not be checked");
  }
}
