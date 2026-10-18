import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PLANE_REFUSAL_CODES, type PlaneRefusalCode } from "@fulcrumaxe/runner-protocol/planePush";
import { buildPlanePushText } from "@fulcrumaxe/runner-protocol/planePushText";
import { withTenant } from "@fx/db/src/withTenant.js";
import { pairingDigest, recordVerifiedOutcome, type PlanePushState, type VerifiedOutcome } from "@fx/core/src/repos/planePushRecord.js";
import { PLANE_PUBLISH_ROLE, PLANE_PUBLISH_VCPUS, insertAgentRun, runPublishSandbox, sandboxNameFor, writeRunStatus, writeRunStatusOn, type ExecutionRun, type LostRunOutcome, type NetworkPolicyRule, type PlanePublishInput, type PlanePublishLine, type SandboxPort } from "@fx/runner";
import { sandboxRunCost } from "@fx/spend";

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

/** A push has at most this many attempts per row (the schema checks the same number). */
export const PUBLISH_ATTEMPT_LIMIT = 3;
/** The worker's own refusal codes, next to the hook's (`PlaneRefusalCode`). They are stored as the item's code and the attempt's label. */
export const PUBLISH_CODES = { retryLimit: "retry_limit", pairingOff: "pairing_off", hookCrashed: "hook_crashed", reportMismatch: "report_mismatch" } as const;

/** What the retry predicate needs: the push row's state, the runtime of its latest push attempt, and how many push attempts it has. */
export interface RetryFacts {
  state: PlanePushState;
  lastPushRuntime: "runner" | "sandbox" | "hosted" | null;
  pushAttempts: number;
  managedByPerson: boolean;
}

/**
 * THE one predicate for "may this item try the push again now": a refused push of a sandbox build with fewer than three push attempts. `retryPublish`
 * enforces it, and P1f-6's `retry_push` action lists itself from it, so the page never offers a retry that would be refused. (A `pushed_pr_not_opened`
 * item is not here: that retry opens the PR with no sandbox, and it is 5c's.)
 */
export function mayRetryPublish(f: RetryFacts): boolean {
  return f.state === "refused" && f.lastPushRuntime === "sandbox" && f.pushAttempts < PUBLISH_ATTEMPT_LIMIT && !f.managedByPerson;
}

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
  /** The hosted side's reads of the public repo, each with its own short-lived token. */
  hosted: {
    verifyPushed(input: { codeRepo: string; branch: string; headSha: string; tipSha: string }): Promise<boolean>;
    verifyPullRequest(input: { codeRepo: string; branch: string; number: number }): Promise<{ url: string } | null>;
  };
  now?: () => number;
}

export type PublishResult =
  /** Nothing to do: the item is unpaired, the run is not a finished sandbox executor run, or the item may not retry now. No run row, no sandbox. */
  | { kind: "skipped"; why: "not_paired" | "not_done" | "not_retryable" | "busy" }
  /** The push was refused (or the platform could not start it); `attemptNo` is set when a sandbox attempt was made. */
  | { kind: "refused"; code: string; attemptNo: number | null }
  | { kind: "published"; state: "pr_opened" | "pushed_pr_not_opened" | "no_public_change"; attemptNo: number }
  /** The worker was built without the publish ports: nothing was read, recorded or started. */
  | { kind: "not_configured" };

