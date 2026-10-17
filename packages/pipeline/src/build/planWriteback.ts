import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  MAX_ROADMAP_BYTES,
  PlanFileInconsistentError,
  PlanFileShapeError,
  PlanWriteError,
  ROADMAP_PATHS,
  applyTaskUpdates,
  computePlan,
  parseRoadmapFile,
  type PullFacts,
  type TaskUpdate,
} from "@fx/core/src/plan/index.js";
import {
  endWritebackEntry,
  enqueuePlanWriteback,
  getEntryByPlanWriteback,
  holdWritebackForPush,
  releaseWritebackAfterPush,
  stopEntry,
} from "../mergeQueue/store.js";
import { compileOverlay } from "@fulcrumaxe/runner-protocol/planePush";
import { PLAN_UPDATE_BRANCH_PREFIX, WritebackGitHubError, type WritebackGitHub } from "./planWritebackGitHub.js";
import {
  getWriteback,
  insertOpening,
  loadWritebackContext,
  moveState,
  recordNeedsSetup,
  recordOpen,
  type PlanWritebackRow,
} from "./planWritebackStore.js";

/**
 * D#598 P5b (Correction C3, R-598-P5b-1 to -10): the post-merge plan write-back. After pull requests merge, the platform brings the plan
 * file's `task_status` (status, prs, open_prs) in step with GitHub, in ONE pull request per repo that a person merges. Deterministic
 * platform code throughout (R-597-1): no model, no agent run, no work item.
 *
 *  - Truth, not replay. The content is always recomputed from the default branch's copy of the file and what GitHub says about the
 *    pull requests, with the pure writer (`applyTaskUpdates`, P5a). A write-back that was closed or lost is replaced by one built from
 *    current truth. Rows only move forward: a status is never lowered, a recorded pull request is never removed from `prs`, and a
 *    status a person set to anything outside the managed words is never touched.
 *  - One pending PR per repo. The next merge finds the open write-back and extends it with one commit to the platform's own branch
 *    (a fast-forward), and only while its queue entry does not hold the slot. The database allows one live write-back per repo.
 *  - The platform's record decides, not the author. `plan_writebacks` keeps the branch and the head sha the platform pushed. A head
 *    that is not that sha means someone else pushed: the platform stops writing to the branch and the entry stops.
 *  - Where it goes. The write-back goes to the repo that holds the plan file, through that repo's own queue as a `plan_writeback`
 *    entry. On a paired repo the plan file must be on the overlay list, else nothing is opened and a setup need is recorded: plan data is
 *    never pushed to the public repo.
 *  - Nothing here merges. Default (toggle off, and P5b ships no toggle): a person merges. The toggle and the automatic merge gate are
 *    P5c, which needs the queue tick (MQ3).
 *
 * Errors. A plan file that does not parse is reported as a fixed code. The parser's and writer's own messages can echo task keys, so
 * they are never logged, stored, returned or thrown on from here.
 */

/** A write-back fails twice in a row (original, then one fresh attempt) and the entry stops for a person (AC 3 of Correction C3). */
export const MAX_WRITEBACK_ATTEMPTS = 2;
/** A hold taken for a push and never released (a crash) is released by the next run after this long. */
export const STUCK_HOLD_MINUTES = 5;

export const WRITEBACK_PR_TITLE = "Update plan status for merged pull requests";
export const WRITEBACK_COMMIT_MESSAGE = "Update plan status for merged pull requests";

/** Fixed reason codes written to `plan_writebacks.reason` and the queue entry. No GitHub or model text ever becomes one. */
export type WritebackReason =
  | "plan_file_not_in_overlay"
  | "changed_by_someone_else"
  | "writeback_changed_by_other"
  | "writeback_replaced"
  | "writeback_not_needed"
  | "writeback_empty_branch";

/** What a refused refresh was, when the queue tick asks for a restart. These are D#519's own stop codes. */
export type RestartCause = "merge_conflict" | "branch_behind";

/**
 * The fixed sentences "Needs you" (P8c) shows for a write-back. Pure functions of a fixed template and a number or a validated path:
 * no model text, no GitHub text.
 */
