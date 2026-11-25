/**
 * The daemon's signed calls to the cloud's runner routes: claim, heartbeat, events and done. Each request body is built with
 * the protocol's message schema and each reply parsed with its reply schema (replies.ts), so a field the protocol does not
 * list is never sent and a reply it does not describe is never believed: it is an error with a closed code.
 */
import {
  CURRENT_PROTOCOL_VERSION, MACHINE_LOGIN_CAPABILITY, MACHINE_ONBOARDING_MIN_PROTOCOL, MachineLoginCode, MachineLoginReport, machineLoginCodePath, machineLoginReportPath, SANDBOX_COMMAND_CAPABILITY, SANDBOX_INVENTORY_MIN_PROTOCOL, VERIFY_SIGN_IN_MIN_PROTOCOL, type VerifySignInState,
  CLAIM_PATH, ClaimMessage, ClaimRateLimitedReply, type ConflictAttestation, HelloMessage, HelloReply, ClaimReply, WAKE_CAPABILITY, type WakeGrant, DoneMessage, DoneReply, DoneRetryReply, EventsMessage, EventsReply, HeartbeatMessage,
  GitTicketMessage, GitTicketReply, GIT_TICKET_PATH, HeartbeatReply, SeqNotIncreasingReply, StopReply,
  CONFLICT_FACTS_CAPABILITY, DISCOVERY_ANALYST_CAPABILITY, ENGINE_BRIDGE_CAPABILITY, SURVEY_CAPABILITY, KVM_FACT_HELLO_CAPABILITY, PREFLIGHT_HELLO_CAPABILITY, HEARTBEAT_INVENTORY_HELLO_CAPABILITY, WATCH_MODE_HELLO_CAPABILITY, ORDERED_FACTS_CAPABILITY, OVERLAP_FACTS_CAPABILITY, TIP_PUBLISH_CAPABILITY, MEM_PROPOSAL_CAPABILITY, MEMORY_PROPOSALS_PATH, MemoryProposalsMessage, MemoryProposalsReply, MEMORY_LIMIT_CAPABILITY, PLANE_MERGE_CAPABILITY, PLANE_MERGE_QUEUE_CAPABILITY, PLANE_MERGE_CLAIM_PATH, PLANE_MERGE_REPORT_PATH, PLANE_MERGE_VERIFY_PATH, PlaneMergeClaimMessage, PlaneMergeClaimReply, PlaneMergeReportMessage, PlaneMergeReportReply, PlaneMergeRetryReply, PlaneMergeVerifyMessage, PlaneMergeVerifyReply,
  BROWSER_CHROME_CAPABILITY, BROWSER_PLAYWRIGHT_CAPABILITY, DEPLOY_ORDER_CAPABILITY, DEPLOY_ORDER_CLAIM_PATH, DEPLOY_ORDER_REPORT_PATH, DeployOrderClaimMessage, DeployOrderClaimReply, DeployOrderReportMessage, DeployOrderReportReply,
  PLANE_PUSH_PAIRING_PATH, PLANE_PUSH_REPORT_PATH, PLANE_PUSH_TOKEN_PATH, PlanePushPairingMessage, PlanePushPairingReply, PlanePushReportMessage, PlanePushReportReply, PlanePushTokenMessage, PlanePushTokenReply, type ClaimCapacity, type ContextLedgerWire, type DoneCheck, type LocalOnlyEvent, type SandboxUnavailableReason, type SignedJob, type StopReason,
  MACHINE_JOB_CLAIM_PATH, MachineJobClaimMessage, MachineJobClaimReply, MAX_PLAN_BYTES, SessionJobProgressBody, SetupProgressBody, SetupProgressReply, SetupPushTokenMessage, SetupPushTokenReply, machineJobProgressPath, setupPlanPath, setupProgressPath, setupPushTokenPath, type SignedMachineJob,
} from "@fulcrumaxe/runner-protocol";
import { errorCodeOf, signedGet, signedPost, type CloudReply } from "../cloud.js";
import { WAKE_PATH, parseWakeReply } from "./wake.js";
import type { MachineCommandReceiver } from "./machineCommands.js";
import type { SandboxCommandReceiver } from "./sandboxCommands.js";
import type { InventoryReporter } from "./sandboxInventory.js";
import type { HostLoadReporter } from "./hostLoad.js";
import type { RunnerKey } from "../keys.js";

export const HELLO_PATH = "/api/runner/hello";
// The claim route's path is the protocol's, shared with the reply bound in cloud.ts so the two cannot drift apart.
export { CLAIM_PATH };
export const HEARTBEAT_PATH = "/api/runner/heartbeat";
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const eventsPath = (runId: string): string => `/api/runner/runs/${runId}/events`;
export const donePath = (runId: string): string => `/api/runner/runs/${runId}/done`;

/** Status 0 means the cloud could not be reached. `code` is the server's short error word, or `invalid_reply` for a reply no schema describes. */
export interface CallError {
  kind: "error";
  status: number;
  code?: string;
  /** The reply was Vercel's own Deployment Protection 401: the runner's key was never judged. */
  protectedDeployment?: true;
}

/** `wake` is the grant the reply carried (D#6 RUNNER-WAKE), absent when it carried none. */
export type Claimed = { kind: "claimed"; signedJob: SignedJob; runId: string; leaseGeneration: number; wake?: WakeGrant; mergeOrder?: true; deployOrder?: true; machineJob?: true };
export type ClaimResult = Claimed | { kind: "idle"; retryAfter: number; wake?: WakeGrant; mergeOrder?: true; deployOrder?: true; machineJob?: true } | { kind: "rate_limited"; retryAfter: number } | CallError;
/** D#6 RUNNER-WAKE: a wake check's answer: the account's wake epoch and the earliest due time, both ms (due null when none). */
export type WakeResult = { kind: "wake"; epoch: number; dueAt: number | null } | CallError;
/** `handoff` is present only when the cloud asked for the run to move to the other side; `deadline` is the UTC instant after which it takes the last pushed commit. */
export type HeartbeatResult = { kind: "ok"; leaseExpiresAt: string; handoff?: { deadline: string } } | { kind: "stop"; reason: StopReason } | CallError;
export type EventsResult =
  | { kind: "ok"; accepted: number; duplicates: number; leaseExpiresAt: string }
  | { kind: "stop"; reason: StopReason }
  | { kind: "seq_not_increasing"; lastAcceptedSeq: number }
  | CallError;
