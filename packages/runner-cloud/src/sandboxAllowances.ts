import type { PoolClient } from "pg";
import { MAX_ALLOWANCE_ENTRIES, MAX_COMMAND_TIMEOUT_S, allowanceSetSha256, parseAllowanceSet } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RepoRow {
  execution_mode: string;
  gh_owner: string | null;
  gh_name: string | null;
}

interface StoredRow {
  version: number;
  entries: unknown[];
  command_timeout_s: number | null;
  set_sha256: string;
  set_aside: boolean;
  created_at: Date;
}

/** `lock` takes the row lock the mode switch takes, so a write's mode check and its append are one step against a switch (a read does not lock). */
async function loadRepo(client: PoolClient, repoId: string, lock = false): Promise<RepoRow> {
  const { rows } = await client.query<RepoRow>(`SELECT execution_mode, gh_owner, gh_name FROM repos WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [repoId]);
  if (!rows[0]) throw new RunnerHttpError(404, "not_found", "no such repository");
  return rows[0];
}

/** The newest row, which is the one in force (or set aside). Nothing is read from the repository: only what an admin approved is here. */
async function loadLatest(client: PoolClient, repoId: string): Promise<StoredRow | null> {
  const { rows } = await client.query<StoredRow>(
    "SELECT version, entries, command_timeout_s, set_sha256, set_aside, created_at FROM repo_runner_sandbox_allowances WHERE repo_id = $1 ORDER BY version DESC LIMIT 1",
    [repoId],
  );
  return rows[0] ?? null;
}

function view(repoId: string, repo: RepoRow, latest: StoredRow | null, canChange: boolean): RunnerHttpResponse["body"] {
  const inForce = latest !== null && !latest.set_aside && latest.entries.length > 0;
  return {
    repo_id: repoId,
    execution_mode: repo.execution_mode,
    // The set is signed into a job only while the repo runs on a runner and the newest approval was not set aside.
    in_use: inForce && repo.execution_mode === "runner_local",
    set_aside: latest?.set_aside === true,
    approved:
      latest === null
        ? null
        : { version: latest.version, entries: latest.entries, command_timeout_s: latest.command_timeout_s, set_sha256: latest.set_sha256, approved_at: latest.created_at.toISOString() },
    can_change: canChange,
    limits: { max_entries: MAX_ALLOWANCE_ENTRIES, max_command_timeout_s: MAX_COMMAND_TIMEOUT_S },
  };
}

const ok = (body: RunnerHttpResponse["body"]): RunnerHttpResponse => ({ status: 200, body, headers: { "cache-control": "no-store" } });

/**
 * GET /api/runners/repos/:id/sandbox-allowances (a session route, any member; read-only for a member). The set an owner or admin last approved
 * for the repo, with its hash, version and time, whether it is in use (the repo is on a runner and the approval was not set aside) and whether
 * the caller may change it. `approved` is null when none was ever approved.
 */
export async function getSandboxAllowances(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw new RunnerHttpError(404, "not_found", "no such repository");
  return ok(
    await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
      const role = await requireMemberRole(client);
      const repo = await loadRepo(client, repoId);
      return view(repoId, repo, await loadLatest(client, repoId), role === "owner" || role === "admin");
    }),
  );
}

/**
 * PUT /api/runners/repos/:id/sandbox-allowances (a session route, owner or admin only; a member gets 403 and nothing is written).
 *
 * The body is exactly `{ set, confirm_repo? }`, where `set` is the reviewed `.fulcrumaxe/runner-sandbox.json` the admin picked in the browser:
 * `{ entries: [{ kind, value, access, reason }], command_timeout_s? }`. The cloud never reads that file from the repository (correction C35); it
 * stores what this person sent, after the floor, and a repo's contents cannot widen a sandbox.
 *
 *  - The set is read strictly and held to the floor in runner-protocol (400 `sandbox_allowance_refused`, with the closed `reason` and the entry's
 *    `index`; nothing is written). A set with entries needs a timeout of 1 to 1800 seconds and a set without entries takes none.
 *  - Approving a set with entries is the step that widens a sandbox, so the repository's own full name must be typed back and match exactly
 *    (400 `confirmation_mismatch`, as C14 section 2 does for the execution mode), and the repo must be on a runner (409 `not_runner_local`).
 *    Approving an empty set is the safe direction: it needs no name and is allowed whatever the mode. Uploading a smaller set and approving it
 *    is the undo, and it applies from the next job; a job already claimed keeps the set it was signed with.
 *  - The definer appends the next version and writes one audit row with the set's sha256, in this transaction. Approving the set already in
 *    force writes nothing and answers `changed: false`.
 */
export async function setSandboxAllowances(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, body: unknown): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw new RunnerHttpError(404, "not_found", "no such repository");
  const invalid = (): never => {
    throw new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
  };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return invalid();
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "set" && keys !== "confirm_repo,set") return invalid();
  const { set: uploaded, confirm_repo: typed } = body as { set: unknown; confirm_repo?: unknown };

  try {
    return ok(
      await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
        const role = await requireMemberRole(client);
        if (role !== "owner" && role !== "admin") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can change this");
        const repo = await loadRepo(client, repoId, true);
        const parsed = parseAllowanceSet(uploaded);
        if (!parsed.ok) throw new RunnerHttpError(400, "sandbox_allowance_refused", "the allowance set was refused", { reason: parsed.code, index: parsed.index });
        const widening = parsed.set.entries.length > 0;
        if (widening) {
          const full = repo.gh_owner && repo.gh_name ? `${repo.gh_owner}/${repo.gh_name}` : null;
          if (full === null || typeof typed !== "string" || typed !== full) throw new RunnerHttpError(400, "confirmation_mismatch", "type the repository's full name to confirm");
          if (repo.execution_mode !== "runner_local") throw new RunnerHttpError(409, "not_runner_local", "allowances are for repositories on a runner");
        }
        const { rows } = await client.query<{ changed: boolean }>("SELECT changed FROM repo_runner_sandbox_allowances_write($1, 'approve', $2::jsonb, $3, $4)", [
          repoId,
          JSON.stringify(parsed.set.entries),
          parsed.set.command_timeout_s ?? null,
          allowanceSetSha256(parsed.set),
        ]);
        return { ...(view(repoId, repo, await loadLatest(client, repoId), true) as object), changed: rows[0]?.changed === true };
      }),
    );
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    switch (pgCode(error)) {
      case "42501":
        throw new RunnerHttpError(403, "forbidden", "only an owner or admin can change this");
      case "P0002":
        throw new RunnerHttpError(404, "not_found", "no such repository");
      case "22023":
        return invalid();
      default:
        throw error;
    }
  }
}

/**
 * Leaving `runner_local` sets the repo's approved allowances aside, in the transaction of the switch: they stay on record and are ignored, and
 * a repo that comes back is approved again before any job carries them (correction C15 section 4). Writes nothing when there are none.
 */
export async function setAsideSandboxAllowances(client: PoolClient, repoId: string): Promise<void> {
  await client.query("SELECT repo_runner_sandbox_allowances_write($1, 'set_aside', NULL::jsonb, NULL::integer, NULL::text)", [repoId]);
}