export function writebackNotice(n: { kind: "changed_by_other"; prNumber: number } | { kind: "plan_file_not_in_overlay"; path: string } | { kind: "waiting" }): string {
  if (n.kind === "changed_by_other") {
    return `The plan update PR #${n.prNumber} was changed by someone else. Merge or close it to resume plan updates.`;
  }
  if (n.kind === "plan_file_not_in_overlay") return `Add ${n.path} to the overlay paths.`;
  return "Plan update waiting";
}

// ---- the pure content ------------------------------------------------------------------------------------------------------------

/**
 * The words this job manages, in the order a task moves through them. Anything else a person set (split, removed, deferred, blocked,
 * ...) is theirs and is never touched. `done` is ranked so a target is compared against it, but a row already `done` is never moved.
 */
const STATUS_RANK: ReadonlyMap<string | null, number> = new Map<string | null, number>([
  [null, 0],
  ["not_started", 0],
  ["in_progress", 1],
  ["in_review", 2],
  ["done", 3],
]);

const sameNumbers = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((n, i) => n === b[i]);
const sorted = (xs: readonly number[]): number[] => [...new Set(xs)].sort((x, y) => x - y);

/**
 * The per-task updates that bring a plan file in step with the pull requests. Throws what `parseRoadmapFile` throws on a file that is
 * not a plan file; `buildWritebackText` is the caller that turns that into a fixed code.
 */
export function deriveTaskUpdates(fileText: string, pulls: readonly PullFacts[]): TaskUpdate[] {
  const parsed = parseRoadmapFile(fileText);
  const computed = new Map(computePlan(parsed, pulls).tasks.map((t) => [t.key, t] as const));
  const updates: TaskUpdate[] = [];
  for (const row of parsed.tasks) {
    const c = computed.get(row.key);
    if (!c) continue;
    const u: TaskUpdate = { key: row.key };

    // prs only grows: the file's own record plus every merged pull request GitHub says belongs to the task.
    const prs = sorted([...row.filePrs, ...c.mergedPrs]);
    if (!sameNumbers(prs, sorted(row.filePrs))) u.prs = prs;

    // open_prs is a statement about now, so it is replaced by what GitHub says is open.
    const openPrs = sorted(c.openPrs);
    if (!sameNumbers(openPrs, sorted(row.fileOpenPrs))) u.openPrs = openPrs;

    // status moves forward only: a target is written only when it ranks ABOVE the file's current word, so a task whose open pull
    // request has since merged (in_review, with more to come) stays in_review, and a done row stays done. A word outside the ranked
    // ones is a person's and is left alone.
    const current = STATUS_RANK.get(row.fileStatus);
    if (current !== undefined && current < 3) {
      const target = c.status === "done" ? "done" : c.openPrs.length > 0 ? "in_review" : c.mergedPrs.length > 0 ? "in_progress" : null;
      if (target !== null && STATUS_RANK.get(target)! > current) u.status = target;
    }
    if (u.prs !== undefined || u.openPrs !== undefined || u.status !== undefined) updates.push(u);
  }
  return updates;
}

export type BuildResult = { ok: true; text: string; changedRows: number } | { ok: false; code: "plan_file_invalid" | "plan_write_refused" };

/** The new text of the plan file, or a fixed code. Never carries a parser or writer message. */
export function buildWritebackText(fileText: string, pulls: readonly PullFacts[]): BuildResult {
  try {
    const updates = deriveTaskUpdates(fileText, pulls);
    return { ok: true, text: applyTaskUpdates(fileText, updates), changedRows: updates.length };
  } catch (err) {
    // fx-swallow-ok: replaced by a fixed code; the parser's and the writer's messages can echo task keys, so they are not kept
    if (err instanceof PlanFileShapeError || err instanceof PlanFileInconsistentError) return { ok: false, code: "plan_file_invalid" };
    if (err instanceof PlanWriteError) return { ok: false, code: "plan_write_refused" };
    throw err;
  }
}

// ---- the job ---------------------------------------------------------------------------------------------------------------------

