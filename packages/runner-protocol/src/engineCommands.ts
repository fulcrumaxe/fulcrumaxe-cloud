/**
 * The cloud-to-runner side of the engine bridge: signed commands, the pull and ack messages, and the decide request an engine hook sends before it spawns or merges.
 * A command is signed with the job signer's key and `key_id` scheme, over `canonicalJson`. The signature binds the command to one runner and one repo (`runner_id`, `repo_gh_id`) and to a
 * short life (`expires_at` at most 600 s after `issued_at`); the runner checks both before it writes anything to the engine.
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { BRIDGE_ENABLE_MIN_PROTOCOL, WATCH_MIN_PROTOCOL } from "./messages.js";
import { AgentId, ASK_ID_PATTERN, SHA40_PATTERN } from "./engineEvents.js";
import { canonicalJson, JobSignatureError, type JobKeyring } from "./jobSignature.js";

const safeInt = z.number().int().safe();
const ghNumber = z.number().int().min(1).max(2_147_483_647);

/** Dial classes a person may set from the cloud. `sandbox.modify`, `methodology.change`, `external.system`, `intent.generate` and `cost.spend` can never be set from here. */
export const SETTABLE_DIAL_CLASSES = ["docs.write", "tests.add", "deps.bump", "agent.spawn", "merge.standard", "merge.fast-path", "memory.write", "archive.move"] as const;
export const SPAWNABLE_ROLES = ["executor", "code-reviewer", "security-reviewer", "acceptance-tester", "browser-tester", "project-manager", "technical-architect", "product-owner", "cost-analyst", "performance-expert", "security-expert"] as const;
export const ENGINE_COMMAND_KINDS = ["start_day", "pause_loop", "resume_loop", "answer_ask", "set_dial", "request_spawn", "stop_agent", "watch", "bridge_enable", "bridge_disable"] as const;
/** D#845 ON-BR-2: the two kinds addressed to a runner (never to a repo's engine session) that turn the bridge on or off for a repo. The runner handles them itself; nothing reaches the engine's inbox. */
export const BRIDGE_COMMAND_KINDS = ["bridge_enable", "bridge_disable"] as const;
/** The codes a runner gives when it will not enable a repo, beyond the ones every command has. The first two are also the `result`s `not_found` and `ambiguous`. */
export const BRIDGE_REFUSALS = [
  "checkout_not_found", "checkout_ambiguous", "checkout_layout_unexpected", "checkout_incomplete", "checkout_unsafe", "checkout_mismatch", "repo_root_invalid", "repo_not_paired",
  "engine_version_unusable", "state_dir_missing", "state_dir_unreadable", "state_dir_shared", "state_dir_reserved", "state_dir_unchecked", "too_many_repos", "settings_damaged", "bridge_failed",
] as const;
export type BridgeRefusal = (typeof BRIDGE_REFUSALS)[number];
/** What an enable answers with, beside its outcome. `connected` and `already_connected` are applied; the other three are refused. */
export const BRIDGE_RESULTS = ["connected", "not_found", "ambiguous", "refused", "already_connected"] as const;
export const ENGINE_ASK_CHOICES = ["approve", "decline", "defer"] as const;
export const COMMAND_REFUSALS = ["signature_invalid", "wrong_runner", "wrong_repo", "expired", "seq_not_increasing", "halted", "operate_off", "host_not_running", "unknown_ask", "unknown_agent", "ceiling", "already_answered", ...BRIDGE_REFUSALS] as const;
export const ENGINE_COMMAND_OUTCOMES = ["applied", "refused", "expired", "not_confirmed"] as const;
/** The longest a command lives, in seconds. */
export const ENGINE_COMMAND_MAX_LIFE_S = 600;
/** How far ahead of the verifier's clock a command's `issued_at` may be, in seconds. A slow runner clock would otherwise stretch the 600 s life by the whole lag. */
export const MAX_CLOCK_SKEW_S = 60;
/** Signed inside every command so a signature made over a job (or anything else the key signs) can never verify as a command. */
export const ENGINE_COMMAND_PURPOSE = "engine_command_v1" as const;
export const ENGINE_NOTE_MAX = 500;
export type EngineCommandKind = (typeof ENGINE_COMMAND_KINDS)[number];