export type DoneResult =
  | { kind: "done"; outcome: "succeeded" | "failed"; failureReason: string | null; prNumber: number | null }
  | { kind: "stop"; reason: StopReason }
  | { kind: "retry"; retryAfter: number }
  | CallError;

/** A git ticket for a cloud-verified run (D#6 R5a-3): the compact JWS, when it expires, and the proxy origin it is good for (checked against the build's pin by the caller). */
export type GitTicketResult = { kind: "ticket"; ticket: string; expiresAt: string; proxyOrigin: string } | { kind: "stop"; reason: StopReason } | CallError;

/** D#598 P1f-3: the repository's pairing as the cloud has it now (a read, no side effect). `not_paired` is the answer for a run that has no public repository. */
export type PlanePushPairingResult =
  | { kind: "pairing"; pairing: PlanePushPairingReply }
  | { kind: "not_paired" }
  | { kind: "pairing_changed" }
  | { kind: "stop"; reason: StopReason }
  | CallError;
/** D#598 P1f-3: the one restricted token, the pull request text and the commit identity. `refused` carries the closed code the cloud answered with. */
export type PlanePushTokenResult =
  | { kind: "token"; reply: PlanePushTokenReply }
  | { kind: "not_paired" }
  | { kind: "refused"; code: string }
  | { kind: "stop"; reason: StopReason }
  | CallError;
/** D#601 MEM-6. `refused` is the cloud's 403 for a run that is not this runner's, 409 for one not finished; anything else is a call error. Counts only: no cloud text reaches the person. */
export type MemoryProposalsResult = { kind: "sent"; status: "ingested" | "already_ingested"; stored: number; refused: number } | { kind: "refused"; code: "run_not_yours" | "run_not_finished" | "capability_missing" } | CallError;
/** D#598 P1f-3: a report is a hint; `recorded` is all the reply says. */
export type PlanePushReportResult = { kind: "recorded" } | { kind: "not_paired" } | { kind: "stop"; reason: StopReason } | CallError;

/** D#6 PUBLIC-MERGE PR3: an order claimed with its bound facts and read credential. Held in memory only; nothing here is logged. */
export type PlaneMergeOrder = Extract<PlaneMergeClaimReply, { order_id: string }>;
export type PlaneMergeClaimResult = { kind: "order"; order: PlaneMergeOrder } | { kind: "none"; retryAfter: number } | { kind: "fenced" } | CallError;
export type PlaneMergeVerifyResult =
  | { kind: "go"; token: string; expiresAt: string; sha: string; mergeMode?: "queue" | "direct" }
  | { kind: "no_go"; reasons: string[] }
  | { kind: "head_moved" }
  /** 409: the order is not this runner's any more (fenced, mismatch, or a credential already issued). Nothing more may be done with it. */
  | { kind: "fenced"; code?: string }
  | CallError;
/** D#749 V2b: a deploy order claimed: the repository and the commit, nothing else (the command is this machine's own). */
export type DeployOrderClaimed = Extract<DeployOrderClaimReply, { order_id: string }>;
export type DeployOrderClaimResult = { kind: "order"; order: DeployOrderClaimed } | { kind: "none"; retryAfter: number } | { kind: "fenced" } | CallError;
export type DeployOrderReportResult = { kind: "recorded" } | { kind: "fenced"; code?: string } | CallError;
/** D#845 ON-8c: a machine job taken, once; the signed job is checked by the caller against the runner's keyring before anything is read from it. */
export type MachineJobClaimResult = { kind: "job"; signedJob: SignedMachineJob } | { kind: "none"; retryAfter: number } | CallError;
/** 404 and 409 are the cloud's closed refusals of a report: this job is not the setup's current one, is not running, or the number is not above the last. */
export type SetupProgressResult = { kind: "recorded" } | { kind: "refused"; status: 404 | 409; code?: string } | CallError;
/** The session job report route answers with the setup route's replies, so one reply type serves both. */
export type MachineJobProgressResult = SetupProgressResult;
/** The plan route's reply as the exact text read: the caller hashes it before it parses it. `too_large` is a body over `MAX_PLAN_BYTES`. */
/** D#845 ON-8f: the one push credential of a setup job. `refused` carries the cloud's closed code (`already_issued`, `push_not_started`, `app_not_installed`, ...). Held in memory only; nothing here is logged. */
export type SetupPushTokenResult = { kind: "token"; token: string; expiresAt: string } | { kind: "refused"; status: 404 | 409 | 502; code?: string } | CallError;
export type SetupPlanResult = { kind: "plan"; text: string } | { kind: "missing" } | { kind: "too_large" } | CallError;
/** D#845 MC-8b: the cloud's answer to a sign-in report. 404 and 409 are its closed refusals (no such request, or the request is no longer in a state that takes this: a late `done` is 409). */
export type MachineLoginReportResult = { kind: "recorded" } | { kind: "refused"; status: 404 | 409; code?: string } | CallError;
/** The code, once. `gone` is 410: it is not there any more (late, already taken, or the request is over). The code is only ever in the `code` field of this result. */
export type MachineLoginCodeResult = { kind: "code"; code: string } | { kind: "gone" } | CallError;
export type PlaneMergeReportResult = { kind: "recorded" } | { kind: "retry"; retryAfter: number } | { kind: "fenced"; code?: string } | CallError;

/** The closed codes a token request can be refused with; any other 4xx or 5xx word is a plain `CallError`. */
const TOKEN_REFUSALS: ReadonlySet<string> = new Set(["pairing_changed", "already_issued", "attempts_exhausted", "app_not_installed", "token_scope_mismatch", "public_unavailable", "not_configured", "republish_base_missing", "republish_pr_closed", "republish_pr_merged", "republish_pairing_off", "no_changes"]);

