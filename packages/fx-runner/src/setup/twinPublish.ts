/**
 * D#845 ON-27c2: the `twin_publish` handler. It sends the change the private twin's default branch has made since the last publish, from the job's `private.base` to its `private.head`, to the twin's PUBLIC repository as ONE commit
 * on the public `main` tip plus one pull request, outside every sandbox (no model, no guest, no VM):
 *   twin_fetch -> push (the route scans, takes the credential, pushes and opens the pull request) -> pr_open
 * THREAT MODEL. The adversaries are a hostile engine (the twin's files are whatever it, prompt-injected, wrote), a stranger on the public repository, and a stale runner. At risk: what the private side holds that must never be
 * public, and the push credential. So:
 *  - the private set (the fixed roots, the person's globs, the install's exact paths, the rule files, the binary allow list) comes ONLY from the signed job. Nothing in the repository chooses it, and the cloud's token route holds it
 *    against the live rows before it hands out a credential (a set edited since the issue mints nothing, `pairing_changed`);
 *  - the commit is built and scanned by D#598's `routeAndPush` in export mode (ON-27c1): private paths are dropped from the change set, every added line is scanned, `secret_shaped` is always on, binary files pass only under the
 *    allow list, and a scan or reader that fails, an overlay that does not compile, a rule file that cannot be read or one the set does not cover each refuse and push nothing;
 *  - the objects come from this runner's own mirror of the private repository into a throwaway bare repository made here (`git init --bare`, no clone, so no remote or user setting can exist in it); the public tip is fetched
 *    anonymously and must be the signed `public.tip`, both when the commit is built and again at push time (else `public_tip_moved`);
 *  - the pull request text is the fixed template (`buildTwinPublishText`) from a count, a date and the published paths. No private title, number or name is an input;
 *  - the credential is the one the cloud hands over for this job (the public repository alone, contents and pull_requests write, once). It reaches the route only as its mint, goes to git through the environment of the one child, and is
 *    revoked in a `finally`. It is asked for only after the commit was built and scanned, and the push step was reported started;
 *  - nothing is forced: a branch that exists is `branch_exists`. Failures are closed codes with one reason word, never git's text, a path or an address.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { buildTwinPublishText, twinPrivateOverlay, type MachineJobOf } from "@fulcrumaxe/runner-protocol";
import {
  PLANE_REFUSAL_CODES,
  PlaneRouteError,
  compileOverlay,
  planePushGit,
  routeAndPush,
  type PlaneRefusalCode,
  type PublicApi,
  type PublicGitTransport,
  type RepoPairing,
} from "@fulcrumaxe/runner-protocol/planePush";
import type { MachineJobHandler } from "../daemon/machineJobs.js";
import type { RunnerClient } from "../daemon/client.js";
import type { Mirrors } from "../daemon/mirror.js";
import type { PlanePushGithub } from "../daemon/planePushGithub.js";

export interface TwinPublishDeps {
  mirrors: Pick<Mirrors, "sync">;
  client: Pick<RunnerClient, "setupPushToken">;
  github: Pick<PlanePushGithub, "branchExists" | "branchHead" | "openPullRequest" | "deleteBranch" | "revokeToken">;
  /** The public repository's `main` tip and the push. Production: `createGitTransport()`. */
  transport: PublicGitTransport;
  /** A directory in the runner's own state where the throwaway repositories are built (absolute; made 0700). */
  workRoot: string;
  now?: () => Date;
}

/** The platform's commit identity on the public commit. A fixed one: nothing of the private side (an author, a committer, an address) is ever copied. */
export const TWIN_PUBLISH_IDENTITY = { name: "fulcrumaxe publisher", email: "publisher@noreply.invalid" } as const;
const WORD = /^[a-z][a-z0-9_]{0,31}$/;
const FULL = /^[0-9a-f]{40}$/;

/** Thrown inside the handler for one closed refusal. */
class Stop extends Error {
  constructor(readonly sub: "twin_fetch" | "push" | "pr_open", readonly code: PlaneRefusalCode | "twin_fetch_failed", readonly reason?: string) {
    super(code);
  }
}
const coded = (code: PlaneRefusalCode, message: string): PlaneRouteError => new PlaneRouteError(code, message);