/** What GitHub says about the repo's pull requests and default branch: the read side of one plan import (`PlanSource`, structurally). */
export interface WritebackTruth {
  head(): Promise<{ defaultBranch: string; sha: string }>;
  pulls(): Promise<{ pulls: PullFacts[]; truncated: boolean }>;
}

export interface PlanWritebackDeps {
  /** Runs `fn` in a tenant transaction for the account (`withTenant`). */
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** The GitHub clients for one repo. The composition root mints the installation token (contents and pull_requests write, this repo only). */
  open(target: { owner: string; name: string }): { truth: WritebackTruth; github: WritebackGitHub };
  /**
   * Who the platform's own commits are made by (the App's bot identity), as an email. Injected, never hard-coded: the composition root
   * reads it from the installation it mints the token for. Adoption of a branch or a head the record does not know (crash recovery)
   * requires every commit's author AND committer to be this identity, else the commit is a person's and is not adopted.
   */
  identity: { email: string };
  now?: () => Date;
  newId?: () => string;
}

/** True when every commit in the comparison was authored and committed by the platform's identity. Fails closed on a missing field. */
function madeByPlatform(deps: PlanWritebackDeps, cmp: { identities: ReadonlyArray<{ authorEmail: string | null; committerEmail: string | null }> }): boolean {
  const want = deps.identity.email.toLowerCase();
  return want !== "" && cmp.identities.length > 0 && cmp.identities.every((i) => i.authorEmail === want && i.committerEmail === want);
}

export type WritebackOutcome =
  /** The repo is not synced yet (no owner or name). */
  | { kind: "repo_unavailable" }
  /** The last import did not read a roadmap file: there is no plan file to write. */
  | { kind: "no_plan_file" }
  /** Paired repo, and the plan file is not on the overlay list: nothing was opened, a setup need is recorded (AC 5). */
  | { kind: "needs_setup"; reason: "plan_file_not_in_overlay"; path: string }
  /** The plan file does not parse, or the writer refused. */
  | { kind: "plan_file_invalid"; code: "plan_file_invalid" | "plan_write_refused" }
  /** GitHub's pull request list was cut short; a partial list could write a wrong status, so nothing was written. */
  | { kind: "truth_incomplete" }
  /** The default branch's copy already says what truth says. */
  | { kind: "up_to_date" }
  | { kind: "opened"; writebackId: string; prNumber: number; attempt: number }
  | { kind: "extended"; writebackId: string; prNumber: number; headSha: string }
  /** The open write-back already holds this content. */
  | { kind: "unchanged"; writebackId: string; prNumber: number }
  /** The write-back's entry holds the queue slot (or a push is in flight); nothing was pushed. Run again later. */
  | { kind: "deferred"; reason: "slot_held" | "concurrent_run" | "entry_stopped" }
  /** Someone else pushed to the branch, or it is no longer the platform's: the platform wrote nothing (AC 6). */
  | { kind: "stopped_changed_by_other"; writebackId: string; prNumber: number }
  /** A restart was asked for on a write-back that is not the platform's open one. */
  | { kind: "not_restartable" }
  /** The second failure in a row: the entry stopped with the queue's own copy for `cause`. The pull request is left for a person. */
  | { kind: "stopped"; writebackId: string; cause: RestartCause };

const now = (deps: PlanWritebackDeps): Date => (deps.now ?? (() => new Date()))();
const newBranch = (id: string): string => `${PLAN_UPDATE_BRANCH_PREFIX}${id.slice(0, 8)}`;

function prBody(path: string): string {
  return [
    "This pull request keeps the plan file's task status in step with the pull requests merged on this repository.",
    "",
    `It changes only \`${path}\`. Fulcrumaxe opened it and adds to it as more pull requests merge. If you change it by hand, Fulcrumaxe stops updating it, so merge or close it to resume plan updates.`,
  ].join("\n");
}

export function runPlanWriteback(deps: PlanWritebackDeps, input: { accountId: string; repoId: string }): Promise<WritebackOutcome> {
  return run(deps, input, 1);
}