export interface DoneInput {
  runId: string;
  leaseGeneration: number;
  sessionId?: string | undefined;
  agentOutput?: Record<string, unknown> | undefined;
  /** D#600 CX-1b: the wire form of the run's context ledger. Left out when an older cloud has refused it. */
  contextLedger?: ContextLedgerWire | undefined;
  /** D#6 R-CHK-2: how the repository's approved check ended. Present only for a job that carried a check. */
  check?: DoneCheck | undefined;
  /** D#519 MQ4-e2-c1: the end-of-round attestation of a conflict round. Present only for a job whose signed form carried `conflict_round`. */
  conflictAttest?: ConflictAttestation | undefined;
}

export interface RunnerClient {
  /** D#605 FL-2: says what this build and machine are. Best effort: the caller keeps going on any answer, and a cloud that predates `facts` answers 400. */
  hello(message: HelloMessage): Promise<{ kind: "ok"; wake?: WakeGrant; /** Capabilities an older cloud refused and the hello went again without; absent when none was dropped. */ dropped?: string[]; /** True when the cloud's hello reply lists the `watch_mode` capability (its ingest takes the slim status and the detail session); absent otherwise. Never a protocol number: clouds at 23 and 24 exist that cannot. */ watchMode?: true; /** True when the cloud's hello reply lists `kvm_fact`: this cloud stores `facts.kvm`, so the runner may send it on its next hello. */ kvmFact?: true; /** True when the cloud's hello reply lists `preflight` (D#845 ON-21b): this cloud stores `facts.preflight`, so the runner may send the codes on its next hello. */ preflight?: true; /** True when the cloud's hello reply lists `heartbeat_inventory`: this cloud takes `sandboxes` on a heartbeat. */ heartbeatInventory?: true } | CallError>;
  /** D#6 RUNNER-WAKE: the no-database wake check, with the token of the grant held. Never a claim: it hands out nothing. */
  wake(token: string): Promise<WakeResult>;
  /**
   * Asks for a run. With `sandboxUnavailable` it is the status poll of a runner that cannot sandbox a job (C16 section 1.3): the reply is
   * `retry_after` only, and a reply that carries a job is an error, never a claim, so nothing a misbehaving cloud sends can be run.
   */
  claim(sandboxUnavailable?: SandboxUnavailableReason, capacity?: ClaimCapacity): Promise<ClaimResult>;
  heartbeat(runId: string, leaseGeneration: number): Promise<HeartbeatResult>;
  events(runId: string, leaseGeneration: number, events: readonly LocalOnlyEvent[]): Promise<EventsResult>;
  done(input: DoneInput): Promise<DoneResult>;
  gitTicket(runId: string, leaseGeneration: number): Promise<GitTicketResult>;
  /** D#598 P1f-3. The run-end hook of an executor run on a repository paired with a public repository. */
  planePushPairing(runId: string, leaseGeneration: number): Promise<PlanePushPairingResult>;
  /** `atTip` (D#598 P1g-3a-3): asks to publish the branch tip for a fix round that added no commit; only ever passed after the hello kept `tip_publish_v1`. */
  planePushToken(runId: string, leaseGeneration: number, atTip?: true): Promise<PlanePushTokenResult>;
  planePushReport(message: PlanePushReportMessage): Promise<PlanePushReportResult>;
  /** D#601 MEM-6. Only ever called after the hello kept `mem_proposal_v1`, and only with proposals a person said yes to. Never retried by the client. */
  memoryProposals(message: MemoryProposalsMessage): Promise<MemoryProposalsResult>;
  /** D#6 PUBLIC-MERGE PR3. The three signed calls of a merge order on this runner. Used only after a claim reply said `merge_order`. */
  planeMergeClaim(): Promise<PlaneMergeClaimResult>;
  planeMergeVerify(message: PlaneMergeVerifyMessage): Promise<PlaneMergeVerifyResult>;
  planeMergeReport(message: PlaneMergeReportMessage): Promise<PlaneMergeReportResult>;
  /** D#749 V2b. The two signed calls of a deploy order on this runner. Used only after a claim reply said `deploy_order`, and only by a runner whose hello kept `deploy_order_v1`. */
  deployOrderClaim(): Promise<DeployOrderClaimResult>;
  deployOrderReport(message: DeployOrderReportMessage): Promise<DeployOrderReportResult>;
  /** D#845 ON-8c. The calls of a machine job: take it (only after a claim reply said `machine_job`), report one step of a setup, and read a setup's plan file. */
  machineJobClaim(): Promise<MachineJobClaimResult>;
  setupProgress(setupId: string, body: SetupProgressBody): Promise<SetupProgressResult>;
  /** D#845 ON-13a1: a session job's report, keyed by its own job id (the cloud's machine-job route); the replies are `setupProgress`'s. */
  machineJobProgress(jobId: string, body: SessionJobProgressBody): Promise<MachineJobProgressResult>;
  setupPlan(setupId: string, version: number): Promise<SetupPlanResult>;
  /** D#845 MC-8b. The two signed calls of one Claude sign-in request: report the link or the end, and take the person's code (once). */
  machineLoginReport(requestId: string, report: MachineLoginReport): Promise<MachineLoginReportResult>;
  machineLoginCode(requestId: string): Promise<MachineLoginCodeResult>;
  setupPushToken(setupId: string, jobId: string): Promise<SetupPushTokenResult>;
}

