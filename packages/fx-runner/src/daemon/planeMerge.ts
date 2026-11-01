/**
 * D#6 PUBLIC-MERGE PR3: the local runner executes the merge of a paired item's PUBLIC pull request.
 *
 * The cloud decides and GitHub enforces the `sha`; this file does the two things only the customer's machine may do for a `runner_local` repository: look at
 * the CONTENT of both commits (the cloud must not read it), and make the one merge call with a credential the cloud minted for the code repository alone.
 *
 * The order of events, each step a hint to the next and none a trust anchor on its own:
 *
 *   1. claim      `plane-merge-claim` hands over the oldest order this runner may take, the facts bound to it (all from the cloud's rows) and the READ credential.
 *   2. content    the public head and the code repository's default branch are fetched with the read credential into a throwaway bare repository; the reviewed
 *                 private head comes from the daemon's mirror (the customer's own git access). Both change sets are computed at EXPLICIT commits by the one shared
 *                 comparison (`@fulcrumaxe/runner-protocol/planePush` changeSet.ts), the read credential is revoked, and the result is reported with both shas.
 *                 A path that is not valid UTF-8 cannot be told apart from GitHub's reading of it, so it makes the whole check "could not know", never a mismatch.
 *   3. verify     `plane-merge-verify`: the cloud runs the whole gate again. On go it hands over the ONE write credential and the sha the merge must name.
 *   4. merge      the pull request is read again with the write credential (head, base, open, not draft); then `PUT .../merge { sha, squash }`. GitHub itself
 *                 refuses when the head is not `sha`. The write credential is revoked in a `finally`. D#694 B7-1: the code repository's merge mode is read here too,
 *                 and must be the one the cloud sent; a repository behind GitHub's merge queue is ENQUEUED (held to `sha`), never merged directly, and nothing is
 *                 merged or enqueued when the mode is unreadable or differs. There is no auto-merge fallback.
 *   5. report     `plane-merge-report`, a hint: the cloud reads GitHub through its own client before it records anything.
 *
 * Every failure path ends in a closed code and revokes both credentials. A credential lives in a local variable of one call and nowhere else: it is never
 * written to a file, a log line, an error, a report, or any process this one starts except the fetch's own environment (the same as a push).
 * Nothing here names a repository, branch or sha that came from anywhere but the cloud's claim reply.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { MAX_PLANE_MERGE_PATHS, type PlaneMergeAbortCode, type PlaneMergeReportMessage, type PlaneMergeVerifyMessage } from "@fulcrumaxe/runner-protocol";
import { PUBLIC_BASE_BRANCH, compileOverlay, diffTreeEntries, planePushGit, sameChangeKeys, treeFromLsTree, type PublicHeadsReader, type TreeEntry } from "@fulcrumaxe/runner-protocol/planePush";
import type { PlaneMergeOrder, RunnerClient } from "./client.js";
import type { PlanePushGithub } from "./planePushGithub.js";

export interface ContentCheck {
  /** The public change set equals the reviewed one, on the conditions of the cloud's own check. */
  same: boolean;
  /** The runner could not know (a read failed, a tree was unusable, no merge base, a path git and GitHub might read differently). Implies `same` false. */
  incomplete: boolean;
  /** The public change set, as paths. At most `MAX_PLANE_MERGE_PATHS` valid paths; more, or an invalid one, makes the check incomplete. */
  paths: string[];
}

const NOT_KNOWN: ContentCheck = { same: false, incomplete: true, paths: [] };
const OBJECT_ID = /^[0-9a-f]{40}$/;
/** The same rule the verify message holds a path to. */
const REPO_PATH = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,4096}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The tree of `commit` as `git ls-tree -r -z` lists it, through the shared reader. The bytes are decoded strictly: a path that is not valid UTF-8 would be
 * turned into U+FFFD by a lenient decode, and two different byte strings could then compare equal (or GitHub, which only speaks UTF-8, could disagree with
 * this machine about the path). Such a tree is "could not know".
 */