export const SettableDialClass = z.enum(SETTABLE_DIAL_CLASSES);
export const SpawnableRole = z.enum(SPAWNABLE_ROLES);
export const CommandRefusal = z.enum(COMMAND_REFUSALS);
/** An optional note from an owner or admin. No C0 or C1 control character (so no newline or tab), no line or paragraph separator, no unpaired surrogate, no bidirectional mark, embedding, override or isolate, and no format character at all (zero-width, byte order mark, tag characters). */
const NOTE_REFUSED = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]|\p{Cs}|\p{Cf}/u;
export const EngineNote = z.string().max(ENGINE_NOTE_MAX).refine((note) => !NOTE_REFUSED.test(note), { message: "the note holds a control, bidirectional or invisible character" });

/**
 * An absolute folder on the person's machine, as the cloud carries it (D#845 ON-BR-2): at most 1,024 characters, a `/` first, no `..` part, and no control, bidirectional or invisible character.
 * It is a request, never a fact: the runner checks the folder itself (a real directory, a clone of the repo) before it uses it.
 */
const ROOT_REFUSED = NOTE_REFUSED;
export const REPO_ROOT_MAX = 1024;
export const RepoRoot = z.string().min(2).max(REPO_ROOT_MAX).refine((p) => p.startsWith("/") && !ROOT_REFUSED.test(p) && !p.split("/").includes(".."), { message: "a folder is absolute, with no .. part and no control or bidirectional character" });
/** The last two parts of a folder, `parent/name`: the most of a path a screen, an ack or an audit row may hold. */
export const bridgeRootTail = (root: string): string => root.split("/").filter((part) => part !== "").slice(-2).join("/");
/** What `bridgeRootTail` returns: one or two parts, none a `..`, no control or bidirectional character. */
export const RootTail = z.string().min(1).max(512).refine((t) => !ROOT_REFUSED.test(t) && !t.startsWith("/") && t.split("/").length <= 2 && t.split("/").every((part) => part !== "" && part !== ".." && part !== "."), { message: "a root tail is one or two plain folder names" });

const strict = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
const NoArgs = strict({});
const BASE = {
  v: z.literal(1),
  purpose: z.literal(ENGINE_COMMAND_PURPOSE),
  command_id: z.string().uuid(),
  command_seq: safeInt.min(1),
  runner_id: z.string().uuid(),
  repo_gh_id: safeInt.min(1),
  issued_by: z.string().uuid(),
  issued_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  halt_epoch: z.number().int().min(0).max(2_147_483_647),
};
const command = <K extends EngineCommandKind, A extends z.ZodTypeAny>(name: K, args: A) => strict({ ...BASE, kind: z.literal(name), args });