interface Facts {
  runId: string;
  status: string;
  sandboxSide: boolean;
  baseSha: string | null;
  workItemId: string;
  repo: { id: string; owner: string; name: string };
  issue: string | null;
  title: string;
  pushId: string;
  codeRepo: string;
  branch: string;
  stampedDigest: string;
  state: PlanePushState;
  managedByPerson: boolean;
  pushAttempts: number;
  lastPushRuntime: RetryFacts["lastPushRuntime"];
  pairing: { codeRepo: string; overlayGlobs: string[]; identifierRulesPath: string | null; planDataRulesPath: string | null } | null;
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
            rp.gh_owner, rp.gh_name, w.gh_number::text AS issue, COALESCE(w.title, '') AS title
       FROM agent_runs r
       JOIN work_items w ON w.account_id = r.account_id AND w.id = r.work_item_id
       JOIN repos rp ON rp.account_id = r.account_id AND rp.id = r.dispatch_repo_id
      WHERE r.account_id = $1 AND r.role = 'executor' AND ${byRun ? "r.id = $2" : "r.work_item_id = $2 AND r.status = 'succeeded' AND r.runtime = 'production'"}
      ORDER BY r.created_at DESC, r.id LIMIT 1`,
    [accountId, byRun ? which.runId : which.workItemId],
  );
  const r = rows[0];
  if (!r) return null;
  const { rows: pairs } = await client.query<{ code_repo: string; overlay_globs: string[]; identifier_rules_path: string | null; plan_data_rules_path: string | null }>(
    "SELECT code_repo, overlay_globs, identifier_rules_path, plan_data_rules_path FROM repo_pairing WHERE repo_id = $1 AND account_id = $2",
    [r.dispatch_repo_id, accountId],
  );
  const p = pairs[0];
  const { rows: pushes } = await client.query(
    `SELECT id, code_repo, branch, pairing_digest, state, managed_by_person_at IS NOT NULL AS managed FROM plane_pushes
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
  return {
    runId: r.run_id, status: r.status, sandboxSide: r.sandbox_side === true, baseSha: r.head_sha, workItemId: r.work_item_id,
    repo: { id: r.dispatch_repo_id, owner: r.gh_owner, name: r.gh_name }, issue: r.issue, title: r.title,
    pushId: push.id, codeRepo: push.code_repo, branch: push.branch, stampedDigest: push.pairing_digest, state: push.state, managedByPerson: push.managed === true,
    // An item refused before any sandbox was started has no attempt yet; its executor ran in the sandbox, so a retry is a sandbox retry.
    pushAttempts: stats[0]?.n ?? 0, lastPushRuntime: stats[0]?.last ?? (r.sandbox_side === true ? "sandbox" : null),
    pairing: p ? { codeRepo: p.code_repo, overlayGlobs: p.overlay_globs, identifierRulesPath: p.identifier_rules_path, planDataRulesPath: p.plan_data_rules_path } : null,
  };
}

const digestOf = (p: NonNullable<Facts["pairing"]>): string => pairingDigest({ codeRepo: p.codeRepo, overlayGlobs: p.overlayGlobs, identifierRulesPath: p.identifierRulesPath, planDataRulesPath: p.planDataRulesPath });

/** Thrown inside the create transaction when the row already has its three push attempts: the run row and the attempt row roll back together. */
class AttemptLimitReached extends Error {}
/** Thrown inside the create transaction when a first attempt finds an earlier push attempt (a replay that raced the first one). */
class AttemptOutOfOrder extends Error {}
/** The schema index that allows one live publish run per executor run (0680): the only unique violation that means "another attempt is in flight". */
const LIVE_CHILD_INDEX = "agent_runs_one_live_continuation_per_parent";

type Mode = "first" | "retry";