async function run(deps: PlanWritebackDeps, input: { accountId: string; repoId: string }, attempt: number): Promise<WritebackOutcome> {
  const { accountId, repoId } = input;
  const ctx = await deps.inTenant(accountId, (c) => loadWritebackContext(c, accountId, repoId));
  if (!ctx.gh) return { kind: "repo_unavailable" };
  // The plan file's path is one of the three the import reads; anything else is not written to.
  if (!ctx.planPath || !ROADMAP_PATHS.includes(ctx.planPath)) return { kind: "no_plan_file" };
  const planPath = ctx.planPath;

  // Paired repo: the plan file must be an overlay path, or this write would be a private-only change to a path that is public.
  if (ctx.overlayGlobs !== null) {
    const overlay = compileOverlay(ctx.overlayGlobs);
    if ("error" in overlay || !overlay.match(planPath)) {
      if (!ctx.live) await deps.inTenant(accountId, (c) => recordNeedsSetup(c, { accountId, repoId, planPath, reason: "plan_file_not_in_overlay" }));
      return { kind: "needs_setup", reason: "plan_file_not_in_overlay", path: planPath };
    }
  }

  const { truth, github } = deps.open(ctx.gh);
  let live: PlanWritebackRow | null = ctx.live;
  if (live?.state === "needs_setup") {
    // The overlay now covers the plan file: the need is met.
    await deps.inTenant(accountId, (c) => moveState(c, { accountId, id: live!.id, from: ["needs_setup"], to: "abandoned" }));
    live = null;
  }
  if (live?.state === "opening") live = await recoverOpening(deps, github, truth, accountId, live);

  let pull: Awaited<ReturnType<WritebackGitHub["readPull"]>> | null = null;
  if (live) {
    const settled = await reconcileLive(deps, github, accountId, live);
    if (settled.kind === "stop") return settled.outcome;
    if (settled.kind === "gone") live = null;
    else {
      pull = settled.pull;
      live = settled.row;
    }
  }

  const head = await truth.head();
  const base = await github.readFile(planPath, head.sha, MAX_ROADMAP_BYTES);
  if (!base) return { kind: "no_plan_file" };
  const read = await truth.pulls();
  if (read.truncated) return { kind: "truth_incomplete" };
  const built = buildWritebackText(base.text, read.pulls);
  if (!built.ok) return { kind: "plan_file_invalid", code: built.code };
  if (built.text === base.text) {
    // The default branch already says what truth says (a person merged the same changes by hand): an open write-back is not needed.
    if (live && pull) await closeNotNeeded(deps, github, accountId, live);
    return { kind: "up_to_date" };
  }

  if (live && pull) return extend(deps, github, accountId, live, planPath, built.text, head.sha);
  return openFresh(deps, github, { accountId, repoId, planPath, attempt, text: built.text, baseBlob: base.blobSha, head });
}

/**
 * A row left `opening` (a crash between making the branch and recording the pull request). GitHub wins: no branch means nothing was
 * made, so the row is dropped. A branch is adopted only when it is exactly what this job makes: at most one commit on a default-branch
 * commit, that commit changing only the plan file with the fixed message. Any other branch is not ours: the row is dropped and the
 * branch is left alone. An adopted branch with a pull request is recorded; one with no pull request gets its pull request now.
 * `base_sha` is the default-branch commit the branch is built on. Returns the live row afterwards, or null when there is none.
 */