/** One command. `args` belongs to its `kind` and nothing else's. */
export const EngineCommand = z
  .discriminatedUnion("kind", [
    command("start_day", NoArgs),
    command("pause_loop", NoArgs),
    command("resume_loop", NoArgs),
    command("answer_ask", strict({ ask_id: z.string().regex(ASK_ID_PATTERN), choice: z.enum(ENGINE_ASK_CHOICES), note: EngineNote.optional() })),
    command("set_dial", strict({ dial_class: SettableDialClass, level: z.number().int().min(1).max(5), ttl: z.enum(["for_today", "none"]) })),
    command("request_spawn", strict({ role: SpawnableRole, discussion: ghNumber })),
    command("stop_agent", strict({ agent_id: AgentId })),
    // D#845 ON-24a: `until` is the end of the watch, `before` the ingest `seq` the reader asks the history before. Whether `before` is at or under the repo's high-water seq is the cloud's check (`watchBeforeWithinHighWater`).
    command("watch", strict({ until: z.string().datetime(), before: safeInt.min(0).optional() })),
    // D#845 ON-BR-2: runner-targeted. `repo_root` is a folder the person picked from what that runner itself offered; the runner still checks it against the repo's own remote.
    command("bridge_enable", strict({ repo_root: RepoRoot.optional() })),
    command("bridge_disable", NoArgs),
  ])
  .superRefine((cmd, ctx) => {
    const life = Date.parse(cmd.expires_at) - Date.parse(cmd.issued_at);
    if (!(life > 0 && life <= ENGINE_COMMAND_MAX_LIFE_S * 1000)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a command lives 1 ms to 600 s", path: ["expires_at"] });
    if (cmd.kind === "watch") {
      const ahead = Date.parse(cmd.args.until) - Date.parse(cmd.issued_at);
      if (!(ahead > 0 && ahead <= ENGINE_COMMAND_MAX_LIFE_S * 1000)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a watch ends 1 ms to 600 s after it is issued", path: ["args", "until"] });
    }
  });
export type EngineCommand = z.infer<typeof EngineCommand>;
export type EngineCommandOf<K extends EngineCommandKind> = Extract<EngineCommand, { kind: K }>;

/** The lowest hello protocol a command kind may be sent to; a kind not listed here predates the bridge's versioning and goes to every bridge runner. */
export const ENGINE_COMMAND_MIN_PROTOCOL: Partial<Record<EngineCommandKind, number>> = { watch: WATCH_MIN_PROTOCOL, bridge_enable: BRIDGE_ENABLE_MIN_PROTOCOL, bridge_disable: BRIDGE_ENABLE_MIN_PROTOCOL };
/** True for a kind that goes to a runner, not to the engine session of a repo. */
export const isBridgeCommandKind = (kind: string): kind is (typeof BRIDGE_COMMAND_KINDS)[number] => (BRIDGE_COMMAND_KINDS as readonly string[]).includes(kind);
/** True when a runner whose hello said `helloProtocol` may be sent a `kind` command. */
export const commandSendableTo = (kind: EngineCommandKind, helloProtocol: number): boolean => helloProtocol >= (ENGINE_COMMAND_MIN_PROTOCOL[kind] ?? 0);
/** True when a `watch` command's `until` is still ahead of the checker's own clock and no more than 600 s ahead of it, whatever the issuer's clock said. */
export const watchUntilAcceptable = (cmd: { args: { until: string } }, now: Date): boolean => {
  const ahead = Date.parse(cmd.args.until) - now.getTime();
  return ahead > 0 && ahead <= ENGINE_COMMAND_MAX_LIFE_S * 1000;
};
/** True when a `watch` cursor is a seq the repo has already reached. */
export const watchBeforeWithinHighWater = (before: number, highWaterSeq: number): boolean => Number.isSafeInteger(before) && before >= 0 && before <= highWaterSeq;

/** A command with its signature. The signature is over `canonicalJson(command)`; `key_id` only picks which trusted key to check it with. */
export const SignedEngineCommand = z.object({ command: EngineCommand, key_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type SignedEngineCommand = z.infer<typeof SignedEngineCommand>;

/** Signs `command` with the cloud's signing key. `key_id` must name that key. */
export function signEngineCommand(commandToSign: EngineCommand, keyId: string, privateKey: KeyObject): SignedEngineCommand {
  const parsed = EngineCommand.parse(commandToSign);
  return SignedEngineCommand.parse({ command: parsed, key_id: keyId, signature: sign(null, Buffer.from(canonicalJson(parsed), "utf8"), privateKey).toString("base64url") });
}

/** Verifies a signed command and returns it. Throws `JobSignatureError` and nothing else (`bad_signature` for any change to the signed bytes, `expired` once `expires_at` has passed or when `issued_at` is more than `MAX_CLOCK_SKEW_S` ahead of `now`). */
export function verifyEngineCommand(signed: unknown, keyring: JobKeyring, now: Date = new Date()): EngineCommand {
  try {
    if (typeof signed !== "object" || signed === null || Array.isArray(signed)) throw new JobSignatureError("malformed", "the signed command is not an object");
    const record = signed as Record<string, unknown>;
    if (record["signature"] === undefined || record["signature"] === null || record["signature"] === "") throw new JobSignatureError("missing_signature", "the command carries no signature");
    const parsed = SignedEngineCommand.safeParse(signed);
    if (!parsed.success) throw new JobSignatureError("malformed", "the command does not match the command schema");
    const { command: cmd, key_id, signature } = parsed.data;
    const entry = Object.hasOwn(keyring, key_id) ? keyring[key_id] : undefined;
    if (entry === undefined) throw new JobSignatureError("unknown_key_id", "the command names a key this runner does not trust");
    const publicKey = typeof (entry as KeyObject).export === "function" ? (entry as KeyObject) : createPublicKey({ key: entry as { kty: "OKP"; crv: "Ed25519"; x: string }, format: "jwk" });
    if (!verify(null, Buffer.from(canonicalJson(cmd), "utf8"), publicKey, Buffer.from(signature, "base64url"))) throw new JobSignatureError("bad_signature", "the signature does not match the command");
    if (Date.parse(cmd.expires_at) <= now.getTime()) throw new JobSignatureError("expired", "the command has expired");
    if (Date.parse(cmd.issued_at) > now.getTime() + MAX_CLOCK_SKEW_S * 1000) throw new JobSignatureError("expired", "the command was issued in the future");
    return cmd;
  } catch (error) {
    if (error instanceof JobSignatureError) throw error;
    throw new JobSignatureError("malformed", "the signed command could not be checked");
  }
}

/** The per-repo controls a pull answers with. */
export const EngineControl = strict({ repo_gh_id: safeInt.min(1), halt_epoch: z.number().int().min(0).max(2_147_483_647), halted: z.boolean(), operate_enabled: z.boolean() });
const RepoKey = /^[1-9][0-9]{0,15}$/;

/** One repo a runner says it bridges (D#845 ON-BR-2): the GitHub id and, once the runner has settled on one, the engine checkout it chose. A runner at `BRIDGE_ENABLE_MIN_PROTOCOL` or later sends the list on every pull. */
export const BridgedRepoReport = strict({ repo_gh_id: safeInt.min(1), root: RepoRoot.optional() });
export type BridgedRepoReport = z.infer<typeof BridgedRepoReport>;
const pullBase = { repo_gh_ids: z.array(safeInt.min(1)).min(1).max(10), after_seq: z.record(z.string().regex(RepoKey), safeInt.min(0)) };
const pullRefine = (body: { repo_gh_ids: number[]; after_seq: Record<string, number>; bridged?: BridgedRepoReport[] | undefined }, ctx: z.RefinementCtx): void => {
  if (new Set(body.repo_gh_ids).size !== body.repo_gh_ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "repeated repo", path: ["repo_gh_ids"] });
  const wanted = new Set(body.repo_gh_ids.map(String));
  if (Object.keys(body.after_seq).some((key) => !wanted.has(key))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "after_seq names a repo that was not asked for", path: ["after_seq"] });
  if (body.bridged !== undefined && new Set(body.bridged.map((b) => b.repo_gh_id)).size !== body.bridged.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "repeated repo", path: ["bridged"] });
};
/**
 * POST /api/runner/engine/commands/pull. `after_seq` names only repos in `repo_gh_ids`. `bridged` and `bridge_commands` exist only at `BRIDGE_ENABLE_MIN_PROTOCOL`: `bridged` is every repo the
 * runner has enabled (with its checkout, when it chose one), and `bridge_commands` asks for the runner's own `bridge_enable` and `bridge_disable` commands for any repo it is paired with, whether or not it bridges it yet.
 */
export const EngineCommandsPullRequest = strict({ ...pullBase, bridged: z.array(BridgedRepoReport).max(10).optional(), bridge_commands: z.literal(true).optional() }).superRefine(pullRefine);
/** The pull request below `BRIDGE_ENABLE_MIN_PROTOCOL`: the strict parse of the older shape, so a runner whose hello is older and that sends the new keys is refused. */
const EngineCommandsPullRequestLegacy = strict(pullBase).superRefine(pullRefine);
/** The schema a pull from a runner whose hello said `helloProtocol` is read with. */
export const engineCommandsPullSchemaFor = (helloProtocol: number): typeof EngineCommandsPullRequest | typeof EngineCommandsPullRequestLegacy => (helloProtocol >= BRIDGE_ENABLE_MIN_PROTOCOL ? EngineCommandsPullRequest : EngineCommandsPullRequestLegacy);
export type EngineCommandsPullRequest = z.infer<typeof EngineCommandsPullRequest>;
/** One repo the runner may bridge, with its GitHub id and cloud-side name (`owner/name`). `enable --repo owner/name` resolves against these and refuses anything not listed. */
export const EngineAllowedRepo = strict({ repo_gh_id: safeInt.min(1), full_name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/) });
export type EngineAllowedRepo = z.infer<typeof EngineAllowedRepo>;
/** `allowed_repos` is every repo the runner is paired with, whatever the request named (at most 100): a runner with none enabled yet can ask with any one id and read this. */
export const EngineCommandsPullReply = strict({ commands: z.array(SignedEngineCommand).max(20), controls: z.array(EngineControl).max(10), allowed_repos: z.array(EngineAllowedRepo).max(100).optional() });
export type EngineCommandsPullReply = z.infer<typeof EngineCommandsPullReply>;

