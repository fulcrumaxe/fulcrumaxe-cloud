/**
 * The one way the daemon reads a workspace's git state on the host (D#6 RUNNER-HOSTREAD-GITDIR-SHAPE). The agent can write most files in the workspace's `.git`
 * (a `commondir`, a `config.worktree`, `info/*`, a `.git` that is a file, links, or a whole new `.git` made inside one Bash call), and the daemon runs git there
 * outside the sandbox. So every read first checks, in this order, and refuses with the closed `workspace_git_refused` on any miss:
 *  1. the pin taken at job setup (`workspacePin.ts`): the same `.git` folder and the same `config` file with the same bytes as the daemon's own clone left;
 *  2. the folder's shape (the push path's check: no gitfile or link, only the sandbox's empty stubs, plain trees, the clone's one alternates line, a plain
 *     reftable folder), and no nested gitfile in the worktree that names a place outside it (`nestedGitfiles.ts`);
 *  3. every key of the config is one the clone writes (`CONFIG_KEY_ALLOWLIST`), read with `--no-includes`.
 * The read itself runs without the user's own and the system git config and without any attributes file outside the repository, so a user-level filter driver
 * (git-lfs, say) cannot be started by an attributes file the agent wrote.
 * Read sites call `readWorkspaceGit` / `runWorkspaceGit` and never build a workspace-directed git call themselves (`test/daemon/hostRead.test.ts` fails on a bare one).
 */
import { gitEnv, type CleanEnvOptions } from "../job/cleanEnv.js";
import { GitPathError, guardConfigEnv, type Git, type GitCapture, type GitCaptured, type GitPathCode } from "./git.js";
import { assertHostReadableGit } from "./workspaceGit.js";
import { assertNoOutsideGitfiles } from "./nestedGitfiles.js";
import { checkPin, pinWorkspace, unpinWorkspace } from "./workspacePin.js";

/**
 * The config keys a workspace made by `git clone --reference <mirror>` (and the daemon's own `checkout`) holds: the repository format, the clone's
 * remote and its branch tracking lines. Everything else is refused, `include.*`, `filter.*`, `diff.*`, `core.worktree`, `core.fsmonitor`, `core.hooksPath` and
 * `extensions.*` (other than the object format) among it. Keys arrive lower-cased in the section and variable names; the branch name keeps its case.
 */
export const CONFIG_KEY_ALLOWLIST: readonly RegExp[] = Object.freeze([
  /^core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/,
  /^extensions\.objectformat$/,
  /^remote\.origin\.(?:url|fetch)$/,
  /^branch\.[^\0\n]+\.(?:remote|merge)$/,
]);

/** The environment and arguments every host read adds: no system or user-level config, no attributes file outside the repository. */
const NEUTRAL_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" });
/**
 * Also in every read: git should not descend into a nested repository. A directory with its own `.git` (a committed gitlink, an untracked nested repo, a
 * submodule whose `.git` is a gitfile) is read by `git diff` and `git status` through a CHILD git started inside it, which reads that repository's own config,
 * a file the pin and the key allowlist do not cover. These settings ask git not to. They are a second line only: `submodule.<name>.ignore` in the
 * workspace's own `.gitmodules` overrides `diff.ignoreSubmodules`, so what actually holds for the diff family is the `--ignore-submodules=all` argument,
 * which `hostGit` puts on every such read and nothing else can build (see below). Repositories that contain gitlinks are not refused (real repositories have
 * submodules); a submodule's changed state is simply not reported, so the changed-files header never names files that changed only inside one.
 */
const NEUTRAL_CONFIG: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["core.attributesFile", "/dev/null"],
  ["diff.ignoreSubmodules", "all"],
  ["submodule.recurse", "false"],
  ["status.submoduleSummary", "false"],
] as const);
const NEUTRAL_ARGS: readonly string[] = Object.freeze(NEUTRAL_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]));

/** The git verbs a host read may run. Only the diff family (`diff`, `status`) inspects submodules. */
export type HostGitVerb = "diff" | "status" | "ls-files" | "for-each-ref" | "rev-parse" | "symbolic-ref";
const SUBMODULE_VERBS: ReadonlySet<HostGitVerb> = new Set<HostGitVerb>(["diff", "status"]);
/** The verbs that name worktree paths. The others read refs and the object store only and never touch a nested repository. */
const WORKTREE_VERBS: ReadonlySet<HostGitVerb> = new Set<HostGitVerb>(["diff", "status", "ls-files"]);
const IGNORE_SUBMODULES_ALL = "--ignore-submodules=all";

