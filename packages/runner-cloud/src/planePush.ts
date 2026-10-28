import { publicPullRequestUrlMatches } from "@fx/core/src/repos/planePushRecord.js";
import { buildPlanePushText } from "@fx/core/src/repos/planePushText.js";
import {
  PLANE_PUSH_PAIRING_PATH,
  PLANE_PUSH_REPORT_PATH,
  PLANE_PUSH_TOKEN_PATH,
  PlanePushPairingMessage,
  PlanePushPairingReply,
  PlanePushReportMessage,
  PlanePushReportReply,
  PlanePushTokenMessage,
  PlanePushTokenReply,
} from "@fulcrumaxe/runner-protocol";
import { stopReply } from "./heartbeat.js";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, requireLeases, type PlanePushHostedPort, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse, type RunnerLeaseOps } from "./http.js";
import { verifyRunnerRequest } from "./verifyRunnerRequest.js";

/**
 * D#598 P1f-2 (Correction C4, point 1a): the two routes a runner's run-end hook uses to publish a paired repo's change to its PUBLIC repo.
 *
 * Both are verified exactly as `git-ticket` is: the RFC 9421 signature with a single-use nonce, the strict message, the lease fence WITHOUT
 * extending the lease, and then facts from OUR rows only. Nothing the runner sends names the repo, the branch or the base.
 *
 *   POST /api/runner/plane-push-token   the ONE restricted token this run's hook may push with. One grant per (run, lease generation): the attempt
 *                                       row is written BEFORE the token is minted, so a second request mints nothing (409 `already_issued`). The
 *                                       token is minted anew (never from a cache), is not stored here, and is not revoked here; the hook revokes it.
 *   POST /api/runner/plane-push-report  what the hook did, as a HINT. For `pushed`, `pr_opened` and `pr_failed` the hosted side reads GitHub with its
 *                                       own token before it records anything: the branch head, the head's single parent, that parent in public
 *                                       `main`'s history, and for a pull request its head ref, repository, base and address. A mismatch records
 *                                       `refused` with `report_mismatch` and stores nothing from the report.
 *
 *   POST /api/runner/plane-push-pairing  (P1f-2b) the repository's pairing as it is NOW, only while its digest equals the one stamped at build start.
 *                                       Read-only: it mints nothing, writes nothing, asks GitHub nothing and has no use-once rule, because the hook
 *                                       calls it twice by design (load, then re-check after its scan). The token reply cannot do that job: a use-once
 *                                       reply read twice is the same bytes, so the second compare would be vacuous.
 *
 * The token reply also carries the pull request title and body (built by `buildPlanePushText` from our work item row and the run id, never from
 * anything an agent wrote) and the platform commit identity (a hosted setting, checked BEFORE the grant so a missing setting spends no attempt).
 * A report that says something exists on GitHub echoes the pairing digest; the cloud compares it with its stamp and never uses the value.
 *
 * This file imports no git code and runs no process: it cannot clone, fetch or push. A test follows the import graph to keep it so.
 *
 * Statuses: 403 `not_paired` (not an executor run on a runner, or the item has no record for the run's own repository), 409 `pairing_changed`
 * (token only: the pairing was removed or edited since the build started), 409 `already_issued`, 409 `attempts_exhausted`, 409/502/503 for a mint
 * GitHub refused, 503 `not_configured` while the worker or the GitHub side is not wired, 503 `public_unavailable` when GitHub could not be asked.
 *
 * The pairing-digest check is on the token route only. A report states what happened on the repository the build STAMPED; it is checked against
 * that repository on GitHub, so a pairing edited after the build started must still be able to record its `pairing_changed` refusal.
 */

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * The refusal codes a hook may report: the push route's fixed list (`PLANE_REFUSAL_CODES` in packages/pipeline, which this package cannot import;
 * packages/worker/test/planePushCodes.test.ts keeps the two equal). A report with any other code is recorded as `push_failed`, so a buggy or hostile
 * runner cannot store a code the item view has no sentence for. `report_mismatch` is the cloud's own and is not on the list.
 */
export const PLANE_PUSH_REPORT_CODES: readonly string[] = [
  "bad_input", "pairing_self", "pairing_changed", "base_diverged", "no_changes", "scan_refused", "scan_identity_mismatch", "public_unavailable",
  "public_tip_moved", "app_not_installed", "token_scope_mismatch", "branch_exists", "push_failed", "pr_failed", "unsafe_git_config", "public_branch_moved", "republish_base_missing",
  "rule_files_not_private", "private_read_failed", "base_not_ancestor",
];

