/**
 * Git path A, the cloud-verified path (D#6 R5a-3, correction C27 section 4). The same four steps as path B (`GitPath`), but every network
 * command goes through the cloud's GitHub proxy instead of to GitHub with the user's credentials. The only credential is a ticket the cloud
 * signs for this one run (`POST /api/runner/git-ticket`, valid 5 minutes); the proxy checks it and mints the GitHub token inside its own function.
 *
 *  - One ticket covers one git command: a mirror sync, or one push chunk. Each is asked for fresh, and a ticket older than 240 s is replaced
 *    before the next command (`TICKET_REUSE_MS`).
 *  - The ticket rides in the environment only (`GIT_CONFIG_COUNT`), as an `http.<proxy>/.extraHeader` scoped to the proxy's address. It is never
 *    in argv, in the mirror's config file or in a log. The user's credential helper is emptied for that address, so it is never asked.
 *  - The proxy's address is the one in the ticket reply, used only when this build pins it for the cloud (`PINNED_GIT_PROXIES`). Anything else
 *    is `git_proxy_unpinned`, before any git runs.
 *  - Pushes are cut to fit the proxy's cap (`planChunks`); a commit that cannot fit stops the run with nothing pushed.
 *  - Path A needs a mirror that lasts (C27 section 4.4): a mirrors directory in a temp directory or on tmpfs/ramfs is `path_a_no_mirror`.
 * The mirror's `remote.origin.url` is set on every sync, so one repo's mirror can serve both paths.
 */
import { realpathSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitTicketResult } from "./client.js";
import { assertGitVersion, createGit, GitPathError, type Git, type GitDeps } from "./git.js";
import { PUSHING_ROLES, type GitJob, type GitPath, type GitPathDeps } from "./gitPath.js";
import { createMirrors, githubUrl, type Mirrors, type RepoRef } from "./mirror.js";
import { publishBranch, pushPlan, workspaceHead, type PushLease } from "./push.js";
import { gitProxyHashFor, gitProxyPinned, PINNED_GIT_PROXIES, type PinnedGitProxies } from "../keyring.js";

/** A ticket is not used for a command that starts more than this long after it was made (the proxy accepts it for 300 s). */
export const TICKET_REUSE_MS = 240_000;
/** Linux `statfs` types of memory-backed file systems: tmpfs and ramfs. */
export const MEMORY_FS_TYPES: ReadonlySet<number> = new Set([0x01021994, 0x858458f6]);

export interface GitPathADeps extends Omit<GitDeps, "mapHttp">, Pick<GitPathDeps, "mirrorsRoot" | "stateDir" | "keepClear"> {
  /** The cloud address this runner is registered with (its pinned proxy is looked up by it). */
  cloudOrigin: string;
  /** Asks the cloud for a ticket for this run: the signed client's `gitTicket`. */
  mintTicket: (runId: string, leaseGeneration: number) => Promise<GitTicketResult>;
  /** Default: the build's table. Replaceable by a test only. */
  pinned?: PinnedGitProxies;
  now?: () => number;
  platform: NodeJS.Platform;
  /** Replaceable so a test can answer for tmpfs. */
  statfs?: (target: string) => { type: number };
  tmpDir?: string;
}

