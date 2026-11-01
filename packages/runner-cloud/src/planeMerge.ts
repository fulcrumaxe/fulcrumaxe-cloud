import {
  CLAIM_IDLE_RETRY_AFTER_SECONDS,
  PLANE_MERGE_CLAIM_PATH,
  PLANE_MERGE_QUEUE_CAPABILITY,
  PLANE_MERGE_REPORT_PATH,
  PLANE_MERGE_VERIFY_PATH,
  PlaneMergeClaimMessage,
  PlaneMergeClaimReply,
  PlaneMergeReportMessage,
  PlaneMergeReportReply,
  PlaneMergeRetryReply,
  PlaneMergeVerifyMessage,
  PlaneMergeVerifyReply,
} from "@fulcrumaxe/runner-protocol";
import { reportError } from "@fx/telemetry";
import { RunnerHttpError, asRunner, parseJsonBody, parseMessage, type PlaneMergeLease, type PlaneMergeOrderFacts, type PlaneMergePort, type PlanePushHostedPort, type RunnerCloudDeps, type RunnerHttpRequest, type RunnerHttpResponse } from "./http.js";
import { verifyRunnerRequest } from "./verifyRunnerRequest.js";

/**
 * D#6 PUBLIC-MERGE PR2b: the three routes by which a paired `runner_local` item's PUBLIC pull request is merged by the customer's own runner. The cloud decides
 * (the whole gate, run again on fresh reads), the runner checks content and merges, and GitHub enforces the `sha`. The cloud never calls merge on this
 * repository and never reads its contents or patches.
 *
 * Each route is verified as `plane-push-token` is: the RFC 9421 signature with a single-use nonce, the strict message, then the order's lease fence WITHOUT
 * extending the lease, then facts from OUR rows only. Nothing a runner sends names a repository, branch, pull request or sha that is then USED: every such
 * value in a message is compared with the order's own row and a difference is refused.
 *
 *   POST /api/runner/plane-merge-claim    the oldest order this runner may take (eligibility is computed in SQL at claim time), leased for ten minutes, with the
 *                                         bound facts and the one READ credential of this (order, lease generation) for the code repository.
 *   POST /api/runner/plane-merge-verify   the runner's content check, bound to both shas. The runner's trust is read again; the whole gate runs again; and only
 *                                         when nothing blocks is the ONE write credential of the order issued (grant written first, then minted). A second verify
 *                                         for an order is 409 `already_issued`.
 *   POST /api/runner/plane-merge-report   what the runner did, as a HINT. The cloud asks GitHub through its own fenced client and records `merged` only when
 *                                         `merged_at` is set and the head is the order's expected head (`settleAuthorizedOrder`). GitHub unreachable: nothing is
 *                                         recorded and the answer is 503 with `retry_after`.
 *
 * The cloud keeps no copy of either credential. A credential that cannot be handed over (the reply cannot be built, a step after the grant throws) is revoked
 * before the error leaves, and the order is ended. The runner revokes what it was handed; the cloud cannot see whether it did.
 *
 * Statuses: 401 (unsigned or wrong runner), 400 (invalid message), 403 `runner_not_trusted`, 409 `fenced` (with the reason), 409 `order_mismatch`,
 * 409 `already_issued`, 409 `not_authorized`, 502/503 for a mint GitHub refused, 503 `not_configured`, 503 `public_unavailable`.
 */

const NO_STORE = { "cache-control": "no-store" } as const;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;

function requirePlaneMerge(deps: RunnerCloudDeps): { merge: PlaneMergePort; hosted: Required<Pick<PlanePushHostedPort, "mintMergeToken" | "revokeToken">> } {
  const merge = deps.planeMerge;
  const hosted = deps.planePush;
  if (!merge || !hosted || !hosted.mintMergeToken) throw new RunnerHttpError(503, "not_configured", "the runner API has no merge-order access configured");
  return { merge, hosted: { mintMergeToken: hosted.mintMergeToken.bind(hosted), revokeToken: hosted.revokeToken.bind(hosted) } };
}

const fenced = (reason: string): RunnerHttpError => new RunnerHttpError(409, "fenced", "the runner no longer holds this order", { reason });

