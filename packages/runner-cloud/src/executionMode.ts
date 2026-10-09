import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { COPY } from "@fulcrumaxe/runner-protocol";
import { humanMergeOnly } from "@fx/db/src/humanMergeOnly.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { isRunnerMode, recordRunStatusMove, type FailureReason } from "@fx/runner";
import { setAsideSandboxAllowances } from "./sandboxAllowances.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

/** The sha256 of the Local auto-merge string the server ships. A client proves it showed this wording by sending it back. */
export const LOCAL_AUTO_MERGE_COPY_SHA256 = createHash("sha256").update(COPY.localAutoMerge, "utf8").digest("hex");

/** What a repo's visibility read can say. Anything that is not a clear "private" is not enough to put a repo on a runner. */
export type RepoVisibilityAnswer = "private" | "public" | "unknown";

export const SETTABLE_MODES = ["sandbox", "runner_local"] as const;
type SettableMode = (typeof SETTABLE_MODES)[number];

type Parsed = { kind: "mode"; mode: SettableMode; confirmRepo: unknown } | { kind: "auto_merge_on"; confirmRepo: unknown; copySha256: unknown } | { kind: "auto_merge_off" };

function parseBody(body: unknown): Parsed {
  const bad = (): never => {
    throw new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
  };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad();
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b).sort().join(",");
  if ("mode" in b) {
    if (keys !== "confirm_repo,mode" && keys !== "mode") return bad();
    if (b.mode === "runner_verified") throw new RunnerHttpError(400, "mode_not_available", "that mode is not available yet");
    if (b.mode !== "sandbox" && b.mode !== "runner_local") return bad();
    return { kind: "mode", mode: b.mode, confirmRepo: b.confirm_repo };
  }
  if (b.auto_merge === true) {
    if (keys !== "auto_merge,confirm_repo,copy_sha256" && keys !== "auto_merge" && keys !== "auto_merge,confirm_repo" && keys !== "auto_merge,copy_sha256") return bad();
    return { kind: "auto_merge_on", confirmRepo: b.confirm_repo, copySha256: b.copy_sha256 };
  }
  if (b.auto_merge === false) {
    if (keys !== "auto_merge") return bad();
    return { kind: "auto_merge_off" };
  }
  return bad();
}

interface RepoRow {
  execution_mode: SettableMode;
  gh_owner: string | null;
  gh_name: string | null;
  auto_merge: boolean;
  gh_repo_id: string | null;
}

async function loadRepo(client: PoolClient, repoId: string): Promise<RepoRow> {
  const { rows } = await client.query<RepoRow>(
    `SELECT r.execution_mode, r.gh_owner, r.gh_name, r.gh_repo_id,
            EXISTS (SELECT 1 FROM repo_local_review_optins o WHERE o.account_id = r.account_id AND o.repo_id = r.id) AS auto_merge
       FROM repos r WHERE r.id = $1 FOR UPDATE OF r`,
    [repoId],
  );
  if (!rows[0]) throw new RunnerHttpError(404, "not_found", "no such repository");
  return rows[0];
}

/** The repository's own full name, typed back by the user. Exact, case-sensitive, untrimmed; a repo with no stored name can never match. */
function confirmed(repo: RepoRow, typed: unknown): void {
  const full = repo.gh_owner && repo.gh_name ? `${repo.gh_owner}/${repo.gh_name}` : null;
  if (full === null || typeof typed !== "string" || typed !== full) {
    throw new RunnerHttpError(400, "confirmation_mismatch", "type the repository's full name to confirm");
  }
}

async function requireOwnerOrAdmin(client: PoolClient): Promise<void> {
  const role = (await client.query<{ role: string | null }>("SELECT current_member_role() AS role")).rows[0]?.role;
  if (role !== "owner" && role !== "admin") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can change this");
}

const state = (repo: { execution_mode: string }, autoMerge: boolean): RunnerHttpResponse["body"] => ({ execution_mode: repo.execution_mode, auto_merge: autoMerge });