async function recoverOpening(
  deps: PlanWritebackDeps,
  github: WritebackGitHub,
  truth: WritebackTruth,
  accountId: string,
  row: PlanWritebackRow,
): Promise<PlanWritebackRow | null> {
  const branch = row.branch!;
  const headSha = await github.readBranchHead(branch);
  if (headSha === null) {
    await deps.inTenant(accountId, (c) => moveState(c, { accountId, id: row.id, from: ["opening"], to: "abandoned" }));
    return null;
  }
  const main = await truth.head();
  const cmp = await github.compare(main.sha, headSha);
  if (cmp.aheadBy === 0 && cmp.files.length === 0) {
    // The crash came between making the branch and pushing the commit: nothing to open (GitHub refuses a pull request with no commits
    // between, and the row would stay `opening` and wedge the repo). End the row, and remove the branch only when it is still the
    // platform's own: its name carries the platform prefix and its tip is the commit just read.
    await deps.inTenant(accountId, (c) =>
      moveState(c, { accountId, id: row.id, from: ["opening"], to: "abandoned", reason: "writeback_empty_branch" satisfies WritebackReason }),
    );
    if (branch.startsWith(PLAN_UPDATE_BRANCH_PREFIX) && (await github.readBranchHead(branch)) === headSha) await github.deleteBranch(branch);
    return null;
  }
  const ours =
    cmp.aheadBy === 1 &&
    cmp.files.length === 1 &&
    cmp.files[0] === row.planPath &&
    cmp.messages.length === 1 &&
    cmp.messages[0] === WRITEBACK_COMMIT_MESSAGE &&
    madeByPlatform(deps, cmp);
  if (!ours) {
    await deps.inTenant(accountId, (c) => moveState(c, { accountId, id: row.id, from: ["opening"], to: "abandoned" }));
    return null;
  }
  const found = await github.findPullByBranch(branch);
  const prNumber = found?.number ?? (await github.openPull({ branch, base: main.defaultBranch, title: WRITEBACK_PR_TITLE, body: prBody(row.planPath) })).number;
  const opened = await deps.inTenant(accountId, async (c) => {
    const r = await recordOpen(c, { accountId, id: row.id, prNumber, headSha, baseSha: cmp.mergeBaseSha });
    if (r) await enqueuePlanWriteback(c, { accountId, repoId: row.repoId, planWritebackId: r.id, prNumber, headSha: r.headSha!, approvedAt: now(deps) });
    return r;
  });
  return opened;
}

type Reconciled =
  | { kind: "stop"; outcome: WritebackOutcome }
  | { kind: "gone" }
  | { kind: "live"; row: PlanWritebackRow; pull: Awaited<ReturnType<WritebackGitHub["readPull"]>> };

/**
 * Compares the platform's record with GitHub for the repo's live write-back. A merged or closed PR ends the record (and its entry), so
 * the job continues with a fresh one. A head that is not the recorded sha, or a branch that is not the platform's, stops all writing.
 * Otherwise makes sure the queue has the entry (idempotent), and frees a hold that a crashed push left behind.
 */
async function reconcileLive(deps: PlanWritebackDeps, github: WritebackGitHub, accountId: string, row: PlanWritebackRow): Promise<Reconciled> {
  const pull = await github.readPull(row.prNumber!);
  if (pull.merged || !pull.open) {
    const to = pull.merged ? "merged" : "closed";
    await deps.inTenant(accountId, async (c) => {
      await moveState(c, { accountId, id: row.id, from: ["open", "changed_by_other"], to });
      await endWritebackEntry(c, { accountId, planWritebackId: row.id, how: to });
    });
    return { kind: "gone" };
  }
  let ours = pull.sameRepo && pull.headRef === row.branch && pull.headSha === row.headSha;
  if (!ours && row.state === "open" && pull.sameRepo && pull.headRef === row.branch) {
    // A run that died after its push landed and before it recorded the new head: the head is the platform's own commit on the recorded one.
    const adopted = await adoptOwnPush(deps, github, accountId, row, pull.headSha);
    if (adopted) {
      row = adopted;
      ours = true;
    }
  }
  if (!ours) {
    if (row.state === "open") await markChangedByOther(deps, accountId, row);
    return { kind: "stop", outcome: { kind: "stopped_changed_by_other", writebackId: row.id, prNumber: row.prNumber! } };
  }
  if (row.state === "changed_by_other") {
    // The head is the recorded one again, but the platform said it would stop; it stays stopped until a person merges or closes the PR.
    return { kind: "stop", outcome: { kind: "stopped_changed_by_other", writebackId: row.id, prNumber: row.prNumber! } };
  }
  await deps.inTenant(accountId, async (c) => {
    const { entry } = await enqueuePlanWriteback(c, { accountId, repoId: row.repoId, planWritebackId: row.id, prNumber: row.prNumber!, headSha: row.headSha!, approvedAt: now(deps) });
    if (entry.state === "in_review" && now(deps).getTime() - entry.updatedAt.getTime() > STUCK_HOLD_MINUTES * 60_000) {
      await releaseWritebackAfterPush(c, { accountId, planWritebackId: row.id });
    }
  });
  return { kind: "live", row, pull };
}

