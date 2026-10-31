/**
 * `live-e2e janitor account|repo --target staging [--apply]` (T6a, T6b), and the same janitors as `run` calls them.
 *
 * Dry-run is the default: without `--apply` the command only reads the account and prints what it would set. With
 * `--apply` it writes the spend baseline (account.ts). Either way it first asks the origin who it is (layer 2) and
 * uses the stored `owner` session; a missing session, a refusal or a failed read is `REFUSED <reason>`, exit 1, and
 * nothing is written. Exit codes: 0 done (or nothing to do), 1 refused or failed, 2 usage.
 */
import { join } from "node:path";
import type { Io } from "../cli.js";
import { MaskRegistry, MASK_FILE_ENV } from "../mask.js";
import { BYPASS_ENV } from "../needs.js";
import { FIXTURE_REPO_ENV } from "../needs-network.js";
import { identityGuard, loadTarget, readDeploymentIdentity, TargetError, type Target } from "../targets.js";
import { openOwnerSession, runAccountJanitor, type JanitorResult } from "./account.js";
import { runRepoJanitor } from "./repo.js";
import { runReposJanitor } from "./repos.js";

const USAGE = "usage: live-e2e janitor <account|repo> --target <name> [--apply] | janitor repos --org <name> [--apply]";

/**
 * The fixture-repo janitor (T6b) once, for `janitor repo` and for `run`. It talks to GitHub only (never the app), so
 * there is no layer 2 or session here. Exit code: 0 done or `SKIPPED-NEED test-repo`, 1 refused, 2 usage.
 */
export async function repoJanitorOnce(io: Io, target: string, apply: boolean): Promise<number> {
  const result = await runRepoJanitor({ target, env: io.env, apply, say: io.stdout, ...(io.githubCa !== undefined ? { ca: io.githubCa } : {}) });
  if (result.status === "skipped") io.stdout(result.need);
  if (result.status === "usage") io.stderr(result.message);
  if (result.status === "refused") io.stderr(describeRefusal(result));
  return result.status === "usage" ? 2 : result.status === "refused" ? 1 : 0;
}

/** One janitor run for `target`: layer 2, the owner session, the janitor, then the cookie write-back. */
export async function janitorOnce(io: Io, target: Target, apply: boolean): Promise<JanitorResult | { ok: false; reason: string; detail?: string; written: number }> {
  // Staging only, decided before any request: the production origin is not even asked who it is.
  if (target.name !== "staging") return { ok: false, reason: "janitor-not-staging", written: 0 };
  const bypass = target.protected ? io.env[BYPASS_ENV] : undefined;
  const refusal = identityGuard(await readDeploymentIdentity(target, bypass, io.fetch), target);
  if (refusal !== null) return { ok: false, reason: refusal, written: 0 };
  const maskFile = io.env[MASK_FILE_ENV];
  // `::add-mask::` lines are for the CI runner to read; at the owner's terminal they would print the cookie into the scrollback.
  const announce = io.env["GITHUB_ACTIONS"] === "true";
  const mask = new MaskRegistry({ emit: announce ? (line) => io.stdout(line) : () => undefined, ...(maskFile ? { file: maskFile } : {}) });
  const owner = await openOwnerSession({
    target,
    targetsDir: join(io.root, "targets"),
    env: io.env,
    now: (io.now ?? Date.now)(),
    mask,
    ...(io.fetch !== undefined ? { fetchImpl: io.fetch } : {}),
  });
  if (owner === null) return { ok: false, reason: "janitor-no-session", detail: "no usable owner session", written: 0 };
  try {
    return await runAccountJanitor({ target, client: owner.session.client, fixtureRepo: io.env[FIXTURE_REPO_ENV], apply, say: io.stdout });
  } finally {
    await owner.commit().catch(() => undefined);
  }
}

export const describeRefusal = (r: { reason: string; detail?: string }): string => `REFUSED ${r.reason}${r.detail === undefined ? "" : ` (${r.detail})`}`;

/** `janitor repos --org <name> [--apply]` (D#441 C2, D1): GitHub through `gh` only, no target and no app session. Exit 0 done, 1 refused, 2 usage (org missing or malformed included). */
async function reposCommand(rest: string[], io: Io): Promise<number> {
  let org: string | undefined;
  let apply = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--apply" && !apply) apply = true;
    else if (rest[i] === "--org" && org === undefined && rest[i + 1] !== undefined && !(rest[i + 1] as string).startsWith("--")) org = rest[(i += 1)];
    else {
      io.stderr(USAGE);
      return 2;
    }
  }
  const result = await runReposJanitor({ org, apply, env: io.env, now: (io.now ?? Date.now)(), say: io.stdout, ...(io.gh !== undefined ? { gh: io.gh } : {}), ...(io.confirm !== undefined ? { confirm: io.confirm } : {}) });
  if (result.status === "done") return 0;
  io.stderr(describeRefusal(result));
  return result.reason === "janitor-repos-org-missing" || result.reason === "janitor-repos-org-malformed" ? 2 : 1;
}

export async function janitorCommand(argv: string[], io: Io): Promise<number> {
  const [which, ...rest] = argv;
  if (which === "repos") return reposCommand(rest, io);
  let target: string | undefined;
  let apply = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--apply" && !apply) apply = true;
    else if (flag === "--target" && target === undefined && rest[i + 1] !== undefined && !(rest[i + 1] as string).startsWith("--")) target = rest[(i += 1)];
    else {
      io.stderr(USAGE);
      return 2;
    }
  }
  if ((which !== "account" && which !== "repo") || target === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    const loaded = loadTarget(join(io.root, "targets"), target, io.env);
    if (which === "repo") return await repoJanitorOnce(io, loaded.name, apply);
    const result = await janitorOnce(io, loaded, apply);
    if (!result.ok) {
      io.stderr(describeRefusal(result));
      return 1;
    }
    return 0;
  } catch (err) {
    if (err instanceof TargetError) {
      io.stderr(err.message);
      return 2;
    }
    throw err;
  }
}
