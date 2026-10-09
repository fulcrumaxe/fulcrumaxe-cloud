/**
 * Git path B, the push (D#6 R4a-3): the daemon pushes a finished run's commit to GitHub itself, outside the agent's sandbox,
 * with the user's own git credential helper. The remote is GitHub itself; nothing here knows of any other host (the cloud-verified path is a different change).
 *
 * A fresh run pushes `fx/<run>-g<generation>`, a name built from the lease alone (`pushPlan`): the run id the cloud handed out and
 * the claim's generation. A fix round (C25 section 1) pushes to the branch of the pull request it fixes, `continues.branch` of the
 * verified signed job, which must have the exact shape of a name some run's lease produced (`CONTINUES_BRANCH`) and must already
 * exist on the remote with its tip at the commit the run started from. Nothing the agent wrote and no other text in the job reaches
 * a ref name. The push is never forced, and `runPush` refuses any refspec other than the one the plan gives.
 *
 * The push runs from the mirror, not from the workspace: the workspace's config is the agent's. The commit is first fetched
 * from a daemon-owned snapshot of the workspace's refs and objects into a private ref of the mirror (git reading a repository,
 * under the guard config), then pushed from there, so the credential helper only ever sees a URL this runner chose.
 */
import path from "node:path";
import { assertGitVersion, GitPathError, type Git } from "./git.js";
import { EMPTY_BLOB_IDS, isSandboxStubName, SANDBOX_STUB_PATHSPECS } from "./sandboxStubs.js";
import { takeSnapshot } from "./snapshot.js";
import { assertGitDirShape, assertWorkspaceGit } from "./workspaceGit.js";

/** The one place a pushed branch can live. A job whose own prefix is anything else is not pushed. */
export const PUSH_BRANCH_PREFIX = "fx/";

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What identifies a claimed run: the run id and the generation of the claim that holds it. */
export interface PushLease {
  runId: string;
  leaseGeneration: number;
}

/** The only branch a fix round may push: the shape of a name `pushPlan` makes for a fresh run (the uuid is the fresh run's, not necessarily the parent's). */
export const CONTINUES_BRANCH = /^fx\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-g[1-9][0-9]{0,8}$/;

/** What `pushPlan` reads of a job's `continues`: the branch of the pull request being fixed. */
export interface PushContinues {
  branch: string;
}

export interface PushPlan {
  /** `fx/<run>-g<generation>`, or `continues.branch` for a fix round. */
  branch: string;
  /** Where the workspace's commit is held in the mirror until it is pushed. */
  localRef: string;
  /** `<localRef>:refs/heads/<branch>`: no `+`, no wildcard. */
  refspec: string;
}

/** The branch of a fix round, or `push_ref_refused` when it is not the shape of a run branch. */
export function continuesBranch(continues: PushContinues): string {
  if (typeof continues.branch !== "string" || !CONTINUES_BRANCH.test(continues.branch)) throw new GitPathError("push_ref_refused");
  return continues.branch;
}

/**
 * The plan for a lease, and for a fix round the verified job's `continues`. Throws `push_ref_refused` for an id or generation that
 * is not what the cloud hands out, and for a `continues.branch` that is not the shape of a run branch. The private ref stays named
 * by this lease, so two jobs never share one; only the target differs.
 */
export function pushPlan(lease: PushLease, continues: PushContinues | null = null): PushPlan {
  if (typeof lease.runId !== "string" || !RUN_ID.test(lease.runId) || !Number.isSafeInteger(lease.leaseGeneration) || lease.leaseGeneration < 1) throw new GitPathError("push_ref_refused");
  const name = `${lease.runId}-g${lease.leaseGeneration}`;
  const branch = continues === null ? `${PUSH_BRANCH_PREFIX}${name}` : continuesBranch(continues);
  const localRef = `refs/fx-push/${name}`;
  return { branch, localRef, refspec: `${localRef}:refs/heads/${branch}` };
}

/** Throws unless `refspec` is exactly the one this lease's plan gives. */
export function assertAllowedRefspec(refspec: string, lease: PushLease, continues: PushContinues | null = null): void {
  if (refspec !== pushPlan(lease, continues).refspec) throw new GitPathError("push_ref_refused");
}

/** What a chunk push (path A) may name as its source: a full object id between the run's `base` and its pushed `sha`. */
export interface ChunkBounds {
  base: string;
  sha: string;
}

/**
 * Path A's chunk refspec (C27 section 4.3): `<oid>:refs/heads/<branch>`, where the target is exactly the plan's branch and `oid` is a full
 * object id that is a descendant of `base` and an ancestor of `sha`. Anything else, `+` included, throws `push_ref_refused`.
 */