/**
 * The branch head is not the recorded sha. If it is exactly one commit on the recorded one, with the platform's fixed message, changing
 * only the plan file, it is the push of a run that died before recording it: record it (and the queue entry's head) and carry on.
 * Anything else is someone else's. Returns the updated row, or null when the head is not the platform's own.
 */
async function adoptOwnPush(deps: PlanWritebackDeps, github: WritebackGitHub, accountId: string, row: PlanWritebackRow, newHead: string): Promise<PlanWritebackRow | null> {
  const cmp = await github.compare(row.headSha!, newHead);
  const own =
    cmp.aheadBy === 1 &&
    cmp.behindBy === 0 &&
    cmp.mergeBaseSha === row.headSha &&
    cmp.files.length === 1 &&
    cmp.files[0] === row.planPath &&
    cmp.messages.length === 1 &&
    cmp.messages[0] === WRITEBACK_COMMIT_MESSAGE &&
    madeByPlatform(deps, cmp);
  if (!own) return null;
  return deps.inTenant(accountId, async (c) => {
    const updated = await recordOpen(c, { accountId, id: row.id, prNumber: row.prNumber!, headSha: newHead, baseSha: row.baseSha! });
    if (!updated) return null;
    const entry = await getEntryByPlanWriteback(c, accountId, row.id);
    if (entry && entry.headSha !== newHead) {
      if (entry.state === "queued") await holdWritebackForPush(c, { accountId, planWritebackId: row.id });
      await releaseWritebackAfterPush(c, { accountId, planWritebackId: row.id, headSha: newHead });
    }
    return updated;
  });
}

/** Deletes the platform's branch only while its head is still the recorded sha: a branch someone has pushed to since is left for them. */
async function deleteOwnBranch(github: WritebackGitHub, row: PlanWritebackRow): Promise<void> {
  const tip = await github.readBranchHead(row.branch!);
  if (tip !== null && tip === row.headSha) await github.deleteBranch(row.branch!);
}

/** The open write-back says nothing the default branch does not: close it, remove its branch, and end its entry. Never while the entry holds the slot. */
async function closeNotNeeded(deps: PlanWritebackDeps, github: WritebackGitHub, accountId: string, row: PlanWritebackRow): Promise<void> {
  const held = await deps.inTenant(accountId, (c) => holdWritebackForPush(c, { accountId, planWritebackId: row.id }));
  if (!held) return; // the entry holds the slot (the queue is merging it) or is stopped for a person: leave it
  try {
    await github.closePull(row.prNumber!);
    await deleteOwnBranch(github, row);
  } catch (err) {
    await deps.inTenant(accountId, (c) => releaseWritebackAfterPush(c, { accountId, planWritebackId: row.id }));
    throw err;
  }
  await deps.inTenant(accountId, async (c) => {
    await moveState(c, { accountId, id: row.id, from: ["open"], to: "superseded", reason: "writeback_not_needed" satisfies WritebackReason });
    await endWritebackEntry(c, { accountId, planWritebackId: row.id, how: "cancelled", reason: "writeback_not_needed" satisfies WritebackReason });
  });
}

async function markChangedByOther(deps: PlanWritebackDeps, accountId: string, row: PlanWritebackRow): Promise<void> {
  await deps.inTenant(accountId, async (c) => {
    await moveState(c, { accountId, id: row.id, from: ["open"], to: "changed_by_other", reason: "changed_by_someone_else" satisfies WritebackReason });
    const entry = await getEntryByPlanWriteback(c, accountId, row.id);
    if (entry) await stopEntry(c, { accountId, entryId: entry.id, reason: "writeback_changed_by_other" satisfies WritebackReason });
  });
}