/** The fixed code a GitHub-side failure carries (`PlanePushApiError.code`), or null for anything else. */
function failureCode(error: unknown): string | null {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "app_not_installed" || code === "code_repo_installation_not_owned" || code === "token_scope_mismatch" || code === "public_unavailable" || code === "not_configured" ? code : null;
}

/** A failure of the GitHub side as the status a runner sees. Anything else is rethrown as it is. */
function mapGitHubFailure(error: unknown): never {
  const code = failureCode(error);
  if (code === "app_not_installed" || code === "code_repo_installation_not_owned") throw new RunnerHttpError(409, "app_not_installed", "the GitHub App is not installed on the public repository");
  if (code === "token_scope_mismatch") throw new RunnerHttpError(502, "token_scope_mismatch", "GitHub did not narrow the token as asked");
  if (code === "not_configured") throw new RunnerHttpError(503, "not_configured", "the runner API has no GitHub App configured");
  if (code === "public_unavailable") throw new RunnerHttpError(503, "public_unavailable", "GitHub could not be asked");
  throw error;
}

const leaseOf = (runner: { accountId: string; runnerId: string }, orderId: string, leaseGeneration: number): PlaneMergeLease => ({ accountId: runner.accountId, runnerId: runner.runnerId, orderId: orderId.toLowerCase(), leaseGeneration });

/** The sanitized reason codes of a gate stop: fixed snake_case words only, at most 40. Never empty. */
function safeReasons(reasons: readonly string[], fallback: string): string[] {
  const kept = [...new Set(reasons.filter((r) => REASON.test(r)))].slice(0, 40);
  return kept.length > 0 ? kept : [fallback];
}

export async function planeMergeClaimRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, PLANE_MERGE_CLAIM_PATH, req, { replay: "once" });
  parseMessage(PlaneMergeClaimMessage, parseJsonBody(req));
  const { merge, hosted } = requirePlaneMerge(deps);
  const claimed = await asRunner(() => merge.store.claimNext({ accountId: runner.accountId, runnerId: runner.runnerId }));
  if (claimed.kind === "none") return { status: 200, body: PlaneMergeClaimReply.parse({ retry_after: CLAIM_IDLE_RETRY_AFTER_SECONDS }), headers: { ...NO_STORE, "retry-after": String(CLAIM_IDLE_RETRY_AFTER_SECONDS) } };
  const { order, facts } = claimed;
  const lease = leaseOf(runner, order.id, order.leaseGeneration);
  // One read credential per (order, lease generation): the grant is written BEFORE the mint, so a second ask mints nothing.
  const grant = await asRunner(() => merge.store.grantReadToken(lease));
  if (grant.kind === "fenced") throw fenced(grant.reason);
  if (grant.kind === "already_issued") throw new RunnerHttpError(409, "already_issued", "a read credential was already issued for this claim");
  let minted: { token: string; expiresAt: Date };
  try {
    minted = await hosted.mintMergeToken(order.codeRepo, runner.accountId, "read");
  } catch (error) {
    // fx-swallow-ok: mapped to a fixed status by mapGitHubFailure (or rethrown); the claim stands (attempts count) and the lease lapses, so the order is offered again
    return mapGitHubFailure(error);
  }
  try {
    return {
      status: 200,
      body: PlaneMergeClaimReply.parse({
        order_id: order.id,
        lease_generation: order.leaseGeneration,
        code_repo: order.codeRepo,
        pr_number: order.prNumber,
        public_branch: facts.publicBranch,
        expected_public_head: order.expectedPublicHead,
        reviewed_head: order.reviewedHead,
        private_repo: { id: order.repoId, owner: facts.privateOwner, name: facts.privateName },
        overlay_globs: facts.overlayGlobs,
        pairing_digest: order.pairingDigest,
        read: { token: minted.token, expires_at: minted.expiresAt.toISOString() },
      }),
      headers: NO_STORE,
    };
  } catch (error) {
    await hosted.revokeToken(minted.token);
    throw error;
  }
}

