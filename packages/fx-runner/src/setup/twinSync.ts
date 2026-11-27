/**
 * D#845 ON-27d2: the `twin_sync` handler. It brings the changes made on a twin's PUBLIC repository into the twin, as ONE ordinary commit on the twin's tip pushed to a branch of the twin, outside every sandbox (no model, no guest, no VM):
 *   twin_fetch -> push
 * The cloud (ON-27d3) opens the pull request on that branch; the engine reviews and merges it like any other. Nothing here reaches the twin's default branch, and nothing private is read or written to the public repository.
 * THREAT MODEL. The adversaries are a stranger who wrote the public repository's files, a hostile or mistaken path list, and a stale runner. At risk: the twin's private files and the push credential. So:
 *  - the public repository is read anonymously over https from GitHub only (the address is built from the signed owner and name), into a scratch bare repository of our own made for this one job, with no token, no hooks, no tags and
 *    no config read from the fetched repository. Nothing is checked out: no file of it is ever written to a working tree. Its `main` tip must be the signed `public.tip` (else `public_tip_moved`);
 *  - the twin's tip comes from this runner's own mirror of the twin and must be the signed `private.base` (else `private_tip_moved`); its objects are read through the mirror's object directory, never copied from a remote, and are attached only after the anonymous fetch so that fetch never advertises them;
 *  - the commit is the twin's base tree with exactly the listed paths set to the public tip's blobs (a listed path the public tip lacks is removed). A path of the private set (the fixed roots, the person's globs, the install's exact
 *    paths, the rule files) is `private_path_change` before anything is built; a symlink, a submodule or a file over 8 MB is `sync_unsafe_path`; and the finished tree is compared to the base tree: any changed path that is not a listed one,
 *    or that the private set covers, refuses and pushes nothing;
 *  - git is told to read a path literally (never as a pattern), the commit has the platform's fixed identity and message and the job's own time, so it carries nothing of the public authors and the same job always makes the same commit;
 *  - the credential is the one the cloud hands over for this job (the TWIN's repository alone, `contents: write`, once). It reaches git only through the environment of the one child, is revoked in a `finally`, and is asked for only after the
 *    commit was built and the push step was reported started;
 *  - the target is `fx/twin-sync-<tip12>` and nothing else, never forced, with no tags: a branch that exists at another commit is `branch_exists`, one at this very commit is already landed.
 * Failures are closed codes with one reason word, never git's text, a path or an address.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TWIN_FIXED_PRIVATE, TWIN_SEED_MAX_PACK_BYTES, TWIN_SYNC_MAX_FILE_BYTES, isTwinSyncPath, twinSyncBranch, type MachineJobOf } from "@fulcrumaxe/runner-protocol";
import { compileOverlay } from "@fulcrumaxe/runner-protocol/planePush";
import type { MachineJobHandler } from "../daemon/machineJobs.js";
import type { RunnerClient } from "../daemon/client.js";
import type { Git } from "../daemon/git.js";
import { githubUrl, type Mirrors } from "../daemon/mirror.js";
import { remoteBranchTip } from "../daemon/push.js";
import { withCredential } from "./setupPush.js";

export interface TwinSyncDeps {
  git: Git;
  mirrors: Pick<Mirrors, "sync" | "objects">;
  client: Pick<RunnerClient, "setupPushToken">;
  /** `DELETE /installation/token` with the token as the bearer. True when it is gone; never throws. */
  revoke: (token: string) => Promise<boolean>;
  /** A directory in the runner's own state where the per-job scratch repositories are made (absolute; made 0700, never a link). */
  scratchRoot: string;
  /** The address of a repository. Default: GitHub over https. Replaceable so a test can point at a local server (plain http on loopback only, as the other push transports allow). */
  remoteUrl?: (repo: { id: string; owner: string; name: string }) => string;
  /** Longest the fetch may run, in ms. */
  fetchTimeoutMs?: number;
  /** The most the fetched objects may hold. Default `TWIN_SEED_MAX_PACK_BYTES`; lower only for a test. */
  maxPackBytes?: number;
}

/** The platform's identity on the sync commit. A fixed one: nothing of the public side (an author, a committer, an address) is ever copied. */
export const TWIN_SYNC_IDENTITY = { name: "fulcrumaxe syncer", email: "syncer@noreply.invalid" } as const;
const FULL = /^[0-9a-f]{40}$/;
const PUBLIC_REF = "refs/fx-sync/public";
type Code = "bad_input" | "private_path_change" | "no_changes" | "sync_unsafe_path" | "public_unavailable" | "public_tip_moved" | "private_tip_moved" | "pairing_changed" | "twin_fetch_failed" | "twin_too_large" | "branch_exists" | "push_failed";

