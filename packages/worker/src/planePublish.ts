import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PLANE_REFUSAL_CODES, type PlaneRefusalCode } from "@fulcrumaxe/runner-protocol/planePush";
import { CHILD_BODY_CLOSING_CODE, buildPlanePushText, prFooterSkipReason } from "@fulcrumaxe/runner-protocol/planePushText";
import { safeChildTitle } from "@fx/core/src/work-items/childTitle.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { PRIVATE_READ_CLASS_SENTENCE, PRIVATE_READ_REFUSAL_KIND } from "@fx/core/src/repos/publicChangeCopy.js";
import { PUBLISH_ATTEMPT_LIMIT, mayRetryPublish, pairingDigest, publicPullRequestUrlMatches, recordUpdatedHead, recordVerifiedOutcome, type PlanePushState, type RetryFacts, type VerifiedOutcome } from "@fx/core/src/repos/planePushRecord.js";
import { REPUBLISH_BRANCH_MOVED, REPUBLISH_FAILED, REPUBLISH_NO_CHANGE } from "@fx/core/src/work-items/baseSync.js";
import { TERMINAL_WORK_ITEM_STAGES } from "@fx/core/src/work-items/stages.js";
import { resolveBuildIdentity, type BuildIdentity, type BuildPurpose } from "@fx/core/src/work-items/buildIdentity.js";
import { cleanWorkItemTitle } from "@fx/core/src/work-items/title.js";
import { FIX_BASE_EVENT, recordRepublishRefusal } from "./fixRoundBase.js";

// The retry predicate and the attempt limit live in @fx/core (the item view and the operator actions list themselves from them); re-exported so this module keeps its names.
export { PUBLISH_ATTEMPT_LIMIT, mayRetryPublish, type RetryFacts };
import { PLANE_PUBLISH_ROLE, PLANE_PUBLISH_VCPUS, recordChildCodePullRequest, insertAgentRun, insertRunEvent, runPublishSandbox, sandboxNameFor, writeRunStatus, writeRunStatusOn, type ExecutionRun, type LostRunOutcome, type NetworkPolicyRule, type PlanePublishInput, type PlanePublishLine, type SandboxPort } from "@fx/runner";
import { sandboxRunCost } from "@fx/spend";
import { readStackParentPull } from "@fx/core/src/work-items/stackParentPull.js";
import { decideStackStart, markBuildNeedsHuman, type StackBasePort } from "@fx/pipeline";
import { loadRunPullRequestText, type RunPullRequestPort } from "@fx/runner-cloud";

/**
 * D#598 P1f-5b: the worker's publish step for a paired repository's SANDBOX build, and "Try the push again" (`retryPublish`).
 *
 * After an executor run settles `succeeded` on a paired repository, `publishPairedChange` makes ONE attempt: it commits the attempt row and the
 * `plane_publish` run row together (the unique `(plane_push_id, attempt_no)` index and a row lock refuse a second attempt for the same number
 * BEFORE any sandbox exists), then creates the one-shot publish sandbox named `pp-<attempt id>`, runs the built hook, and records what GitHub
 * confirms. The hook's output is a hint: nothing is recorded as pushed or opened until the hosted side has read the branch and the pull request.
 *
 * What is decided from our rows alone: the repository, the public branch (the push row's), the private base (the executor run's recorded head), the
 * pairing (read now), the PR text and the commit identity. Nothing the agent or the hook says chooses any of them.
 */

/**
 * What the stored code `public_unavailable` honestly means, for the sentence P1f-6 shows. The hosted side cannot tell these apart, because each one fails the same
 * step (making a token for, or reading, the public repository): the App is not installed on it, a token could not be minted, or GitHub did not answer.
 */
export const PUBLIC_UNAVAILABLE_NOTE = "The public repository could not be reached: the GitHub App may not be installed there, a token could not be made, or GitHub did not answer. The platform cannot tell these apart.";

/** The `run_events` kind the executor run carries once its private pull request is open: the per-run marker, so a replay opens nothing. */
export const PRIVATE_PR_MARKER = "plane.private_pr";
/** The notice an executor run carries when the pairing's PR footer was left off: the item has no issue number (`no_issue_number`), or it is a planned PR child and the footer would close its parent's issue (`child_closing_keyword`). */
export const PR_FOOTER_SKIPPED = "plane.pr_footer_skipped";

/** The worker's own refusal codes, next to the hook's (`PlaneRefusalCode`). They are stored as the item's code and the attempt's label. */
export const PUBLISH_CODES = { retryLimit: "retry_limit", pairingOff: "pairing_off", hookCrashed: "hook_crashed", reportMismatch: "report_mismatch" } as const;

export interface PlanePublishDeps {
  pool: Pool;
  port: SandboxPort;
  /** The built `fx-plane-publish.mjs` (its text), from the build step; never read from a path at run time. */
  hook: () => string;
  /** The proxy-only egress policy; throws when the GitHub proxy is not configured. */
  networkPolicy: () => Promise<NetworkPolicyRule[]>;
  /** The platform commit identity (the two hosted settings), or null when missing or malformed. */
  identity: () => { name: string; email: string } | null;
  /** The head of the private branch as GitHub says now, or null when there is no such branch. A throw means GitHub could not be asked. */
  privateHead: (input: { repo: { id: string; owner: string; name: string }; branch: string }) => Promise<string | null>;
  /** The head of the private repository's default branch as GitHub says now, or null when there is none. A throw means GitHub could not be asked. The publish rules are read at it. */
  privateDefaultHead: (input: { repo: { id: string; owner: string; name: string } }) => Promise<string | null>;
  /** The hosted side's reads of the public repo, each with its own short-lived token. */
  hosted: {
    verifyPushed(input: { accountId: string; codeRepo: string; branch: string; headSha: string; tipSha: string }): Promise<boolean>;
    verifyPullRequest(input: { accountId: string; codeRepo: string; branch: string; number: number }): Promise<{ url: string } | null>;
    /** D#598 P1f-5c: opens the pull request on the paired repo's already-pushed branch (base `main`), with a fresh token it revokes before it returns. No git. Throws an error with `code` `pr_failed` or `public_unavailable`. */
    openPullRequest(input: { accountId: string; codeRepo: string; branch: string; title: string; body: string }): Promise<{ number: number; url: string }>;
    /** FIXROUND-REFRESH-HEAD: the public branch's head (null: no such branch), with a fresh token revoked before it returns. Absent: a fix round of a paired item that pushed is refused. */
    branchHead?(input: { accountId: string; codeRepo: string; branch: string }): Promise<string | null>;
  };
  /** D#598 P1f-5c: the PRIVATE repo's pull request side, the same port a runner run's `done` opens its pull request with. Absent: the platform opens none. */
  pullRequests?: RunPullRequestPort;
  /** D#598 P1f-5c: a stacked item's pull request opens against its parent's branch, read through the build step's own port. */
  stackBase?: StackBasePort;
  now?: () => number;
}

/** Why a publish was refused `bad_input` before any attempt: a closed set, so the log says which input was missing while the stored code stays one word. */
export type BadInputReason = "no_identity" | "base_missing" | "head_missing" | "default_tip_missing";

export type PublishResult =
  /** Nothing to do: the item is unpaired, the run is not a finished sandbox executor run, or the item may not retry now. No run row, no sandbox. */
  | { kind: "skipped"; why: "not_paired" | "not_done" | "not_retryable" | "busy" }
  /** The push was refused (or the platform could not start it); `attemptNo` is set when a sandbox attempt was made. */
  | { kind: "refused"; code: string; attemptNo: number | null; reason?: BadInputReason }
  | { kind: "published"; state: "pr_opened" | "pushed_pr_not_opened" | "no_public_change"; attemptNo: number }
  /** FIXROUND-REPUBLISH (R2-c2): a sandbox fix round's change replaced the head of the open public pull request's branch. */
  | { kind: "updated"; attemptNo: number }
  /** The worker was built without the publish ports: nothing was read, recorded or started. */
  | { kind: "not_configured" };

