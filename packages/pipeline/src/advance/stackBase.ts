import { SHA_PATTERN } from "../build/mergeGate.js";

/**
 * D#598 P3b: where a stacked child's executor starts. An item with a `stack_parent_id` builds on its parent's open pull request, so the
 * run starts from that pull request's head and its own pull request is opened against the parent's branch (not the default branch).
 *
 * Nothing here looks at which repository, which plan or whether the repository is paired: the same rules hold for every connected repo.
 *
 * The check that makes the start safe is the one in the Spec: the head sha GitHub gives for the parent's pull request must equal the tip
 * of the parent's branch as fetched (a second, separate read). When they differ the parent is moving, or the read is stale, and the start
 * is refused with a reason; it is never "built from whichever one". The prompt carries the same sha and tells the sandbox to check it
 * again after its own fetch, because the branch may move between this read and the clone.
 */

/** What GitHub says about the parent's pull request and its branch, two reads. */
export interface StackParentFacts {
  state: "open" | "closed";
  merged: boolean;
  /** `head.sha` of the pull request. */
  headSha: string;
  /** `head.ref`: the parent's branch. */
  headRef: string;
  /** Whether the branch lives in the repository itself (a fork's branch cannot be fetched from `origin`). */
  headInBaseRepo: boolean;
  /** The tip of `headRef` as the branch read (`GET git/ref/heads/<ref>`) says. */
  branchTipSha: string;
}

export interface StackBasePort {
  /** Reads the parent's pull request and its branch tip. A read that cannot be made throws. */
  readParent(input: { repoId: string; owner: string; name: string; prNumber: number }): Promise<StackParentFacts>;
}

/** The refusals a start can answer with for a stacked item. Fixed codes, never text. */
export const STACK_START_REFUSALS = [
  "stack_parent_no_pull_request",
  "stack_parent_closed",
  "stack_parent_branch_unusable",
  "stack_parent_head_moved",
  "stack_parent_unreadable",
  "stack_base_unavailable",
  "stack_runtime_unsupported",
] as const;
export type StackStartRefusal = (typeof STACK_START_REFUSALS)[number];

/** A branch name that is safe to put in a git command line and a pull request's `base`. Stricter than git: no leading `-`, no `..`, no `@{`. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
export function isSafeBranchName(ref: string): boolean {
  return SAFE_BRANCH.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".") && !ref.endsWith(".lock");
}

export type StackStart =
  /** Start from the parent's branch at exactly this commit; open the pull request against this branch. */
  | { ok: true; base: { branch: string; sha: string } }
  /** The parent already merged: the child builds on the default branch as any item does. (P3c handles a child whose pull request already exists.) */
  | { ok: true; base: null }
  | { ok: false; reason: StackStartRefusal };

/** The decision, from what GitHub said. Pure, so the table of cases is a plain test. */
export function decideStackStart(facts: StackParentFacts): StackStart {
  if (facts.state === "closed") return facts.merged ? { ok: true, base: null } : { ok: false, reason: "stack_parent_closed" };
  if (facts.state !== "open" || facts.merged) return { ok: false, reason: "stack_parent_unreadable" };
  if (!facts.headInBaseRepo || !isSafeBranchName(facts.headRef)) return { ok: false, reason: "stack_parent_branch_unusable" };
  if (!SHA_PATTERN.test(facts.headSha) || !SHA_PATTERN.test(facts.branchTipSha)) return { ok: false, reason: "stack_parent_unreadable" };
  if (facts.headSha !== facts.branchTipSha) return { ok: false, reason: "stack_parent_head_moved" };
  return { ok: true, base: { branch: facts.headRef, sha: facts.headSha } };
}

interface Json {
  [k: string]: unknown;
}
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export interface StackBaseHttp {
  request(req: { method: "GET"; path: string }): Promise<{ status: number; body: unknown }>;
}

/**
 * The real port over read-only repository clients. Two GETs: the pull request (the `read` client: metadata and pull requests) and the branch ref (the `repo_map` client, whose exact path list includes one branch ref and nothing else of the code). Anything unexpected throws (the start
 * answers `stack_parent_unreadable`), so a malformed answer is never read as an open pull request.
 */
export function createStackBasePort(deps: { open(kind: "read" | "repo_map", r: { repoId: string; owner: string; name: string }): Promise<StackBaseHttp> }): StackBasePort {
  return {
    async readParent({ repoId, owner, name, prNumber }) {
      if (!NAME.test(owner) || !NAME.test(name) || !Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error("stack parent: invalid repository or pull request number");
      const target = { repoId, owner, name };
      const http = await deps.open("read", target);
      const repo = `/repos/${owner}/${name}`;
      const pull = await http.request({ method: "GET", path: `${repo}/pulls/${prNumber}` });
      if (pull.status !== 200 || !isObj(pull.body)) throw new Error(`stack parent: pull request read answered ${pull.status}`);
      const b = pull.body;
      const head = b.head;
      const base = b.base;
      if (!isObj(head) || typeof head.sha !== "string" || typeof head.ref !== "string" || !isObj(base) || !isObj(base.repo) || typeof base.repo.full_name !== "string") throw new Error("stack parent: malformed pull request");
      if (b.state !== "open" && b.state !== "closed") throw new Error("stack parent: malformed pull request state");
      const headInBaseRepo = isObj(head.repo) && typeof head.repo.full_name === "string" && head.repo.full_name.toLowerCase() === base.repo.full_name.toLowerCase();
      // The branch tip is only read for a branch we could use; a merged or closed pull request needs no tip.
      let branchTipSha = "";
      if (b.state === "open" && headInBaseRepo && isSafeBranchName(head.ref)) {
        const ref = await (await deps.open("repo_map", target)).request({ method: "GET", path: `${repo}/git/ref/heads/${head.ref.split("/").map(encodeURIComponent).join("/")}` });
        if (ref.status !== 200 || !isObj(ref.body) || !isObj(ref.body.object) || typeof ref.body.object.sha !== "string") throw new Error(`stack parent: branch read answered ${ref.status}`);
        branchTipSha = ref.body.object.sha;
      }
      return { state: b.state, merged: b.merged === true || (typeof b.merged_at === "string" && b.state === "closed"), headSha: head.sha, headRef: head.ref, headInBaseRepo, branchTipSha };
    },
  };
}