/** The work root, made 0700 or checked to be: a real directory (never a link), closed to group and others. */
function ensureRoot(root: string): void {
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
    mkdirSync(root, { recursive: true, mode: 0o700 });
    stat = lstatSync(root);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("work_root_insecure");
  if ((stat.mode & 0o077) !== 0) {
    chmodSync(root, 0o700);
    if ((lstatSync(root).mode & 0o077) !== 0) throw new Error("work_root_insecure");
  }
}

/** The pairing the route reads, from the signed job alone. Both reads of it (the route's two) are this one object: the live comparison is the cloud's, at the token route. */
export function pairingOf(job: MachineJobOf<"twin_publish">): RepoPairing & { enabled: true; codeRepo: string } {
  const set = job.args.private_set;
  return {
    enabled: true,
    codeRepo: `${job.args.public.owner}/${job.args.public.name}`,
    overlayGlobs: twinPrivateOverlay({ overlayGlobs: set.overlay_globs, installPaths: set.install_paths }),
    identifierRulesPath: set.identifier_rules_path,
    planDataRulesPath: set.plan_data_rules_path,
    binaryGlobs: [...set.blob_globs],
  };
}

export function createTwinPublishHandler(deps: TwinPublishDeps): MachineJobHandler<"twin_publish"> {
  const now = deps.now ?? ((): Date => new Date());
  return async ({ job, reporter, signal }) => {
    const { public: pub, private: prv } = job.args;
    let token: string | undefined;
    let work: string | undefined;
    let at: "twin_fetch" | "push" | "pr_open" = "twin_fetch";
    try {
      // The schema already refuses a job that is not homed on the twin; this is the same fence at the point of use.
      if (job.setup_id === undefined || prv.gh_id !== job.repo_gh_id || pub.gh_id === job.repo_gh_id || !FULL.test(prv.base) || !FULL.test(prv.head) || !FULL.test(pub.tip)) throw new Stop("twin_fetch", "bad_input", "target");
      await reporter.report({ sub_step: "twin_fetch", state: "started" });
      ensureRoot(deps.workRoot);
      work = mkdtempSync(path.join(deps.workRoot, "tp-"));
      let mirrorDir: string;
      try {
        mirrorDir = (await deps.mirrors.sync({ id: String(prv.gh_id), owner: prv.owner, name: prv.name })).dir;
        await planePushGit(work, ["init", "--bare", "--quiet", "--template="]);
        await planePushGit(
          work,
          ["-c", "transfer.fsckObjects=true", "fetch", "--no-tags", "--quiet", "--no-write-fetch-head", "--upload-pack=git upload-pack --strict", mirrorDir, `${prv.head}:refs/fx/head`, `${prv.base}:refs/fx/base`],
          undefined,
          { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "uploadpack.allowAnySHA1InWant", GIT_CONFIG_VALUE_0: "true" },
        );
      } catch {
        // fx-swallow-ok: replaced by one closed code; the tool's own text can carry a path
        throw new Stop("twin_fetch", "twin_fetch_failed", "mirror");
      }
      if (signal.aborted) return;
      try {
        await planePushGit(work, ["merge-base", "--is-ancestor", "refs/fx/base", "refs/fx/head"]);
      } catch {
        // fx-swallow-ok: replaced by the closed refusal
        throw new Stop("twin_fetch", "base_not_ancestor", "base");
      }
      const pairing = pairingOf(job);
      // The text is made from what is published: the paths the change touches outside the private set. An overlay that does not compile refuses here, as it does in the route.
      const overlay = compileOverlay(pairing.overlayGlobs);
      if ("error" in overlay) throw new Stop("twin_fetch", "scan_refused", "overlay_invalid");
      const names = (await planePushGit(work, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "refs/fx/base", "refs/fx/head", "--"])).toString("utf8").split("\0").filter((p) => p !== "");
      const commits = Number((await planePushGit(work, ["rev-list", "--count", "--first-parent", "refs/fx/base..refs/fx/head"])).toString("utf8").trim());
      if (!Number.isSafeInteger(commits) || commits < 1) throw new Stop("twin_fetch", "bad_input", "range");
      const text = buildTwinPublishText({ commits, date: job.issued_at.slice(0, 10), paths: names.filter((p) => !overlay.match(p)) });
      await reporter.report({ sub_step: "twin_fetch", state: "ok" });

      at = "push";
      await reporter.report({ sub_step: "push", state: "started" });
      if (reporter.closed || signal.aborted) return;
      const api: PublicApi = {
        // The route asks for its credential after the commit was built and scanned: that is when the cloud's token route is asked, once.
        async mintPushToken(codeRepo) {
          if (codeRepo.toLowerCase() !== pairing.codeRepo.toLowerCase()) throw Object.assign(new Error("token_scope_mismatch"), { code: "token_scope_mismatch" });
          const got = await deps.client.setupPushToken(job.setup_id as string, job.job_id);
          if (got.kind !== "token") {
            const refused = got.kind === "refused" ? got.code : undefined;
            const code = refused === "pairing_changed" || refused === "app_not_installed" || refused === "token_scope_mismatch" ? refused : "public_unavailable";
            throw Object.assign(new Error(code), { code });
          }
          token = got.token;
          return got.token;
        },
        branchExists: (i) => deps.github.branchExists(i),
        branchHead: (i) => deps.github.branchHead(i),
        openPullRequest: (i) => deps.github.openPullRequest(i),
      };
      // The public tip is the signed one, when the commit is built and again at push time.
      const transport: PublicGitTransport = {
        async fetchTip(dir, codeRepo) {
          const fetched = await deps.transport.fetchTip(dir, codeRepo);
          if (fetched !== pub.tip) throw coded("public_tip_moved", "the public repo's main is not the tip this job was issued against");
          return fetched;
        },
        push: (i) => deps.transport.push(i),
      };
      const result = await routeAndPush(
        {
          repoDir: work, privateBase: prv.base, privateHead: prv.head, privateDefaultTip: prv.head, own: { owner: prv.owner, name: prv.name }, defaultBranch: "main", branch: job.args.branch,
          title: text.title, body: text.body, identity: TWIN_PUBLISH_IDENTITY, commitTime: Math.floor(now().getTime() / 1000), mode: "export",
        },
        { loadPairing: async () => pairing, loadOwn: async () => ({ owner: prv.owner, name: prv.name }), api, transport },
      );
      if (result.plane !== "paired") throw new Stop("push", "bad_input", "plane");
      await reporter.report({ sub_step: "push", state: "ok", head_sha: result.commit });
      at = "pr_open";
      await reporter.report({ sub_step: "pr_open", state: "ok" });
    } catch (error) {
      // fx-swallow-ok: a job the cloud already ended has nobody to tell; any other failure is reported below as a closed code
      if (reporter.closed) return;
      let stop: Stop;
      if (error instanceof Stop) stop = error;
      else if (error instanceof PlaneRouteError) {
        // A branch that was pushed and has no pull request is reported on the pull request's step, so the cloud can tell it from a refusal that pushed nothing.
        const first = error.refusals[0]?.kind;
        let reason: string | undefined = first !== undefined && WORD.test(first) ? first : undefined;
        // The branch the pull request could not be opened for is ours alone (it did not exist before this push) and a later publish of the same head names it again, so it is removed, but only while it is still the
        // commit we pushed. Left behind it would make every retry `branch_exists`. The reason word says which it was.
        if (error.code === "pr_failed" && error.pushed && error.commit !== null && token !== undefined) {
          const input = { codeRepo: pairingOf(job).codeRepo, branch: job.args.branch, token };
          let gone = false;
          try {
            gone = (await deps.github.branchHead(input)) === error.commit && (await deps.github.deleteBranch(input));
          } catch {
            // fx-swallow-ok: a head that could not be read leaves the branch where it is, which the reason word below says
          }
          reason = gone ? "branch_deleted" : "branch_kept";
        }
        stop = new Stop(error.code === "pr_failed" ? "pr_open" : at, error.code, reason);
      } else {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        stop = new Stop(at, typeof code === "string" && (PLANE_REFUSAL_CODES as readonly string[]).includes(code) ? (code as PlaneRefusalCode) : at === "twin_fetch" ? "twin_fetch_failed" : "push_failed");
      }
      await reporter.report({ sub_step: stop.sub, state: "failed", failure_code: stop.code, ...(stop.reason === undefined ? {} : { failure_reason: stop.reason }) });
    } finally {
      if (token !== undefined) await deps.github.revokeToken(token); // never throws; a token that cannot be revoked now lapses at GitHub's own expiry
      if (work !== undefined) rmSync(work, { recursive: true, force: true });
    }
  };
}