interface Facts {
  runId: string;
  status: string;
  sandboxSide: boolean;
  baseSha: string | null;
  workItemId: string;
  repo: { id: string; owner: string; name: string };
  title: string;
  pushId: string;
  codeRepo: string;
  branch: string;
  stampedDigest: string;
  state: PlanePushState;
  managedByPerson: boolean;
  pushAttempts: number;
  /** Push attempts whose publish run is a child of THIS executor run (a Build again run starts from none, whatever the record already holds). */
  runPushAttempts: number;
  /** This executor run already opened (or reused) its private pull request: a replay opens nothing, and a pull request a person closed is never reopened. */
  privatePrDone: boolean;
  lastPushRuntime: RetryFacts["lastPushRuntime"];
  /** FIXROUND-REPUBLISH (R2-c2): the head the platform last left on the public branch (the stamp), the base a sandbox fix round was brought up to date with, and the update attempts this run already has. */
  stamp: string | null;
  /** The work item's stage now: a pull request closed or merged on GitHub leaves the push row at `pr_opened`, and it is the item that records it. */
  itemStage: string;
  fixBase: { sha: string; branch: string } | null;
  updateAttempts: number;
  pairing: { codeRepo: string; overlayGlobs: string[]; identifierRulesPath: string | null; planDataRulesPath: string | null; prFooter: string | null } | null;
}

/**
 * The executor run (named, or the item's newest sandbox executor run), its push row, the attempts so far and the pairing as it is now. An item
 * paired to two repos over time has two push rows: the one whose `code_repo` is the CURRENT pairing's is chosen (case-folded); with no pairing, or
 * none matching, the newest row is returned and the caller refuses on the mismatch. The choice never depends on row order.
 */
async function readFacts(client: PoolClient, accountId: string, which: { runId: string } | { workItemId: string }): Promise<Facts | null> {
  const byRun = "runId" in which;
  const { rows } = await client.query(
    `SELECT r.id AS run_id, r.status, r.job_signed IS NULL AND r.runtime = 'production' AS sandbox_side, r.head_sha, r.work_item_id, r.dispatch_repo_id,
            rp.gh_owner, rp.gh_name, COALESCE(w.title, '') AS title, w.stage AS item_stage
       FROM agent_runs r
       JOIN work_items w ON w.account_id = r.account_id AND w.id = r.work_item_id
       JOIN repos rp ON rp.account_id = r.account_id AND rp.id = r.dispatch_repo_id
      WHERE r.account_id = $1 AND r.role = 'executor' AND ${byRun ? "r.id = $2" : "r.work_item_id = $2 AND r.status = 'succeeded' AND r.runtime = 'production'"}
      ORDER BY r.created_at DESC, r.id LIMIT 1`,
    [accountId, byRun ? which.runId : which.workItemId],
  );
  const r = rows[0];
  if (!r) return null;
  // The base the build started from is the ORIGINAL build run's: fix rounds are executor runs that continue the chain (each one's parent is the previous executor run),
  // and their head is where the round ended, never the build's base. Walk to the root of the chain.
  const { rows: roots } = await client.query<{ head_sha: string | null }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_run_id, head_sha, 0 AS depth FROM agent_runs WHERE account_id = $1 AND id = $2
       UNION ALL
       SELECT p.id, p.parent_run_id, p.head_sha, c.depth + 1 FROM chain c
         JOIN agent_runs p ON p.account_id = $1 AND p.id = c.parent_run_id AND p.role = 'executor' AND p.work_item_id = $3
        WHERE c.depth < 50
     ) SELECT head_sha FROM chain ORDER BY depth DESC LIMIT 1`,
    [accountId, r.run_id, r.work_item_id],
  );
  const buildBase = roots[0] ? roots[0].head_sha : r.head_sha;
  const { rows: pairs } = await client.query<{ code_repo: string; overlay_globs: string[]; identifier_rules_path: string | null; plan_data_rules_path: string | null; pr_footer: string | null }>(
    "SELECT code_repo, overlay_globs, identifier_rules_path, plan_data_rules_path, pr_footer FROM repo_pairing WHERE repo_id = $1 AND account_id = $2",
    [r.dispatch_repo_id, accountId],
  );
  const p = pairs[0];
  const { rows: pushes } = await client.query(
    `SELECT id, code_repo, branch, pairing_digest, state, head_sha, managed_by_person_at IS NOT NULL AS managed FROM plane_pushes
      WHERE account_id = $1 AND work_item_id = $2 AND repo_id = $3
      ORDER BY COALESCE(lower(code_repo) = lower($4::text), false) DESC, created_at DESC, id LIMIT 1`,
    [accountId, r.work_item_id, r.dispatch_repo_id, p?.code_repo ?? null],
  );
  const push = pushes[0];
  if (!push) return null;
  const { rows: stats } = await client.query<{ n: number; last: RetryFacts["lastPushRuntime"] }>(
    `SELECT count(*)::int AS n, (array_agg(runtime ORDER BY attempt_no DESC))[1] AS last FROM plane_push_attempts WHERE account_id = $1 AND plane_push_id = $2 AND kind = 'push'`,
    [accountId, push.id],
  );
  const { rows: own } = await client.query<{ pushes: number; marked: boolean }>(
    `SELECT (SELECT count(*)::int FROM plane_push_attempts a JOIN agent_runs pr ON pr.account_id = a.account_id AND pr.id = a.run_id
              WHERE a.account_id = $1 AND a.plane_push_id = $2 AND a.kind = 'push' AND pr.parent_run_id = $3) AS pushes,
            EXISTS (SELECT 1 FROM run_events WHERE account_id = $1 AND run_id = $3 AND kind = $4) AS marked`,
    [accountId, push.id, r.run_id, PRIVATE_PR_MARKER],
  );
  // The base the cloud wrote when it started a sandbox fix round that must update the public pull request (a malformed one reads as none: the round then publishes nothing).
  const { rows: bases } = await client.query<{ payload: { base_sha?: unknown; branch?: unknown } | null }>("SELECT payload FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 ORDER BY seq DESC LIMIT 1", [accountId, r.run_id, FIX_BASE_EVENT]);
  const b = bases[0]?.payload;
  const fixBase = b && typeof b.base_sha === "string" && SHA.test(b.base_sha) && typeof b.branch === "string" && UPDATE_BRANCH.test(b.branch) && !b.branch.includes("..") ? { sha: b.base_sha, branch: b.branch } : null;
  const { rows: updates } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM plane_push_attempts a JOIN agent_runs pr ON pr.account_id = a.account_id AND pr.id = a.run_id
      WHERE a.account_id = $1 AND a.plane_push_id = $2 AND a.kind = 'fix_round' AND pr.parent_run_id = $3`,
    [accountId, push.id, r.run_id],
  );
  return {
    itemStage: r.item_stage as string,
    stamp: typeof push.head_sha === "string" ? push.head_sha : null, fixBase, updateAttempts: updates[0]?.n ?? 0,
    runId: r.run_id, status: r.status, sandboxSide: r.sandbox_side === true, baseSha: buildBase, workItemId: r.work_item_id,
    repo: { id: r.dispatch_repo_id, owner: r.gh_owner, name: r.gh_name }, title: r.title,
    pushId: push.id, codeRepo: push.code_repo, branch: push.branch, stampedDigest: push.pairing_digest, state: push.state, managedByPerson: push.managed === true,
    // An item refused before any sandbox was started has no attempt yet; its executor ran in the sandbox, so a retry is a sandbox retry.
    pushAttempts: stats[0]?.n ?? 0, runPushAttempts: own[0]?.pushes ?? 0, privatePrDone: own[0]?.marked === true, lastPushRuntime: stats[0]?.last ?? (r.sandbox_side === true ? "sandbox" : null),
    pairing: p ? { codeRepo: p.code_repo, overlayGlobs: p.overlay_globs, identifierRulesPath: p.identifier_rules_path, planDataRulesPath: p.plan_data_rules_path, prFooter: p.pr_footer } : null,
  };
}

const SHA = /^[0-9a-f]{40}$/;
/** The private branch of a fix round's pull request: the item's issue branch or a runner's run branch, both under `fx/`. */
const UPDATE_BRANCH = /^fx\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const digestOf = (p: NonNullable<Facts["pairing"]>): string => pairingDigest({ codeRepo: p.codeRepo, overlayGlobs: p.overlayGlobs, identifierRulesPath: p.identifierRulesPath, planDataRulesPath: p.planDataRulesPath });