export async function planeMergeVerifyRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, PLANE_MERGE_VERIFY_PATH, req, { replay: "once" });
  const message = parseMessage(PlaneMergeVerifyMessage, parseJsonBody(req));
  const { merge, hosted } = requirePlaneMerge(deps);
  const lease = leaseOf(runner, message.order_id, message.lease_generation);
  const fence = await asRunner(() => merge.store.fence(lease));
  if (fence.kind === "fenced") throw fenced(fence.reason);
  const order = fence.order;
  // Every bound value the runner repeats is compared with the order's own row; the order's values are the ones used.
  if (message.reviewed_head !== order.reviewedHead || message.public_head !== order.expectedPublicHead || message.pairing_digest !== order.pairingDigest) {
    throw new RunnerHttpError(409, "order_mismatch", "the message does not describe this order");
  }
  // One verify per order: the write credential is issued at most once, and a second ask never runs the gate.
  if (order.state !== "claimed" || order.writeTokenIssuedAt !== null) throw new RunnerHttpError(409, "already_issued", "a write credential was already issued for this order");
  // The runner's trust is read again now, not only at claim: it may have been revoked, paused or lost its registrant's role since.
  const trustedNow = () => asRunner(() => merge.store.runnerTrusted({ accountId: runner.accountId, runnerId: runner.runnerId, repoId: order.repoId }));
  if (!(await trustedNow())) throw new RunnerHttpError(403, "runner_not_trusted", "this runner may not act on this order now");

  // The credential, held only in this closure from the moment it is minted until it is in the reply (or revoked).
  let minted: { token: string; expiresAt: Date } | null = null;
  const settleFailed = async (code: string): Promise<void> => {
    await asRunner(() => merge.store.finish({ accountId: runner.accountId, orderId: order.id, to: "failed", code, actor: { by: "cloud" } })).catch((error: unknown) => reportError(error, { stage: "runner.plane_merge_settle", route: PLANE_MERGE_VERIFY_PATH }));
  };
  const delegate = async (): Promise<{ delegated: true }> => {
    // The gate reached its merge call: nothing blocks. Trust once more (the gate took time), then the grant, then the mint.
    if (!(await trustedNow())) throw new RunnerHttpError(403, "runner_not_trusted", "this runner may not act on this order now");
    const granted = await asRunner(() => merge.store.authorize(lease));
    if (granted.kind === "fenced") throw fenced(granted.reason);
    if (granted.kind === "already_issued") throw new RunnerHttpError(409, "already_issued", "a write credential was already issued for this order");
    try {
      minted = await hosted.mintMergeToken(order.codeRepo, runner.accountId, "write");
    } catch (error) {
      // fx-swallow-ok: mapped to a fixed status by mapGitHubFailure (or rethrown); the grant is spent and no credential exists, so the order ends failed and nothing waits for a merge that cannot happen
      await settleFailed("runner_merge_failed");
      return mapGitHubFailure(error);
    }
    return { delegated: true };
  };

  // D#694 B7-1: a queue repository's order goes only to a runner that can enqueue; the merge mode is sent only to such a runner (an older one's strict reply refuses the key).
  const queueCapable = await asRunner(() => merge.store.runnerHasCapability({ accountId: runner.accountId, runnerId: runner.runnerId, capability: PLANE_MERGE_QUEUE_CAPABILITY }));
  let result: Awaited<ReturnType<PlaneMergePort["goPhase"]>>;
  try {
    result = await merge.goPhase({
      accountId: runner.accountId,
      order,
      queueCapable,
      attestation: { reviewedHead: message.reviewed_head, publicHead: message.public_head, same: message.same, incomplete: message.incomplete, paths: message.paths },
      delegate,
    });
  } catch (error) {
    if (minted !== null) {
      // Something after the grant failed (recording the gate's outcome): the credential never reaches the runner, so it is revoked and the order ends.
      await hosted.revokeToken((minted as { token: string }).token);
      await settleFailed("runner_merge_failed");
    }
    if (error instanceof RunnerHttpError) throw error;
    // A gate that could not read GitHub (or any other failure): nothing was decided, the order stays leased, and the runner may ask again.
    reportError(error, { stage: "runner.plane_merge_gate", route: PLANE_MERGE_VERIFY_PATH });
    throw new RunnerHttpError(503, "public_unavailable", "GitHub could not be asked");
  }

  const endOrder = (to: string, code: string) => asRunner(() => merge.store.finish({ accountId: runner.accountId, orderId: order.id, to, code, actor: { by: "cloud" } }));
  switch (result.kind) {
    case "go": {
      const credential = minted as { token: string; expiresAt: Date } | null;
      if (credential === null) {
        await settleFailed("runner_merge_failed");
        throw new RunnerHttpError(500, "internal", "internal error");
      }
      try {
        return { status: 200, body: PlaneMergeVerifyReply.parse({ go: true, token: credential.token, expires_at: credential.expiresAt.toISOString(), sha: order.expectedPublicHead, ...(queueCapable ? { merge_mode: result.mergeMode } : {}) }), headers: NO_STORE };
      } catch (error) {
        await hosted.revokeToken(credential.token);
        await settleFailed("runner_merge_failed");
        throw error;
      }
    }
    case "blocked": {
      const reasons = safeReasons(result.reasons, "runner_merge_failed");
      await endOrder("blocked", reasons[0]!);
      return { status: 200, body: PlaneMergeVerifyReply.parse({ go: false, reasons }), headers: NO_STORE };
    }
    case "pr_not_open": {
      await endOrder("blocked", "public_pr_not_open");
      return { status: 200, body: PlaneMergeVerifyReply.parse({ go: false, reasons: ["public_pr_not_open"] }), headers: NO_STORE };
    }
    case "head_moved": {
      await endOrder("superseded", "public_head_moved");
      return { status: 200, body: PlaneMergeVerifyReply.parse({ go: false, head_moved: true }), headers: NO_STORE };
    }
    case "refused": {
      const reasons = safeReasons([result.reason], "runner_merge_failed");
      await endOrder("blocked", reasons[0]!);
      return { status: 200, body: PlaneMergeVerifyReply.parse({ go: false, reasons }), headers: NO_STORE };
    }
  }
}