export async function assertAllowedChunkRefspec(git: Git, mirrorDir: string, refspec: string, lease: PushLease, continues: PushContinues | null, bounds: ChunkBounds): Promise<void> {
  const plan = pushPlan(lease, continues);
  const [source, target, ...rest] = refspec.split(":");
  if (rest.length > 0 || source === undefined || !OBJECT_ID.test(source) || target !== `refs/heads/${plan.branch}` || !OBJECT_ID.test(bounds.base) || !OBJECT_ID.test(bounds.sha)) throw new GitPathError("push_ref_refused");
  await git.run("push_ref_refused", ["-C", mirrorDir, "merge-base", "--is-ancestor", bounds.base, source]);
  await git.run("push_ref_refused", ["-C", mirrorDir, "merge-base", "--is-ancestor", source, bounds.sha]);
}

/** Pushes `refspec`, out of the mirror at `mirrorDir`, to `url`, after checking it against the lease. Never forced, no hooks, no tags, no submodules. */
export async function runPush(git: Git, mirrorDir: string, url: string, refspec: string, lease: PushLease, continues: PushContinues | null = null, chunk?: ChunkBounds): Promise<void> {
  if (chunk !== undefined && refspec !== pushPlan(lease, continues).refspec) await assertAllowedChunkRefspec(git, mirrorDir, refspec, lease, continues, chunk);
  else assertAllowedRefspec(refspec, lease, continues);
  await git.run("push_failed", ["-C", mirrorDir, "push", "--porcelain", "--atomic", "--no-verify", "--no-follow-tags", "--no-recurse-submodules", "--", url, refspec]);
}

/** The tip of `refs/heads/<branch>` on the remote, or null when there is no such branch. Matches the exact ref name only (a pattern also matches deeper names). */
export async function remoteBranchTip(git: Git, mirrorDir: string, url: string, branch: string): Promise<string | null> {
  const listing = await git.run("push_failed", ["-C", mirrorDir, "ls-remote", "--heads", "--", url, `refs/heads/${branch}`]);
  for (const line of listing.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (ref === `refs/heads/${branch}` && sha !== undefined && OBJECT_ID.test(sha)) return sha;
  }
  return null;
}

/**
 * The commit a resumed session's workspace is at. Read the way the push reads it: from a snapshot the daemon made, never from
 * the workspace's own `.git`. Throws `snapshot_refused` or `push_ref_refused` for a workspace that is not what a clone makes.
 */