/** Thrown inside the create transaction when the row already has its three push attempts: the run row and the attempt row roll back together. */
class AttemptLimitReached extends Error {}
/** Thrown inside the create transaction when a first attempt finds an earlier push attempt (a replay that raced the first one). */
class AttemptOutOfOrder extends Error {}
/** Thrown inside the create transaction when, under the row lock, the push row is no longer in the state this attempt was read in, or a person has taken the branch over. */
class PushRowChanged extends Error {}
/** The schema index that allows one live publish run per executor run (0680): the only unique violation that means "another attempt is in flight". */
const LIVE_CHILD_INDEX = "agent_runs_one_live_continuation_per_parent";

type Mode = "first" | "retry";

async function attempt(deps: PlanePublishDeps, accountId: string, which: { runId: string } | { workItemId: string }, mode: Mode): Promise<PublishResult> {
  const now = deps.now ?? Date.now;
  const facts = await withTenant(deps.pool, accountId, (c) => readFacts(c, accountId, which));
  if (!facts || !facts.sandboxSide) return { kind: "skipped", why: "not_paired" };
  if (facts.status !== "succeeded") return { kind: "skipped", why: "not_done" };
  /** Records a refusal on the item with no attempt spent (nothing was started), e.g. a limit reached or a pairing now off. */
  const refuse = async (code: string, reason?: BadInputReason): Promise<PublishResult> => {
    await withTenant(deps.pool, accountId, (c) => recordVerifiedOutcome(c, { accountId, id: facts.pushId, outcome: { state: "refused", code } }));
    // A retry's reason is logged by the retry workflow's own line; a first publish has none, so it logs here.
    if (reason !== undefined && mode === "first") console.info(JSON.stringify({ event: "plane.publish_refused", work_item_id: facts.workItemId, code, reason }));
    return { kind: "refused", code, attemptNo: null, ...(reason === undefined ? {} : { reason }) };
  };

  if (mode === "retry") {
    if (!mayRetryPublish(facts)) {
      if (facts.state === "refused" && facts.lastPushRuntime === "sandbox" && facts.pushAttempts >= PUBLISH_ATTEMPT_LIMIT && !facts.managedByPerson) return refuse(PUBLISH_CODES.retryLimit);
      return { kind: "skipped", why: "not_retryable" };
    }
    if (facts.pairing === null) return refuse(PUBLISH_CODES.pairingOff);
  } else if (facts.runPushAttempts > 0 || (facts.state !== "building" && facts.state !== "scanning")) {
    // The first attempt runs once per executor run: a replay of this run must not start a second sandbox. A Build again run is a new run, so it publishes
    // (the record-wide cap of three push attempts still applies, below).
    // (An item whose record already moved on, such as an open public pull request, is not at the start of its public change.)
    return { kind: "skipped", why: "busy" };
  } else if (facts.pairing === null || digestOf(facts.pairing) !== facts.stampedDigest) {
    // The pairing moved since the build started: nothing is pushed (C4). A retry reads the pairing as it is now; Build again re-stamps.
    return refuse("pairing_changed");
  }
  const pairing = facts.pairing!;
  // The pairing now names another public repo than this push row: the retry would push to the repo the owner unpaired. Nothing starts, no attempt is spent.
  if (pairing.codeRepo.toLowerCase() !== facts.codeRepo.toLowerCase()) return refuse("pairing_changed");
  const givenDigest = digestOf(pairing);

  // Everything the platform can check BEFORE it spends an attempt: a problem here is `public_unavailable` and leaves the retry available.
  const identity = deps.identity();
  if (identity === null) return refuse("bad_input", "no_identity");
  if (facts.baseSha === null || !SHA.test(facts.baseSha)) return refuse("bad_input", "base_missing");
  // D#483 S5-b2c-4 (R9): the issue number and the private branch are the build identity's, never `gh_number` or an `fx/issue-<n>` built here. A new publish starts something (`start`); a retry reads what already
  // happened (`observe`). A refusal stores the resolver's code for a planned PR child; a top-level item keeps `bad_input`, as before.
  const resolved = await resolveIdentity(deps.pool, accountId, facts.workItemId, mode === "first" ? "start" : "observe");
  if (!resolved.ok) return refuse(resolved.code);
  const build = resolved.identity;
  // Final guard, before any attempt is spent: a child's finished body that would still close an issue is never published.
  if (childTextRefused(facts.title, facts.runId, pairing.prFooter, build)) return refuse(CHILD_BODY_CLOSING_CODE);
  let policy: NetworkPolicyRule[];
  let head: string | null;
  let defaultTip: string | null;
  try {
    policy = await deps.networkPolicy();
    head = await deps.privateHead({ repo: facts.repo, branch: build.branch });
    defaultTip = await deps.privateDefaultHead({ repo: facts.repo });
  } catch {
    // fx-swallow-ok: the proxy host or GitHub could not be used; nothing was started, the item shows the fixed unavailable refusal
    return refuse("public_unavailable");
  }
  if (head === null) return refuse("bad_input", "head_missing");
  if (defaultTip === null || !SHA.test(defaultTip)) return refuse("bad_input", "default_tip_missing");

  // The attempt row and the run row commit TOGETHER, and BEFORE any sandbox exists. The name is `pp-` plus exactly this attempt's id.
  const attemptId = randomUUID();
  const name = sandboxNameFor({ role: PLANE_PUBLISH_ROLE, runId: attemptId, attemptId });
  let attemptNo = 0;
  let publishRunId: string;
  try {
    publishRunId = (
      await insertAgentRun(deps.pool, {
        id: randomUUID(), accountId, workItemId: facts.workItemId, parentRunId: facts.runId, role: PLANE_PUBLISH_ROLE, runtime: "production", dispatchRepoId: facts.repo.id,
        inCreateTransaction: async (client, runId) => {
          const { rows: locked } = await client.query<{ state: string; managed: boolean }>(
            "SELECT state, managed_by_person_at IS NOT NULL AS managed FROM plane_pushes WHERE account_id = $1 AND id = $2 FOR UPDATE",
            [accountId, facts.pushId],
          );
          // The facts above were read before this lock: a person may have taken the branch over, or the row moved on, since. Act only on what is true now.
          const now = locked[0];
          const stateOk = mode === "retry" ? now?.state === "refused" : now?.state === "building" || now?.state === "scanning";
          if (!now || now.managed || !stateOk) throw new PushRowChanged();
          // Numbered per kind, like the runner path (migration 0882): past the highest PUSH number, so a PR-open retry never uses one up.
          const { rows } = await client.query<{ pushes: number; top: number; own: number }>(
            `SELECT count(*)::int AS pushes, COALESCE(max(a.attempt_no), 0)::int AS top, (count(*) FILTER (WHERE pr.parent_run_id = $3))::int AS own
               FROM plane_push_attempts a LEFT JOIN agent_runs pr ON pr.account_id = a.account_id AND pr.id = a.run_id
              WHERE a.account_id = $1 AND a.plane_push_id = $2 AND a.kind = 'push'`,
            [accountId, facts.pushId, facts.runId],
          );
          const pushes = rows[0]?.pushes ?? 0;
          attemptNo = (rows[0]?.top ?? 0) + 1;
          if (mode === "first" && (rows[0]?.own ?? 0) !== 0) throw new AttemptOutOfOrder();
          if (pushes >= PUBLISH_ATTEMPT_LIMIT || attemptNo > PUBLISH_ATTEMPT_LIMIT) throw new AttemptLimitReached();
          await client.query(`INSERT INTO plane_push_attempts (id, account_id, plane_push_id, run_id, runtime, kind, attempt_no) VALUES ($1, $2, $3, $4, 'sandbox', 'push', $5)`, [attemptId, accountId, facts.pushId, runId, attemptNo]);
          await client.query("SELECT agent_run_sandbox_mark($1::uuid, $2::uuid, true, NULL, false, NULL, NULL, $3::text)", [accountId, runId, name]);
        },
      })
    ).id;
  } catch (err) {
    if (err instanceof AttemptLimitReached) return refuse(PUBLISH_CODES.retryLimit);
    if (err instanceof AttemptOutOfOrder) return { kind: "skipped", why: "busy" };
    if (err instanceof PushRowChanged) return { kind: "skipped", why: mode === "retry" ? "not_retryable" : "busy" };
    // Another attempt is in flight (the live-child index). Any other unique violation is a real fault and is not hidden as "busy".
    const pg = err as { code?: string; constraint?: string } | undefined;
    if (pg?.code === "23505" && pg.constraint === LIVE_CHILD_INDEX) return { kind: "skipped", why: "busy" };
    throw err;
  }

  // From here the attempt is real: whatever happens, it ends terminal and the sandbox ends deleted (runPublishSandbox's finally).
  const text = buildPlanePushText({ itemTitle: textTitle(facts.title, build), runId: facts.runId, prFooter: pairing.prFooter, issueNumber: build.issueNumber, child: build.isChild });
  await noteFooterSkipped(deps.pool, accountId, facts.runId, pairing.prFooter, build);
  const input: PlanePublishInput = {
    own: { owner: facts.repo.owner, name: facts.repo.name }, codeRepo: facts.codeRepo, privateBase: facts.baseSha, privateHead: head, privateDefaultTip: defaultTip, branch: facts.branch, title: text.title, body: text.body,
    identity, commitTime: Math.floor(now() / 1000),
    pairing: { overlayGlobs: pairing.overlayGlobs, identifierRulesPath: pairing.identifierRulesPath, planDataRulesPath: pairing.planDataRulesPath },
  };
  const began = await writeRunStatus(deps.pool, { accountId, runId: publishRunId, from: "pending", to: "running" });
  if (!began.updated) {
    // Cancelled before it started: no sandbox. The attempt is finished and the item can try again.
    await finishAttempt(deps.pool, accountId, { pushId: facts.pushId, attemptId, runId: publishRunId, outcome: { state: "refused", code: PUBLISH_CODES.hookCrashed }, label: PUBLISH_CODES.hookCrashed, failed: true, usd: 0, envelope: null });
    return { kind: "refused", code: PUBLISH_CODES.hookCrashed, attemptNo };
  }
  const started = now();
  let outcome: VerifiedOutcome;
  let label: string;
  let crashed = false;
  try {
    const run = await runPublishSandbox(deps.port, { sandboxName: name, hook: deps.hook(), input, networkPolicy: policy });
    if (run.kind === "crashed") {
      crashed = true;
      ({ outcome, label } = { outcome: { state: "refused", code: PUBLISH_CODES.hookCrashed }, label: PUBLISH_CODES.hookCrashed });
    } else {
      // The pairing is hook INPUT, so the hook cannot see a later change: the worker re-reads its digest now and trusts nothing from the hook if it moved.
      const after = await withTenant(deps.pool, accountId, (c) => readFacts(c, accountId, { runId: facts.runId }));
      ({ outcome, label } = after?.pairing && digestOf(after.pairing) === givenDigest ? await verify(deps, accountId, facts, run.terminal) : { outcome: { state: "refused", code: "pairing_changed" }, label: "pairing_changed" });
    }
  } catch {
    // fx-swallow-ok: the sandbox, the write or GitHub failed in a way the hook's output cannot explain; the item shows the fixed crash refusal
    crashed = true;
    ({ outcome, label } = { outcome: { state: "refused", code: PUBLISH_CODES.hookCrashed }, label: PUBLISH_CODES.hookCrashed });
  }
  // The public head is stamped with the private head it was built from (read before the sandbox started), so the merge gate can tie the two.
  if (outcome.headSha !== undefined) outcome = { ...outcome, sourceHead: head };
  const seconds = Math.max(0, Math.round((now() - started) / 1000));
  // The price comes from the vCPUs this sandbox was created with (1), not the pinned 2 every agent sandbox has.
  const cost = sandboxRunCost([{ ownDurationMs: seconds * 1000 }], { vcpus: PLANE_PUBLISH_VCPUS });
  await finishAttempt(deps.pool, accountId, {
    pushId: facts.pushId, attemptId, runId: publishRunId, outcome, label, failed: crashed, usd: cost.usd,
    envelope: { publish: { attempt_no: attemptNo, outcome: label, seconds, vcpus: PLANE_PUBLISH_VCPUS, usd: cost.usd, basis: cost.basis, private_head: head } },
    // R9: the hosted side confirmed the pull request, so a planned PR child's binding to it is written in the same transaction as the push row's outcome (set once).
    ...(build.isChild && outcome.state === "pr_opened" && outcome.prNumber !== undefined ? { after: (client: PoolClient) => bindChildCodePullRequest(client, accountId, facts, outcome.prNumber!) } : {}),
  });
  if (outcome.state === "refused") {
    // One structured line per refused publish: the item, the code and (for a private read) the closed class. Nothing else.
    logPublishRefused(facts.workItemId, outcome.code!, outcome.refusals?.find((r) => r.kind === PRIVATE_READ_REFUSAL_KIND)?.rule_key);
    return { kind: "refused", code: outcome.code!, attemptNo };
  }
  return { kind: "published", state: outcome.state as "pr_opened" | "pushed_pr_not_opened" | "no_public_change", attemptNo };
}

