/**
 * The engine event family: what the engine running on a person's machine tells the cloud, as closed, free-text-free facts.
 * Every event is a strict object (`v`, `seq`, `ts`, `kind` and that kind's own fields). Nothing here carries a title, message, branch, path or prompt,
 * and nothing carries a figure the cloud computes (cost, totals, rates): the engine sends raw facts and the cloud's own spend and stats code does the arithmetic.
 */
import { z } from "zod";
import { CREDENTIAL_MODES, USAGE_TOKENS_MAX, WATCH_MIN_PROTOCOL } from "./messages.js";

const safeInt = z.number().int().safe();
/** GitHub issue, discussion and pull request numbers: positive and small enough for an integer column. */
const ghNumber = z.number().int().min(1).max(2_147_483_647);
/** Counts, ordinals and epochs. */
export const ENGINE_COUNT_MAX = 2_147_483_647;
const count = z.number().int().min(0).max(ENGINE_COUNT_MAX);
/** Longest duration an event may report, in seconds (31 days). */
export const ENGINE_DURATION_S_MAX = 2_678_400;
const usageTokens = safeInt.min(0).max(USAGE_TOKENS_MAX);
const seconds = z.number().int().min(0).max(ENGINE_DURATION_S_MAX);

export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SPAWN_ID_PATTERN = /^toolu_[A-Za-z0-9]{1,64}$/;
export const ASK_ID_PATTERN = /^[0-9a-f]{16}$/;
export const LINE_ID_PATTERN = /^[0-9a-f]{16}$/;
export const SHA40_PATTERN = /^[0-9a-f]{40}$/;
export const ROW_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
/** The shape of a model tier on a `usage_tick`: the same text as the CHECK on `machine_usage_daily.model_tier`. */
export const MODEL_TIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
export const ENGINE_VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
export const AgentId = z.string().regex(AGENT_ID_PATTERN);
export const SpawnId = z.string().regex(SPAWN_ID_PATTERN);
export const AskId = z.string().regex(ASK_ID_PATTERN);
export const LineId = z.string().regex(LINE_ID_PATTERN);
export const Sha40 = z.string().regex(SHA40_PATTERN);
export const RowKey = z.string().regex(ROW_KEY_PATTERN);
export const ModelId = z.string().regex(MODEL_ID_PATTERN);

/** The fifteen roles the engine names, lowercase. Any other agent is `other` (every kind that carries a role accepts it). */
export const ENGINE_ROLES = ["executor", "code-reviewer", "security-reviewer", "project-manager", "acceptance-tester", "browser-tester", "technical-architect", "product-owner", "cost-analyst", "performance-expert", "security-expert", "researcher", "mission-analyst", "docs-writer", "debater"] as const;
export const EngineRole = z.enum(ENGINE_ROLES);
export type EngineRole = z.infer<typeof EngineRole>;
const RoleOrOther = z.enum([...ENGINE_ROLES, "other"]);
const ActorRole = z.enum([...ENGINE_ROLES, "team-lead", "other"]);

export const ENGINE_ORIGINS = ["interactive", "cron", "host"] as const;
/** The roadmap's real closed status set. A row with any other status is left out by the emitter; the snapshot is still sent. */
export const ROADMAP_STATUSES = ["not_started", "in_progress", "done", "blocked", "deferred", "split", "removed", "superseded"] as const;
const Origin = z.enum(ENGINE_ORIGINS);
const HostReason = z.enum(["stopped_by_person", "halted", "crash_loop", "operate_off", "machine_shutdown"]).optional();
const TickKind = z.enum(["loop", "checkin", "start_day", "command", "reorient"]);
const TickOutcome = z.enum(["ok", "error", "interrupted"]).optional();
const BridgeReason = z.enum(["schema", "oversize", "redaction", "partial_line"]).optional();

/** The turn's or agent's own token totals, raw. All four are required when the object is present; an unreadable transcript omits the object, so the cloud shows "not recorded", never zero. */
export const EngineUsage = z.object({ input: safeInt.min(0).max(USAGE_TOKENS_MAX), output: safeInt.min(0).max(USAGE_TOKENS_MAX), cache_read: safeInt.min(0).max(USAGE_TOKENS_MAX), cache_write: safeInt.min(0).max(USAGE_TOKENS_MAX) }).strict();
export type EngineUsage = z.infer<typeof EngineUsage>;
const CredentialMode = z.enum(CREDENTIAL_MODES);

export const SLIM_AGE_S_MAX = 86_400;
export const SLIM_STATUS_REASONS = ["unwatched"] as const;
const SlimAge = z.number().int().min(0).max(SLIM_AGE_S_MAX).nullable();