async function attempt(deps: PlanePublishDeps, accountId: string, which: { runId: string } | { workItemId: string }, mode: Mode): Promise<PublishResult> {
  const now = deps.now ?? Date.now;
  const facts = await withTenant(deps.pool, accountId, (c) => readFacts(c, accountId, which));
  if (!facts || !facts.sandboxSide) return { kind: "skipped", why: "not_paired" };
  if (facts.status !== "succeeded") return { kind: "skipped", why: "not_done" };
  /** Records a refusal on the item with no attempt spent (nothing was started), e.g. a limit reached or a pairing now off. */
  const refuse = async (code: string): Promise<PublishResult> => {
    await withTenant(deps.pool, accountId, (c) => recordVerifiedOutcome(c, { accountId, id: facts.pushId, outcome: { state: "refused", code } }));
    return { kind: "refused", code, attemptNo: null };
  };

  if (mode === "retry") {
    if (!mayRetryPublish(facts)) {
      if (facts.state === "refused" && facts.lastPushRuntime === "sandbox" && facts.pushAttempts >= PUBLISH_ATTEMPT_LIMIT && !facts.managedByPerson) return refuse(PUBLISH_CODES.retryLimit);
      return { kind: "skipped", why: "not_retryable" };
    }
    if (facts.pairing === null) return refuse(PUBLISH_CODES.pairingOff);
  } else if (facts.pushAttempts > 0 || (facts.state !== "building" && facts.state !== "scanning")) {
    // The first attempt runs once per build: a replay (or an item that already has a record of its push) must not start a second sandbox.
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
  if (identity === null || facts.baseSha === null || !/^[0-9a-f]{40}$/.test(facts.baseSha) || facts.issue === null) return refuse("bad_input");
  let policy: NetworkPolicyRule[];
  let head: string | null;
  try {
    policy = await deps.networkPolicy();
    head = await deps.privateHead({ repo: facts.repo, branch: `fx/issue-${facts.issue}` });
  } catch {
    // fx-swallow-ok: the proxy host or GitHub could not be used; nothing was started, the item shows the fixed unavailable refusal
    return refuse("public_unavailable");
  }
  if (head === null) return refuse("bad_input");

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
          await client.query("SELECT 1 FROM plane_pushes WHERE account_id = $1 AND id = $2 FOR UPDATE", [accountId, facts.pushId]);
          // Numbered like the runner path: past the highest number of ANY kind (a later `pr_open` row takes the next one), while the limit counts push attempts.
          const { rows } = await client.query<{ pushes: number; top: number }>(
            "SELECT count(*) FILTER (WHERE kind = 'push')::int AS pushes, COALESCE(max(attempt_no), 0)::int AS top FROM plane_push_attempts WHERE account_id = $1 AND plane_push_id = $2",
            [accountId, facts.pushId],
          );
          const pushes = rows[0]?.pushes ?? 0;
          attemptNo = (rows[0]?.top ?? 0) + 1;
          if (mode === "first" && pushes !== 0) throw new AttemptOutOfOrder();
          if (pushes >= PUBLISH_ATTEMPT_LIMIT || attemptNo > PUBLISH_ATTEMPT_LIMIT) throw new AttemptLimitReached();
          await client.query(`INSERT INTO plane_push_attempts (id, account_id, plane_push_id, run_id, runtime, kind, attempt_no) VALUES ($1, $2, $3, $4, 'sandbox', 'push', $5)`, [attemptId, accountId, facts.pushId, runId, attemptNo]);
          await client.query("SELECT agent_run_sandbox_mark($1::uuid, $2::uuid, true, NULL, false, NULL, NULL, $3::text)", [accountId, runId, name]);
        },
      })
    ).id;
  } catch (err) {
    if (err instanceof AttemptLimitReached) return refuse(PUBLISH_CODES.retryLimit);
    if (err instanceof AttemptOutOfOrder) return { kind: "skipped", why: "busy" };
    // Another attempt is in flight (the live-child index). Any other unique violation is a real fault and is not hidden as "busy".
    const pg = err as { code?: string; constraint?: string } | undefined;
    if (pg?.code === "23505" && pg.constraint === LIVE_CHILD_INDEX) return { kind: "skipped", why: "busy" };
    throw err;
  }

  // From here the attempt is real: whatever happens, it ends terminal and the sandbox ends deleted (runPublishSandbox's finally).
  const text = buildPlanePushText({ itemTitle: facts.title, runId: facts.runId });
  const input: PlanePublishInput = {
    own: { owner: facts.repo.owner, name: facts.repo.name }, codeRepo: facts.codeRepo, privateBase: facts.baseSha, privateHead: head, branch: facts.branch, title: text.title, body: text.body,
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
      ({ outcome, label } = after?.pairing && digestOf(after.pairing) === givenDigest ? await verify(deps, facts, run.terminal) : { outcome: { state: "refused", code: "pairing_changed" }, label: "pairing_changed" });
    }
  } catch {
    // fx-swallow-ok: the sandbox, the write or GitHub failed in a way the hook's output cannot explain; the item shows the fixed crash refusal
    crashed = true;
    ({ outcome, label } = { outcome: { state: "refused", code: PUBLISH_CODES.hookCrashed }, label: PUBLISH_CODES.hookCrashed });
  }
  const seconds = Math.max(0, Math.round((now() - started) / 1000));
  // The price comes from the vCPUs this sandbox was created with (1), not the pinned 2 every agent sandbox has.
  const cost = sandboxRunCost([{ ownDurationMs: seconds * 1000 }], { vcpus: PLANE_PUBLISH_VCPUS });
  await finishAttempt(deps.pool, accountId, {
    pushId: facts.pushId, attemptId, runId: publishRunId, outcome, label, failed: crashed, usd: cost.usd,
    envelope: { publish: { attempt_no: attemptNo, outcome: label, seconds, vcpus: PLANE_PUBLISH_VCPUS, usd: cost.usd, basis: cost.basis } },
  });
  if (outcome.state === "refused") return { kind: "refused", code: outcome.code!, attemptNo };
  return { kind: "published", state: outcome.state as "pr_opened" | "pushed_pr_not_opened" | "no_public_change", attemptNo };
}