export async function readTree(dir: string, commit: string): Promise<Map<string, TreeEntry> | null> {
  if (!OBJECT_ID.test(commit)) return null;
  let raw: Buffer;
  try {
    raw = await planePushGit(dir, ["ls-tree", "-r", "-z", commit]);
  } catch {
    // fx-swallow-ok: an unreadable tree is "could not know", reported as such
    return null;
  }
  let text: string;
  try {
    text = UTF8.decode(raw);
  } catch {
    // fx-swallow-ok: a path that is not UTF-8 is "could not know"
    return null;
  }
  return treeFromLsTree(text);
}

async function mergeBaseOf(dir: string, a: string, b: string): Promise<string | null> {
  try {
    const id = (await planePushGit(dir, ["merge-base", a, b])).toString("utf8").trim();
    return OBJECT_ID.test(id) ? id : null;
  } catch {
    // fx-swallow-ok: no merge base is "could not know"
    return null;
  }
}

/** True when `commit` has exactly one parent and it is `parent`. Read from the commit object's own header (a graft or replace ref cannot change it). */
async function singleParentIs(dir: string, commit: string, parent: string): Promise<boolean> {
  try {
    const header = (await planePushGit(dir, ["cat-file", "commit", commit])).toString("latin1").split("\n\n")[0] ?? "";
    const parents = header.split("\n").filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
    return parents.length === 1 && parents[0] === parent;
  } catch {
    // fx-swallow-ok: an unreadable commit is not a single-parent commit
    return false;
  }
}

export interface ContentInput {
  /** A repository holding the public head and the code repository's default tip as objects. */
  publicDir: string;
  publicHead: string;
  publicDefault: string;
  /** A repository holding the reviewed private head, and whose HEAD is the private default branch (the daemon's mirror). */
  privateDir: string;
  reviewedHead: string;
  overlayGlobs: readonly string[];
}

/**
 * The cloud's `checkPublicContent` rules, at explicit commits, on objects this machine fetched itself: the public head must be a single commit on its merge
 * base with the default branch; each side's change set is its tree against its merge base's tree, keyed by (path, base entry, head entry); the private side
 * drops the paths the pairing keeps out of the public repository; the public side drops nothing. Never throws: anything unknown is `incomplete`.
 */
export async function checkContent(input: ContentInput): Promise<ContentCheck> {
  const overlay = compileOverlay(input.overlayGlobs);
  if ("error" in overlay) return NOT_KNOWN;
  if (![input.publicHead, input.publicDefault, input.reviewedHead].every((id) => OBJECT_ID.test(id))) return NOT_KNOWN;
  const publicBase = await mergeBaseOf(input.publicDir, input.publicDefault, input.publicHead);
  if (publicBase === null || !(await singleParentIs(input.publicDir, input.publicHead, publicBase))) return NOT_KNOWN;
  const publicHeadTree = await readTree(input.publicDir, input.publicHead);
  const publicBaseTree = await readTree(input.publicDir, publicBase);
  if (publicHeadTree === null || publicBaseTree === null) return NOT_KNOWN;
  const pub = diffTreeEntries(publicBaseTree, publicHeadTree, () => true);
  const paths = pub.paths.filter((p) => REPO_PATH.test(p));
  const pathsUsable = paths.length === pub.paths.length && paths.length <= MAX_PLANE_MERGE_PATHS;
  const shown = paths.slice(0, MAX_PLANE_MERGE_PATHS);
  const privateBase = await mergeBaseOf(input.privateDir, "HEAD", input.reviewedHead);
  if (privateBase === null) return { same: false, incomplete: !pathsUsable, paths: shown };
  const privateHeadTree = await readTree(input.privateDir, input.reviewedHead);
  const privateBaseTree = await readTree(input.privateDir, privateBase);
  // The reviewed side being unreadable means nothing was proven about it: "not the same", with the public paths as they are (the cloud's own rule).
  if (privateHeadTree === null || privateBaseTree === null) return { same: false, incomplete: !pathsUsable, paths: shown };
  const priv = diffTreeEntries(privateBaseTree, privateHeadTree, (p) => !overlay.match(p));
  const same = sameChangeKeys(priv.keys, pub.keys);
  // A path list that is cut short or unusable is incomplete, and an incomplete check is never "the same" (the message schema holds the runner to it).
  return pathsUsable ? { same, incomplete: false, paths: shown } : { same: false, incomplete: true, paths: shown };
}