/** What a runner (or the clock) says happened to an authorized order. Only ever a hint. */
export type SettleHint = { result: "merged" | "enqueued" | "refused" | "aborted"; abortCode?: string } | null;
export type SettleOutcome = { state: "merged" | "enqueued" | "head_moved" | "failed"; code: string; recorded: boolean } | { state: "unchanged" };

/**
 * Ends an AUTHORIZED order from what GitHub says through the cloud's own fenced client, never from a report: merged only when `merged_at` is set AND the head
 * is the order's expected head. The runner saying "merged" when GitHub does not say so (or names another head) is `runner_report_mismatch`; a moved head is
 * `head_moved` (the workflow re-reviews). Throws when GitHub cannot be asked, and then records nothing. Shared by the report route and the workflow's
 * reconcile of an order whose lease ran out without a report.
 */
export async function settleAuthorizedOrder(port: PlaneMergePort, accountId: string, order: PlaneMergeOrderFacts, hint: SettleHint): Promise<SettleOutcome> {
  // D#694 B7-1: an `enqueued` report is checked against the pull request AND its queue entry; any other hint against the pull request alone.
  const queue = hint?.result === "enqueued" ? await port.readPublicQueue({ accountId, order }) : null;
  const pull = queue ?? (await port.readPublicPull({ accountId, order }));
  const end = async (to: "merged" | "enqueued" | "head_moved" | "failed", code: string): Promise<SettleOutcome> => {
    const done = await port.store.finish({ accountId, orderId: order.id, to, code, actor: { by: "cloud" } });
    if (done.kind !== "finished") return { state: "unchanged" };
    let recorded = false;
    if (to === "merged") {
      // The merge stands whatever happens next; recording the rest is best effort and retried by the item's own reconcile.
      try {
        await port.recordMerged({ accountId, order });
        recorded = true;
      } catch (error) {
        reportError(error, { stage: "runner.plane_merge_record", route: PLANE_MERGE_REPORT_PATH });
      }
    }
    if (to === "enqueued" && queue?.entryId != null) {
      // The queue entry stands whatever happens next; the fact is best effort, and the webhook's delivery of the same entry dedupes onto it.
      try {
        await port.recordEnqueued({ accountId, order, entryId: queue.entryId });
        recorded = true;
      } catch (error) {
        reportError(error, { stage: "runner.plane_merge_record_enqueued", route: PLANE_MERGE_REPORT_PATH });
      }
    }
    return { state: to, code, recorded };
  };
  if (pull.merged) return pull.headSha === order.expectedPublicHead ? end("merged", "merged") : end("failed", "runner_report_mismatch");
  if (!pull.open) return end("failed", "public_pr_not_open");
  if (pull.headSha !== order.expectedPublicHead) return end("head_moved", "public_head_moved");
  // Open, the expected head, not merged. An enqueue stands only when GitHub shows the entry; the merge itself is the webhook's to record.
  if (queue !== null) return queue.entryId === null ? end("failed", "runner_report_mismatch") : end("enqueued", "enqueued");
  if (hint?.result === "merged") return end("failed", "runner_report_mismatch");
  if (hint?.result === "refused") return end("failed", "merge_call_refused");
  if (hint?.result === "aborted") return end("failed", hint.abortCode === "base_retargeted" ? "stacked_on_open_pr" : hint.abortCode === "pr_draft" ? "pr_draft" : "runner_merge_failed");
  return end("failed", "runner_merge_failed");
}

