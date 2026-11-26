import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { MACHINE_JOB_MAX_LIFE_S, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { engineTarballUrl } from "./setupJobs.js";

/**
 * D#845 ON-15a: POST /api/v1/engine/repos/:id/update. An owner or admin on a session (no token) asks for the installed project's engine to be brought to the newest release its machine can run.
 *
 * `readEngineBehind` is the behind-read (the card of ON-15d uses it too): the installed setup's `engine_version` against the newest published release (`withdrawn_at IS NULL`, `min_runner_protocol` at most the
 * placed machine's, MAJOR.MINOR.PATCH), compared number by number. Nothing is behind when the version is unknown or the newest release is not newer. Every query names the account itself on top of row security.
 * The signed job is built from that read; the definer `engine_update_issue` (migration 1093) re-reads it under the repo's lock, so a release published or withdrawn in between is 409 `setup_changed`, and writes
 * the update and the job together. 200 `{update_id, job_id, attempt, from_version, to_version, branch}`.
 * Refusals: 403 `forbidden`, 404 `not_found` (no installed project of this repo, any foreign id included), 409 `setup_not_placed` | `not_behind` | `update_live` | `setup_changed`, 503 `not_configured`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = String.raw`^\d{1,6}\.\d{1,6}\.\d{1,6}$`;
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);
const newer = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! > y![i]!;
  return false;
};

export interface EngineBehind {
  setupId: string;
  repo: { ghRepoId: number };
  runnerId: string | null;
  from: string | null;
  release: { version: string; commit_sha: string; tarball_sha256: string } | null;
  /** True when a release newer than the installed one can run on the placed machine. */
  behind: boolean;
}

/** The behind-read of an installed repo; null when the repo has no installed (phase `done`) setup in this account. */
export async function readEngineBehind(client: PoolClient, accountId: string, repoId: string): Promise<EngineBehind | null> {
  const s = (
    await client.query<{ id: string; engine_version: string | null; runner_id: string | null; protocol_version: number | null; gh_repo_id: string }>(
      `SELECT s.id, s.engine_version, pl.runner_id, rn.protocol_version, r.gh_repo_id FROM project_setups s
         JOIN repos r ON r.account_id = s.account_id AND r.id = s.repo_id
         LEFT JOIN project_placements pl ON pl.account_id = s.account_id AND pl.repo_id = s.repo_id
         LEFT JOIN runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL
        WHERE s.account_id = $1 AND s.repo_id = $2 AND s.phase = 'done'`,
      [accountId, repoId],
    )
  ).rows[0];
  if (!s) return null;
  const release =
    s.protocol_version === null
      ? null
      : (
          await client.query<NonNullable<EngineBehind["release"]>>(
            `SELECT version, commit_sha, tarball_sha256 FROM engine_releases
              WHERE withdrawn_at IS NULL AND min_runner_protocol <= $1 AND version ~ '${VERSION}' ORDER BY published_at DESC, id DESC LIMIT 1`,
            [s.protocol_version],
          )
        ).rows[0] ?? null;
  const from = s.engine_version !== null && new RegExp(VERSION).test(s.engine_version) ? s.engine_version : null;
  return { setupId: s.id, repo: { ghRepoId: Number(s.gh_repo_id) }, runnerId: s.runner_id && s.protocol_version !== null ? s.runner_id : null, from, release, behind: release !== null && from !== null && newer(release.version, from) };
}

/**
 * D#845 ON-15d: what the Team app's update card shows for one repo of the list. `null` for a repo with no installed project. `behind` is the version pair the card offers (only while nothing is under way and the project is on a
 * machine, so the button cannot meet `setup_not_placed`); `update` is the repo's newest update while it is under way, or after it failed while the project is still behind (a done update, or a failure the engine has since
 * outgrown, is nothing to show). Nothing is stamped: a later update, or a later release, changes it by itself. Only closed fields leave: no ids, no text a runner wrote.
 */