const kind = <K extends string, S extends z.ZodRawShape>(name: K, shape: S) => z.object({ v: z.literal(1), engine_instance_id: z.string().uuid(), seq: safeInt.min(0), ts: z.string().datetime(), kind: z.literal(name), ...shape }).strict();

const HostEvent = (name: "host_started" | "host_stopped" | "host_heartbeat") => kind(name, { reason: HostReason });
const BridgeEvent = (name: "bridge_heartbeat" | "bridge_dropped") => kind(name, { count: count.optional(), reason: BridgeReason });
const TICK_TAIL = { tick_kind: TickKind, outcome: TickOutcome, duration_s: seconds.optional() };

const KIND_SCHEMAS = [
  kind("agent_started", { spawn_id: SpawnId, role: RoleOrOther, discussion: ghNumber.optional(), background: z.boolean(), isolation: z.enum(["worktree", "none"]), model: ModelId.optional() }),
  kind("agent_linked", { spawn_id: SpawnId, agent_id: AgentId }),
  kind("agent_stopped", { agent_id: AgentId, role: RoleOrOther, verdict: z.enum(["pass", "fail", "done", "blocked", "needs_fix", "unknown"]), discussion: ghNumber.optional(), pr: ghNumber.optional(), duration_s: seconds.optional(), model: ModelId.optional(), credential_mode: CredentialMode, usage: EngineUsage.optional() }),
  kind("spawn_blocked", { role: RoleOrOther, discussion: ghNumber.optional(), reason: z.enum(["circuit_breaker", "budget", "planned_prs", "no_spec", "halted", "cloud_denied", "cloud_unreachable", "other"]) }),
  kind("merge_lane", { pr: ghNumber, discussion: ghNumber.optional(), state: z.enum(["queued", "testing", "merged", "failed", "dequeued", "refused"]) }),
  kind("merged", { pr: ghNumber, discussion: ghNumber.optional(), closes: z.boolean() }),
  kind("gate_receipt", { pr: ghNumber, gate: z.enum(["gate1", "code_review", "security_review", "acceptance", "browser", "ci_full"]), result: z.enum(["pass", "fail", "error", "skipped"]), head_sha: Sha40 }),
  kind("team_log_line", { line_id: LineId, actor_role: ActorRole, category: z.enum(["activated", "starting", "spawning", "merged", "needs_boss", "blocked", "heartbeat", "other"]), discussion: ghNumber.optional(), pr: ghNumber.optional() }),
  kind("loop_tick", { origin: Origin, duration_s: seconds }),
  kind("checkin_tick", { name: RowKey, origin: Origin }),
  kind("engine_heartbeat", { origin: Origin, source_ages_s: z.object({ loop: seconds.optional(), team_log: seconds.optional(), plan: seconds.optional(), merge_queue: seconds.optional() }).strict().optional() }),
  kind("plan_snapshot", {
    snapshot_id: AgentId,
    chunk_index: z.number().int().min(0).max(99),
    chunk_count: z.number().int().min(1).max(100),
    plan_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    items: z.array(z.object({ discussion: ghNumber, ordinal: count, state: z.enum(["planned", "in_progress", "pr_open", "merged", "blocked", "dropped"]) }).strict()).max(300),
    roadmap: z.array(z.object({ row_key: RowKey.or(z.literal("")), discussion: ghNumber.optional(), status: z.enum(ROADMAP_STATUSES), planned_prs: count }).strict()).max(500),
  }),
  kind("ask_raised", { ask_id: AskId, ask_kind: z.enum(["owner_decision", "merge_blocked", "credential", "budget", "review_blocked", "other"]), source: z.enum(["team_log", "discussion_label", "issue_label"]), discussion: ghNumber.optional(), pr: ghNumber.optional() }),
  kind("ask_cleared", { ask_id: AskId, how: z.enum(["answered_cloud", "answered_github", "withdrawn", "expired"]) }),
  HostEvent("host_started"),
  HostEvent("host_stopped"),
  HostEvent("host_heartbeat"),
  kind("tick_started", TICK_TAIL),
  kind("tick_ended", { ...TICK_TAIL, model: ModelId.optional(), credential_mode: CredentialMode, usage: EngineUsage.optional() }),
  kind("compaction_detected", {}),
  kind("halt_applied", { halt_epoch: count, method: z.enum(["scope", "group_only"]), survivors: count }),
  BridgeEvent("bridge_heartbeat"),
  BridgeEvent("bridge_dropped"),
  // D#845 ON-1: raw token counts for one window of an engine session's model use, from the in-guest supervisor. The cloud prices it, never the engine. `model_tier` has the shape of `machine_usage_daily.model_tier`.
  // D#845 ON-24a: while nobody watches the repo the runner sends this in place of the three heartbeats, at most once a minute. `age_s` is whole seconds since that source was last seen, null for never.
  kind("slim_status", { sources: z.object({ bridge: SlimAge, host: SlimAge, engine: SlimAge }).strict(), reason: z.enum(SLIM_STATUS_REASONS) }),
  kind("usage_tick", { model_tier: z.string().regex(MODEL_TIER_PATTERN), input_tokens: usageTokens, output_tokens: usageTokens, cache_read_tokens: usageTokens, cache_write_tokens: usageTokens, window_s: seconds }),
] as const;