interface Finish {
  pushId: string;
  attemptId: string;
  runId: string;
  /** Null for an update attempt (a fix round): it never writes the push row's outcome; `after` records what it found. */
  outcome: VerifiedOutcome | null;
  after?: (client: PoolClient) => Promise<void>;
  label: string;
  failed: boolean;
  usd: number;
  envelope: Record<string, unknown> | null;
}

/**
 * The one final record of an attempt, in ONE transaction: the item's outcome, the attempt's `finished_at` and label, and the run's terminal status.
 * The run's status write is a compare-and-set from `running`; a run something else already ended (a cancel mid-flight) is simply left as it is, and
 * the outcome and the stamp are still written: a cancelled run never rolls back what the attempt found.
 */
async function finishAttempt(pool: Pool, accountId: string, f: Finish): Promise<void> {
  await withTenant(pool, accountId, async (client) => {
    if (f.outcome !== null) await recordVerifiedOutcome(client, { accountId, id: f.pushId, outcome: f.outcome });
    if (f.after) await f.after(client);
    await client.query("UPDATE plane_push_attempts SET finished_at = COALESCE(finished_at, now()), outcome = COALESCE(outcome, $3) WHERE account_id = $1 AND id = $2", [accountId, f.attemptId, f.label]);
    await writeRunStatusOn(client, {
      accountId, runId: f.runId, from: "running", to: f.failed ? "failed" : "succeeded", ...(f.failed ? { failureReason: PUBLISH_CODES.hookCrashed } : {}),
      result: { usd: f.usd, ...(f.envelope ? { envelope: f.envelope } : {}) },
    });
  });
}

/** A publish run still `running` this long after its sandbox was requested is lost even if the provider still lists the sandbox (it was created with a 75-minute timeout). */
export const PUBLISH_LOST_AFTER_MS = 80 * 60_000;

/**
 * The lost-run settle for publish runs, which the existing lost-run sweep calls for the `plane_publish` role in place of the sandbox target's (that one derives
 * an `rn-` name from the role). It acts only on the RECORDED name, and only when that name is exactly `pp-` plus the id of the attempt row whose `run_id` is this
 * run. A run whose sandbox is gone (or older than the sandbox's own timeout) ends `failed`, its attempt finishes `hook_crashed`, and the item's push row goes to
 * `refused` so "Try the push again" is offered. The sandbox is stopped and deleted by its recorded name, best effort (the reaper is the net).
 */