function requirePlanePush(deps: RunnerCloudDeps): PlanePushHostedPort {
  if (!deps.planePush) throw new RunnerHttpError(503, "not_configured", "the runner API has no GitHub access for public pushes configured");
  return deps.planePush;
}

type PlanePushOps = Required<Pick<RunnerLeaseOps, "planePushGrant" | "planePushSettleGrant" | "planePushReportContext" | "planePushRecordReport">>;

function requirePlanePushOps(deps: RunnerCloudDeps): PlanePushOps {
  const leases = requireLeases(deps);
  if (!leases.planePushGrant || !leases.planePushSettleGrant || !leases.planePushReportContext || !leases.planePushRecordReport) {
    throw new RunnerHttpError(503, "not_configured", "the runner API has no worker configured");
  }
  return leases as PlanePushOps;
}

/** The fixed code a GitHub-side failure carries (`PlanePushApiError.code`), or null for anything else. */
function failureCode(error: unknown): string | null {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "app_not_installed" || code === "code_repo_installation_not_owned" || code === "token_scope_mismatch" || code === "public_unavailable" || code === "not_configured" ? code : null;
}

export async function planePushTokenRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, PLANE_PUSH_TOKEN_PATH, req, { replay: "once" });
  const message = parseMessage(PlanePushTokenMessage, parseJsonBody(req));
  const ops = requirePlanePushOps(deps);
  const port = requirePlanePush(deps);
  // The platform identity is a hosted setting. A missing or malformed one answers before any grant, so a misconfiguration does not burn one of the
  // three push attempts and GitHub is not asked for a token nobody can use.
  const identity = deps.planePushIdentity?.() ?? null;
  if (!identity) throw new RunnerHttpError(503, "not_configured", "the platform identity for public pushes is not configured");
  // The schema accepts an uppercase uuid and the database matches it either way, so the id is lowercased once, here, and used everywhere below
  // (the text builder wants the canonical form). A run id the builder refuses is a plain 400 now, before a grant, an attempt or a mint exists.
  const runId = message.run_id.toLowerCase();
  try {
    buildPlanePushText({ itemTitle: "", runId });
  } catch {
    throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  }
  const lease = { accountId: runner.accountId, runnerId: runner.runnerId, runId, leaseGeneration: message.lease_generation };

  const grant = await asRunner(() => ops.planePushGrant(lease));
  switch (grant.kind) {
    case "fenced":
      return stopReply(grant.reason);
    case "not_paired":
      throw new RunnerHttpError(403, "not_paired", "this run has no public repository to push to");
    case "pairing_changed":
      throw new RunnerHttpError(409, "pairing_changed", "the repository's pairing changed after the build started");
    case "already_issued":
      throw new RunnerHttpError(409, "already_issued", "a token was already issued for this run");
    case "attempts_exhausted":
      throw new RunnerHttpError(409, "attempts_exhausted", "this change has used all its push attempts");
    case "refused":
      // FIXROUND-REPUBLISH (R2-c1): a fix round without a signed base. D#483 S5-b2c-4: or a planned PR child whose build identity was refused; the resolver's fixed code is the status's code.
      if (grant.code !== "republish_base_missing") throw new RunnerHttpError(409, grant.code, "this planned PR can no longer publish: its build identity was refused");
      throw new RunnerHttpError(409, "republish_base_missing", "this fix round has no signed base to update the public pull request from");
    case "granted":
      break;
  }

  // The text needs the item title, which the grant reads, so it is built right after the grant and before anything is minted: nothing past this line
  // can fail on the text, and a failure here finishes the attempt without a token ever existing.
  let pr: ReturnType<typeof buildPlanePushText>;
  try {
    pr = buildPlanePushText({ itemTitle: grant.itemTitle, runId, prFooter: grant.prFooter, issueNumber: grant.issueNumber, child: grant.child });
  } catch (error) {
    await asRunner(() => ops.planePushSettleGrant({ ...lease, attemptId: grant.attemptId, issued: false, code: "text_failed" }));
    throw error;
  }

  let minted: { token: string; expiresAt: Date };
  try {
    minted = await port.mintToken(grant.codeRepo, runner.accountId);
  } catch (error) {
    const code = failureCode(error);
    // The grant is spent either way (no token existed, but one request is one grant); the attempt records why.
    await asRunner(() => ops.planePushSettleGrant({ ...lease, attemptId: grant.attemptId, issued: false, code: code ?? "mint_failed" }));
    // The paired repo's installation belongs to another account: the person sees the same plain sentence as for a missing install; the attempt keeps the exact code.
    if (code === "app_not_installed" || code === "code_repo_installation_not_owned") throw new RunnerHttpError(409, "app_not_installed", "the GitHub App is not installed on the public repository");
    if (code === "token_scope_mismatch") throw new RunnerHttpError(502, "token_scope_mismatch", "GitHub did not narrow the token as asked");
    if (code === "public_unavailable") throw new RunnerHttpError(503, "public_unavailable", "GitHub could not be asked");
    if (code === "not_configured") throw new RunnerHttpError(503, "not_configured", "the runner API has no GitHub App configured");
    throw error;
  }
  // From here the token exists and nobody has it. Anything that stops it reaching the runner revokes it first, so no token outlives a failed hand-over.
  try {
    const settled = await asRunner(() => ops.planePushSettleGrant({ ...lease, attemptId: grant.attemptId, issued: true }));
    if (!settled) throw new RunnerHttpError(500, "internal", "internal error");
    return {
      status: 200,
      body: PlanePushTokenReply.parse({ token: minted.token, expires_at: minted.expiresAt.toISOString(), code_repo: grant.codeRepo, branch: grant.branch, base: "main", pr, identity: { name: identity.name, email: identity.email }, ...(grant.updateOf === null ? {} : { replaces_head: grant.updateOf }) }),
      headers: NO_STORE,
    };
  } catch (error) {
    await port.revokeToken(minted.token);
    throw error;
  }
}