export interface EngineUpdateCard {
  behind: { from: string; to: string } | null;
  update: { from_version: string; to_version: string; phase: string; sub_step: string | null; state: string; failure_code: string | null; pr: number | null } | null;
}
export async function readEngineUpdateCard(client: PoolClient, accountId: string, repoId: string): Promise<EngineUpdateCard | null> {
  const seen = await readEngineBehind(client, accountId, repoId);
  if (seen === null) return null;
  const newest = (
    await client.query<NonNullable<EngineUpdateCard["update"]>>(
      `SELECT from_version, to_version, phase, sub_step, state, failure_code, pr FROM engine_updates WHERE account_id = $1 AND repo_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [accountId, repoId],
    )
  ).rows[0];
  const live = newest !== undefined && newest.phase !== "done" && newest.phase !== "failed";
  const shown = newest !== undefined && (live || (newest.phase === "failed" && seen.behind)) ? newest : null;
  return { behind: !live && seen.behind && seen.from !== null && seen.release !== null && seen.runnerId !== null ? { from: seen.from, to: seen.release.version } : null, update: shown };
}

export interface IssuedEngineUpdate { update_id: string; job_id: string; attempt: number; from_version: string; to_version: string; branch: string }

export async function updateEngine(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw refuse(404, "not_found", "no such repository");
  const signer = (await deps.engineCommandSigner?.()) ?? null;
  if (signer?.signMachineJob === undefined) throw refuse(503, "not_configured", "the cloud cannot issue an engine update now");
  const repo = repoId.toLowerCase();
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => withTenant(deps.appUserPool, principal.accountId, principal.userId, fn);
  const read = await tenant(async (client) => {
    const role = await requireMemberRole(client);
    if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can update the engine");
    const seen = await readEngineBehind(client, principal.accountId, repo);
    if (seen === null) throw refuse(404, "not_found", "no such installed project");
    if (seen.runnerId === null) throw refuse(409, "setup_not_placed", "the project is not placed on a machine");
    const live = await client.query("SELECT 1 FROM engine_updates WHERE account_id = $1 AND repo_id = $2 AND phase NOT IN ('done', 'failed')", [principal.accountId, repo]);
    if (live.rows.length > 0) throw refuse(409, "update_live", "an update of this project is already under way");
    if (!seen.behind || seen.release === null || seen.from === null) throw refuse(409, "not_behind", "the engine is up to date");
    return { ...seen, runnerId: seen.runnerId, release: seen.release, from: seen.from };
  });
  const issued = (deps.now ?? (() => new Date()))();
  const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
  const [updateId, jobId] = [randomUUID(), randomUUID()];
  const branch = `fx/engine-update-${read.release.version}`;
  const signed = signer.signMachineJob({
    v: 1, job_id: jobId, runner_id: read.runnerId, repo_gh_id: read.repo.ghRepoId, setup_id: read.setupId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "engine_update",
    args: { engine: { version: read.release.version, commit_sha: read.release.commit_sha, tarball_url: engineTarballUrl(read.release.commit_sha), tarball_sha256: read.release.tarball_sha256 }, branch },
  } as MachineJob);
  let result: { o_result: string; o_attempt: number | null };
  try {
    result = await tenant(async (client) =>
      (await client.query<{ o_result: string; o_attempt: number | null }>("SELECT o_result, o_attempt FROM engine_update_issue($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6, $7)", [updateId, jobId, repo, read.setupId, JSON.stringify(signed), issued, expires])).rows[0]!,
    );
  } catch (error) {
    if (pgCode(error) === "42501") throw refuse(403, "forbidden", "only an owner or admin can update the engine");
    throw error;
  }
  const refusals: Record<string, [number, string, string]> = {
    not_found: [404, "not_found", "no such installed project"],
    not_placed: [409, "setup_not_placed", "the project is not placed on a machine"],
    not_behind: [409, "not_behind", "the engine is up to date"],
    update_live: [409, "update_live", "an update of this project is already under way"],
    setup_changed: [409, "setup_changed", "the releases changed while the job was made; try again"],
  };
  if (result.o_result !== "ok" || result.o_attempt === null) {
    const [status, code, message] = refusals[result.o_result] ?? [409, "setup_changed", "try again"];
    throw refuse(status, code, message);
  }
  const body: IssuedEngineUpdate = { update_id: updateId, job_id: jobId, attempt: result.o_attempt, from_version: read.from, to_version: read.release.version, branch };
  return { status: 200, body, headers: { "cache-control": "no-store" } };
}