export function createPublishSettler(deps: { pool: Pool; port: SandboxPort; now?: () => number }): { settleIfLost(run: Pick<ExecutionRun, "id" | "accountId">): Promise<LostRunOutcome> } {
  const now = deps.now ?? Date.now;
  return {
    async settleIfLost(run) {
      const row = await withTenant(deps.pool, run.accountId, async (client) => {
        const { rows } = await client.query(
          `SELECT r.status, r.sandbox_name, r.sandbox_requested_at, r.work_item_id, r.parent_run_id, a.id AS attempt_id, a.plane_push_id, a.finished_at, a.kind
             FROM agent_runs r JOIN plane_push_attempts a ON a.account_id = r.account_id AND a.run_id = r.id
            WHERE r.account_id = $1 AND r.id = $2 AND r.role = $3`,
          [run.accountId, run.id, PLANE_PUBLISH_ROLE],
        );
        return rows[0];
      });
      if (!row || row.status !== "running" || row.sandbox_name !== `pp-${row.attempt_id}`) return "alive";
      const handle = { runId: run.id, sandboxName: row.sandbox_name as string };
      const aged = row.sandbox_requested_at !== null && now() - new Date(row.sandbox_requested_at).getTime() > PUBLISH_LOST_AFTER_MS;
      let exists: boolean;
      try {
        exists = await deps.port.sandboxExists(handle);
      } catch {
        // fx-swallow-ok: the provider could not answer; a later tick looks again
        return "unknown";
      }
      if (exists && !aged) return "alive";
      if (exists) {
        try {
          await deps.port.stop(handle);
          await deps.port.deleteSandbox(handle);
        } catch {
          // fx-swallow-ok: the reaper deletes a publish sandbox whose run is terminal
        }
      }
      // A lost UPDATE of the open public pull request leaves the push row as it is (it still shows the earlier change) and sends the item to a person.
      const update = row.kind === "fix_round";
      await finishAttempt(deps.pool, run.accountId, {
        pushId: row.plane_push_id, attemptId: row.attempt_id, runId: run.id, outcome: update ? null : { state: "refused", code: PUBLISH_CODES.hookCrashed }, label: PUBLISH_CODES.hookCrashed, failed: true, usd: 0, envelope: null,
        ...(update ? { after: (client: PoolClient) => recordRepublishRefusal(client, { accountId: run.accountId, workItemId: row.work_item_id }, { code: REPUBLISH_FAILED, prNumber: null, moveToNeedsPerson: true, attempt: row.parent_run_id ?? run.id }) } : {}),
      });
      return "settled";
    },
  };
}

/** One structured line per refused publish: the item, the code and (for a private read) the closed class. Nothing else; no tool text reaches this process. */
function logPublishRefused(workItemId: string, code: string, failureClass?: string): void {
  // A class is logged only for `private_read_failed` and only from the closed set: any other code's refusal entries are the sandbox's own text.
  const cls = code === "private_read_failed" && failureClass !== undefined && Object.hasOwn(PRIVATE_READ_CLASS_SENTENCE, failureClass) ? failureClass : undefined;
  console.info(JSON.stringify({ event: "plane.publish_refused", work_item_id: workItemId, code, ...(cls === undefined ? {} : { class: cls }) }));
}

const REFUSED = (code: string, refusals?: PlanePublishLine["refusals"]): { outcome: VerifiedOutcome; label: string } => ({ outcome: { state: "refused", code, ...(refusals ? { refusals } : {}) }, label: code });

/** What an update attempt ends with: the stamp moves (`updated`), or the item goes to a person with the code the round's refusal is recorded under. */
type UpdateEnd = { kind: "updated"; headSha: string; tipSha: string } | { kind: "refused"; code: string; label: string; failureClass?: string };

/** The hook's terminal line for an UPDATE, believed only after GitHub confirms it (the same read of the branch as a first push). Anything doubtful is a failed update. */
async function verifyUpdate(deps: PlanePublishDeps, accountId: string, facts: Facts, line: PlanePublishLine): Promise<UpdateEnd> {
  const failed = (label: string): UpdateEnd => ({ kind: "refused", code: REPUBLISH_FAILED, label, ...(label === "private_read_failed" ? { failureClass: line.failure_class ?? "other" } : {}) });
  switch (line.phase) {
    case "no_change":
      return { kind: "refused", code: REPUBLISH_NO_CHANGE, label: "no_change" };
    case "refused":
      return line.code === "public_branch_moved" ? { kind: "refused", code: REPUBLISH_BRANCH_MOVED, label: "public_branch_moved" } : failed(line.code !== undefined && (PLANE_REFUSAL_CODES as readonly string[]).includes(line.code) ? line.code : PUBLISH_CODES.reportMismatch);
    case "updated": {
      if (line.head_sha === undefined || line.tip_sha === undefined || (line.branch !== undefined && line.branch !== facts.branch)) return failed(PUBLISH_CODES.reportMismatch);
      try {
        // The branch is the push row's, whatever the line says.
        return (await deps.hosted.verifyPushed({ accountId, codeRepo: facts.codeRepo, branch: facts.branch, headSha: line.head_sha, tipSha: line.tip_sha }))
          ? { kind: "updated", headSha: line.head_sha, tipSha: line.tip_sha }
          : failed(PUBLISH_CODES.reportMismatch);
      } catch {
        // fx-swallow-ok: GitHub could not be asked; nothing is stored from the line and the item goes to a person
        return failed("public_unavailable");
      }
    }
    default:
      return failed(PUBLISH_CODES.reportMismatch);
  }
}

/**
 * FIXROUND-REPUBLISH (R2-c2): after a SANDBOX fix round whose item has an open public pull request, replaces the head of the platform's public branch with ONE new commit on the current public main, in a
 * publish sandbox like a first push. The checks that need no sandbox come first and spend nothing: the record must still be an open, platform-owned pull request, the pairing must still name its
 * repository, and the round must carry the base the cloud signed in its create transaction. Whatever goes wrong ends with the item in Needs a person and the push row untouched (it still shows the
 * earlier change), never `refused`: nothing here offers "Try the push again", which would be a first push.
 */