export async function workspaceHead(git: Git, mirrorDir: string, workspace: string, snapshotsRoot: string): Promise<string> {
  const mirrorObjects = path.join(mirrorDir, "objects");
  assertWorkspaceGit(path.resolve(workspace), mirrorObjects);
  const snapshot = await takeSnapshot({ workspace: path.resolve(workspace), mirrorObjects, root: snapshotsRoot });
  try {
    assertGitDirShape(snapshot.gitDir, mirrorObjects, true);
    return (await git.run("push_failed", ["--git-dir", snapshot.gitDir, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
  } finally {
    snapshot.remove();
  }
}

/** The most one push may carry through the cloud's relay: its 4 MiB cap less 64 KiB of headroom for pkt-lines (C27 section 4.3). */
export const PUSH_BUDGET_BYTES = 4_194_304 - 65_536;
/** Path A retries a failed chunk this many more times, each with a fresh ticket. */
export const CHUNK_RETRIES = 2;

/** A size in whole MB (1 MiB each), rounded up, never below the 5 the protocol allows. */
export const sizeMbOf = (bytes: number): number => Math.max(5, Math.ceil(bytes / 1_048_576));

/** The bytes the objects of `commit` that `previous` lacks take on disk: a stand-in for the pack a push would send, measured without reading any of it. */
async function newBytes(git: Git, mirrorDir: string, commit: string, previous: string): Promise<number> {
  const out = (await git.run("push_failed", ["-C", mirrorDir, "rev-list", "--objects", "--disk-usage", commit, `^${previous}`])).trim();
  if (!/^\d{1,15}$/.test(out)) throw new GitPathError("push_failed");
  return Number(out);
}

/**
 * Where a run's commits are cut into pushes (C27 section 4.3). Nothing is pushed here. If `sha` as a whole fits the budget the answer is
 * `[sha]`. Otherwise the first-parent commits are measured one by one against their predecessor, and grouped greedily into runs that each fit;
 * the answer is each group's last commit. A single commit over the budget throws `push_too_large` with the largest one's size, so a push
 * either goes whole or does not start.
 */
export async function planChunks(git: Git, mirrorDir: string, base: string, sha: string, budget: number = PUSH_BUDGET_BYTES): Promise<string[]> {
  if ((await newBytes(git, mirrorDir, sha, base)) <= budget) return [sha];
  const commits = (await git.run("push_failed", ["-C", mirrorDir, "rev-list", "--reverse", "--first-parent", `${base}..${sha}`])).split("\n").filter((line) => line !== "");
  if (commits.length === 0 || commits.some((oid) => !OBJECT_ID.test(oid)) || commits[commits.length - 1] !== sha) throw new GitPathError("push_failed");
  const sizes: number[] = [];
  let previous = base;
  for (const commit of commits) {
    sizes.push(await newBytes(git, mirrorDir, commit, previous));
    previous = commit;
  }
  const largest = Math.max(...sizes);
  if (largest > budget) throw new GitPathError("push_too_large", sizeMbOf(largest));
  const ends: string[] = [];
  let used = 0;
  commits.forEach((commit, index) => {
    const size = sizes[index]!;
    if (used > 0 && used + size > budget) ends.push(commits[index - 1]!);
    used = used > 0 && used + size <= budget ? used + size : size;
  });
  ends.push(sha);
  return ends;
}

/** Codes that end a path A push at once: retrying cannot help, or must not happen. */
const NO_RETRY: ReadonlySet<string> = new Set(["git_stopped", "git_revoked", "clone_limited", "push_too_large", "git_ticket_refused", "git_proxy_unpinned", "push_ref_refused", "push_rejected", "continuation_branch_missing"]);

/** Path A's way into the network: each `open` is a git (and the remote address) good for one network command or one push chunk, with a fresh ticket. */
export interface PushTransport {
  open(): Promise<{ git: Git; url: string }>;
}

export interface PublishOptions {
  /** Path A: network commands and pushes go through this, in chunks that fit the relay's cap. Absent: path B, one push with `git`. */
  transport?: PushTransport;
  /** The verified job's `continues`: the push then goes to its branch, which must exist with its tip at `base`. */
  continues?: PushContinues | null;
  /** True once the cloud has said stop: nothing is pushed after that (C24 section 1.3). Asked right before the push. */
  stopped?: () => boolean;
}

/**
 * Pushes each chunk's last commit in order, one ref per push, no `+`. A failed chunk is tried up to `CHUNK_RETRIES` more times, each with a
 * fresh ticket, and then ends `push_incomplete`; the codes in `NO_RETRY` end it at once. A lost race on a fix round's branch is `push_rejected`
 * (read from what the remote holds now), and a chunk that turns out to have landed anyway counts as pushed. Returns false when `stopped` says so.
 */
async function pushChunks(transport: PushTransport, mirrorDir: string, ends: readonly string[], plan: PushPlan, lease: PushLease, continues: PushContinues | null, bounds: ChunkBounds, stopped: (() => boolean) | undefined): Promise<boolean> {
  let expectedTip = bounds.base;
  for (const oid of ends) {
    const refspec = ends.length === 1 ? plan.refspec : `${oid}:refs/heads/${plan.branch}`;
    for (let attempt = 0; ; attempt++) {
      if (stopped?.() === true) return false;
      try {
        const net = await transport.open();
        await runPush(net.git, mirrorDir, net.url, refspec, lease, continues, bounds);
        break;
      } catch (error) {
        if (!(error instanceof GitPathError)) throw error;
        if (NO_RETRY.has(error.code)) throw error;
        if (continues !== null) {
          const net = await transport.open();
          const now = await remoteBranchTip(net.git, mirrorDir, net.url, plan.branch).catch(() => undefined); // fx-swallow-ok: the push's own failure stands when the remote cannot be asked
          if (now === oid) break;
          if (now !== undefined && now !== expectedTip) throw new GitPathError("push_rejected");
        }
        if (attempt >= CHUNK_RETRIES) throw new GitPathError("push_incomplete");
      }
    }
    expectedTip = oid;
  }
  return true;
}

/**
 * D#6 R4d-2 (C32 section 2 item 2): throws `sandbox_stub_committed` when any commit in `base..sha` adds, as an empty blob, a file the sandbox
 * makes an empty placeholder for (`sandboxStubs.ts`). Every commit counts, not only the net result: a stub added and removed again is still in
 * the pushed history. A non-empty file of the same name, or an existing one that is changed, is not a stub. Read from the mirror, after the fetch.
 */
export async function assertNoCommittedStubs(git: Git, mirrorDir: string, base: string, sha: string): Promise<void> {
  const raw = await git.run("push_failed", ["-C", mirrorDir, "log", "-m", "--full-history", "--no-renames", "--diff-filter=A", "--raw", "--no-abbrev", "-z", "--format=", `${base}..${sha}`, "--", ...SANDBOX_STUB_PATHSPECS]);
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const meta = tokens[i]!.match(/^:\d{6} \d{6} [0-9a-f]+ ([0-9a-f]+) A$/);
    if (meta === null) continue;
    const added = tokens[i + 1] ?? "";
    if (EMPTY_BLOB_IDS.has(meta[1]!) && isSandboxStubName(added)) throw new GitPathError("sandbox_stub_committed");
  }
}

export type Published ={ pushed: false } | { pushed: true; branch: string; sha: string };

/**
 * Brings the workspace's HEAD into the mirror and pushes it to the run's branch. Nothing is pushed when HEAD is still the commit the
 * workspace started from (`base`): the cloud then finds no commit and ends the run `no_commit`, and no empty branch is left behind.
 *
 * The fetch never reads the workspace's `.git`. That directory is the agent's, and a process that outlived the run can still
 * write it. The daemon copies the few things a fetch needs into a snapshot of its own (`takeSnapshot`), checks the snapshot, and
 * fetches from that with a strict `upload-pack` (the path exactly as given, no `.git` suffix tried). The snapshot is deleted
 * whatever happens. `snapshotsRoot` is a directory under the runner's private state.
 */
export async function publishBranch(git: Git, mirrorDir: string, url: string, workspace: string, base: string, lease: PushLease, snapshotsRoot: string, options: PublishOptions = {}): Promise<Published> {
  const continues = options.continues ?? null;
  const plan = pushPlan(lease, continues);
  if (!OBJECT_ID.test(base)) throw new GitPathError("push_ref_refused");
  await assertGitVersion(git);
  const mirrorObjects = path.join(mirrorDir, "objects");
  // Early fail-fast on the workspace as it stands. It is not what the fetch trusts: the snapshot is.
  assertWorkspaceGit(path.resolve(workspace), mirrorObjects);
  const snapshot = await takeSnapshot({ workspace: path.resolve(workspace), mirrorObjects, root: snapshotsRoot });
  try {
    await git.run("push_failed", ["-C", mirrorDir, "update-ref", "-d", plan.localRef]);
    // The snapshot is checked last, right before the fetch reads it: it is what the fetch trusts, so it is what is validated.
    assertGitDirShape(snapshot.gitDir, mirrorObjects, true);
    try {
      await git.run("push_failed", ["-C", mirrorDir, "fetch", "--upload-pack=git upload-pack --strict", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--", snapshot.gitDir, `HEAD:${plan.localRef}`]);
      const sha = (await git.run("push_failed", ["-C", mirrorDir, "rev-parse", "--verify", `${plan.localRef}^{commit}`])).trim();
      if (sha === base) return { pushed: false };
      // Backstop for the checks above: what is pushed must grow from the commit this run started at, whatever git read to find it.
      // The agent may have switched branches; whatever HEAD holds is published if `base` is its ancestor (C32 section 2), else this is `head_not_from_base`.
      await git.run("head_not_from_base", ["-C", mirrorDir, "merge-base", "--is-ancestor", base, sha]);
      await assertNoCommittedStubs(git, mirrorDir, base, sha);
      const transport = options.transport;
      if (continues !== null) {
        // A fix round updates a pull request's branch, so the branch must still be there, still at the commit this run started from.
        // A moved tip cannot take this push (it would not be a fast-forward), and the daemon does not retry: it reports `push_rejected`.
        const net = transport === undefined ? { git, url } : await transport.open();
        const remoteTip = await remoteBranchTip(net.git, mirrorDir, net.url, plan.branch);
        if (remoteTip === null) throw new GitPathError("continuation_branch_missing");
        if (remoteTip !== base) throw new GitPathError("push_rejected");
      }
      if (transport !== undefined) {
        // Path A: sized before anything is sent, so a commit the relay would refuse stops the run with nothing pushed.
        const ends = await planChunks(git, mirrorDir, base, sha);
        if (!(await pushChunks(transport, mirrorDir, ends, plan, lease, continues, { base, sha }, options.stopped))) return { pushed: false };
        return { pushed: true, branch: plan.branch, sha };
      }
      if (options.stopped?.() === true) return { pushed: false };
      try {
        await runPush(git, mirrorDir, url, plan.refspec, lease, continues);
      } catch (error) {
        if (continues === null || !(error instanceof GitPathError) || error.code !== "push_failed") throw error;
        // The branch can move between the check and the push, and the remote then refuses it as non-fast-forward. Say so from what the remote holds now; the push itself is not retried. (A branch deleted in that window is re-created by the push: the accepted gap of C25 section 1.4.)
        const now = await remoteBranchTip(git, mirrorDir, url, plan.branch).catch(() => undefined); // fx-swallow-ok: the push's own closed code stands when the remote cannot be asked
        if (now !== undefined && now !== base) throw new GitPathError("push_rejected");
        throw error;
      }
      return { pushed: true, branch: plan.branch, sha };
    } finally {
      // fx-swallow-ok: a private ref left behind is deleted at the start of the next publish for this lease
      await git.run("push_failed", ["-C", mirrorDir, "update-ref", "-d", plan.localRef]).catch(() => undefined);
    }
  } finally {
    snapshot.remove();
  }
}