/**
 * POST /api/runner/plane-push-pairing. Same order as the token route (signature with a single-use nonce, the strict message, the lease fence
 * without extending the lease, then our own rows), but nothing here is granted or recorded.
 */
export async function planePushPairingRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, PLANE_PUSH_PAIRING_PATH, req, { replay: "once" });
  const message = parseMessage(PlanePushPairingMessage, parseJsonBody(req));
  const leases = requireLeases(deps);
  if (!leases.planePushPairing) throw new RunnerHttpError(503, "not_configured", "the runner API has no worker configured");
  const lease = { accountId: runner.accountId, runnerId: runner.runnerId, runId: message.run_id, leaseGeneration: message.lease_generation };
  const found = await asRunner(() => leases.planePushPairing!(lease));
  switch (found.kind) {
    case "fenced":
      return stopReply(found.reason);
    case "not_paired":
      throw new RunnerHttpError(403, "not_paired", "this run has no public repository to push to");
    case "pairing_changed":
      // No pairing in the body: the answer must not hand a hook a pairing the build did not start with.
      throw new RunnerHttpError(409, "pairing_changed", "the repository's pairing changed after the build started");
    case "pairing":
      return {
        status: 200,
        body: PlanePushPairingReply.parse({
          code_repo: found.codeRepo,
          overlay_globs: found.overlayGlobs,
          identifier_rules_path: found.identifierRulesPath,
          plan_data_rules_path: found.planDataRulesPath,
          pairing_digest: found.pairingDigest,
        }),
        headers: NO_STORE,
      };
  }
}

type Recorded = Parameters<PlanePushOps["planePushRecordReport"]>[0];

/** What a verified (or mismatched) report becomes: the item's new state, whether it ends the hook, and the attempt's label. */
interface Decision {
  outcome: Recorded["outcome"];
  terminal: boolean;
  label: string;
  /** True for a report that changes nothing and asked GitHub nothing (the attempt is already finished, or this phase was already verified). */
  skip?: boolean;
}

const NOOP: Decision = { outcome: null, terminal: false, label: "noop", skip: true };

const MISMATCH: Decision = { outcome: { state: "refused", code: "report_mismatch" }, terminal: true, label: "report_mismatch" };

const bad = (): never => {
  throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
};

/**
 * The report is a hint. For a phase that says something exists on GitHub, GitHub is asked (with the hosted side's own token) and the answer
 * decides; the runner's `branch` is compared with the record's and never used.
 */