async function republish(deps: PlanePublishDeps, accountId: string, facts: Facts): Promise<PublishResult> {
  const now = deps.now ?? Date.now;
  const fixBase = facts.fixBase!;
  const who = { accountId, workItemId: facts.workItemId };
  const stopWith = async (code: string): Promise<PublishResult> => {
    await withTenant(deps.pool, accountId, (c) => recordRepublishRefusal(c, who, { code, prNumber: null, moveToNeedsPerson: true, attempt: facts.runId }));
    return { kind: "refused", code, attemptNo: null };
  };
  // An open, platform-owned pull request; anything else is not ours to update. A replay of this run is not a second update.
  if (facts.state !== "pr_opened" || facts.managedByPerson || facts.stamp === null || (TERMINAL_WORK_ITEM_STAGES as readonly string[]).includes(facts.itemStage)) return { kind: "skipped", why: "not_paired" };
  if (facts.updateAttempts > 0) return { kind: "skipped", why: "busy" };
  if (facts.pairing === null || facts.pairing.codeRepo.toLowerCase() !== facts.codeRepo.toLowerCase()) return stopWith(REPUBLISH_FAILED);
  const identity = deps.identity();
  if (identity === null) return stopWith(REPUBLISH_FAILED);
  // The round was started through the resolver already; reading it again (`observe`) keeps a parent deleted since from stranding a change that is built and ready to publish.
  const resolved = await resolveIdentity(deps.pool, accountId, facts.workItemId, "observe");
  if (!resolved.ok) return stopWith(REPUBLISH_FAILED);
  const build = resolved.identity;
  if (childTextRefused(facts.title, facts.runId, facts.pairing.prFooter, build)) return stopWith(REPUBLISH_FAILED);
  const pairing = facts.pairing;
  const stamp = facts.stamp;
  const givenDigest = digestOf(pairing);
  let policy: NetworkPolicyRule[];
  let head: string | null;
  let defaultTip: string | null;
  try {
    policy = await deps.networkPolicy();
    head = await deps.privateHead({ repo: facts.repo, branch: fixBase.branch });
    // The trusted private default tip, read by the platform as for a first push: the pairing's rules are read there, and the rule-file guard runs from merge-base(base, tip) to the head.
    defaultTip = await deps.privateDefaultHead({ repo: facts.repo });
  } catch {
    // fx-swallow-ok: the proxy host or GitHub could not be used; nothing was started, the item shows the fixed failure sentence
    return stopWith(REPUBLISH_FAILED);
  }
  if (head === null || defaultTip === null || !/^[0-9a-f]{40}$/.test(defaultTip)) return stopWith(REPUBLISH_FAILED);

  const attemptId = randomUUID();
  const name = sandboxNameFor({ role: PLANE_PUBLISH_ROLE, runId: attemptId, attemptId });
  let attemptNo = 0;
  let publishRunId: string;
  try {
    publishRunId = (
      await insertAgentRun(deps.pool, {
        id: randomUUID(), accountId, workItemId: facts.workItemId, parentRunId: facts.runId, role: PLANE_PUBLISH_ROLE, runtime: "production", dispatchRepoId: facts.repo.id,
        inCreateTransaction: async (client, runId) => {
          const { rows: locked } = await client.query<{ state: string; managed: boolean; head_sha: string | null }>(
            "SELECT state, managed_by_person_at IS NOT NULL AS managed, head_sha FROM plane_pushes WHERE account_id = $1 AND id = $2 FOR UPDATE",
            [accountId, facts.pushId],
          );
          // The facts were read before this lock: act only on what is true now (still open, still ours, still at the head read above).
          const row = locked[0];
          if (!row || row.managed || row.state !== "pr_opened" || row.head_sha !== stamp) throw new PushRowChanged();
          // The item may have been closed or merged since the facts were read.
          const { rows: item } = await client.query<{ stage: string }>("SELECT stage FROM work_items WHERE account_id = $1 AND id = $2", [accountId, facts.workItemId]);
          if (!item[0] || (TERMINAL_WORK_ITEM_STAGES as readonly string[]).includes(item[0].stage)) throw new PushRowChanged();
          // Numbered on its own kind: an update is not one of the three pushes of a first publish.
          const { rows: next } = await client.query<{ n: number }>("SELECT COALESCE(max(attempt_no), 0)::int + 1 AS n FROM plane_push_attempts WHERE account_id = $1 AND plane_push_id = $2 AND kind = 'fix_round'", [accountId, facts.pushId]);
          attemptNo = next[0]!.n;
          await client.query(`INSERT INTO plane_push_attempts (id, account_id, plane_push_id, run_id, runtime, kind, attempt_no) VALUES ($1, $2, $3, $4, 'sandbox', 'fix_round', $5)`, [attemptId, accountId, facts.pushId, runId, attemptNo]);
          await client.query("SELECT agent_run_sandbox_mark($1::uuid, $2::uuid, true, NULL, false, NULL, NULL, $3::text)", [accountId, runId, name]);
        },
      })
    ).id;
  } catch (err) {
    if (err instanceof PushRowChanged) return { kind: "skipped", why: "not_paired" };
    const pg = err as { code?: string; constraint?: string } | undefined;
    if (pg?.code === "23505" && pg.constraint === LIVE_CHILD_INDEX) return { kind: "skipped", why: "busy" };
    throw err;
  }

  const text = buildPlanePushText({ itemTitle: textTitle(facts.title, build), runId: facts.runId, prFooter: pairing.prFooter, issueNumber: build.issueNumber, child: build.isChild });
  await noteFooterSkipped(deps.pool, accountId, facts.runId, pairing.prFooter, build);
  const input: PlanePublishInput = {
    own: { owner: facts.repo.owner, name: facts.repo.name }, codeRepo: facts.codeRepo, privateBase: fixBase.sha, privateHead: head, privateDefaultTip: defaultTip, branch: facts.branch, updateOf: stamp, title: text.title, body: text.body,
    identity, commitTime: Math.floor(now() / 1000),
    pairing: { overlayGlobs: pairing.overlayGlobs, identifierRulesPath: pairing.identifierRulesPath, planDataRulesPath: pairing.planDataRulesPath },
  };
  const sourceHead: string = head;
  const finish = (end: UpdateEnd, extra: { failed: boolean; usd: number; envelope: Record<string, unknown> | null }) =>
    finishAttempt(deps.pool, accountId, {
      pushId: facts.pushId, attemptId, runId: publishRunId, outcome: null, label: end.kind === "updated" ? "updated" : end.label, ...extra,
      after: async (client) => {
        if (end.kind === "updated") {
          // Only an open, platform-owned row moves; a person who took the branch over meanwhile keeps it.
          await recordUpdatedHead(client, { accountId, id: facts.pushId, headSha: end.headSha, tipSha: end.tipSha, sourceHead });
        } else {
          await recordRepublishRefusal(client, who, { code: end.code, prNumber: null, moveToNeedsPerson: true, attempt: facts.runId });
        }
      },
    });
  const began = await writeRunStatus(deps.pool, { accountId, runId: publishRunId, from: "pending", to: "running" });
  if (!began.updated) {
    await finish({ kind: "refused", code: REPUBLISH_FAILED, label: PUBLISH_CODES.hookCrashed }, { failed: true, usd: 0, envelope: null });
    return { kind: "refused", code: REPUBLISH_FAILED, attemptNo };
  }
  const started = now();
  let end: UpdateEnd;
  let crashed = false;
  try {
    const run = await runPublishSandbox(deps.port, { sandboxName: name, hook: deps.hook(), input, networkPolicy: policy });
    if (run.kind === "crashed") {
      crashed = true;
      end = { kind: "refused", code: REPUBLISH_FAILED, label: PUBLISH_CODES.hookCrashed };
    } else {
      // The pairing is hook INPUT: re-read now, and trust nothing from the hook if it moved.
      const after = await withTenant(deps.pool, accountId, (c) => readFacts(c, accountId, { runId: facts.runId }));
      end = after?.pairing && digestOf(after.pairing) === givenDigest ? await verifyUpdate(deps, accountId, facts, run.terminal) : { kind: "refused", code: REPUBLISH_FAILED, label: "pairing_changed" };
    }
  } catch {
    // fx-swallow-ok: the sandbox, the write or GitHub failed in a way the hook's output cannot explain; the item shows the fixed failure sentence
    crashed = true;
    end = { kind: "refused", code: REPUBLISH_FAILED, label: PUBLISH_CODES.hookCrashed };
  }
  const seconds = Math.max(0, Math.round((now() - started) / 1000));
  if (end.kind === "refused") logPublishRefused(facts.workItemId, end.label, end.failureClass);
  const cost = sandboxRunCost([{ ownDurationMs: seconds * 1000 }], { vcpus: PLANE_PUBLISH_VCPUS });
  await finish(end, { failed: crashed, usd: cost.usd, envelope: { publish: { attempt_no: attemptNo, kind: "fix_round", outcome: end.kind === "updated" ? "updated" : end.label, seconds, vcpus: PLANE_PUBLISH_VCPUS, usd: cost.usd, basis: cost.basis, private_head: head } } });
  return end.kind === "updated" ? { kind: "updated", attemptNo } : { kind: "refused", code: end.code, attemptNo };
}

/** The hook's terminal line becomes an outcome only after GitHub confirms it (report verification, C4 point 1a). Anything doubtful is `report_mismatch`, storing nothing from the line. */
async function verify(deps: PlanePublishDeps, accountId: string, facts: Facts, line: PlanePublishLine): Promise<{ outcome: VerifiedOutcome; label: string }> {
  const mismatch = REFUSED(PUBLISH_CODES.reportMismatch);
  switch (line.phase) {
    case "no_change":
      return { outcome: { state: "no_public_change" }, label: "no_change" };
    case "refused":
      if (line.code === undefined || !(PLANE_REFUSAL_CODES as readonly string[]).includes(line.code)) return mismatch;
      // The failure class of a private read is stored as one closed refusal entry (kind, no place, the class as the rule key): the existing column carries it.
      return REFUSED(line.code as PlaneRefusalCode, line.code === "private_read_failed" ? [{ kind: PRIVATE_READ_REFUSAL_KIND, place: "-", rule_key: line.failure_class ?? "other" }] : line.refusals?.filter((r) => r.kind !== PRIVATE_READ_REFUSAL_KIND));
    case "pr_opened":
    case "pr_failed": {
      if (line.head_sha === undefined || line.tip_sha === undefined || (line.branch !== undefined && line.branch !== facts.branch)) return mismatch;
      if (line.phase === "pr_opened" && line.pr_number === undefined) return mismatch;
      try {
        // The branch is the push row's, whatever the line says.
        if (!(await deps.hosted.verifyPushed({ accountId, codeRepo: facts.codeRepo, branch: facts.branch, headSha: line.head_sha, tipSha: line.tip_sha }))) return mismatch;
        if (line.phase === "pr_failed") return { outcome: { state: "pushed_pr_not_opened", headSha: line.head_sha, tipSha: line.tip_sha }, label: "pr_failed" };
        const pr = await deps.hosted.verifyPullRequest({ accountId, codeRepo: facts.codeRepo, branch: facts.branch, number: line.pr_number! });
        return pr === null || !publicPullRequestUrlMatches(facts.codeRepo, line.pr_number!, pr.url) ? mismatch : { outcome: { state: "pr_opened", headSha: line.head_sha, tipSha: line.tip_sha, prNumber: line.pr_number!, prUrl: pr.url }, label: "pr_opened" };
      } catch {
        // fx-swallow-ok: GitHub could not be asked; nothing is stored from the line and the item shows the fixed unavailable refusal
        return REFUSED("public_unavailable");
      }
    }
    default:
      return mismatch;
  }
}