/** The reason a queued runner run is cancelled with when its repo leaves `runner_local` (a member of `FailureReason`). */
const CANCEL_REASON: FailureReason = "execution_mode_changed";

/**
 * POST /api/runners/repos/:id/execution-mode (a session route, owner or admin only; a member gets 403).
 *
 * Three bodies, strict (an unknown key is 400):
 *  - `{ mode, confirm_repo }`: move the repo between `sandbox` and `runner_local`. It changes where the code goes, so
 *    the repo's own full name must be typed back and matches exactly (400 `confirmation_mismatch`, nothing written).
 *    `runner_verified` is refused until it exists. A public repo, or one whose visibility cannot be read, is never put
 *    on a runner (409). Leaving `runner_local` turns the auto-merge opt-in off in the same transaction (the opt-in's
 *    foreign key requires it), so a repo that comes back starts with it off. It sets the repo's approved sandbox allowances aside too (R7a),
 *    for the same reason. It also cancels every pending runner run of the
 *    repo in the same transaction (correction C24 section 2; `repo_cancel_pending_runner_runs`, 0759): queued runs, jobless ones
 *    and follow-ups waiting on `claimable_after`, with the failure reason `execution_mode_changed`. Running runs are left
 *    alone, and coming back to `runner_local` restores nothing. The reply's `cancelled_runs` is how many were cancelled (0 when
 *    none, and on every other body); the one audit row records the same number.
 *  - `{ auto_merge: true, confirm_repo, copy_sha256 }`: turn the opt-in on (correction C14 section 2). The name must
 *    match, and `copy_sha256` must be the hash of the Local auto-merge wording this server ships (409 `copy_changed`,
 *    nothing written), which shows the client displayed it. The repo must be on a runner (409). The definer writes the
 *    audit row, with the hash.
 *  - `{ auto_merge: false }`: turn it off. The safe direction, so no name is asked; the definer still audits it.
 * Every refusal happens before any write, and the writes of one request share one transaction.
 */