/** One more commit on the platform's own branch, as a fast-forward, while the entry does not hold the slot. */
async function extend(
  deps: PlanWritebackDeps,
  github: WritebackGitHub,
  accountId: string,
  row: PlanWritebackRow,
  planPath: string,
  text: string,
  baseSha: string,
): Promise<WritebackOutcome> {
  const onBranch = await github.readFile(planPath, row.headSha!, MAX_ROADMAP_BYTES);
  if (!onBranch) throw new WritebackGitHubError("bad_response");
  if (onBranch.text === text) return { kind: "unchanged", writebackId: row.id, prNumber: row.prNumber! };

  const held = await deps.inTenant(accountId, (c) => holdWritebackForPush(c, { accountId, planWritebackId: row.id }));
  if (!held) {
    // Either the entry holds the slot, or it is stopped for a person (a stopped entry is never put back in the queue by a push).
    const entry = await deps.inTenant(accountId, (c) => getEntryByPlanWriteback(c, accountId, row.id));
    return { kind: "deferred", reason: entry?.state === "stopped" ? "entry_stopped" : "slot_held" };
  }
  let commitSha: string;
  let parentSha: string;
  try {
    ({ commitSha, parentSha } = await github.putFile({ path: planPath, branch: row.branch!, text, blobSha: onBranch.blobSha, message: WRITEBACK_COMMIT_MESSAGE }));
  } catch (err) {
    // The push did not land: the entry goes back to the queue on its old head, then the failure is reported as it was.
    await deps.inTenant(accountId, (c) => releaseWritebackAfterPush(c, { accountId, planWritebackId: row.id }));
    throw err;
  }
  // The contents API checks the file's blob, not the branch tip. A parent that is not the head the platform recorded means another
  // identity pushed between the check and the push: the new head is not recorded, and the write-back stops for a person.
  if (parentSha !== row.headSha) {
    await markChangedByOther(deps, accountId, row);
    return { kind: "stopped_changed_by_other", writebackId: row.id, prNumber: row.prNumber! };
  }
  await deps.inTenant(accountId, async (c) => {
    await recordOpen(c, { accountId, id: row.id, prNumber: row.prNumber!, headSha: commitSha, baseSha });
    await releaseWritebackAfterPush(c, { accountId, planWritebackId: row.id, headSha: commitSha });
  });
  return { kind: "extended", writebackId: row.id, prNumber: row.prNumber!, headSha: commitSha };
}

async function openFresh(
  deps: PlanWritebackDeps,
  github: WritebackGitHub,
  a: { accountId: string; repoId: string; planPath: string; attempt: number; text: string; baseBlob: string; head: { defaultBranch: string; sha: string } },
): Promise<WritebackOutcome> {
  const id = (deps.newId ?? randomUUID)();
  const branch = newBranch(id);
  try {
    await deps.inTenant(a.accountId, (c) => insertOpening(c, { accountId: a.accountId, repoId: a.repoId, id, planPath: a.planPath, branch, attempt: a.attempt }));
  } catch (err) {
    // The partial unique index: another run opened this repo's write-back first.
    if ((err as { code?: string }).code === "23505") return { kind: "deferred", reason: "concurrent_run" };
    throw err;
  }
  let commitSha: string;
  let parentSha: string;
  let prNumber: number;
  let createdBranch = false;
  // The tips this attempt itself made: the commit the branch was created at, then the platform's commit on it.
  const ownTips = new Set<string>();
  try {
    await github.createBranch(branch, a.head.sha);
    createdBranch = true;
    ownTips.add(a.head.sha);
    ({ commitSha, parentSha } = await github.putFile({ path: a.planPath, branch, text: a.text, blobSha: a.baseBlob, message: WRITEBACK_COMMIT_MESSAGE }));
    if (parentSha === a.head.sha) ownTips.add(commitSha);
    ({ number: prNumber } = await github.openPull({ branch, base: a.head.defaultBranch, title: WRITEBACK_PR_TITLE, body: prBody(a.planPath) }));
  } catch (err) {
    // Only a branch THIS attempt made is removed, and only while its tip is still a commit this attempt made (re-read first, as in
    // `deleteOwnBranch`). One that already existed (`branch_exists`), or one someone pushed to since, is not ours to delete.
    if (createdBranch) {
      try {
        const tip = await github.readBranchHead(branch);
        if (tip !== null && ownTips.has(tip)) await github.deleteBranch(branch);
      } catch {
        // fx-swallow-ok: the original failure is what is reported; an orphan branch is found by the next run (the row is dropped below)
      }
    }
    await deps.inTenant(a.accountId, (c) => moveState(c, { accountId: a.accountId, id, from: ["opening"], to: "abandoned" }));
    throw err;
  }
  // A parent other than the commit the branch was made at: someone pushed to the fresh branch before the platform's commit. The pull
  // request is still recorded (it is where the notice goes), on the head the platform knew, and the write-back stops for a person.
  const raced = parentSha !== a.head.sha;
  const recordedHead = raced ? a.head.sha : commitSha;
  const row = await deps.inTenant(a.accountId, async (c) => {
    const r = await recordOpen(c, { accountId: a.accountId, id, prNumber, headSha: recordedHead, baseSha: a.head.sha });
    await enqueuePlanWriteback(c, { accountId: a.accountId, repoId: a.repoId, planWritebackId: id, prNumber, headSha: recordedHead, approvedAt: now(deps) });
    return r;
  });
  if (raced && row) {
    await markChangedByOther(deps, a.accountId, row);
    return { kind: "stopped_changed_by_other", writebackId: id, prNumber };
  }
  return { kind: "opened", writebackId: id, prNumber, attempt: a.attempt };
}