/** How the platform's own opening of the private pull request ended. `skipped`: nothing to do or no GitHub port; `failed`: GitHub or the rows could not say (the driver then finds no pull request, as it always has). */
export type PrivatePullRequest = "opened" | "reused" | "skipped" | "failed";

/**
 * D#598 P1f-5c (Q1): opens the private pull request for a paired sandbox build, as a runner run's `done` does: a draft (or the open one on the branch, if our App opened it),
 * made ready at once (a hosted build has no file-scope check to wait for). Repo, branch, base and text come from our rows; nothing the agent wrote chooses any of them.
 */
async function openPrivatePullRequest(deps: PlanePublishDeps, accountId: string, facts: Facts): Promise<PrivatePullRequest> {
  const port = deps.pullRequests;
  if (!port) return "skipped";
  try {
    // The private draft is opened on the build identity's branch: `fx/issue-<n>`, or a planned PR child's own `fx/<parent#>-<key>`. A refusal opens nothing.
    const resolved = await resolveIdentity(deps.pool, accountId, facts.workItemId, "observe");
    if (!resolved.ok) return "skipped";
    const { text, parent } = await withTenant(deps.pool, accountId, async (c) => ({ text: await loadRunPullRequestText(c, { accountId, runId: facts.runId }), parent: await readStackParentPull(c, facts.workItemId) }));
    if (text === null) return "failed";
    let base = await port.defaultBranch(facts.repo);
    if (parent !== null) {
      // A stacked item's run branched from its parent's branch, so its pull request goes against that branch (a parent that merged since is the default branch).
      if (parent.prNumber === null || !deps.stackBase) return "failed";
      const decided = decideStackStart(await deps.stackBase.readParent({ repoId: facts.repo.id, owner: facts.repo.owner, name: facts.repo.name, prNumber: parent.prNumber }));
      if (!decided.ok) return "failed";
      if (decided.base !== null) base = decided.base.branch;
    }
    const pr = await port.openDraft({ repo: facts.repo, branch: resolved.identity.branch, base, run: text });
    if (pr.draft) {
      try {
        await port.markReady({ repo: facts.repo, pullRequest: pr });
      } catch {
        // fx-swallow-ok: as in `done`, a refusal to mark ready leaves a good pull request open as a draft; someone with write access marks it ready
      }
    }
    // The marker: this run's private pull request is open. Written once it is, so a replay opens nothing and a pull request a person closes stays closed.
    try {
      await withTenant(deps.pool, accountId, (c) => insertRunEvent(c, accountId, facts.runId, PRIVATE_PR_MARKER, { outcome: pr.reused ? "reused" : "opened", pr: pr.number }));
    } catch {
      // fx-swallow-ok: the pull request is open; a missing marker only means a replay looks for it again and reuses it
    }
    return pr.reused ? "reused" : "opened";
  } catch {
    // fx-swallow-ok: any failure here is the existing "no pull request" outcome for a person to look at; it never stops the publish step
    return "failed";
  }
}

/** "Open the pull request again" for `pushed_pr_not_opened`, either runtime: the hosted side opens it with a fresh token. No sandbox, no run row, no git. */
export type OpenPublicResult =
  | { kind: "opened"; prNumber: number; attemptNo: number }
  | { kind: "refused"; code: string; attemptNo: number | null }
  | { kind: "skipped"; why: "not_retryable" }
  | { kind: "not_configured" };

/**
 * The build identity of an item, in a short transaction of its own (`start` takes a planned PR child's launch lock). A refusal carries the code to store: the resolver's for a planned PR
 * child, `bad_input` for a top-level item (its stored word for an item with no issue number, unchanged).
 */
async function resolveIdentity(pool: Pool, accountId: string, workItemId: string, purpose: BuildPurpose): Promise<{ ok: true; identity: BuildIdentity } | { ok: false; code: string }> {
  const r = await withTenant(pool, accountId, (c) => resolveBuildIdentity(c, accountId, workItemId, purpose));
  return r.ok ? r : { ok: false, code: r.isChild ? r.reason : "bad_input" };
}

/** The title the public text is built from: a child's goes through `cleanWorkItemTitle` first, as everything a person reads does (the text builder then cleans it again for the public plane). */
const textTitle = (stored: string, build: TextIdentity): string => (build.isChild ? safeChildTitle(cleanWorkItemTitle(stored)) : stored);

/** True when a planned PR child's finished public body would still close an issue (the final guard in `buildPlanePushText`). */
export function childTextRefused(title: string, runId: string, prFooter: string | null, build: TextIdentity): boolean {
  if (!build.isChild) return false;
  try {
    buildPlanePushText({ itemTitle: textTitle(title, build), runId, prFooter, issueNumber: build.issueNumber, child: true });
    return false;
  } catch (err) {
    if (err instanceof Error && err.message === CHILD_BODY_CLOSING_CODE) return true;
    throw err;
  }
}

/** R9: records the code-plane pull request on the child's executor run, once: `{ branch: the push row's public branch, prNumber, plane: "code", codeRepo }`. A second record for the run adds nothing. */
async function bindChildCodePullRequest(client: PoolClient, accountId: string, facts: Pick<Facts, "runId" | "branch" | "codeRepo">, prNumber: number): Promise<void> {
  await recordChildCodePullRequest(client, accountId, facts.runId, { branch: facts.branch, prNumber, codeRepo: facts.codeRepo });
}

/** A footer that is left off the body (it needs an issue number the item lacks, or, for a planned PR child, it would close the parent's issue): the run records a notice line so the person can see why. */
type TextIdentity = { issueNumber: number | null; isChild: boolean };
async function noteFooterSkipped(pool: Pool, accountId: string, runId: string, footer: string | null, build: TextIdentity): Promise<void> {
  const reason = prFooterSkipReason(footer, build.issueNumber, { child: build.isChild });
  if (reason === null) return;
  await withTenant(pool, accountId, (c) => insertRunEvent(c, accountId, runId, PR_FOOTER_SKIPPED, { reason }));
}