export type PlaneMergeOutcome =
  /** No order was waiting (or the claim failed): nothing was done. */
  | "none"
  | "merged"
  /** D#694 B7-1: the pull request was put in GitHub's merge queue; the merge itself is GitHub's, recorded by the cloud from its own events. */
  | "enqueued"
  /** GitHub refused the merge call, or the cloud's gate said no go; the order is over. */
  | "refused"
  | "blocked"
  | "head_moved"
  | "aborted"
  /** The cloud no longer holds this runner to the order (fenced), or could not be reached to finish it. */
  | "stopped"
  | "failed";

export interface PlaneMergeDeps {
  client: Pick<RunnerClient, "planeMergeClaim" | "planeMergeVerify" | "planeMergeReport">;
  github: PlanePushGithub;
  reader: PublicHeadsReader;
  /** Brings the daemon's mirror of the private repository up to date and answers its directory. */
  syncMirror: (repo: { id: string; owner: string; name: string }) => Promise<{ dir: string }>;
  /** A directory in the runner's private state where the throwaway repositories are built (made 0700). */
  workRoot: string;
  uid?: number | undefined;
  now?: () => Date;
  /** Replaceable so a test does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** One closed line per order, for the runner's output: an outcome word. Never a token, a path or text from the change. */
  say?: (line: string) => void;
}

const WORK_DIR = /^m-[A-Za-z0-9]{6}$/;
const CALL_TRIES = 3;
const REPORT_TRIES = 5;
const RETRY_MS = 1500;
/** A credential with less than this left is not used: the merge could not be finished with it. */
const MIN_TOKEN_LIFE_MS = 30_000;

function isOwnDirectory(root: string, dir: string): boolean {
  if (path.dirname(dir) !== root || !WORK_DIR.test(path.basename(dir))) return false;
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    // fx-swallow-ok: a directory that cannot be read is not one this handler may delete
    return false;
  }
}