/**
 * The queue tick (MQ3) asks for this when it could not refresh the write-back PR (a conflict, or the branch is too far behind). There
 * is no agent round for a write-back: the platform closes its own PR, deletes its own branch, and opens a fresh one from current truth
 * on the current default branch. That is not a force-push, because it closes a branch only the platform wrote. The second failure in a
 * row stops the entry instead, with the cause as the queue's fixed stop code.
 */
export async function restartPlanWriteback(
  deps: PlanWritebackDeps,
  input: { accountId: string; repoId: string; writebackId: string; cause: RestartCause },
): Promise<WritebackOutcome> {
  const { accountId, repoId } = input;
  const row = await deps.inTenant(accountId, (c) => getWriteback(c, accountId, input.writebackId));
  if (!row || row.repoId !== repoId || row.state !== "open" || row.prNumber === null) return { kind: "not_restartable" };
  const ctx = await deps.inTenant(accountId, (c) => loadWritebackContext(c, accountId, repoId));
  if (!ctx.gh) return { kind: "repo_unavailable" };
  const { github } = deps.open(ctx.gh);

  const pull = await github.readPull(row.prNumber);
  if (pull.merged || !pull.open) return run(deps, input, 1); // already over: reconcile settles it and a fresh one is built if needed
  const ours = pull.sameRepo && pull.headRef === row.branch && pull.headSha === row.headSha;
  if (!ours) {
    await markChangedByOther(deps, accountId, row);
    return { kind: "stopped_changed_by_other", writebackId: row.id, prNumber: row.prNumber };
  }
  if (row.attempt >= MAX_WRITEBACK_ATTEMPTS) {
    await deps.inTenant(accountId, async (c) => {
      const entry = await getEntryByPlanWriteback(c, accountId, row.id);
      if (entry) await stopEntry(c, { accountId, entryId: entry.id, reason: input.cause });
    });
    return { kind: "stopped", writebackId: row.id, cause: input.cause };
  }
  await github.closePull(row.prNumber);
  // Re-read the head right before the delete: a branch someone pushed to after the check above is left for them.
  await deleteOwnBranch(github, row);
  await deps.inTenant(accountId, async (c) => {
    await moveState(c, { accountId, id: row.id, from: ["open"], to: "superseded", reason: input.cause });
    await endWritebackEntry(c, { accountId, planWritebackId: row.id, how: "cancelled", reason: "writeback_replaced" satisfies WritebackReason });
  });
  return run(deps, { accountId, repoId }, row.attempt + 1);
}