class Stop extends Error {
  constructor(readonly sub: "twin_fetch" | "push", readonly code: Code, readonly reason: string) {
    super(code);
  }
}

/** The set the sync refuses to touch, from the signed job alone: the fixed roots, the person's globs, the install's exact paths and the two rule files. */
export function privatePatternsOf(job: MachineJobOf<"twin_sync">): string[] {
  const set = job.args.private_set;
  return [...TWIN_FIXED_PRIVATE, ...set.overlay_globs, ...set.install_paths, ...(set.identifier_rules_path === null ? [] : [set.identifier_rules_path]), ...(set.plan_data_rules_path === null ? [] : [set.plan_data_rules_path])];
}

/** The scratch root, made 0700 or checked to be: a real directory (never a link). */
function ensureRoot(root: string): void {
  if (!path.isAbsolute(root)) throw new TypeError("the scratch root must be absolute");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error("scratch_root_insecure");
}

/** The bytes of every object this scratch repository holds itself (loose and packed), as `count-objects -v` counts them in KiB; the mirror's objects are not counted. */
async function storedBytes(git: Git, repo: string): Promise<number> {
  const out = await git.run("mirror_failed", ["-C", repo, "count-objects", "-v"]);
  const kib = (key: string): number => Number(out.match(new RegExp(`^${key}: (\\d+)$`, "m"))?.[1] ?? Number.NaN);
  const total = (kib("size") + kib("size-pack") + kib("size-garbage")) * 1024;
  if (!Number.isFinite(total)) throw new Stop("twin_fetch", "twin_fetch_failed", "size");
  return total;
}

function targetOf(deps: TwinSyncDeps, repo: { id: string; owner: string; name: string }): { url: string; target: URL } {
  const url = (deps.remoteUrl ?? githubUrl)(repo);
  const target = new URL(url);
  const loopback = target.hostname === "127.0.0.1" || target.hostname === "localhost";
  if (!(target.protocol === "https:" || (deps.remoteUrl !== undefined && target.protocol === "http:" && loopback)) || target.username !== "" || target.password !== "") throw new Stop("twin_fetch", "twin_fetch_failed", "remote");
  return { url, target };
}