function ensureRoot(root: string, uid: number | undefined): void {
  if (!path.isAbsolute(root)) throw new TypeError("the work root must be absolute");
  let stat = (() => {
    try {
      return lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("work_root_insecure");
    }
  })();
  if (stat === null) {
    mkdirSync(root, { mode: 0o700, recursive: true });
    stat = lstatSync(root);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("work_root_insecure");
  if (uid !== undefined && stat.uid !== uid) throw new Error("work_root_insecure");
  if ((stat.mode & 0o077) !== 0) {
    chmodSync(root, 0o700);
    if ((lstatSync(root).mode & 0o077) !== 0) throw new Error("work_root_insecure");
  }
}

/** Removes the throwaway repositories a stopped daemon left behind: only entries of the exact work-directory shape that are real directories. */
export function sweepMergeWorkRoot(root: string): void {
  let names: string[];
  try {
    if (lstatSync(root).isSymbolicLink()) return;
    names = readdirSync(root);
  } catch {
    // fx-swallow-ok: no work directory yet
    return;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    if (!isOwnDirectory(root, dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // fx-swallow-ok: a leftover is only disk, and the next start tries again
    }
  }
}

type MergeReport = Omit<PlaneMergeReportMessage, "order_id" | "lease_generation" | "token_revoked">;

export function createPlaneMergeHandler(deps: PlaneMergeDeps): () => Promise<PlaneMergeOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const say = (outcome: PlaneMergeOutcome): PlaneMergeOutcome => {
    if (outcome !== "none") deps.say?.(`fx-runner: public merge: ${outcome}`);
    return outcome;
  };
  sweepMergeWorkRoot(deps.workRoot);

  /** The content check for a claimed order, with the read credential revoked as soon as the fetch is over. `moved` when the branch is not at the order's head. */
  async function inspect(order: PlaneMergeOrder): Promise<{ check: ContentCheck; moved: boolean; readRevoked: boolean }> {
    let work: string | undefined;
    let readRevoked = false;
    let tips: { head: string; defaultTip: string } | undefined;
    try {
      try {
        ensureRoot(deps.workRoot, deps.uid);
        work = mkdtempSync(path.join(deps.workRoot, "m-"));
        if (!isOwnDirectory(deps.workRoot, work)) throw new Error("work_dir_insecure");
        await planePushGit(work, ["init", "--bare", "--quiet", "--template="]);
        tips = await deps.reader.fetchHeads(work, order.code_repo, order.public_branch, order.read.token);
      } catch {
        // fx-swallow-ok: a failed fetch is "could not know"; the closed result below is what is reported
        tips = undefined;
      } finally {
        // Revoked whatever happened above: the fetch is the only thing the read credential is for.
        readRevoked = await deps.github.revokeToken(order.read.token);
      }
      if (work === undefined || tips === undefined) return { check: NOT_KNOWN, moved: false, readRevoked };
      if (tips.head !== order.expected_public_head) return { check: NOT_KNOWN, moved: true, readRevoked };
      let privateDir: string;
      try {
        privateDir = (await deps.syncMirror({ id: order.private_repo.id, owner: order.private_repo.owner, name: order.private_repo.name })).dir;
        await planePushGit(privateDir, ["cat-file", "-e", `${order.reviewed_head}^{commit}`]);
      } catch {
        // fx-swallow-ok: a mirror that cannot be synced, or that lacks the reviewed commit, is "could not know"
        return { check: NOT_KNOWN, moved: false, readRevoked };
      }
      const check = await checkContent({ publicDir: work, publicHead: tips.head, publicDefault: tips.defaultTip, privateDir, reviewedHead: order.reviewed_head, overlayGlobs: order.overlay_globs }).catch(() => NOT_KNOWN);
      return { check, moved: false, readRevoked };
    } finally {
      if (work !== undefined && isOwnDirectory(deps.workRoot, work)) {
        try {
          rmSync(work, { recursive: true, force: true });
        } catch {
          // fx-swallow-ok: a leftover is only disk; the next start sweeps the work root
        }
      }
    }
  }

  /** The write credential's one use: read the pull request again, then the one merge call. Returns what to report; never throws. */
  async function merge(order: PlaneMergeOrder, go: { token: string; expiresAt: string; sha: string; mergeMode?: "queue" | "direct" }): Promise<MergeReport> {
    const aborted = (abort_code: PlaneMergeAbortCode): MergeReport => ({ result: "aborted", abort_code });
    if (go.sha !== order.expected_public_head || Date.parse(go.expiresAt) - now().getTime() < MIN_TOKEN_LIFE_MS) return aborted("internal");
    let pull: Awaited<ReturnType<PlanePushGithub["getPull"]>>;
    try {
      pull = await deps.github.getPull({ codeRepo: order.code_repo, number: order.pr_number, token: go.token });
    } catch {
      // fx-swallow-ok: replaced by the closed abort code
      return aborted("read_failed");
    }
    if (pull.number !== order.pr_number || pull.merged || pull.state !== "open") return aborted("pr_not_open");
    if (pull.draft) return aborted("pr_draft");
    if (pull.headSha !== go.sha) return aborted("head_moved");
    if (pull.headRef !== order.public_branch || pull.headRepo.toLowerCase() !== pull.baseRepo.toLowerCase() || pull.baseRepo.toLowerCase() !== order.code_repo.toLowerCase()) return aborted("internal");
    // The base is the repository's own default branch (its setting, not the pull request's say-so), and the one the content check compared against.
    if (pull.baseRef !== pull.defaultBranch || pull.defaultBranch !== PUBLIC_BASE_BRANCH) return aborted("base_retargeted");
    // The cloud read the mode of the code repository; this machine reads it again with the write credential, and the two must agree. A cloud from before the queue sends none: `direct`.
    const mode = await deps.github.getMergeQueueMode({ codeRepo: order.code_repo, branch: pull.defaultBranch, token: go.token });
    if (mode === "unknown") return aborted("queue_unreadable");
    if (mode !== (go.mergeMode ?? "direct")) return aborted("queue_mode_mismatch");
    if (mode === "queue") {
      if (pull.nodeId === "") return aborted("internal");
      try {
        const queued = await deps.github.enqueuePull({ codeRepo: order.code_repo, pullRequestId: pull.nodeId, expectedHeadOid: go.sha, token: go.token });
        return queued.outcome === "enqueued" ? { result: "enqueued" } : queued.outcome === "head_moved" ? aborted("head_moved") : { result: "refused", http_status: queued.status };
      } catch {
        // fx-swallow-ok: no usable answer to the enqueue: it may or may not have happened, and the cloud reads GitHub itself before it records anything
        return aborted("internal");
      }
    }
    try {
      const done = await deps.github.mergePull({ codeRepo: order.code_repo, number: order.pr_number, sha: go.sha, token: go.token });
      return { result: done.merged ? "merged" : "refused", http_status: done.status };
    } catch {
      // fx-swallow-ok: no answer to the merge call: it may or may not have happened, and the cloud reads GitHub itself before it records anything
      return aborted("internal");
    }
  }

  async function report(order: PlaneMergeOrder, body: MergeReport, tokenRevoked: boolean): Promise<"recorded" | "fenced" | "failed"> {
    for (let attempt = 1; attempt <= REPORT_TRIES; attempt++) {
      const sent = await deps.client.planeMergeReport({ order_id: order.order_id, lease_generation: order.lease_generation, ...body, token_revoked: tokenRevoked });
      if (sent.kind === "recorded") return "recorded";
      if (sent.kind === "fenced") return "fenced";
      if (attempt === REPORT_TRIES) break;
      if (sent.kind === "retry") await sleep(Math.min(sent.retryAfter, 60) * 1000);
      else if (sent.kind === "error" && (sent.status === 0 || sent.status >= 500)) await sleep(RETRY_MS * attempt);
      else break;
    }
    return "failed";
  }

  return async () => {
    const claimed = await deps.client.planeMergeClaim();
    if (claimed.kind !== "order") return "none";
    const order = claimed.order;

    // 1 and 2: the content check. The read credential is revoked inside `inspect`.
    const seen = await inspect(order);
    if (seen.moved) {
      // The branch is not at the order's head: nothing to compare, nothing to ask. The cloud re-reviews.
      const told = await report(order, { result: "aborted", abort_code: "head_moved" }, seen.readRevoked);
      return say(told === "recorded" ? "head_moved" : "stopped");
    }

    // 3: verify, bound to both shas. A failure to know is `incomplete`, never silence.
    const message: PlaneMergeVerifyMessage = {
      order_id: order.order_id,
      lease_generation: order.lease_generation,
      reviewed_head: order.reviewed_head,
      public_head: order.expected_public_head,
      same: seen.check.same,
      incomplete: seen.check.incomplete,
      paths: seen.check.paths,
      pairing_digest: order.pairing_digest,
      token_revoked: seen.readRevoked,
    };
    let verdict = await deps.client.planeMergeVerify(message);
    for (let attempt = 1; verdict.kind === "error" && (verdict.status === 0 || verdict.status >= 500) && attempt < CALL_TRIES; attempt++) {
      await sleep(RETRY_MS * attempt);
      verdict = await deps.client.planeMergeVerify(message);
    }
    if (verdict.kind === "no_go") return say("blocked");
    if (verdict.kind === "head_moved") return say("head_moved");
    if (verdict.kind === "fenced") return say("stopped");
    if (verdict.kind !== "go") return say("failed");

    // 4: the one merge call, with the one write credential, revoked in a `finally`.
    let outcome: MergeReport = { result: "aborted", abort_code: "internal" };
    let revoked = false;
    try {
      outcome = await merge(order, verdict);
    } catch {
      // fx-swallow-ok: `merge` does not throw; this keeps the revoke below certain whatever happens
      outcome = { result: "aborted", abort_code: "internal" };
    } finally {
      revoked = await deps.github.revokeToken(verdict.token);
    }

    // 5: the report, a hint.
    const told = await report(order, outcome, revoked);
    if (told === "fenced") return say("stopped");
    if (outcome.result === "merged" || outcome.result === "enqueued") return say(outcome.result);
    return say(outcome.result === "refused" ? "refused" : "aborted");
  };
}