/** The deepest existing ancestor of `target`, resolved through links (a mirrors root that is not made yet is judged by where it will be). */
function resolvedAncestor(target: string): string {
  let current = path.resolve(target);
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      // fx-swallow-ok: not made yet; the nearest directory that exists decides
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

const under = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

export function createGitPathA(deps: GitPathADeps): GitPath {
  const git = createGit({ ...deps, mapHttp: true });
  const pinned = deps.pinned ?? PINNED_GIT_PROXIES;
  const now = deps.now ?? Date.now;
  const platform = deps.platform;
  const snapshotsRoot = path.join(deps.stateDir, "git-snapshots");
  // The mirrors are the same directory path B uses; this path only changes what it fetches from and pushes to.
  const forObjects = createMirrors({ git, mirrorsRoot: deps.mirrorsRoot, stateDir: deps.stateDir, ...(deps.keepClear === undefined ? {} : { keepClear: deps.keepClear }) });

  /** Proxy address of a repo: the pinned origin plus the GitHub path, with the owner and name checked again. */
  const proxyUrl = (origin: string, repo: RepoRef): string => `${origin}/api/gh-proxy${new URL(githubUrl(repo)).pathname}`;

  /** Asks for a ticket and turns every way it can fail into a closed code. Pins the proxy before anything else is done with the reply. */
  async function mint(lease: PushLease): Promise<{ ticket: string; origin: string }> {
    const reply = await deps.mintTicket(lease.runId, lease.leaseGeneration);
    if (reply.kind === "stop") throw new GitPathError("git_stopped");
    if (reply.kind === "error") throw new GitPathError(reply.status === 401 ? "git_revoked" : "git_ticket_refused");
    if (!gitProxyPinned(deps.cloudOrigin, reply.proxyOrigin, pinned)) throw new GitPathError("git_proxy_unpinned");
    return { ticket: reply.ticket, origin: reply.proxyOrigin };
  }

  /**
   * A git that carries a fresh ticket (and the repo's proxy address) for one stretch of work. A command that starts after
   * `TICKET_REUSE_MS` gets a new ticket first.
   */
  async function open(job: GitJob, lease: PushLease): Promise<{ git: Git; url: string; mirrors: Mirrors }> {
    let current = await mint(lease);
    let madeAt = now();
    const configOf = (c: { ticket: string; origin: string }): Array<readonly [string, string]> => [
      [`http.${c.origin}/.extraHeader`, `fx-git-ticket: ${c.ticket}`],
      [`credential.${c.origin}/.helper`, ""],
      ["http.followRedirects", "false"],
      ["protocol.version", "2"],
    ];
    const ticketed: Git = {
      async run(code, args, config) {
        if (now() - madeAt > TICKET_REUSE_MS) {
          current = await mint(lease);
          madeAt = now();
        }
        return git.run(code, args, [...configOf(current), ...(config ?? [])]);
      },
    };
    const url = proxyUrl(current.origin, job.repo);
    const mirrors = createMirrors({ git: ticketed, mirrorsRoot: deps.mirrorsRoot, stateDir: deps.stateDir, ...(deps.keepClear === undefined ? {} : { keepClear: deps.keepClear }), remoteUrl: () => url });
    return { git: ticketed, url, mirrors };
  }

  /** Throws `path_a_no_mirror` when the mirrors directory would not outlive the run. Looks at the file system only. */
  function assertPersistentMirrors(): void {
    const real = resolvedAncestor(deps.mirrorsRoot);
    if (under(real, resolvedAncestor(deps.tmpDir ?? tmpdir()))) throw new GitPathError("path_a_no_mirror");
    if (platform === "linux") {
      let type: number;
      try {
        type = (deps.statfs ?? statfsSync)(real).type;
      } catch {
        // fx-swallow-ok: a file system that cannot be asked about is not shown to persist
        throw new GitPathError("path_a_no_mirror");
      }
      if (MEMORY_FS_TYPES.has(type)) throw new GitPathError("path_a_no_mirror");
    }
  }

  return {
    check(job, lease) {
      // Nothing is made and no network is touched: the pin and the mirror location are judged first.
      if (gitProxyHashFor(deps.cloudOrigin, pinned) === undefined) throw new GitPathError("git_proxy_unpinned");
      assertPersistentMirrors();
      if (job.branch_prefix !== "fx/") throw new GitPathError("push_ref_refused");
      pushPlan(lease, job.continues);
    },
    async resume(job, lease, workspace) {
      if (job.continues === null) return null;
      const session = await open(job, lease);
      await assertGitVersion(session.git);
      const { dir, tip } = await session.mirrors.continuationTip(job.repo, job.continues);
      try {
        return (await workspaceHead(session.git, dir, workspace, snapshotsRoot)) === tip ? { base: tip } : null;
      } catch (error) {
        if (error instanceof GitPathError && !["git_stopped", "git_revoked", "clone_limited", "git_proxy_unpinned", "git_ticket_refused"].includes(error.code)) return null;
        throw error;
      }
    },
    async prepare(job, lease, workspace) {
      const session = await open(job, lease);
      await assertGitVersion(session.git);
      return session.mirrors.prepareWorkspace(job.repo, lease, workspace, job.continues);
    },
    readGrants: (job) => [forObjects.objects(job.repo)],
    async publish(job, lease, workspace, base, stopped) {
      if (!PUSHING_ROLES.has(job.role)) return { pushed: false };
      const transport = {
        async open() {
          const session = await open(job, lease);
          return { git: session.git, url: session.url };
        },
      };
      return publishBranch(git, forObjects.dir(job.repo), "", workspace, base, lease, snapshotsRoot, { continues: job.continues, transport, ...(stopped === undefined ? {} : { stopped }) });
    },
  };
}

