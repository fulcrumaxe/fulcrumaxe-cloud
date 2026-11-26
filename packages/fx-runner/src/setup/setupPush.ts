/**
 * D#845 ON-8f1: the push of a project setup, made by the runner itself, outside every sandbox, with the one credential the cloud hands over for this job (`setupPushToken`, once per attempt).
 *
 * THREAT MODEL. The adversary is whatever ran in the guest (its bundle was checked and applied by ON-8d) and a hostile or mistaken cloud reply. At risk: the customer's repository and the credential. So:
 *  - the credential (a `contents: write` installation token for this one repository) lives in a variable of one call. It reaches git only through the environment of the one child (`GIT_CONFIG_*`, spelled as in
 *    `createGitTransport`): never an argument, a URL, a config file, the mirror, a log or a guest. It is revoked in a `finally`, whatever happens;
 *  - the commit is brought into the mirror the way every runner push does it (`publishBranch`): from a snapshot of the workspace's git folder the daemon made and checked, never from the workspace's own `.git`;
 *  - what is pushed is built here from the verified tip: PR mode pushes that commit, which must sit directly on the job's `base_sha`; direct mode pushes a root commit made with `commit-tree` from the tip's tree;
 *  - the target is built here from the signed job and the plan: PR mode only `refs/heads/fx/engine-install-<v>` (the branch the signed job names, never the default branch), with `--force-with-lease` on the tip read just
 *    before, so a branch a person moved meanwhile is never overwritten; direct mode only the default branch, never forced, and only while the remote still has no commit on it;
 *  - the host is fixed to GitHub over https (`githubUrl`); redirects, prompts, credential helpers, hooks and every other protocol are off. `remoteUrl` is replaceable for a test only, as the mirrors' is.
 * Failures are closed codes: `push_failed` with a reason word, and `direct_raced` when the default branch got a commit first (the cloud then issues the same setup again as a pull request).
 */
import path from "node:path";
import { ENGINE_INSTALL_BRANCH, ENGINE_UPDATE_BRANCH, type MachineJobOf } from "@fulcrumaxe/runner-protocol";
import type { RunnerClient } from "../daemon/client.js";
import type { Git } from "../daemon/git.js";
import { githubUrl } from "../daemon/mirror.js";
import { remoteBranchTip } from "../daemon/push.js";
import { takeSnapshot } from "../daemon/snapshot.js";
import { assertGitDirShape, assertWorkspaceGit } from "../daemon/workspaceGit.js";

export interface SetupPushDeps {
  git: Git;
  client: Pick<RunnerClient, "setupPushToken">;
  /** `DELETE /installation/token` with the token as the bearer. True when it is gone; never throws. */
  revoke: (token: string) => Promise<boolean>;
  /** The runner's private directory the snapshots are made under (`<state>/git-snapshots`). */
  snapshotsRoot: string;
  /** The address of the repository. Default: GitHub over https. Replaceable so a test can point at a local bare repository. */
  remoteUrl?: (repo: { id: string; owner: string; name: string }) => string;
}

export interface SetupPushInput {
  /** An `engine_update` job only ever pushes its signed update branch, on top of `base` (the default branch tip the host read); it has no default branch to push. */
  job: MachineJobOf<"project_setup"> | MachineJobOf<"engine_update">;
  base?: string;
  repo: { id: string; owner: string; name: string; defaultBranch: string | null };
  /** The directory whose objects the workspace borrows, and the workspace the verified bundle was applied to. */
  mirrorDir: string;
  workspace: string;
  /** The verified tip `applyBundle` returned. */
  tip: string;
}

export type SetupPushOutcome = { ok: true; head: string } | { ok: false; code: "push_failed" | "direct_raced"; reason: string };

const FULL = /^[0-9a-f]{40}$/;
const DEFAULT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}){0,3}$/;
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", GIT_CONFIG_NOSYSTEM: "1" } as const;

class Stop extends Error {
  constructor(readonly code: "push_failed" | "direct_raced", readonly reason: string) {
    super(code);
  }
}