export const ENGINE_EVENT_KINDS = ["agent_started", "agent_linked", "agent_stopped", "spawn_blocked", "merge_lane", "merged", "gate_receipt", "team_log_line", "loop_tick", "checkin_tick", "engine_heartbeat", "plan_snapshot", "ask_raised", "ask_cleared", "host_started", "host_stopped", "host_heartbeat", "tick_started", "tick_ended", "compaction_detected", "halt_applied", "bridge_heartbeat", "bridge_dropped", "usage_tick", "slim_status"] as const;
export type EngineEventKind = (typeof ENGINE_EVENT_KINDS)[number];

/**
 * How each kind is sent while a repo is unwatched. `always_on` kinds are never held back (a figure or a fact the cloud cannot get another way, `usage_tick` among them), `on_demand` kinds go
 * only while someone watches the repo, and `replaced_by_slim` kinds are the three heartbeats a `slim_status` stands in for (they stay valid for runners below 23, which still send them).
 */
export const ENGINE_EVENT_CLASSES = {
  always_on: ["agent_started", "agent_linked", "agent_stopped", "spawn_blocked", "merge_lane", "merged", "gate_receipt", "ask_raised", "ask_cleared", "halt_applied", "host_started", "host_stopped", "tick_ended", "bridge_dropped", "usage_tick", "slim_status"],
  on_demand: ["team_log_line", "loop_tick", "checkin_tick", "plan_snapshot", "tick_started", "compaction_detected"],
  replaced_by_slim: ["bridge_heartbeat", "host_heartbeat", "engine_heartbeat"],
} as const satisfies Record<string, readonly EngineEventKind[]>;
export type EngineEventClass = keyof typeof ENGINE_EVENT_CLASSES;

/** Keys no event may carry at any depth: free text, and every figure the cloud computes. Matched case-insensitively; `total_` is a prefix. */
export const ENGINE_FORBIDDEN_KEYS = ["text", "message", "content", "output", "prompt", "description", "title", "body", "branch", "path", "usd", "cost", "cost_usd", "price"] as const;
export const ENGINE_FORBIDDEN_KEY_PREFIX = "total_";
const FORBIDDEN = new Set<string>(ENGINE_FORBIDDEN_KEYS);
/** Deepest nesting and most nodes the scan walks; anything larger is refused outright (no real event comes near either). */
const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_NODES = 20_000;

/** True when `key` is a forbidden name. */
export function isForbiddenEngineKey(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN.has(lower) || lower.startsWith(ENGINE_FORBIDDEN_KEY_PREFIX);
}

/** True when a forbidden key sits anywhere in `value`, or the value is too deep or too large to scan. Reports nothing about which key or what value. */
export function hasForbiddenEngineKey(value: unknown): boolean {
  let nodes = 0;
  const walk = (node: unknown, depth: number, parent: string): boolean => {
    if (typeof node !== "object" || node === null) return false;
    if (depth > SCAN_MAX_DEPTH || ++nodes > SCAN_MAX_NODES) return true;
    if (Array.isArray(node)) return node.some((item) => walk(item, depth + 1, parent));
    // The one exception: `usage.output` is the output token count. The usage schema still requires it to be a safe integer, so no text fits under it.
    return Object.keys(node).some((key) => (isForbiddenEngineKey(key) && !(parent === "usage" && key === "output")) || walk((node as Record<string, unknown>)[key], depth + 1, key));
  };
  return walk(value, 0, "");
}

/** The plan snapshot's size cap, as the compact JSON the emitter writes. */
export const PLAN_SNAPSHOT_MAX_BYTES = 65_536;
/** One events request may not exceed this many bytes of JSON. */
export const ENGINE_EVENTS_BODY_MAX_BYTES = 262_144;
/** The UTF-8 size of the value as JSON. A value too deeply nested to stringify (it throws RangeError) counts as infinitely large, so the size rules refuse it instead of the parse throwing. */
const jsonBytes = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    // fx-swallow-ok: a value too deep to stringify is reported as over the size limit (Infinity), which refuses the message
    return Number.POSITIVE_INFINITY;
  }
};