export interface RunnerClientConfig {
  origin: string;
  key: RunnerKey;
  now: () => Date;
  fetchFn: typeof fetch;
  /** The Vercel protection bypass secret, if set; passed to every call and sent only to `origin`. */
  bypass?: string | undefined;
  /**
   * D#749 VERIFY-SIGN-EXPIRY: the state of this machine's saved verify sign-in, asked on each ordinary claim (never a status poll). Absent, or answering undefined: the claim carries nothing.
   * It is sent only when `protocolVersion` (what this runner's hello declares; the current one when not given) is `VERIFY_SIGN_IN_MIN_PROTOCOL` or later.
   */
  verifySignIn?: () => VerifySignInState | undefined;
  /**
   * D#587 B-7a: the sandbox inventory, asked on each ordinary claim (never a status poll). It is sent only when `protocolVersion` is `SANDBOX_INVENTORY_MIN_PROTOCOL` or later, and only when the
   * reporter says it is due (the list changed, or ten minutes passed). It counts as sent once the cloud answered 200.
   */
  sandboxInventory?: InventoryReporter;
  /**
   * D#845 ON-1b: the machine's load, asked on each ordinary claim (never a status poll). It is sent only when `protocolVersion` is `MACHINE_ONBOARDING_MIN_PROTOCOL` or later, and only when the
   * reporter says it is due. It counts as sent once the cloud answered 200. Wired only by a runner whose hello lists `project_setup_v1`.
   */
  hostLoad?: HostLoadReporter;
  /**
   * D#587 B-7b: receives the signed sandbox commands a claim reply carries and holds their acks for the next claim. Wired only by a runner whose hello lists `sandbox_commands_v1`;
   * like the inventory it is used only at protocol 21 or later, and never on a status poll. The acks count as sent once the cloud answered 200.
   */
  sandboxCommands?: SandboxCommandReceiver;
  /**
   * D#845 MC-8b: receives the signed machine commands (the Claude sign-in link) a claim reply carries and holds their acks for the next claim. Used only at protocol 22 or later, and never on a status poll.
   */
  machineCommands?: MachineCommandReceiver;
  /**
   * D#587 FU-179: true once a hello reply listed `heartbeat_inventory`. Only then does a heartbeat carry the sandbox inventory (from the same reporter a claim uses, so the two share one
   * "last sent" state). A runner holding a run sends no claim, so this is how a VM that exists while the job runs reaches the cloud. It counts as sent once the cloud answered `sandboxes_recorded`.
   */
  heartbeatInventory?: () => boolean;
  protocolVersion?: number;
}