/**
 * The arguments of one host read. The only way to get one is `hostGit`, and `readWorkspaceGit` / `runWorkspaceGit` accept nothing else, so a read of the diff
 * family without `--ignore-submodules=all` cannot be written: it does not type-check, and the class cannot be constructed outside this file.
 */
export class HostGitArgs {
  private constructor(readonly argv: readonly string[], readonly touchesWorktree: boolean) {}
  /** @internal use `hostGit`. */
  static build(verb: HostGitVerb, rest: readonly string[]): HostGitArgs {
    // A caller's own `--ignore-submodules` (any value) is refused: the builder alone sets it.
    if (rest.some((arg) => arg === "--ignore-submodules" || arg.startsWith("--ignore-submodules="))) refused();
    // `--recurse-submodules` (on any verb) starts git inside every submodule.
    if (rest.some((arg) => arg === "--recurse-submodules" || arg.startsWith("--recurse-submodules="))) refused();
    return new HostGitArgs(SUBMODULE_VERBS.has(verb) ? [verb, IGNORE_SUBMODULES_ALL, ...rest] : [verb, ...rest], WORKTREE_VERBS.has(verb));
  }
}

/** Builds the arguments of a host read: `hostGit("diff", "--name-only", base)` runs `git diff --ignore-submodules=all --name-only <base>`. */
export const hostGit = (verb: HostGitVerb, ...rest: readonly string[]): HostGitArgs => HostGitArgs.build(verb, rest);

const refused = (): never => {
  throw new GitPathError("workspace_git_refused");
};

/** Throws unless every key in `git config --list --null` output is on the allowlist. */
export function assertConfigKeys(listing: string): void {
  for (const entry of listing.split("\0")) {
    if (entry === "") continue;
    const [key, ...rest] = entry.split("\n");
    const value = rest.join("\n");
    // The ref storage format is a plain choice of two; any other value (or a key that is not on the list) is refused.
    if (key === "extensions.refstorage") {
      if (value !== "files" && value !== "reftable") refused();
      continue;
    }
    if (!CONFIG_KEY_ALLOWLIST.some((allowed) => allowed.test(key!))) refused();
  }
}

/** Pin, shape and config-key checks; `listConfig` returns the output of `git config --file <file> --list --null --no-includes`. */
async function vet(workspace: string, listConfig: (file: string) => Promise<string>, walk: boolean): Promise<void> {
  // The check that said no is kept as a closed word (the stage, or the more exact word a shape check carried), so a refusal can be told apart in the runner's log.
  let stage = "pin";
  try {
    const mirrorObjects = checkPin(workspace);
    stage = "git_dir_shape";
    assertHostReadableGit(workspace, mirrorObjects);
    stage = "nested_dotgit";
    if (walk) assertNoOutsideGitfiles(workspace);
    stage = "config_keys";
    assertConfigKeys(await listConfig(`${workspace}/.git/config`));
    // Read again after git ran: the folder must still be the pinned one.
    stage = "pin_after_read";
    checkPin(workspace);
  } catch (error) {
    // fx-swallow-ok: replaced by the closed code; the underlying error may carry a path
    throw new GitPathError("workspace_git_refused", undefined, error instanceof GitPathError && error.detail !== undefined ? error.detail : stage);
  }
}

const CONFIG_LIST = (file: string): string[] => ["config", "--file", file, "--list", "--null", "--no-includes"];

/** Records the workspace's git folder right after the daemon's clone (or after it verified a resumed one), and refuses a config with a key the clone does not write. */
export async function pinWorkspaceGit(git: Git, workspace: string, mirrorObjects: string): Promise<void> {
  try {
    pinWorkspace(workspace, mirrorObjects);
    await vet(workspace, (file) => git.run("workspace_git_refused", CONFIG_LIST(file), undefined, undefined, NEUTRAL_ENV), false);
  } catch {
    // fx-swallow-ok: replaced by the closed code; a workspace that cannot be pinned is not used
    unpinWorkspace(workspace);
    refused();
  }
}

/**
 * One host-read sequence (the changed-files listing is a `diff` and an `ls-files`): the first worktree read walks the worktree for nested repositories
 * (`nestedGitfiles.ts`), the others in the same session do not walk again. Ref-only reads never walk, with or without a session.
 */
export class HostReadSession {
  walked = false;
}