export async function setExecutionMode(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, body: unknown): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw new RunnerHttpError(404, "not_found", "no such repository");
  const parsed = parseBody(body);
  const run = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      await requireOwnerOrAdmin(client);
      return fn(client);
    });

  try {
    if (parsed.kind === "auto_merge_off") {
      return await respond(
        await run(async (client) => {
          const repo = await loadRepo(client, repoId);
          const changed = (await client.query<{ changed: boolean }>("SELECT repo_local_review_optin_set($1, false) AS changed", [repoId])).rows[0]?.changed === true;
          return { repo, autoMerge: false, changed };
        }),
      );
    }

    if (parsed.kind === "auto_merge_on") {
      // D#6 M1G-a: the operator's lock. Checked first, before the wording and the typed name, and nothing is written.
      await run(async (client) => {
        if (humanMergeOnly((await loadRepo(client, repoId)).gh_repo_id)) throw new RunnerHttpError(409, "human_merge_only", "a person merges every pull request in this repository");
      });
      if (typeof parsed.copySha256 !== "string" || !SHA256.test(parsed.copySha256) || parsed.copySha256 !== LOCAL_AUTO_MERGE_COPY_SHA256) {
        // Checked after the name, so a wrong name is always the first thing reported.
        await run(async (client) => confirmed(await loadRepo(client, repoId), parsed.confirmRepo));
        throw new RunnerHttpError(409, "copy_changed", "the wording changed; reload and confirm again");
      }
      return await respond(
        await run(async (client) => {
          const repo = await loadRepo(client, repoId);
          confirmed(repo, parsed.confirmRepo);
          if (repo.execution_mode !== "runner_local") throw new RunnerHttpError(409, "not_runner_local", "auto-merge is for repositories on a runner");
          const changed = (await client.query<{ changed: boolean }>("SELECT repo_local_review_optin_set($1, true, $2) AS changed", [repoId, parsed.copySha256])).rows[0]?.changed === true;
          return { repo, autoMerge: true, changed };
        }),
      );
    }

    // A mode change. The visibility read goes to GitHub, so it happens between two short transactions, and the second
    // locks the repo and checks everything again.
    const first = await run(async (client) => {
      const repo = await loadRepo(client, repoId);
      confirmed(repo, parsed.confirmRepo);
      return repo;
    });
    if (parsed.mode === "runner_local" && first.execution_mode !== "runner_local") {
      const seen = await readVisibility(deps, principal.accountId, repoId);
      if (seen === "public") throw new RunnerHttpError(409, "public_repo", "a public repository cannot run on a runner");
      if (seen !== "private") throw new RunnerHttpError(409, "repo_visibility_unknown", "the repository's visibility could not be read");
    }
    return await respond(
      await run(async (client) => {
        const repo = await loadRepo(client, repoId);
        confirmed(repo, parsed.confirmRepo);
        if (repo.execution_mode === parsed.mode) return { repo, autoMerge: repo.auto_merge, changed: false };
        let autoMergeOff = false;
        if (repo.execution_mode === "runner_local") {
          autoMergeOff = (await client.query<{ changed: boolean }>("SELECT repo_local_review_optin_set($1, false) AS changed", [repoId])).rows[0]?.changed === true;
        }
        await client.query("UPDATE repos SET execution_mode = $2, updated_at = now() WHERE id = $1", [repoId, parsed.mode]);
        // Leaving the runner modes (to sandbox) ends the repo's queued runner runs with it. The definer moves them (the web tier's login cannot write
        // a run's status) and answers their ids; the events are written here, by the code every status change uses, in this transaction.
        let cancelled = 0;
        // D#6 R5b-1 (C26 section 3, C38): only a move that LEAVES the runner modes ends the queued runs. runner_local <-> runner_verified cancels nothing.
        if (repo.execution_mode === "runner_local") {
          // The allowance set-aside stays runner_local-only: it keys on the old mode being runner_local, whatever the new one is.
          // D#6 R7a (C15 section 4): the repo's approved sandbox allowances are set aside, so a repo that comes back is approved again first.
          await setAsideSandboxAllowances(client, repoId);
        }
        if (isRunnerMode(repo.execution_mode) && !isRunnerMode(parsed.mode)) {
          const { rows: moved } = await client.query<{ run_id: string }>("SELECT run_id FROM repo_cancel_pending_runner_runs($1)", [repoId]);
          for (const run of moved) {
            await recordRunStatusMove(client, { accountId: principal.accountId, runId: run.run_id, from: "pending", to: "cancelled", failureReason: CANCEL_REASON });
          }
          cancelled = moved.length;
        }
        await client.query("SELECT repo_execution_mode_switch_audit($1, $2, $3, $4, $5)", [repoId, repo.execution_mode, parsed.mode, autoMergeOff, cancelled]);
        return { repo: { ...repo, execution_mode: parsed.mode }, autoMerge: false, changed: true, cancelledRuns: cancelled };
      }),
    );
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    switch (pgCode(error)) {
      case "42501":
        throw new RunnerHttpError(403, "forbidden", "only an owner or admin can change this");
      case "P0002":
        throw new RunnerHttpError(404, "not_found", "no such repository");
      case "55000":
        throw new RunnerHttpError(409, "not_runner_local", "auto-merge is for repositories on a runner");
      default:
        throw error;
    }
  }
}

function respond(done: { repo: { execution_mode: string }; autoMerge: boolean; changed: boolean; cancelledRuns?: number }): RunnerHttpResponse {
  return { status: 200, body: { ...(state(done.repo, done.autoMerge) as object), changed: done.changed, cancelled_runs: done.cancelledRuns ?? 0 }, headers: { "cache-control": "no-store" } };
}

async function readVisibility(deps: RunnerCloudDeps, accountId: string, repoId: string): Promise<RepoVisibilityAnswer> {
  try {
    return (await deps.repoVisibility?.(accountId, repoId)) ?? "unknown";
  } catch {
    // fx-swallow-ok: a failed read is "unknown", which refuses (409 repo_visibility_unknown)
    return "unknown";
  }
}