async function decide(m: PlanePushReportMessage, plane: { codeRepo: string; branch: string; pairingDigest: string; state: string }, attempt: { tokenIssued: boolean; finished: boolean; outcome: string | null } | null, port: PlanePushHostedPort, accountId: string): Promise<Decision> {
  switch (m.phase) {
    case "building":
      // The build start already stamped `building`; a report must never move a later state back to it.
      return { outcome: null, terminal: false, label: "building" };
    case "scanning":
      return { outcome: { state: "scanning" }, terminal: false, label: "scanning" };
    case "no_change":
      return { outcome: { state: "no_public_change" }, terminal: true, label: "no_change" };
    case "refused": {
      if (m.code === undefined) return bad();
      const code = PLANE_PUSH_REPORT_CODES.includes(m.code) ? m.code : "push_failed";
      return { outcome: { state: "refused", code, ...(m.refusals ? { refusals: m.refusals } : {}) }, terminal: true, label: code };
    }
    case "pushed":
    case "pr_failed":
    case "updated":
    case "pr_opened": {
      if (m.head_sha === undefined || m.tip_sha === undefined) return bad();
      if (m.phase === "pr_opened" && m.pr_number === undefined) return bad();
      // Bounded work per attempt: once it has finished, or this phase was already verified, a report costs nothing (no mint, no GitHub read). A push is
      // therefore verified at most twice per attempt: once as `pushed`, once as the report that ends it.
      if (attempt?.finished || (m.phase === "pushed" && attempt?.outcome === "pushed")) return NOOP;
      // The hook echoes the digest of the pairing it scanned against. It must equal the one stamped at build start; the value is never used, only compared.
      if (m.pairing_digest !== plane.pairingDigest) return MISMATCH;
      // The reads below know 40-character shas only. Another length is a fixed refusal now, not a 503 on every retry.
      if (m.head_sha.length !== 40 || m.tip_sha.length !== 40) return { outcome: { state: "refused", code: "bad_input" }, terminal: true, label: "bad_input" };
      // A push needs the token this run was granted; a report of one without a grant cannot be true. The branch is the record's, whatever the runner says.
      if (!attempt?.tokenIssued || (m.branch !== undefined && m.branch !== plane.branch)) return MISMATCH;
      const input = { accountId, codeRepo: plane.codeRepo, branch: plane.branch, headSha: m.head_sha, tipSha: m.tip_sha };
      // An update is only ever of a pull request that is open (the grant gave the hook no token otherwise); the same read of GitHub as a first push decides it: head, its single parent, that parent in public main.
      if (m.phase === "updated" && plane.state !== "pr_opened") return MISMATCH;
      if (!(await port.verifyPushed(input))) return MISMATCH;
      if (m.phase === "updated") return { outcome: { state: "updated", headSha: m.head_sha, tipSha: m.tip_sha }, terminal: true, label: "updated" };
      if (m.phase === "pushed") return { outcome: { state: "pushed", headSha: m.head_sha, tipSha: m.tip_sha }, terminal: false, label: "pushed" };
      if (m.phase === "pr_failed") return { outcome: { state: "pushed_pr_not_opened", headSha: m.head_sha, tipSha: m.tip_sha }, terminal: true, label: "pr_failed" };
      const pr = await port.verifyPullRequest({ accountId, codeRepo: plane.codeRepo, branch: plane.branch, number: m.pr_number! });
      // The address stored is the paired repository's pull request of the reported number, whatever the read returned.
      if (!pr || !publicPullRequestUrlMatches(plane.codeRepo, m.pr_number!, pr.url)) return MISMATCH;
      return { outcome: { state: "pr_opened", headSha: m.head_sha, tipSha: m.tip_sha, prNumber: m.pr_number!, prUrl: pr.url }, terminal: true, label: "pr_opened" };
    }
  }
}

export async function planePushReportRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, PLANE_PUSH_REPORT_PATH, req, { replay: "once" });
  const message = parseMessage(PlanePushReportMessage, parseJsonBody(req));
  const ops = requirePlanePushOps(deps);
  const port = requirePlanePush(deps);
  const lease = { accountId: runner.accountId, runnerId: runner.runnerId, runId: message.run_id, leaseGeneration: message.lease_generation };

  const context = await asRunner(() => ops.planePushReportContext(lease));
  if (context.kind === "fenced") return stopReply(context.reason);
  if (context.kind === "not_paired") throw new RunnerHttpError(403, "not_paired", "this run has no public repository to push to");

  let decision: Decision;
  try {
    decision = await decide(message, context.plane, context.attempt, port, runner.accountId);
  } catch (error) {
    // GitHub could not be asked: nothing is recorded, and the hook sends the report again.
    if (failureCode(error) === "not_configured") throw new RunnerHttpError(503, "not_configured", "the runner API has no GitHub App configured");
    if (failureCode(error) !== null) throw new RunnerHttpError(503, "public_unavailable", "GitHub could not be asked");
    throw error;
  }

  if (decision.skip) return { status: 200, body: PlanePushReportReply.parse({ recorded: true }), headers: NO_STORE };
  const done = await asRunner(() =>
    ops.planePushRecordReport({ ...lease, planePushId: context.plane.id, outcome: decision.outcome, terminal: decision.terminal, label: decision.label, ...(message.token_revoked !== undefined ? { tokenRevoked: message.token_revoked } : {}) }),
  );
  if (done.kind === "fenced") return stopReply(done.reason);
  if (done.kind === "not_paired") throw new RunnerHttpError(403, "not_paired", "this run has no public repository to push to");
  return { status: 200, body: PlanePushReportReply.parse({ recorded: true }), headers: NO_STORE };
}