export async function planeMergeReportRun(deps: RunnerCloudDeps, req: RunnerHttpRequest): Promise<RunnerHttpResponse> {
  const runner = await verifyRunnerRequest(deps, PLANE_MERGE_REPORT_PATH, req, { replay: "once" });
  const message = parseMessage(PlaneMergeReportMessage, parseJsonBody(req));
  const { merge } = requirePlaneMerge(deps);
  const lease = leaseOf(runner, message.order_id, message.lease_generation);
  const fence = await asRunner(() => merge.store.fence(lease));
  if (fence.kind === "fenced") {
    // A late report for an order that is already over (expired, failed, superseded or head_moved while authorized) from the runner that held it: the runner may
    // already have merged. Before the 409, and before anything is recorded, the cloud looks at GitHub itself; only a merge at the order's own expected head is
    // recorded (the facts of the item, never the over order's row), and a read that fails records nothing and is retried.
    if (fence.reason === "order_terminal" && message.result === "merged") {
      const late = await asRunner(() => merge.store.getById({ accountId: runner.accountId, orderId: lease.orderId }));
      if (late !== null && late.writeTokenIssuedAt !== null && late.state !== "merged" && late.leaseGeneration === message.lease_generation) {
        try {
          const pull = await merge.readPublicPull({ accountId: runner.accountId, order: late });
          if (pull.merged && pull.headSha === late.expectedPublicHead) {
            await merge.recordMerged({ accountId: runner.accountId, order: late });
            return { status: 200, body: PlaneMergeReportReply.parse({ recorded: true }), headers: NO_STORE };
          }
        } catch (error) {
          reportError(error, { stage: "runner.plane_merge_late_report", route: PLANE_MERGE_REPORT_PATH });
          const retry = 30;
          return { status: 503, body: PlaneMergeRetryReply.parse({ retry_after: retry }), headers: { ...NO_STORE, "retry-after": String(retry) } };
        }
      }
    }
    throw fenced(fence.reason);
  }
  const order = fence.order;
  const recorded = { status: 200, body: PlaneMergeReportReply.parse({ recorded: true }), headers: NO_STORE } as const;

  if (order.state === "claimed") {
    // No go was ever issued: nothing was merged, and a report that says it was cannot be true.
    if (message.result !== "aborted") throw new RunnerHttpError(409, "not_authorized", "no write credential was issued for this order");
    const moved = message.abort_code === "head_moved" || message.abort_code === "base_retargeted";
    await asRunner(() => merge.store.finish({ accountId: runner.accountId, orderId: order.id, to: moved ? "head_moved" : "failed", code: moved ? "public_head_moved" : "runner_merge_failed", actor: { by: "cloud" } }));
    return recorded;
  }

  try {
    await settleAuthorizedOrder(merge, runner.accountId, order, { result: message.result, ...(message.abort_code !== undefined ? { abortCode: message.abort_code } : {}) });
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    // GitHub could not be asked: nothing is recorded, and the runner sends the report again.
    reportError(error, { stage: "runner.plane_merge_report", route: PLANE_MERGE_REPORT_PATH });
    const retry = 30;
    return { status: 503, body: PlaneMergeRetryReply.parse({ retry_after: retry }), headers: { ...NO_STORE, "retry-after": String(retry) } };
  }
  return recorded;
}
