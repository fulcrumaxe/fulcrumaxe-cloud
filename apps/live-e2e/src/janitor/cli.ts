/**
 * `live-e2e janitor account --target staging [--apply]` (T6a), and the same janitor as `run` calls it.
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

const USAGE = "usage: live-e2e janitor account --target <name> [--apply]";

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

export async function janitorCommand(argv: string[], io: Io): Promise<number> {
  const [which, ...rest] = argv;
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
  if (which !== "account" || target === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    const result = await janitorOnce(io, loadTarget(join(io.root, "targets"), target, io.env), apply);
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