export async function pushSetup(deps: SetupPushDeps, input: SetupPushInput): Promise<SetupPushOutcome> {
  const { job, repo } = input;
  const direct = job.kind === "project_setup" && job.args.mode === "direct";
  const baseSha = job.kind === "project_setup" ? job.args.base_sha : input.base;
  const localRef = `refs/fx-push/setup-${job.job_id}`;
  let token: string | undefined;
  try {
    const branch = direct ? (repo.defaultBranch as string) : job.args.branch;
    // The target is never taken from anything the guest wrote; the signed job and the plan name it, and it is checked again here.
    if (!FULL.test(input.tip) || !DEFAULT_BRANCH.test(branch) || branch.includes("..") || branch.endsWith(".lock") || job.setup_id === undefined || baseSha === undefined || !FULL.test(baseSha) || (job.kind === "project_setup" && repo.defaultBranch === null)) throw new Stop("push_failed", "target");
    if (!direct && (!(job.kind === "project_setup" ? ENGINE_INSTALL_BRANCH : ENGINE_UPDATE_BRANCH).test(branch) || branch === repo.defaultBranch)) throw new Stop("push_failed", "target");
    const url = (deps.remoteUrl ?? githubUrl)(repo);
    const target = new URL(url);
    // https only; plain http is for a test server on loopback (a replaced `remoteUrl`), as the other push transports allow
    const loopback = target.hostname === "127.0.0.1" || target.hostname === "localhost";
    if (!(target.protocol === "https:" || (deps.remoteUrl !== undefined && target.protocol === "http:" && loopback)) || target.username !== "" || target.password !== "") throw new Stop("push_failed", "remote");

    const sha = await stage(deps, input, localRef);
    if (!direct && (await deps.git.run("push_failed", ["-C", input.mirrorDir, "rev-parse", "--verify", `${sha}^`])).trim() !== baseSha) throw new Stop("push_failed", "not_on_base");

    const got = await deps.client.setupPushToken(job.setup_id, job.job_id);
    if (got.kind !== "token") throw new Stop("push_failed", got.kind === "refused" ? "token_refused" : "token_failed");
    token = got.token;
    const authed = withCredential(deps.git, token, target);

    let pushed = sha;
    let lease: string[] = [];
    if (direct) {
      // the default branch still has no commit, or someone got there first
      const seen = await remoteBranchTip(authed, input.mirrorDir, url, branch).catch(() => undefined);
      if (seen === undefined) throw new Stop("push_failed", "ls_remote");
      if (seen !== null) throw new Stop("direct_raced", "head_exists");
      pushed = await rootCommit(deps.git, input.mirrorDir, sha, job as MachineJobOf<"project_setup">, localRef);
    } else {
      const tipNow = await remoteBranchTip(authed, input.mirrorDir, url, branch).catch(() => undefined);
      if (tipNow === undefined) throw new Stop("push_failed", "ls_remote");
      // a re-run moves the branch it made before, and only if it is still where it was just read
      if (tipNow !== null) lease = [`--force-with-lease=refs/heads/${branch}:${tipNow}`];
    }
    try {
      await authed.run("push_failed", ["-C", input.mirrorDir, "push", "--porcelain", "--no-verify", "--no-follow-tags", "--no-recurse-submodules", ...lease, "--", url, `${localRef}:refs/heads/${branch}`]);
    } catch {
      // fx-swallow-ok: replaced by closed codes; git's own text can hold the address
      const now = await remoteBranchTip(authed, input.mirrorDir, url, branch).catch(() => undefined);
      if (direct && now !== undefined && now !== null) throw new Stop("direct_raced", "rejected");
      throw new Stop("push_failed", "rejected");
    }
    if ((await remoteBranchTip(authed, input.mirrorDir, url, branch).catch(() => undefined)) !== pushed) throw new Stop("push_failed", "not_landed");
    return { ok: true, head: pushed };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, code: error.code, reason: error.reason };
    // fx-swallow-ok: any other failure (git, the filesystem) is one closed outcome; its text can hold a path or the address
    return { ok: false, code: "push_failed", reason: "git" };
  } finally {
    await deps.git.run("workspace_failed", ["-C", input.mirrorDir, "update-ref", "-d", localRef]).catch(() => undefined); // fx-swallow-ok: a private ref left behind is deleted by the next run of this job id
    if (token !== undefined) await deps.revoke(token).catch(() => false); // fx-swallow-ok: a token that cannot be revoked now lapses at GitHub's own expiry
  }
}

/** The verified tip, brought from a snapshot of the workspace's git folder into the mirror under a private ref. Returns its id, which must be the tip. */
async function stage(deps: SetupPushDeps, input: SetupPushInput, localRef: string): Promise<string> {
  const mirrorObjects = path.join(input.mirrorDir, "objects");
  assertWorkspaceGit(path.resolve(input.workspace), mirrorObjects);
  const snapshot = await takeSnapshot({ workspace: path.resolve(input.workspace), mirrorObjects, root: deps.snapshotsRoot });
  try {
    assertGitDirShape(snapshot.gitDir, mirrorObjects, true);
    await deps.git.run("push_failed", ["-C", input.mirrorDir, "fetch", "--upload-pack=git upload-pack --strict", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--", snapshot.gitDir, `HEAD:${localRef}`]);
  } finally {
    snapshot.remove();
  }
  const sha = (await deps.git.run("push_failed", ["-C", input.mirrorDir, "rev-parse", "--verify", `${localRef}^{commit}`])).trim();
  if (sha !== input.tip) throw new Stop("push_failed", "tip_mismatch");
  return sha;
}

/** Direct mode: one root commit with the tip's tree, the install commit's message, and the job's own fixed identity and time, so the same job always makes the same commit. */
async function rootCommit(git: Git, mirrorDir: string, tip: string, job: MachineJobOf<"project_setup">, localRef: string): Promise<string> {
  const when = `@${String(Math.floor(Date.parse(job.issued_at) / 1000))} +0000`;
  const env = { GIT_AUTHOR_NAME: "fulcrumaxe", GIT_AUTHOR_EMAIL: "runner@localhost", GIT_COMMITTER_NAME: "fulcrumaxe", GIT_COMMITTER_EMAIL: "runner@localhost", GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  const root = (await git.run("push_failed", ["-C", mirrorDir, "commit-tree", `${tip}^{tree}`, "-m", `Install the fulcrumaxe engine ${job.args.engine.version}`], undefined, undefined, env)).trim();
  if (!FULL.test(root)) throw new Stop("push_failed", "root_commit");
  await git.run("push_failed", ["-C", mirrorDir, "update-ref", localRef, root]);
  return root;
}

/** A git whose every network command carries the hardening and, for https, the credential in the environment of that one child. With no token it is the same git, anonymous (D#845 ON-27b: the twin seed's read of a public repository). */
export function withCredential(git: Git, token: string | undefined, target: URL): Git {
  const hardening: Array<readonly [string, string]> = [
    ["protocol.allow", "never"], [`protocol.${target.protocol.slice(0, -1)}.allow`, "always"], ["http.followRedirects", "false"], ["http.sslVerify", "true"], ["credential.helper", ""], ["core.askPass", ""],
    ...(token === undefined ? [] : [[`http.${target.origin}/.extraHeader`, `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`] as const]),
  ];
  return { run: (code, args, config, timeoutMs, extraEnv) => git.run(code, args, [...hardening, ...(config ?? [])], timeoutMs, { ...NO_PROMPT, ...extraEnv }) };
}

