/**
 * D#845 ON-27b: the `twin_seed` handler. It copies the default branch of a public repository, at the commit the signed job names, into the empty private twin the job names, outside every sandbox (no model, no guest, no VM):
 *   twin_fetch -> push
 * THREAT MODEL. The adversary is the public repository's contents (anyone may have written them) and a hostile or mistaken cloud reply. At risk: the customer's twin and the push credential. So:
 *  - the public repository is read anonymously over https from GitHub only (the address is built from the signed owner and name, never taken from the job as text), into a scratch bare repository of our own made for this
 *    one job, with no token, no hooks (the guard config), no config read from the fetched repository and no tags. Nothing is checked out: no file of it is ever written to a working tree;
 *  - the fetched tip must be the signed `head_sha` (else `twin_head_moved`), and the objects fetched may not pass `TWIN_SEED_MAX_PACK_BYTES` (else `twin_too_large`, under GitHub's 2 GB push limit);
 *  - the credential is the one the cloud hands over for this job (`setupPushToken`, once; the twin's repository alone, `contents: write`). It reaches git only through the environment of the one child (`withCredential`), is revoked in a
 *    `finally`, and is asked for only after the fetch and the size check passed and the push step was reported started;
 *  - the target is the twin's default-branch ref and nothing else: `<head_sha>:refs/heads/<default_branch>`, never forced, with no tags. A twin that already has any branch is `twin_not_empty` and nothing is pushed.
 * Large files: Git LFS objects are not fetched, so LFS pointers are copied as pointers. Failures are closed codes with one reason word, never git's text, a path or an address.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { TWIN_SEED_MAX_PACK_BYTES, type MachineJobOf } from "@fulcrumaxe/runner-protocol";
import type { MachineJobHandler } from "../daemon/machineJobs.js";
import type { RunnerClient } from "../daemon/client.js";
import type { Git } from "../daemon/git.js";
import { githubUrl } from "../daemon/mirror.js";
import { remoteBranchTip } from "../daemon/push.js";
import { withCredential } from "./setupPush.js";

export interface TwinSeedDeps {
  git: Git;
  client: Pick<RunnerClient, "setupPushToken">;
  /** `DELETE /installation/token` with the token as the bearer. True when it is gone; never throws. */
  revoke: (token: string) => Promise<boolean>;
  /** The runner's own directory the per-job scratch repository is made in (absolute). */
  scratchRoot: string;
  /** The address of a repository. Default: GitHub over https. Replaceable so a test can point at a local server (plain http on loopback only, as the other push transports allow). */
  remoteUrl?: (repo: { id: string; owner: string; name: string }) => string;
  /** Longest the fetch may run, in ms. */
  fetchTimeoutMs?: number;
  /** The most the fetched objects may hold. Default `TWIN_SEED_MAX_PACK_BYTES`; lower only for a test. */
  maxPackBytes?: number;
}

const FULL = /^[0-9a-f]{40}$/;
const LOCAL = "refs/fx-twin/head";
class Stop extends Error {
  constructor(readonly sub: "twin_fetch" | "push", readonly code: "twin_head_moved" | "twin_too_large" | "twin_not_empty" | "twin_fetch_failed" | "push_failed", readonly reason: string) {
    super(code);
  }
}

/** The bytes of every object in the scratch repository (loose and packed), as `count-objects -v` counts them in KiB. */
async function storedBytes(git: Git, repo: string): Promise<number> {
  const out = await git.run("mirror_failed", ["-C", repo, "count-objects", "-v"]);
  const kib = (key: string): number => Number(out.match(new RegExp(`^${key}: (\\d+)$`, "m"))?.[1] ?? Number.NaN);
  const total = (kib("size") + kib("size-pack") + kib("size-garbage")) * 1024;
  if (!Number.isFinite(total)) throw new Stop("twin_fetch", "twin_fetch_failed", "size");
  return total;
}

function targetOf(deps: TwinSeedDeps, repo: { id: string; owner: string; name: string }): { url: string; target: URL } {
  const url = (deps.remoteUrl ?? githubUrl)(repo);
  const target = new URL(url);
  // https only; plain http is for a test server on loopback (a replaced `remoteUrl`)
  const loopback = target.hostname === "127.0.0.1" || target.hostname === "localhost";
  if (!(target.protocol === "https:" || (deps.remoteUrl !== undefined && target.protocol === "http:" && loopback)) || target.username !== "" || target.password !== "") throw new Stop("twin_fetch", "twin_fetch_failed", "remote");
  return { url, target };
}