async function openPublicPullRequest(deps: PlanePublishDeps, accountId: string, workItemId: string): Promise<OpenPublicResult> {
  const { rows } = await withTenant(deps.pool, accountId, (c) =>
    c.query<{ id: string; code_repo: string; branch: string; state: PlanePushState; head_sha: string | null; tip_sha: string | null; source_head: string | null; managed: boolean; title: string; run_id: string | null; pairing_repo: string | null; pr_footer: string | null }>(
      `SELECT p.id, p.code_repo, p.branch, p.state, p.head_sha, p.tip_sha, p.source_head, p.managed_by_person_at IS NOT NULL AS managed, COALESCE(w.title, '') AS title,
              (SELECT r.id FROM agent_runs r WHERE r.account_id = p.account_id AND r.work_item_id = p.work_item_id AND r.role = 'executor' ORDER BY r.created_at DESC, r.id LIMIT 1) AS run_id,
              (SELECT rp.code_repo FROM repo_pairing rp WHERE rp.account_id = p.account_id AND rp.repo_id = p.repo_id) AS pairing_repo,
              (SELECT rp.pr_footer FROM repo_pairing rp WHERE rp.account_id = p.account_id AND rp.repo_id = p.repo_id) AS pr_footer
         FROM plane_pushes p JOIN work_items w ON w.account_id = p.account_id AND w.id = p.work_item_id
        WHERE p.account_id = $1 AND p.work_item_id = $2`,
      [accountId, workItemId],
    ),
  );
  const p = rows[0];
  if (!p || p.state !== "pushed_pr_not_opened" || p.managed || p.head_sha === null || p.tip_sha === null || p.run_id === null) return { kind: "skipped", why: "not_retryable" };
  // The pairing is read now. A pairing that is off or points elsewhere writes nothing to the public repo and records nothing: the pushed branch stays as it is.
  if (p.pairing_repo === null) return { kind: "refused", code: PUBLISH_CODES.pairingOff, attemptNo: null };
  if (p.pairing_repo !== p.code_repo) return { kind: "refused", code: "pairing_changed", attemptNo: null };

  // The issue number is the build identity's (a planned PR child's is its parent's). A top-level item with no number keeps the old behaviour: no footer that needs one.
  // Resolved, and the child's final text guard run, BEFORE the attempt row exists: a refusal here leaves no attempt behind, as on the other paths.
  const found = await withTenant(deps.pool, accountId, (c) => resolveBuildIdentity(c, accountId, workItemId, "observe"));
  if (!found.ok && found.isChild) return { kind: "refused", code: found.reason, attemptNo: null };
  const build: TextIdentity = found.ok ? found.identity : { issueNumber: null, isChild: false };
  if (childTextRefused(p.title, p.run_id, p.pr_footer, build)) return { kind: "refused", code: CHILD_BODY_CLOSING_CODE, attemptNo: null };

  const attemptId = randomUUID();
  const attemptNo = await withTenant(deps.pool, accountId, async (c) => {
    await c.query("SELECT 1 FROM plane_pushes WHERE account_id = $1 AND id = $2 FOR UPDATE", [accountId, p.id]);
    // Numbered per kind (migration 0882): a PR-open retry counts its own, and never takes a number a push attempt may use.
    const { rows: n } = await c.query<{ n: number }>("SELECT COALESCE(max(attempt_no), 0)::int + 1 AS n FROM plane_push_attempts WHERE account_id = $1 AND plane_push_id = $2 AND kind = 'pr_open'", [accountId, p.id]);
    await c.query("INSERT INTO plane_push_attempts (id, account_id, plane_push_id, run_id, runtime, kind, attempt_no) VALUES ($1, $2, $3, NULL, 'hosted', 'pr_open', $4)", [attemptId, accountId, p.id, n[0]!.n]);
    return n[0]!.n;
  });
  const end = async (outcome: string, record?: VerifiedOutcome, after?: (c: PoolClient) => Promise<void>): Promise<void> =>
    withTenant(deps.pool, accountId, async (c) => {
      if (record) await recordVerifiedOutcome(c, { accountId, id: p.id, outcome: record });
      if (after) await after(c);
      await c.query("UPDATE plane_push_attempts SET finished_at = now(), outcome = $3 WHERE account_id = $1 AND id = $2", [accountId, attemptId, outcome]);
    });
  const stop = async (code: string): Promise<OpenPublicResult> => {
    await end(code);
    return { kind: "refused", code, attemptNo };
  };
  try {
    // The branch must still hold exactly what was pushed, on the tip it was built on: nothing else is turned into a pull request.
    if (!(await deps.hosted.verifyPushed({ accountId, codeRepo: p.code_repo, branch: p.branch, headSha: p.head_sha, tipSha: p.tip_sha }))) return await stop(PUBLISH_CODES.reportMismatch);
    // The footer is validated when the pairing is written. This path pushes nothing and has no rule files to scan with; the push paths scan the body they send.
    const text = buildPlanePushText({ itemTitle: textTitle(p.title, build), runId: p.run_id, prFooter: p.pr_footer, issueNumber: build.issueNumber, child: build.isChild });
    await noteFooterSkipped(deps.pool, accountId, p.run_id, p.pr_footer, build);
    const opened = await deps.hosted.openPullRequest({ accountId, codeRepo: p.code_repo, branch: p.branch, title: text.title, body: text.body });
    const pr = await deps.hosted.verifyPullRequest({ accountId, codeRepo: p.code_repo, branch: p.branch, number: opened.number });
    if (pr === null || !publicPullRequestUrlMatches(p.code_repo, opened.number, pr.url)) return await stop(PUBLISH_CODES.reportMismatch);
    await end("pr_opened", { state: "pr_opened", headSha: p.head_sha, tipSha: p.tip_sha, ...(p.source_head !== null ? { sourceHead: p.source_head } : {}), prNumber: opened.number, prUrl: pr.url }, build.isChild ? (c) => bindChildCodePullRequest(c, accountId, { runId: p.run_id!, branch: p.branch, codeRepo: p.code_repo }, opened.number) : undefined);
    return { kind: "opened", prNumber: opened.number, attemptNo };
  } catch (err) {
    // fx-swallow-ok: GitHub's answer becomes one of two fixed words; the item stays "pushed, pull request not opened" and can be tried again
    return stop((err as { code?: string } | undefined)?.code === "pr_failed" ? "pr_failed" : "public_unavailable");
  }
}

export interface PlanePublish {
  /**
   * D#598 P1f-5c: after a SANDBOX executor run settles `succeeded` on a paired repository: open the private pull request, then make the publish attempt. The two are
   * independent (a failure of one never stops the other). An item that is not at the start of its public change (a fix round, a replay, an unpaired repo) does nothing.
   */
  settlePairedBuild(input: { accountId: string; executorRunId: string }): Promise<{ privatePullRequest: PrivatePullRequest; publish: PublishResult }>;
  /** "Open the pull request again" for an item in `pushed_pr_not_opened`. */
  openPublicPullRequest(input: { accountId: string; workItemId: string }): Promise<OpenPublicResult>;
  /** After an executor run settles: one publish attempt, or a skip (unpaired, not a finished sandbox executor run). */
  publishPairedChange(input: { accountId: string; executorRunId: string }): Promise<PublishResult>;
  /** "Try the push again": the next attempt (2 or 3), or the stored refusal `retry_limit` / `pairing_off`, or a skip when the item may not retry. */
  retryPublish(input: { accountId: string; workItemId: string }): Promise<PublishResult>;
}

export function createPlanePublish(deps: PlanePublishDeps | null): PlanePublish {
  if (deps === null) {
    return {
      publishPairedChange: async () => ({ kind: "not_configured" }),
      retryPublish: async () => ({ kind: "not_configured" }),
      openPublicPullRequest: async () => ({ kind: "not_configured" }),
      settlePairedBuild: async () => ({ privatePullRequest: "skipped", publish: { kind: "not_configured" } }),
    };
  }
  return {
    async settlePairedBuild(i) {
      const facts = await withTenant(deps.pool, i.accountId, (c) => readFacts(c, i.accountId, { runId: i.executorRunId }));
      // A sandbox fix round that was started to update the open public pull request (it carries the base the cloud signed): the update, and no private pull request (it has one).
      if (facts !== null && facts.sandboxSide && facts.status === "succeeded" && facts.fixBase !== null) return { privatePullRequest: "skipped", publish: await republish(deps, i.accountId, facts) };
      // Only the start of an item's public change: a sandbox executor run that finished, on a record that is still at the start (building or scanning). "Already settled" is
      // judged per executor run, not per record: Build again re-stamps a refused record to building and keeps its old attempts, and its new run must still open the private
      // pull request and publish.
      const atStart = facts !== null && facts.sandboxSide && facts.status === "succeeded" && (facts.state === "building" || facts.state === "scanning");
      if (!facts || !atStart || (facts.privatePrDone && facts.runPushAttempts > 0)) return { privatePullRequest: "skipped", publish: { kind: "skipped", why: "not_paired" } };
      const privatePullRequest = facts.privatePrDone ? "skipped" : await openPrivatePullRequest(deps, i.accountId, facts);
      const publish = await attempt(deps, i.accountId, { runId: i.executorRunId }, "first");
      // The record already holds its three push attempts: nothing is published, and the item says why instead of waiting on a public change that will never come.
      if (publish.kind === "refused" && publish.code === PUBLISH_CODES.retryLimit && publish.attemptNo === null) await markBuildNeedsHuman(deps.pool, i.accountId, facts.workItemId, facts.runId, "push_cap_reached");
      return { privatePullRequest, publish };
    },
    openPublicPullRequest: (i) => openPublicPullRequest(deps, i.accountId, i.workItemId),
    publishPairedChange: (i) => attempt(deps, i.accountId, { runId: i.executorRunId }, "first"),
    retryPublish: (i) => attempt(deps, i.accountId, { workItemId: i.workItemId }, "retry"),
  };
}