interface Finish {
  pushId: string;
  attemptId: string;
  runId: string;
  outcome: VerifiedOutcome;
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
    await recordVerifiedOutcome(client, { accountId, id: f.pushId, outcome: f.outcome });
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
          `SELECT r.status, r.sandbox_name, r.sandbox_requested_at, a.id AS attempt_id, a.plane_push_id, a.finished_at
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
      await finishAttempt(deps.pool, run.accountId, {
        pushId: row.plane_push_id, attemptId: row.attempt_id, runId: run.id, outcome: { state: "refused", code: PUBLISH_CODES.hookCrashed }, label: PUBLISH_CODES.hookCrashed, failed: true, usd: 0, envelope: null,
      });
      return "settled";
    },
  };
}

const REFUSED = (code: string, refusals?: PlanePublishLine["refusals"]): { outcome: VerifiedOutcome; label: string } => ({ outcome: { state: "refused", code, ...(refusals ? { refusals } : {}) }, label: code });

/** The hook's terminal line becomes an outcome only after GitHub confirms it (report verification, C4 point 1a). Anything doubtful is `report_mismatch`, storing nothing from the line. */
async function verify(deps: PlanePublishDeps, facts: Facts, line: PlanePublishLine): Promise<{ outcome: VerifiedOutcome; label: string }> {
  const mismatch = REFUSED(PUBLISH_CODES.reportMismatch);
  switch (line.phase) {
    case "no_change":
      return { outcome: { state: "no_public_change" }, label: "no_change" };
    case "refused":
      return line.code !== undefined && (PLANE_REFUSAL_CODES as readonly string[]).includes(line.code) ? REFUSED(line.code as PlaneRefusalCode, line.refusals) : mismatch;
    case "pr_opened":
    case "pr_failed": {
      if (line.head_sha === undefined || line.tip_sha === undefined || (line.branch !== undefined && line.branch !== facts.branch)) return mismatch;
      if (line.phase === "pr_opened" && line.pr_number === undefined) return mismatch;
      try {
        // The branch is the push row's, whatever the line says.
        if (!(await deps.hosted.verifyPushed({ codeRepo: facts.codeRepo, branch: facts.branch, headSha: line.head_sha, tipSha: line.tip_sha }))) return mismatch;
        if (line.phase === "pr_failed") return { outcome: { state: "pushed_pr_not_opened", headSha: line.head_sha, tipSha: line.tip_sha }, label: "pr_failed" };
        const pr = await deps.hosted.verifyPullRequest({ codeRepo: facts.codeRepo, branch: facts.branch, number: line.pr_number! });
        return pr === null ? mismatch : { outcome: { state: "pr_opened", headSha: line.head_sha, tipSha: line.tip_sha, prNumber: line.pr_number!, prUrl: pr.url }, label: "pr_opened" };
      } catch {
        // fx-swallow-ok: GitHub could not be asked; nothing is stored from the line and the item shows the fixed unavailable refusal
        return REFUSED("public_unavailable");
      }
    }
    default:
      return mismatch;
  }
}

export interface PlanePublish {
  /** After an executor run settles: one publish attempt, or a skip (unpaired, not a finished sandbox executor run). */
  publishPairedChange(input: { accountId: string; executorRunId: string }): Promise<PublishResult>;
  /** "Try the push again": the next attempt (2 or 3), or the stored refusal `retry_limit` / `pairing_off`, or a skip when the item may not retry. */
  retryPublish(input: { accountId: string; workItemId: string }): Promise<PublishResult>;
}

export function createPlanePublish(deps: PlanePublishDeps | null): PlanePublish {
  if (deps === null) return { publishPairedChange: async () => ({ kind: "not_configured" }), retryPublish: async () => ({ kind: "not_configured" }) };
  return {
    publishPairedChange: (i) => attempt(deps, i.accountId, { runId: i.executorRunId }, "first"),
    retryPublish: (i) => attempt(deps, i.accountId, { workItemId: i.workItemId }, "retry"),
  };
}