/**
 * POST /api/runner/engine/commands/:id/ack. A refusal reason goes with `refused` and with nothing that was applied. A `bridge_enable` ack also carries a `result` (D#845 ON-BR-2):
 * `connected` and `already_connected` are applied, `connected` with the chosen folder's last two parts; `not_found`, `ambiguous` and `refused` are refused, `ambiguous` with the folders (at most 10)
 * the person may pick from. `not_found` may list the copies it skipped as unsafe in `skipped` (information only, never pickable, ruling 9), and `refused` with `checkout_incomplete` carries the one it found in `candidates`; a candidate is offered for a pick, never adopted.
 */
export const EngineCommandAck = strict({
  outcome: z.enum(ENGINE_COMMAND_OUTCOMES),
  refusal: CommandRefusal.optional(),
  result: z.enum(BRIDGE_RESULTS).optional(),
  root_tail: RootTail.optional(),
  candidates: z.array(RepoRoot).min(1).max(10).optional(),
  /** Copies the scan skipped as unsafe (others can write in them): shown for information, never pickable (ruling 9). Only with `not_found`. */
  skipped: z.array(RepoRoot).min(1).max(10).optional(),
}).superRefine((ack, ctx) => {
  const bad = (message: string, at: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [at] });
  if ((ack.outcome === "refused" && ack.refusal === undefined) || (ack.outcome === "applied" && ack.refusal !== undefined)) bad("a refused ack names its reason and an applied one names none", "refusal");
  if (ack.result === undefined) {
    if (ack.root_tail !== undefined || ack.candidates !== undefined || ack.skipped !== undefined) bad("a folder goes with a result", ack.root_tail !== undefined ? "root_tail" : ack.candidates !== undefined ? "candidates" : "skipped");
    return;
  }
  const applied = ack.result === "connected" || ack.result === "already_connected";
  if ((ack.outcome === "applied") !== applied) bad("connected and already_connected are applied, the other results are refused", "outcome");
  if (ack.result === "connected" && ack.root_tail === undefined) bad("connected names the folder", "root_tail");
  if (!applied && ack.root_tail !== undefined) bad("only a connected repo has a folder", "root_tail");
  if (applied && ack.candidates !== undefined) bad("a connected repo offers no folders", "candidates");
  if (ack.result === "not_found" && (ack.refusal !== "checkout_not_found" || ack.candidates !== undefined)) bad("not_found is refused checkout_not_found and offers nothing to pick", "refusal");
  if (ack.result !== "not_found" && ack.skipped !== undefined) bad("only not_found lists skipped copies", "skipped");
  if (ack.result === "ambiguous" && (ack.refusal !== "checkout_ambiguous" || (ack.candidates?.length ?? 0) < 2)) bad("ambiguous is refused checkout_ambiguous with at least two folders", "candidates");
  if (ack.result === "refused" && (ack.refusal === undefined || !(BRIDGE_REFUSALS as readonly string[]).includes(ack.refusal) || ack.refusal === "checkout_not_found" || ack.refusal === "checkout_ambiguous")) bad("a refused result names one of the bridge refusals", "refusal");
});
export type EngineCommandAck = z.infer<typeof EngineCommandAck>;