export function createRunnerClient(config: RunnerClientConfig): RunnerClient {
  /** Set once a `done` carrying `context_ledger` is refused as an invalid message: that cloud predates the field. */
  let cloudRefusesLedger = false;
  /** One signed POST; undefined when the cloud could not be reached. */
  async function send(path: string, body: unknown): Promise<CloudReply | undefined> {
    try {
      return await signedPost({ origin: config.origin, path, body, key: config.key, now: config.now(), fetchFn: config.fetchFn, bypass: config.bypass });
    } catch {
      // fx-swallow-ok: signedPost reports a network failure in fixed words; the caller sees it as status 0 and decides whether to retry
      return undefined;
    }
  }
  const fail = (reply: CloudReply | undefined, code?: string): CallError => {
    const known = code ?? (reply === undefined ? undefined : errorCodeOf(reply.body));
    return { kind: "error", status: reply?.status ?? 0, ...(known === undefined ? {} : { code: known }), ...(reply?.protectedDeployment === true ? { protectedDeployment: true as const } : {}) };
  };

  return {
    async hello(message) {
      const parsed = HelloMessage.parse(message);
      let reply = await send(HELLO_PATH, parsed);
      // D#6 RUNNER-WAKE: a cloud from before `wake_v1` refuses the unknown capability with 400 invalid_message and records nothing, so the same
      // hello goes again without it, and the runner works as it did before (plain claims, no grant).
      // The same for `plane_merge_v1` (D#6 PUBLIC-MERGE), in two steps so a cloud that knows `wake_v1` but not `plane_merge_v1` keeps its wake grant: the newer
      // capability is dropped alone first, and `wake_v1` goes too only if the hello is still refused.
      const refused = (r: CloudReply | undefined): boolean => r?.status === 400 && errorCodeOf(r.body) === "invalid_message";
      let dropped: string[] = [];
      // `mem_proposal_v1` (D#601 MEM-6) is the newest, so it goes first (the runner then offers no memory proposal), then `tip_publish_v1` (D#598 P1g-3a-3) (the runner then never asks to publish the branch tip), then `ordered_facts_v1` (D#483 S5-j2c2) (the runner computes and sends no ordering fact), then `conflict_facts_v1` (D#519 MQ4-e2-a) (no `conflict` field on a merge report), then `discovery_analyst` (D#483 S4-f4) (a cloud without it just never offers the analyst), then `plane_merge_queue_v1` (D#694 B7-1), then `memory_limit_v1` (D#6 CARD-OOM-CAUSE-WORDS): a cloud that knows the others keeps them, and the caller reads the `dropped` list to know not to send the field.
      // D#845 ON-10c: `survey_v1` is the newest build capability and goes right after `watch_mode_v1` (the cloud's list has had it since before `kvm_fact_v1`, `preflight_v1` and `heartbeat_inventory_v1`, so a cloud that lacks those still keeps it, and costs no retry for it): a cloud without it keeps every other capability and this runner is never offered a survey.
      // D#845 ON-21b: `preflight_v1` is the newest capability of all, so it goes before everything else: an old cloud refuses the hello only because of it, so the one retry costs that capability alone (and `kvm_fact_v1` and the rest stay), and the runner never sends `facts.preflight`.
      // D#845 ON-6c: `kvm_fact_v1` goes before everything else: an old cloud refuses the hello only because of it, so the one retry costs that capability alone and `sandbox_commands_v1` and the browser and deploy ones stay.
      // D#587 FU-179: `heartbeat_inventory_v1` is newer still, so it is dropped first, before `preflight_v1`: an old cloud refuses the hello only because of it, and the one retry costs that capability alone (the runner then sends no inventory on a heartbeat).
      // D#749 V2b/V2c-1: `browser_playwright_v1`, `browser_chrome_v1` and `deploy_order_v1` follow `kvm_fact_v1` and `sandbox_commands_v1` (above): a cloud without them keeps every other capability.
      // D#845 watch mode: `watch_mode_v1` is the newest build capability, so it goes first after those three (and after `kvm_fact_v1`, which is dropped before all of them): a cloud without it keeps every other capability and watch mode stays off.
      // D#842 EB-3c: `engine_bridge_v1` was the newest build capability, so it goes first after those three (which are only advertised while their settings and probe pass): a cloud without it keeps every other capability and the bridge stays off.
      // D#483 S5-j2e-RUNNER: `overlap_facts_v1` is the newest build capability, so it goes first after the three browser/deploy ones: a cloud without it keeps every other capability.
      // D#845 MC-8b: `machine_login_v1` is the newest build capability of all, so it goes first after the three browser and deploy ones (which are only advertised while their settings and probe pass): a cloud without it keeps every other capability, and the runner then answers every sign-in command as unsupported.
      for (const drop of [HEARTBEAT_INVENTORY_HELLO_CAPABILITY, PREFLIGHT_HELLO_CAPABILITY, KVM_FACT_HELLO_CAPABILITY, SANDBOX_COMMAND_CAPABILITY, BROWSER_PLAYWRIGHT_CAPABILITY, BROWSER_CHROME_CAPABILITY, DEPLOY_ORDER_CAPABILITY, SURVEY_CAPABILITY, MACHINE_LOGIN_CAPABILITY, WATCH_MODE_HELLO_CAPABILITY, ENGINE_BRIDGE_CAPABILITY, OVERLAP_FACTS_CAPABILITY, MEM_PROPOSAL_CAPABILITY, TIP_PUBLISH_CAPABILITY, ORDERED_FACTS_CAPABILITY, CONFLICT_FACTS_CAPABILITY, DISCOVERY_ANALYST_CAPABILITY, PLANE_MERGE_QUEUE_CAPABILITY, MEMORY_LIMIT_CAPABILITY, PLANE_MERGE_CAPABILITY, WAKE_CAPABILITY] as const) {
        if (!refused(reply) || !(parsed.capabilities ?? []).includes(drop)) continue;
        dropped = [...dropped, drop];
        reply = await send(HELLO_PATH, { ...parsed, capabilities: (parsed.capabilities ?? []).filter((c) => !dropped.includes(c)) });
      }
      if (reply?.status !== 200) return fail(reply);
      // The hello is best effort: a 200 whose body is not a protocol reply still counts, it just brings no grant.
      // `capabilities` is read on its own (a missing, malformed or unknown one is "not offered", never a failure of the rest of the reply), and only a listed `watch_mode` counts.
      const { capabilities, ...rest } = (typeof reply.body === "object" && reply.body !== null && !Array.isArray(reply.body) ? reply.body : {}) as Record<string, unknown>;
      const body = HelloReply.safeParse(rest);
      const left = dropped.length === 0 ? {} : { dropped };
      const watch = body.success && Array.isArray(capabilities) && capabilities.includes("watch_mode") ? { watchMode: true as const } : {};
      const kvm = body.success && Array.isArray(capabilities) && capabilities.includes("kvm_fact") && !dropped.includes(KVM_FACT_HELLO_CAPABILITY) ? { kvmFact: true as const } : {};
      const preflight = body.success && Array.isArray(capabilities) && capabilities.includes("preflight") && !dropped.includes(PREFLIGHT_HELLO_CAPABILITY) ? { preflight: true as const } : {};
      const beat = body.success && Array.isArray(capabilities) && capabilities.includes("heartbeat_inventory") && !dropped.includes(HEARTBEAT_INVENTORY_HELLO_CAPABILITY) ? { heartbeatInventory: true as const } : {};
      return body.success && body.data.wake !== undefined ? { kind: "ok", wake: body.data.wake, ...watch, ...kvm, ...preflight, ...beat, ...left } : { kind: "ok", ...watch, ...kvm, ...preflight, ...beat, ...left };
    },

    async wake(token) {
      let reply: CloudReply | undefined;
      try {
        reply = await signedGet({ origin: config.origin, path: WAKE_PATH, key: config.key, now: config.now(), fetchFn: config.fetchFn, bypass: config.bypass, headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      } catch {
        // fx-swallow-ok: signedGet reports a network failure in fixed words; the caller counts it as a failed check
        reply = undefined;
      }
      if (reply?.status === 200) {
        const parsed = parseWakeReply(reply.body);
        return parsed === undefined ? fail(reply, "invalid_reply") : { kind: "wake", epoch: parsed.epoch, dueAt: parsed.due_at };
      }
      return fail(reply);
    },

    async claim(sandboxUnavailable, capacity) {
      // A status poll (closed sandbox) takes no job, so it declares no capacity; every other claim says what the runner could take now (D#6 C43-4).
      const signIn = sandboxUnavailable === undefined && (config.protocolVersion ?? CURRENT_PROTOCOL_VERSION) >= VERIFY_SIGN_IN_MIN_PROTOCOL ? config.verifySignIn?.() : undefined;
      const inventory = sandboxUnavailable === undefined && (config.protocolVersion ?? CURRENT_PROTOCOL_VERSION) >= SANDBOX_INVENTORY_MIN_PROTOCOL ? await config.sandboxInventory?.next() : undefined;
      const hostLoad = sandboxUnavailable === undefined && (config.protocolVersion ?? CURRENT_PROTOCOL_VERSION) >= MACHINE_ONBOARDING_MIN_PROTOCOL ? config.hostLoad?.next() : undefined;
      const commands = sandboxUnavailable === undefined && (config.protocolVersion ?? CURRENT_PROTOCOL_VERSION) >= SANDBOX_INVENTORY_MIN_PROTOCOL ? config.sandboxCommands : undefined;
      const sentAcks = commands?.pendingAcks() ?? [];
      const machine = sandboxUnavailable === undefined && (config.protocolVersion ?? CURRENT_PROTOCOL_VERSION) >= MACHINE_ONBOARDING_MIN_PROTOCOL ? config.machineCommands : undefined;
      const sentMachineAcks = machine?.pendingAcks() ?? [];
      const reply = await send(CLAIM_PATH, ClaimMessage.parse(sandboxUnavailable !== undefined ? { sandbox_unavailable: sandboxUnavailable } : { ...(capacity === undefined ? {} : { capacity }), ...(sentMachineAcks.length === 0 ? {} : { machine_acks: sentMachineAcks }), ...(signIn === undefined ? {} : { verify_sign_in: signIn }), ...(inventory === undefined ? {} : { sandboxes: inventory.rows }), ...(sentAcks.length === 0 ? {} : { sandbox_acks: sentAcks }), ...(hostLoad === undefined ? {} : { host_load: hostLoad.load }) }));
      if (reply?.status === 200) {
        inventory?.commit();
        hostLoad?.commit();
        commands?.committed(sentAcks);
        machine?.committed(sentMachineAcks);
        const parsed = ClaimReply.safeParse(reply.body);
        if (!parsed.success) return fail(reply, "invalid_reply");
        if (commands !== undefined && parsed.data.sandbox_commands !== undefined) commands.receive(parsed.data.sandbox_commands);
        if (machine !== undefined && parsed.data.machine_commands !== undefined) machine.receive(parsed.data.machine_commands);
        // A status poll takes no job: a reply with one is refused here, so no code path past this point can run it.
        if (sandboxUnavailable !== undefined && "signed_job" in parsed.data) return fail(reply, "invalid_reply");
        // The reply schema also refuses a claim whose `run_id` differs from the signed job's own.
        const wake = { ...(parsed.data.wake === undefined ? {} : { wake: parsed.data.wake }), ...(parsed.data.merge_order === true ? { mergeOrder: true as const } : {}), ...(parsed.data.deploy_order === true ? { deployOrder: true as const } : {}), ...(parsed.data.machine_job === true ? { machineJob: true as const } : {}) };
        return "signed_job" in parsed.data
          ? { kind: "claimed", signedJob: parsed.data.signed_job, runId: parsed.data.run_id, leaseGeneration: parsed.data.lease_generation, ...wake }
          : { kind: "idle", retryAfter: parsed.data.retry_after, ...wake };
      }
      if (reply?.status === 429) {
        const parsed = ClaimRateLimitedReply.safeParse(reply.body);
        return parsed.success ? { kind: "rate_limited", retryAfter: parsed.data.retry_after } : fail(reply, "invalid_reply");
      }
      return fail(reply);
    },

    async heartbeat(runId, leaseGeneration) {
      const inventory = config.heartbeatInventory?.() === true && (config.protocolVersion ?? CURRENT_PROTOCOL_VERSION) >= SANDBOX_INVENTORY_MIN_PROTOCOL ? await config.sandboxInventory?.next() : undefined;
      const reply = await send(HEARTBEAT_PATH, HeartbeatMessage.parse({ run_id: runId, lease_generation: leaseGeneration, ...(inventory === undefined ? {} : { sandboxes: inventory.rows }) }));
      if (reply?.status === 200) {
        const parsed = HeartbeatReply.safeParse(reply.body);
        if (parsed.success && parsed.data.sandboxes_recorded === true) inventory?.commit();
        return parsed.success ? { kind: "ok", leaseExpiresAt: parsed.data.lease_expires_at, ...(parsed.data.handoff === undefined ? {} : { handoff: { deadline: parsed.data.handoff.deadline } }) } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 409) {
        const parsed = StopReply.safeParse(reply.body);
        return parsed.success ? { kind: "stop", reason: parsed.data.reason } : fail(reply, "invalid_reply");
      }
      return fail(reply);
    },

    async gitTicket(runId, leaseGeneration) {
      const reply = await send(GIT_TICKET_PATH, GitTicketMessage.parse({ run_id: runId, lease_generation: leaseGeneration }));
      if (reply?.status === 200) {
        const parsed = GitTicketReply.safeParse(reply.body);
        return parsed.success ? { kind: "ticket", ticket: parsed.data.ticket, expiresAt: parsed.data.expires_at, proxyOrigin: parsed.data.proxy_origin } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 409) {
        const parsed = StopReply.safeParse(reply.body);
        return parsed.success ? { kind: "stop", reason: parsed.data.reason } : fail(reply, "invalid_reply");
      }
      return fail(reply);
    },

    async planePushPairing(runId, leaseGeneration) {
      const reply = await send(PLANE_PUSH_PAIRING_PATH, PlanePushPairingMessage.parse({ run_id: runId, lease_generation: leaseGeneration }));
      if (reply?.status === 200) {
        // The reply schema recomputes the digest from the other fields: a pairing that disagrees with its own digest is an invalid reply.
        const parsed = PlanePushPairingReply.safeParse(reply.body);
        return parsed.success ? { kind: "pairing", pairing: parsed.data } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 403 && errorCodeOf(reply.body) === "not_paired") return { kind: "not_paired" };
      if (reply?.status === 409) {
        const stop = StopReply.safeParse(reply.body);
        if (stop.success) return { kind: "stop", reason: stop.data.reason };
        if (errorCodeOf(reply.body) === "pairing_changed") return { kind: "pairing_changed" };
      }
      return fail(reply);
    },

    async planePushToken(runId, leaseGeneration, atTip) {
      const reply = await send(PLANE_PUSH_TOKEN_PATH, PlanePushTokenMessage.parse({ run_id: runId, lease_generation: leaseGeneration, ...(atTip === true ? { at_tip: true } : {}) }));
      if (reply?.status === 200) {
        const parsed = PlanePushTokenReply.safeParse(reply.body);
        return parsed.success ? { kind: "token", reply: parsed.data } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 403 && errorCodeOf(reply.body) === "not_paired") return { kind: "not_paired" };
      if (reply?.status === 409) {
        const stop = StopReply.safeParse(reply.body);
        if (stop.success) return { kind: "stop", reason: stop.data.reason };
      }
      const code = reply === undefined ? undefined : errorCodeOf(reply.body);
      if (reply !== undefined && [409, 502, 503].includes(reply.status) && code !== undefined && TOKEN_REFUSALS.has(code)) return { kind: "refused", code };
      return fail(reply);
    },

    async planePushReport(message) {
      const parsed = PlanePushReportMessage.safeParse(message);
      if (!parsed.success) return fail(undefined, "invalid_message");
      const reply = await send(PLANE_PUSH_REPORT_PATH, parsed.data);
      if (reply?.status === 200) return PlanePushReportReply.safeParse(reply.body).success ? { kind: "recorded" } : fail(reply, "invalid_reply");
      if (reply?.status === 403 && errorCodeOf(reply.body) === "not_paired") return { kind: "not_paired" };
      if (reply?.status === 409) {
        const stop = StopReply.safeParse(reply.body);
        if (stop.success) return { kind: "stop", reason: stop.data.reason };
      }
      return fail(reply);
    },

    async memoryProposals(message) {
      const parsed = MemoryProposalsMessage.safeParse(message);
      if (!parsed.success) return fail(undefined, "invalid_message");
      const reply = await send(MEMORY_PROPOSALS_PATH, parsed.data);
      if (reply?.status === 200) {
        const body = MemoryProposalsReply.safeParse(reply.body);
        return body.success ? { kind: "sent", ...body.data } : fail(reply, "invalid_reply");
      }
      const code = reply === undefined ? undefined : errorCodeOf(reply.body);
      if ((reply?.status === 403 || reply?.status === 409) && (code === "run_not_yours" || code === "run_not_finished" || code === "capability_missing")) return { kind: "refused", code };
      return fail(reply);
    },

    async planeMergeClaim() {
      const reply = await send(PLANE_MERGE_CLAIM_PATH, PlaneMergeClaimMessage.parse({}));
      if (reply?.status === 200) {
        const parsed = PlaneMergeClaimReply.safeParse(reply.body);
        if (!parsed.success) return fail(reply, "invalid_reply");
        return "order_id" in parsed.data ? { kind: "order", order: parsed.data } : { kind: "none", retryAfter: parsed.data.retry_after };
      }
      if (reply?.status === 409) return { kind: "fenced" };
      return fail(reply);
    },

    async planeMergeVerify(message) {
      const parsed = PlaneMergeVerifyMessage.safeParse(message);
      if (!parsed.success) return fail(undefined, "invalid_message");
      const reply = await send(PLANE_MERGE_VERIFY_PATH, parsed.data);
      if (reply?.status === 200) {
        const body = PlaneMergeVerifyReply.safeParse(reply.body);
        if (!body.success) return fail(reply, "invalid_reply");
        const d = body.data;
        if (d.go) return { kind: "go", token: d.token, expiresAt: d.expires_at, sha: d.sha, ...(d.merge_mode === undefined ? {} : { mergeMode: d.merge_mode }) };
        return "head_moved" in d ? { kind: "head_moved" } : { kind: "no_go", reasons: d.reasons };
      }
      if (reply?.status === 409) {
        const code = errorCodeOf(reply.body);
        return { kind: "fenced", ...(code === undefined ? {} : { code }) };
      }
      return fail(reply);
    },

    async planeMergeReport(message) {
      const parsed = PlaneMergeReportMessage.safeParse(message);
      if (!parsed.success) return fail(undefined, "invalid_message");
      const reply = await send(PLANE_MERGE_REPORT_PATH, parsed.data);
      if (reply?.status === 200) return PlaneMergeReportReply.safeParse(reply.body).success ? { kind: "recorded" } : fail(reply, "invalid_reply");
      if (reply?.status === 503) {
        const retry = PlaneMergeRetryReply.safeParse(reply.body);
        if (retry.success) return { kind: "retry", retryAfter: retry.data.retry_after };
      }
      if (reply?.status === 409) {
        const code = errorCodeOf(reply.body);
        return { kind: "fenced", ...(code === undefined ? {} : { code }) };
      }
      return fail(reply);
    },

    async deployOrderClaim() {
      const reply = await send(DEPLOY_ORDER_CLAIM_PATH, DeployOrderClaimMessage.parse({}));
      if (reply?.status === 200) {
        const parsed = DeployOrderClaimReply.safeParse(reply.body);
        if (!parsed.success) return fail(reply, "invalid_reply");
        return "order_id" in parsed.data ? { kind: "order", order: parsed.data } : { kind: "none", retryAfter: parsed.data.retry_after };
      }
      if (reply?.status === 409) return { kind: "fenced" };
      return fail(reply);
    },

    async deployOrderReport(message) {
      const parsed = DeployOrderReportMessage.safeParse(message);
      if (!parsed.success) return fail(undefined, "invalid_message");
      const reply = await send(DEPLOY_ORDER_REPORT_PATH, parsed.data);
      if (reply?.status === 200) return DeployOrderReportReply.safeParse(reply.body).success ? { kind: "recorded" } : fail(reply, "invalid_reply");
      if (reply?.status === 409) {
        const code = errorCodeOf(reply.body);
        return { kind: "fenced", ...(code === undefined ? {} : { code }) };
      }
      return fail(reply);
    },

    async machineJobClaim() {
      const reply = await send(MACHINE_JOB_CLAIM_PATH, MachineJobClaimMessage.parse({}));
      if (reply?.status !== 200) return fail(reply);
      const parsed = MachineJobClaimReply.safeParse(reply.body);
      if (!parsed.success) return fail(reply, "invalid_reply");
      return "signed_job" in parsed.data ? { kind: "job", signedJob: parsed.data.signed_job } : { kind: "none", retryAfter: parsed.data.retry_after };
    },

    async setupProgress(setupId, body) {
      const parsed = SetupProgressBody.safeParse(body);
      if (!parsed.success || !UUID_TEXT.test(setupId)) return fail(undefined, "invalid_message");
      const reply = await send(setupProgressPath(setupId), parsed.data);
      if (reply?.status === 200) return SetupProgressReply.safeParse(reply.body).success ? { kind: "recorded" } : fail(reply, "invalid_reply");
      if (reply?.status === 404 || reply?.status === 409) {
        const code = errorCodeOf(reply.body);
        return { kind: "refused", status: reply.status, ...(code === undefined ? {} : { code }) };
      }
      return fail(reply);
    },

    async machineJobProgress(jobId, body) {
      const parsed = SessionJobProgressBody.safeParse(body);
      if (!parsed.success || !UUID_TEXT.test(jobId)) return fail(undefined, "invalid_message");
      const reply = await send(machineJobProgressPath(jobId), parsed.data);
      if (reply?.status === 200) return SetupProgressReply.safeParse(reply.body).success ? { kind: "recorded" } : fail(reply, "invalid_reply");
      if (reply?.status === 404 || reply?.status === 409) {
        const code = errorCodeOf(reply.body);
        return { kind: "refused", status: reply.status, ...(code === undefined ? {} : { code }) };
      }
      return fail(reply);
    },

    async setupPushToken(setupId, jobId) {
      if (!UUID_TEXT.test(setupId)) return fail(undefined, "invalid_message");
      const reply = await send(setupPushTokenPath(setupId), SetupPushTokenMessage.parse({ job_id: jobId }));
      if (reply?.status === 200) {
        const parsed = SetupPushTokenReply.safeParse(reply.body);
        return parsed.success ? { kind: "token", token: parsed.data.token, expiresAt: parsed.data.expires_at } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 404 || reply?.status === 409 || reply?.status === 502) {
        const code = errorCodeOf(reply.body);
        return { kind: "refused", status: reply.status, ...(code === undefined ? {} : { code }) };
      }
      return fail(reply);
    },

    async setupPlan(setupId, version) {
      if (!UUID_TEXT.test(setupId) || !Number.isSafeInteger(version) || version < 1) return fail(undefined, "invalid_message");
      let reply: CloudReply | undefined;
      try {
        reply = await signedGet({ origin: config.origin, path: setupPlanPath(setupId, version), key: config.key, now: config.now(), fetchFn: config.fetchFn, bypass: config.bypass, headers: { accept: "application/json" } });
      } catch {
        // fx-swallow-ok: signedGet reports a network failure in fixed words; the caller sees status 0 and reports plan_fetch_failed
        reply = undefined;
      }
      if (reply?.status === 200) return Buffer.byteLength(reply.raw ?? "") > MAX_PLAN_BYTES ? { kind: "too_large" } : { kind: "plan", text: reply.raw ?? "" };
      if (reply?.status === 404) return { kind: "missing" };
      return fail(reply);
    },

    async machineLoginReport(requestId, report) {
      const parsed = MachineLoginReport.safeParse(report);
      if (!parsed.success || !UUID_TEXT.test(requestId)) return fail(undefined, "invalid_message");
      const reply = await send(machineLoginReportPath(requestId), parsed.data);
      if (reply?.status === 200) return { kind: "recorded" };
      if (reply?.status === 404 || reply?.status === 409) {
        const code = errorCodeOf(reply.body);
        return { kind: "refused", status: reply.status, ...(code === undefined ? {} : { code }) };
      }
      return fail(reply);
    },

    async machineLoginCode(requestId) {
      if (!UUID_TEXT.test(requestId)) return fail(undefined, "invalid_message");
      let reply: CloudReply | undefined;
      try {
        reply = await signedGet({ origin: config.origin, path: machineLoginCodePath(requestId), key: config.key, now: config.now(), fetchFn: config.fetchFn, bypass: config.bypass, headers: { accept: "application/json" } });
      } catch {
        // fx-swallow-ok: signedGet reports a network failure in fixed words; the caller counts it as a failed fetch
        reply = undefined;
      }
      if (reply?.status === 410) return { kind: "gone" };
      if (reply?.status === 200) {
        const body = typeof reply.body === "object" && reply.body !== null && !Array.isArray(reply.body) ? (reply.body as Record<string, unknown>) : {};
        const code = MachineLoginCode.safeParse(body["code"]);
        return code.success ? { kind: "code", code: code.data } : fail(undefined, "invalid_reply");
      }
      return fail(reply);
    },

    async events(runId, leaseGeneration, events) {
      const reply = await send(eventsPath(runId), EventsMessage.parse({ run_id: runId, lease_generation: leaseGeneration, events }));
      if (reply?.status === 200) {
        const parsed = EventsReply.safeParse(reply.body);
        return parsed.success ? { kind: "ok", accepted: parsed.data.accepted, duplicates: parsed.data.duplicates, leaseExpiresAt: parsed.data.lease_expires_at } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 409) {
        const stop = StopReply.safeParse(reply.body);
        if (stop.success) return { kind: "stop", reason: stop.data.reason };
        const behind = SeqNotIncreasingReply.safeParse(reply.body);
        return behind.success ? { kind: "seq_not_increasing", lastAcceptedSeq: behind.data.last_accepted_seq } : fail(reply, "invalid_reply");
      }
      return fail(reply);
    },

    async done(input) {
      const base = { run_id: input.runId, lease_generation: input.leaseGeneration, ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }), ...(input.check === undefined ? {} : { check: input.check }), ...(input.conflictAttest === undefined ? {} : { conflict_attest: input.conflictAttest }) };
      // The ledger is advisory too: one the protocol refuses is left out, and so is it once an older cloud has refused the field.
      const ledger = input.contextLedger !== undefined && !cloudRefusesLedger ? { context_ledger: input.contextLedger } : {};
      const build = (extra: Record<string, unknown>) => {
        // The envelope is advisory: one the protocol refuses (too large or too deep) is left out rather than failing the run.
        const withOutput = input.agentOutput === undefined ? undefined : DoneMessage.safeParse({ ...base, ...extra, agentOutput: input.agentOutput });
        return withOutput?.success ? withOutput : DoneMessage.safeParse({ ...base, ...extra });
      };
      let message = build(ledger);
      if (!message.success && "context_ledger" in ledger) message = build({});
      if (!message.success) return fail(undefined, "invalid_message");
      let reply = await send(donePath(input.runId), message.data);
      // A cloud from before CX-1b refuses the unknown key with 400 invalid_message before it looks at the run (nothing is written), so the
      // same `done` goes again without it, and the runner stops sending it to this cloud.
      if (reply?.status === 400 && message.data.context_ledger !== undefined && errorCodeOf(reply.body) === "invalid_message") {
        cloudRefusesLedger = true;
        const without = build({});
        if (without.success) reply = await send(donePath(input.runId), without.data);
      }
      if (reply?.status === 200) {
        const parsed = DoneReply.safeParse(reply.body);
        return parsed.success ? { kind: "done", outcome: parsed.data.outcome, failureReason: parsed.data.failure_reason, prNumber: parsed.data.pr_number } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 409) {
        const parsed = StopReply.safeParse(reply.body);
        return parsed.success ? { kind: "stop", reason: parsed.data.reason } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 503) {
        const parsed = DoneRetryReply.safeParse(reply.body);
        // A 503 with an error body (no worker configured) is not the "GitHub could not be asked" reply: it falls through to an error.
        if (parsed.success) return { kind: "retry", retryAfter: parsed.data.retry_after };
      }
      return fail(reply);
    },
  };
}