export function createTwinSyncHandler(deps: TwinSyncDeps): MachineJobHandler<"twin_sync"> {
  return async ({ job, reporter, signal }) => {
    const { public: from, private: to, paths } = job.args;
    let token: string | undefined;
    let scratch: string | undefined;
    let at: "twin_fetch" | "push" = "twin_fetch";
    try {
      // The schema already refuses a job that is not homed on the twin; this is the same fence at the point of use.
      if (job.setup_id === undefined || to.gh_id !== job.repo_gh_id || from.gh_id === job.repo_gh_id || !FULL.test(from.tip) || !FULL.test(to.base) || job.args.branch !== twinSyncBranch(from.tip) || paths.length < 1 || new Set(paths).size !== paths.length || !paths.every(isTwinSyncPath)) {
        throw new Stop("twin_fetch", "bad_input", "target");
      }
      const overlay = compileOverlay(privatePatternsOf(job));
      if ("error" in overlay) throw new Stop("twin_fetch", "bad_input", "overlay");
      // A path of the private set is refused before anything is read or built.
      if (paths.some((p) => overlay.match(p))) throw new Stop("twin_fetch", "private_path_change", "private");
      await reporter.report({ sub_step: "twin_fetch", state: "started" });
      ensureRoot(deps.scratchRoot);
      scratch = path.join(deps.scratchRoot, `twin-sync-${randomBytes(8).toString("hex")}.git`);
      mkdirSync(scratch, { mode: 0o700 });
      const git = (args: readonly string[], env?: Record<string, string>): Promise<string> => deps.git.run("mirror_failed", args, undefined, undefined, env);
      // Paths are read literally, never as patterns, by every git command here.
      const literal = { GIT_LITERAL_PATHSPECS: "1" };
      await git(["init", "-q", "--bare", "--template=", "--", scratch]);
      // The twin's tip comes from its mirror and must be the signed base. Its objects are attached only AFTER the anonymous fetch below, so that fetch never advertises the twin's commit ids to the public host as "haves".
      const twin = { id: String(to.gh_id), owner: to.owner, name: to.name };
      try {
        const synced = await deps.mirrors.sync(twin);
        if (synced.base !== to.base) throw new Stop("twin_fetch", "private_tip_moved", "base");
      } catch (error) {
        // fx-swallow-ok: replaced by one closed code; the tool's own text can carry a path
        if (error instanceof Stop) throw error;
        throw new Stop("twin_fetch", "twin_fetch_failed", "mirror");
      }
      if (signal.aborted) return;
      // The public tip, anonymously.
      const source = targetOf(deps, { id: String(from.gh_id), owner: from.owner, name: from.name });
      const anonymous = withCredential(deps.git, undefined, source.target);
      try {
        await anonymous.run("mirror_failed", ["-C", scratch, "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-gc", "--", source.url, `+refs/heads/main:${PUBLIC_REF}`], [["transfer.unpackLimit", "1"]], deps.fetchTimeoutMs);
      } catch {
        // fx-swallow-ok: replaced by one closed code; git's own text can hold the address
        throw new Stop("twin_fetch", "public_unavailable", "fetch");
      }
      if (signal.aborted) return;
      const tip = (await git(["-C", scratch, "rev-parse", "--verify", `${PUBLIC_REF}^{commit}`]).catch(() => "")).trim(); // fx-swallow-ok: no commit is read as a tip that is not the signed one
      if (tip !== from.tip) throw new Stop("twin_fetch", "public_tip_moved", "tip");
      if ((await storedBytes(deps.git, scratch)) > Math.min(deps.maxPackBytes ?? TWIN_SEED_MAX_PACK_BYTES, TWIN_SEED_MAX_PACK_BYTES)) throw new Stop("twin_fetch", "twin_too_large", "pack");
      // Now the twin's objects are attached (read through the mirror's object directory, never copied) and the base commit must be there.
      try {
        mkdirSync(path.join(scratch, "objects", "info"), { recursive: true });
        writeFileSync(path.join(scratch, "objects", "info", "alternates"), `${deps.mirrors.objects(twin)}\n`, { mode: 0o600 });
        await git(["-C", scratch, "rev-parse", "--verify", `${to.base}^{commit}`]);
      } catch {
        // fx-swallow-ok: replaced by one closed code; the tool's own text can carry a path
        throw new Stop("twin_fetch", "twin_fetch_failed", "mirror");
      }

      // The tree: the twin's base with exactly the listed paths set to the public tip's blobs, in a private index file of this scratch repository.
      // `update-index` needs a work tree to name; an empty one inside the scratch directory, which nothing is ever checked out into.
      mkdirSync(path.join(scratch, "fx-wt"), { mode: 0o700 });
      const env = { ...literal, GIT_INDEX_FILE: path.join(scratch, "fx-sync-index"), GIT_WORK_TREE: path.join(scratch, "fx-wt") };
      await git(["-C", scratch, "read-tree", `${to.base}^{tree}`], env);
      const present: Array<{ path: string; mode: string; sha: string }> = [];
      const removed: string[] = [];
      for (const p of paths) {
        const line = (await git(["-C", scratch, "ls-tree", "-z", "--full-tree", from.tip, "--", p], env)).split("\0").filter((l) => l !== "")[0];
        const entry = line?.match(/^(\d+) (\w+) ([0-9a-f]{40})\t([\s\S]*)$/);
        // A path the public tip has no file at (it never had one, or it is a directory now) is removed from the twin, when the twin has a file there.
        if (entry === null || entry === undefined || entry[2] === "tree" || entry[4] !== p) {
          removed.push(p);
          continue;
        }
        if (entry[2] !== "blob" || (entry[1] !== "100644" && entry[1] !== "100755")) throw new Stop("twin_fetch", "sync_unsafe_path", "mode");
        if (Number((await git(["-C", scratch, "cat-file", "-s", entry[3]!])).trim()) > TWIN_SYNC_MAX_FILE_BYTES) throw new Stop("twin_fetch", "sync_unsafe_path", "size");
        present.push({ path: p, mode: entry[1], sha: entry[3]! });
      }
      // Removals first, so a file that became a directory (or the reverse) in the same sync is not a conflict; no `--replace`, so an entry that is not listed is never dropped to make room.
      for (const p of removed) await git(["-C", scratch, "update-index", "--force-remove", "--", p], env);
      try {
        for (const e of present) await git(["-C", scratch, "update-index", "--add", "--cacheinfo", `${e.mode},${e.sha},${e.path}`], env);
      } catch {
        // fx-swallow-ok: replaced by one closed code; git's own text names a path
        throw new Stop("twin_fetch", "sync_unsafe_path", "conflict");
      }
      const tree = (await git(["-C", scratch, "write-tree"], env)).trim();
      if (!FULL.test(tree)) throw new Stop("twin_fetch", "bad_input", "tree");
      // The finished tree against the base's: only listed paths may differ, and none of the private set.
      const changed = (await git(["-C", scratch, "diff-tree", "-r", "--name-only", "-z", "--no-renames", `${to.base}^{tree}`, tree], env)).split("\0").filter((p) => p !== "");
      if (changed.join("\0").length > 60_000) throw new Stop("twin_fetch", "bad_input", "too_big");
      if (changed.some((p) => overlay.match(p))) throw new Stop("twin_fetch", "private_path_change", "private");
      const listed = new Set(paths);
      if (changed.some((p) => !listed.has(p))) throw new Stop("twin_fetch", "bad_input", "outside");
      if (changed.length === 0) throw new Stop("twin_fetch", "no_changes", "equal");

      const when = `@${Math.floor(Date.parse(job.issued_at) / 1000)} +0000`;
      const identity = { GIT_AUTHOR_NAME: TWIN_SYNC_IDENTITY.name, GIT_AUTHOR_EMAIL: TWIN_SYNC_IDENTITY.email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_NAME: TWIN_SYNC_IDENTITY.name, GIT_COMMITTER_EMAIL: TWIN_SYNC_IDENTITY.email, GIT_COMMITTER_DATE: when };
      const commit = (await git(["-C", scratch, "commit-tree", tree, "-p", to.base, "-m", `Bring in changes made on the public repository\n\nPublic commit ${from.tip}\n`], identity)).trim();
      if (!FULL.test(commit) || commit === to.base) throw new Stop("twin_fetch", "bad_input", "commit");
      await reporter.report({ sub_step: "twin_fetch", state: "ok" });

      at = "push";
      await reporter.report({ sub_step: "push", state: "started" });
      if (reporter.closed || signal.aborted) return;
      const dest = targetOf(deps, { id: String(to.gh_id), owner: to.owner, name: to.name });
      const got = await deps.client.setupPushToken(job.setup_id, job.job_id);
      if (got.kind !== "token") {
        const refused = got.kind === "refused" ? got.code : undefined;
        throw new Stop("push", refused === "pairing_changed" ? "pairing_changed" : "push_failed", refused === "pairing_changed" ? "set" : got.kind === "refused" ? "token_refused" : "token_failed");
      }
      token = got.token;
      const authed = withCredential(deps.git, token, dest.target);
      const existing = await remoteBranchTip(authed, scratch, dest.url, job.args.branch).catch(() => undefined); // fx-swallow-ok: an unreadable twin is one closed refusal below
      if (existing === undefined) throw new Stop("push", "push_failed", "ls_remote");
      // The same commit already on the branch is a push that landed before and was not reported; any other commit there is somebody's.
      if (existing !== null && existing !== commit) throw new Stop("push", "branch_exists", "exists");
      if (existing === null) {
        try {
          await authed.run("push_failed", ["-C", scratch, "push", "--porcelain", "--no-verify", "--no-follow-tags", "--no-recurse-submodules", "--", dest.url, `${commit}:refs/heads/${job.args.branch}`]);
        } catch {
          // fx-swallow-ok: replaced by closed codes; git's own text can hold the address
          throw new Stop("push", "push_failed", "rejected");
        }
        if ((await remoteBranchTip(authed, scratch, dest.url, job.args.branch).catch(() => undefined)) !== commit) throw new Stop("push", "push_failed", "not_landed");
      }
      await reporter.report({ sub_step: "push", state: "ok", head_sha: commit });
    } catch (error) {
      // fx-swallow-ok: a job the cloud already ended has nobody to tell; any other failure is reported below as a closed code
      if (reporter.closed) return;
      const stop = error instanceof Stop ? error : new Stop(at, at === "push" ? "push_failed" : "twin_fetch_failed", "git");
      await reporter.report({ sub_step: stop.sub, state: "failed", failure_code: stop.code, failure_reason: stop.reason });
    } finally {
      if (token !== undefined) await deps.revoke(token).catch(() => false); // fx-swallow-ok: a token that cannot be revoked now lapses at GitHub's own expiry
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    }
  };
}

export type TwinSyncJob = MachineJobOf<"twin_sync">;