/** Runs git in the workspace through `capture` with the guarded environment, after the checks. Throws `GitPathError("workspace_git_refused")` on a refusal. */
export async function readWorkspaceGit(capture: GitCapture, envOptions: CleanEnvOptions, workspace: string, args: HostGitArgs, timeoutMs: number, session?: HostReadSession): Promise<GitCaptured> {
  const env = { ...gitEnv(envOptions), ...guardConfigEnv(), ...NEUTRAL_ENV };
  await vet(workspace, async (file) => {
    const out = await capture("git", CONFIG_LIST(file), env, 30_000);
    if (out.code !== 0 || out.timedOut) return refused();
    return out.stdout;
  }, args.touchesWorktree && session?.walked !== true);
  if (args.touchesWorktree && session !== undefined) session.walked = true;
  return capture("git", [...NEUTRAL_ARGS, "-C", workspace, ...args.argv], env, timeoutMs);
}

/** The same for a `Git` runner (the resume clean-up's listing): checks, then `git.run`. */
export async function runWorkspaceGit(git: Git, code: GitPathCode, workspace: string, args: HostGitArgs): Promise<string> {
  await vet(workspace, (file) => git.run("workspace_git_refused", CONFIG_LIST(file), undefined, undefined, NEUTRAL_ENV), args.touchesWorktree);
  return git.run(code, ["-C", workspace, ...args.argv], NEUTRAL_CONFIG, undefined, NEUTRAL_ENV);
}

/** What `mergeDefaultInto` found. `merged`: the branch now holds `target` (a merge commit, or a fast-forward when the branch had no commit of its own). `blocked`: the merge is clean but the working tree would not take it (local changes in the way); nothing was changed. */
export type BranchUpdate = { kind: "current" } | { kind: "merged"; head: string } | { kind: "conflict" } | { kind: "blocked" };

const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** The author and committer of the update's merge commit: fixed words, the same on every machine. */
const UPDATE_IDENTITY: readonly string[] = ["-c", "user.name=fulcrumaxe runner", "-c", "user.email=runner@fulcrumaxe.invalid"];

/**
 * Brings the workspace's branch up to date with `target`, a commit of the repository's default branch that the runner read from its own mirror (`rev-parse HEAD` there, after the sync).
 * Run before the agent starts, on a clone the daemon just made or on a resumed workspace it has just vetted, and vetted again here (pin, folder shape, config keys, nested repositories).
 *  - `target` is already in the branch's history: `current`, nothing is written.
 *  - `merge-tree --write-tree` decides whether the merge is clean, without touching the working tree. Exit 1 is git's "conflicts": `conflict`, nothing is written to the tree or the branch.
 *    Any other failure is an error and throws.
 *  - Clean: `git merge --no-edit` with a fixed identity; hooks are off (guard config) and no verification hook is asked for. History is never rewritten: the branch only gains the merge.
 * The objects of `target` are read through the clone's alternates (its mirror); nothing is fetched.
 */
export async function mergeDefaultInto(git: Git, workspace: string, target: string): Promise<BranchUpdate> {
  if (!COMMIT_ID.test(target)) throw new GitPathError("workspace_failed");
  await vet(workspace, (file) => git.run("workspace_git_refused", CONFIG_LIST(file), undefined, undefined, NEUTRAL_ENV), true);
  const inside = async (...args: string[]): Promise<string> => git.run("workspace_failed", ["-C", workspace, ...args], NEUTRAL_CONFIG, undefined, NEUTRAL_ENV);
  try {
    await inside("merge-base", "--is-ancestor", target, "HEAD");
    return { kind: "current" };
  } catch (error) {
    if (!(error instanceof GitPathError) || error.exitCode !== 1) throw error;
  }
  try {
    await inside("merge-tree", "--write-tree", "--no-messages", "HEAD", target);
  } catch (error) {
    if (error instanceof GitPathError && error.exitCode === 1) return { kind: "conflict" };
    throw error;
  }
  try {
    await inside(...UPDATE_IDENTITY, "merge", "--no-edit", "--no-verify", "--no-stat", "-m", "Bring the branch up to date with the default branch", target);
  } catch (error) {
    // `git merge` ends 1 for conflicts and 2 for a merge it refused to start (local changes would be overwritten); anything else (128: a fatal error) is not an answer.
    if (!(error instanceof GitPathError) || (error.exitCode !== 1 && error.exitCode !== 2)) throw error;
    // fx-swallow-ok: a clean merge the tree would not take (an untracked or changed file in the way): git refused before changing anything; the caller starts from a fresh clone instead
    return { kind: "blocked" };
  }
  const head = (await inside("rev-parse", "--verify", "HEAD^{commit}")).trim();
  if (!COMMIT_ID.test(head)) throw new GitPathError("workspace_failed");
  return { kind: "merged", head };
}