const EventKinds = z.discriminatedUnion("kind", KIND_SCHEMAS);
/**
 * One engine event. The forbidden-key scan runs first and stops the parse, so its error is one fixed line with no path and nothing from the event.
 * Any other violation (an extra key, a wrong type, one character outside an id's pattern) is the strict kind schema's.
 */
export const EngineEvent = z
  .unknown()
  .superRefine((value, ctx) => {
    if (hasForbiddenEngineKey(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an engine event may not carry a free-text or computed-figure field" });
  })
  .pipe(EventKinds)
  .superRefine((event, ctx) => {
    if (event.kind === "plan_snapshot" && jsonBytes(event) > PLAN_SNAPSHOT_MAX_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a plan snapshot over 64 KiB" });
    if (event.kind === "plan_snapshot" && event.chunk_index >= event.chunk_count) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "chunk_index is not below chunk_count" });
    if (event.kind === "plan_snapshot" && event.roadmap.some((row) => row.row_key === "" && row.discussion === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a row with no key names its discussion" });
  });
export type EngineEvent = z.infer<typeof EngineEvent>;
export type EngineEventOf<K extends EngineEventKind> = Extract<EngineEvent, { kind: K }>;

/** The pure ordering check the cloud and the runner share: the index of the first event whose `seq` does not exceed the one before it, or null when the batch strictly increases. */
export function engineSeqOrderViolation(events: readonly { seq: number }[]): number | null {
  for (let i = 1; i < events.length; i++) if (!(events[i]!.seq > events[i - 1]!.seq)) return i;
  return null;
}

/** POST /api/runner/engine/events. The account and runner come from the verified key, never from here. */
export const EngineEventsMessage = z
  .object({
    session: z.object({ engine_instance_id: z.string().uuid(), repo_gh_id: safeInt.min(1), engine_version: z.string().regex(ENGINE_VERSION_PATTERN) }).strict(),
    events: z.array(EngineEvent).min(1).max(100),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (message.events.some((event) => event.engine_instance_id !== message.session.engine_instance_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an event names an engine instance other than the session's", path: ["events"] });
    if (engineSeqOrderViolation(message.events) !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "seq_order", path: ["events"] });
    if (jsonBytes(message) > ENGINE_EVENTS_BODY_MAX_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an events request over 256 KiB" });
  });
export type EngineEventsMessage = z.infer<typeof EngineEventsMessage>;

/** Parses a body the way the route answers it: 400 `seq_order` when only the order is wrong, else 400 `invalid_message`. */
export function parseEngineEventsMessage(body: unknown): { ok: true; message: EngineEventsMessage } | { ok: false; error: "seq_order" | "invalid_message" } {
  const parsed = EngineEventsMessage.safeParse(body);
  if (parsed.success) return { ok: true, message: parsed.data };
  const onlyOrder = parsed.error.issues.every((issue) => issue.message === "seq_order");
  return { ok: false, error: onlyOrder ? "seq_order" : "invalid_message" };
}

/** The replies to an events request. `watch_until` (D#845 ON-24a) is how long the repo stays watched; the cloud sends it only to a runner whose hello is at `WATCH_MIN_PROTOCOL` or later. `last_accepted_seq` is null until the session has had an event accepted. */
const lastSeq = safeInt.min(0).nullable();
export const EngineEventsAcceptedReply = z.object({ accepted: count, duplicates: count, last_accepted_seq: lastSeq, watch_until: z.string().datetime().optional() }).strict();
export const EngineEventsErrorReply = z.union([
  z.object({ error: z.literal("seq_not_increasing"), last_accepted_seq: lastSeq }).strict(),
  z.object({ error: z.enum(["engine_bridge_off", "engine_repo_not_enabled"]) }).strict(),
  z.object({ error: z.literal("engine_event_quota"), retry_after_s: seconds }).strict(),
  z.object({ error: z.enum(["seq_order", "invalid_message"]) }).strict(),
]);
/** The accepted reply for a runner whose hello said `helloProtocol`: `watch_until` is dropped below `WATCH_MIN_PROTOCOL`, because a strict parse that predates the key would refuse the reply and the runner would retry the batch. */
export function buildEventsAcceptedReply(reply: { accepted: number; duplicates: number; last_accepted_seq: number | null }, watchUntil: string | undefined, helloProtocol: number): EngineEventsAcceptedReply {
  return EngineEventsAcceptedReply.parse(watchUntil !== undefined && helloProtocol >= WATCH_MIN_PROTOCOL ? { ...reply, watch_until: watchUntil } : reply);
}
export type EngineEventsAcceptedReply = z.infer<typeof EngineEventsAcceptedReply>;
export type EngineEventsErrorReply = z.infer<typeof EngineEventsErrorReply>;