export function createTwinSeedHandler(deps: TwinSeedDeps): MachineJobHandler<"twin_seed"> {
  return async ({ job, reporter, signal }) => {
    const { public: from, private: to } = job.args;
    let token: string | undefined;
    const scratch = path.join(deps.scratchRoot, `twin-seed-${randomBytes(8).toString("hex")}.git`);
    let at: "twin_fetch" | "push" = "twin_fetch";
    try {
      // The schema already refuses a job that does not target the twin; this is the same fence at the point of use.
      if (job.setup_id === undefined || to.gh_id !== job.repo_gh_id || from.gh_id === job.repo_gh_id || !FULL.test(from.head_sha)) throw new Stop("twin_fetch", "push_failed", "target");
      await reporter.report({ sub_step: "twin_fetch", state: "started" });
      const source = targetOf(deps, { id: String(from.gh_id), owner: from.owner, name: from.name });
      await deps.git.run("mirror_failed", ["init", "-q", "--bare", "--", scratch]);
      const anonymous = withCredential(deps.git, undefined, source.target);
      try {
        await anonymous.run("mirror_failed", ["-C", scratch, "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-gc", "--", source.url, `+refs/heads/${from.default_branch}:${LOCAL}`], [["transfer.unpackLimit", "1"]], deps.fetchTimeoutMs);
      } catch {
        // fx-swallow-ok: replaced by one closed code; git's own text can hold the address
        throw new Stop("twin_fetch", "twin_fetch_failed", "fetch");
      }
      if (signal.aborted) return;
      const tip = (await deps.git.run("mirror_failed", ["-C", scratch, "rev-parse", "--verify", `${LOCAL}^{commit}`]).catch(() => "")).trim(); // fx-swallow-ok: no commit is read as a tip that is not the signed one
      if (tip !== from.head_sha) throw new Stop("twin_fetch", "twin_head_moved", "tip");
      if ((await storedBytes(deps.git, scratch)) > Math.min(deps.maxPackBytes ?? TWIN_SEED_MAX_PACK_BYTES, TWIN_SEED_MAX_PACK_BYTES)) throw new Stop("twin_fetch", "twin_too_large", "pack");
      await reporter.report({ sub_step: "twin_fetch", state: "ok" });

      at = "push";
      await reporter.report({ sub_step: "push", state: "started" });
      if (reporter.closed || signal.aborted) return;
      const dest = targetOf(deps, { id: String(to.gh_id), owner: to.owner, name: to.name });
      const got = await deps.client.setupPushToken(job.setup_id, job.job_id);
      if (got.kind !== "token") throw new Stop("push", "push_failed", got.kind === "refused" ? "token_refused" : "token_failed");
      token = got.token;
      const authed = withCredential(deps.git, token, dest.target);
      // An empty twin has no branch at all; one that has any is somebody's work and is not touched.
      const listing = await authed.run("push_failed", ["-C", scratch, "ls-remote", "--heads", "--", dest.url]).catch(() => undefined); // fx-swallow-ok: an unreadable twin is one closed refusal below
      if (listing === undefined) throw new Stop("push", "push_failed", "ls_remote");
      if (listing.trim() !== "") throw new Stop("push", "twin_not_empty", "has_branch");
      try {
        await authed.run("push_failed", ["-C", scratch, "push", "--porcelain", "--no-verify", "--no-follow-tags", "--no-recurse-submodules", "--", dest.url, `${LOCAL}:refs/heads/${from.default_branch}`]);
      } catch {
        // fx-swallow-ok: replaced by closed codes; git's own text can hold the address
        throw new Stop("push", "push_failed", "rejected");
      }
      if ((await remoteBranchTip(authed, scratch, dest.url, from.default_branch).catch(() => undefined)) !== from.head_sha) throw new Stop("push", "push_failed", "not_landed");
      await reporter.report({ sub_step: "push", state: "ok", head_sha: from.head_sha });
    } catch (error) {
      // fx-swallow-ok: a job the cloud already ended has nobody to tell; any other failure is reported below as a closed code
      if (reporter.closed) return;
      const stop = error instanceof Stop ? error : new Stop(at, at === "push" ? "push_failed" : "twin_fetch_failed", "git");
      await reporter.report({ sub_step: stop.sub, state: "failed", failure_code: stop.code, failure_reason: stop.reason });
    } finally {
      if (token !== undefined) await deps.revoke(token).catch(() => false); // fx-swallow-ok: a token that cannot be revoked now lapses at GitHub's own expiry
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}

export type TwinSeedJob = MachineJobOf<"twin_seed">;