export const ENGINE_DECISION_TYPES = ["engine_spawn", "engine_merge", "engine_spec_ready"] as const;
export const ENGINE_SPEC_TAGS = ["feature", "critical", "small", "bug", "doc", "process", "other"] as const;
/** POST /api/runner/engine/decide. `tag` is the Discussion title's prefix as the engine read it; a missing tag or `other` is asked about at every preset. */
export const EngineDecideRequest = strict({
  repo_gh_id: safeInt.min(1),
  decision_type: z.enum(ENGINE_DECISION_TYPES),
  request_key: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
  subject: strict({ discussion: ghNumber.optional(), pr: ghNumber.optional(), role: z.enum([...SPAWNABLE_ROLES, "other"]).optional(), head_sha: z.string().regex(SHA40_PATTERN).optional(), tag: z.enum(ENGINE_SPEC_TAGS).optional() }),
  command_id: z.string().uuid().optional(),
});
export type EngineDecideRequest = z.infer<typeof EngineDecideRequest>;
export const EngineDecideReply = strict({ disposition: z.enum(["act", "announce", "ask"]), receipt_id: z.string().uuid().nullable(), ask_id: z.string().uuid().nullable(), answered: z.enum(["approve", "decline"]).nullable(), halted: z.boolean() });
export type EngineDecideReply = z.infer<typeof EngineDecideReply>;
