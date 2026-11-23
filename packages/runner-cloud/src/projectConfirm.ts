import type { PoolClient } from "pg";
import { markRunnerWork } from "@fx/core/src/pendingWork.js";
import { emitSetupChanged } from "@fx/core/src/onboarding/engineTrack.js";
import { writeEngineAudit } from "@fx/db/src/engineAudit.js";
import { EngineOperateRefusal, lockEngineBridge, readEngineBridgeSettings, setEngineBridgeSettings } from "@fx/db/src/engineBridge.js";
import { assertMayAddReposToRunner, PlanHolderOnlyError } from "@fx/db/src/runnerPlanLoosen.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { autoPlaceProject, lockRunners, placeProject } from "./placement.js";
import { readRepoVisibility, type RepoVisibilityAnswer } from "./repoPrivacy.js";
import { configuredWakeKey } from "./wakeToken.js";

/**
 * D#845 ON-7a: confirming a project. `POST /api/runners/repos/:id/place` with `{ kind, runner_id?, turn_on_operate?, operate_others? }`. An owner or admin, on a session.
 *
 * One transaction, or nothing: the setup row, the repo's runner mode, the placement (MC-9), the machine's repository list, the engine bridge tick (watch on when it is off) and the
 * audit row commit together, so a write that fails undoes every one before it. The visibility read goes to GitHub, so it happens before the transaction opens and is never stored:
 * a public repo is accepted on this path (the engine track), `unknown` is refused with 409 `repo_visibility_unknown` and nothing is written. Other runner paths still refuse public repos.
 *
 * `kind` is `existing` (a survey follows, so the setup starts at `survey`) or `new` (a repo made through create-intent: nothing to survey, so it starts at `plan`). `kind` is the client's word and only picks the starting phase; it grants nothing. (The create-repo service's audit row names the repo, but production code may not read the audit log, so deriving it server-side needs a definer: a follow-up.) The route starts no
 * survey itself. There is no coverage check here (the Engine plan gates the install). Operate is never turned on by itself: with `turn_on_operate: true` and the account switch off, it
 * goes on only when `operate_others` names exactly the other repos that would be operated with it (409 `operate_consent_stale` when the list the person saw is not the current one).
 *
 * Refusals: 403 `forbidden`, 404 `not_found`, 409 `setup_exists` (with the first setup's id), `account_not_active`, `repo_visibility_unknown`, `project_already_placed`,
 * `machine_single_project`, `machine_not_eligible`, `no_eligible_machine`, `operate_consent_stale`, `operate_public_pending`, `placement_busy` (a deadlock with another change to the machine: try again); 400 `invalid_message`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (): RunnerHttpError => new RunnerHttpError(400, "invalid_message", "the request does not match what this route takes");
const KEYS = new Set(["kind", "runner_id", "turn_on_operate", "operate_others"]);

interface Input {
  kind: "existing" | "new";
  runnerId: string | null;
  turnOnOperate: boolean;
  operateOthers: string[];
}

function parse(body: unknown): Input {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid();
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !KEYS.has(k))) throw invalid();
  if (b.kind !== "existing" && b.kind !== "new") throw invalid();
  if (b.runner_id !== undefined && (typeof b.runner_id !== "string" || !UUID.test(b.runner_id))) throw invalid();
  if (b.turn_on_operate !== undefined && typeof b.turn_on_operate !== "boolean") throw invalid();
  const others = b.operate_others ?? [];
  if (!Array.isArray(others) || others.length > 100 || others.some((x) => typeof x !== "string" || !UUID.test(x))) throw invalid();
  return { kind: b.kind, runnerId: typeof b.runner_id === "string" ? b.runner_id.toLowerCase() : null, turnOnOperate: b.turn_on_operate === true, operateOthers: (others as string[]).map((x) => x.toLowerCase()) };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

/** The oldest setup of the repo that is not done or removed. Names the account and the repo itself, on top of row security. */
export async function firstLiveSetup(client: PoolClient, accountId: string, repoId: string): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>("SELECT id FROM project_setups WHERE account_id = $1 AND repo_id = $2 AND phase NOT IN ('done', 'removed') ORDER BY created_at LIMIT 1", [accountId, repoId]);
  return rows[0]?.id ?? null;
}

const publicPending = (): RunnerHttpError => new RunnerHttpError(409, "operate_public_pending", "Operate isn't available for public repos yet. The engine can watch this repo, but won't act on it.");

const setupExists = (id: string): RunnerHttpError => new RunnerHttpError(409, "setup_exists", "this repository is already being set up", { setup_id: id });

export async function placeProjectRoute(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string, body: unknown): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw new RunnerHttpError(404, "not_found", "no such repository");
  repoId = repoId.toLowerCase();
  const input = parse(body);
  const { accountId, userId } = principal;
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => withTenant(deps.appUserPool, accountId, userId, fn);

  // Before any GitHub read: who may ask, and which repository it is (its own row, matched on the account).
  const full = await tenant(async (client) => {
    if ((await requireMemberRole(client)) === "member") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can place a project");
    const { rows } = await client.query<{ gh_owner: string | null; gh_name: string | null }>("SELECT gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2", [accountId, repoId]);
    if (!rows[0]) throw new RunnerHttpError(404, "not_found", "no such repository");
    return rows[0].gh_owner && rows[0].gh_name ? `${rows[0].gh_owner}/${rows[0].gh_name}` : "this repository";
  });
  // Asked of GitHub on every call and never remembered. Public and private are both accepted here; anything else (a missing reader, a rejected call, a 404 or 5xx) is refused.
  const seen = await readRepoVisibility(deps, accountId, repoId);
  if (seen === "unknown") {
    throw new RunnerHttpError(409, "repo_visibility_unknown", `GitHub didn't say whether ${full} is public or private. Try again in a minute`);
  }
  // Operate on a public repo waits for the decide rule for work from strangers (D#845 S-8; its follow-up, a stored `repos.is_private` kept by the sync and webhooks, lets decide
  // answer `ask` itself, and also covers a repo that turns public after operate is on, which this gate does not). Until then, a confirm that would turn operate on reads the
  // visibility of every repo it would operate. Watch-only placement of a public repo is unaffected.
  const othersSeen = new Map<string, RepoVisibilityAnswer>();
  if (input.turnOnOperate) await Promise.all(input.operateOthers.filter((id) => id !== repoId).map(async (id) => { othersSeen.set(id, await readRepoVisibility(deps, accountId, id)); }));

  const now = (deps.now ?? (() => new Date()))();
  const wakeEnabled = configuredWakeKey(deps.wakeKey) !== null;
  try {
    const done = await tenant(async (client) => {
      const actor = { accountId, userId };
      const status = (await client.query<{ status: string }>("SELECT status FROM accounts WHERE id = $1 AND deleted_at IS NULL", [accountId])).rows[0]?.status;
      if (status !== "active") throw new RunnerHttpError(409, "account_not_active", "this account is not active");
      const repo = (await client.query<{ execution_mode: string }>("SELECT execution_mode FROM repos WHERE account_id = $1 AND id = $2 FOR UPDATE", [accountId, repoId])).rows[0];
      if (!repo) throw new RunnerHttpError(404, "not_found", "no such repository");
      // The bridge's switches and ticks are read, decided on, then written. Every writer takes this same per-account lock first (`setEngineBridgeSettings` does too, so a settings
      // change cannot slip between the consent check below and its write), and holds it to commit.
      await lockEngineBridge(client);

      const first = await firstLiveSetup(client, accountId, repoId);
      if (first) throw setupExists(first);
      // The index is the arbiter: a writer that loses the race lands here, and reads the winner's id.
      let setupId: string;
      await client.query("SAVEPOINT on7_setup");
      try {
        setupId = (await client.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id", [accountId, repoId, input.kind, input.kind === "existing" ? "survey" : "plan", userId])).rows[0]!.id;
        await client.query("RELEASE SAVEPOINT on7_setup");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT on7_setup");
        const winner = pgCode(error) === "23505" ? await firstLiveSetup(client, accountId, repoId) : null;
        if (winner) throw setupExists(winner);
        throw error;
      }

      // A repo moves onto a runner from the sandbox only; one already on a runner mode keeps the mode the person chose.
      if (repo.execution_mode === "sandbox") {
        await client.query("UPDATE repos SET execution_mode = 'runner_local', verified_copy_sha256 = NULL, updated_at = now() WHERE account_id = $1 AND id = $2", [accountId, repoId]);
        await client.query("SELECT repo_execution_mode_switch_audit($1, 'sandbox', 'runner_local', false, 0)", [repoId]);
      }

      // The placement (MC-9). Its own refusals pass through: nothing here repeats them.
      const placed = { repoId, now, wakeEnabled };
      // The order a move takes (`moveProject`): the machine's locks first, then the placement row. A confirm that inserted the placement first and locked the machine after would
      // wait on a move to the same machine that waits on this insert (CWE-833). An automatic placement picks its machine inside, so it cannot lock first; a deadlock there is
      // answered 409 `placement_busy` below.
      if (input.runnerId) {
        await lockRunners(client, [input.runnerId]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`runner_register:${accountId}`]);
      }
      const runnerId = input.runnerId ?? (await autoPlaceProject(client, actor, placed));
      if (input.runnerId) await placeProject(client, actor, { ...placed, runnerId });

      // The machine's repository list: the same locks the move takes, then the plan-holder rule, then the one definer that writes the list.
      await lockRunners(client, [runnerId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`runner_register:${accountId}`]);
      try {
        await assertMayAddReposToRunner(client, userId, runnerId, [repoId]);
      } catch (error) {
        if (error instanceof PlanHolderOnlyError) throw new RunnerHttpError(403, error.code, error.message);
        throw error;
      }
      const list = (await client.query<{ a: string[] }>("SELECT allowed_repo_ids AS a FROM runners WHERE account_id = $1 AND id = $2", [accountId, runnerId])).rows[0]?.a ?? [];
      if (!list.includes(repoId)) await client.query("SELECT runner_repos_set($1, $2::uuid[])", [runnerId, [...list, repoId]]);
      await client.query("UPDATE project_setups SET runner_id = $3, updated_at = now() WHERE account_id = $1 AND id = $2", [accountId, setupId, runnerId]);

      // The engine bridge: this repo ticked, watch on. Operate only on the person's word, naming what it would also operate.
      const before = await readEngineBridgeSettings(client);
      if (!before.repo_ids.includes(repoId)) {
        await client.query("INSERT INTO engine_bridge_repos (account_id, repo_id, enabled_by) VALUES ($1, $2, $3)", [accountId, repoId, userId]);
        await writeEngineAudit(client, "engine_bridge.settings_changed", { kind: "repo_added", repo_id: repoId });
      }
      let operate = before.operate_enabled;
      if (!operate && input.turnOnOperate) {
        if (!sameSet(input.operateOthers, before.repo_ids.filter((id) => id !== repoId))) throw new RunnerHttpError(409, "operate_consent_stale", "the repositories this would also operate changed. Reload and confirm again");
        operate = true;
        for (const id of before.repo_ids.filter((x) => x !== repoId)) {
          const v = othersSeen.get(id) ?? "unknown";
          if (v === "unknown") throw new RunnerHttpError(409, "repo_visibility_unknown", "GitHub didn't say whether one of those repositories is public or private. Try again in a minute");
          if (v === "public") throw publicPending();
        }
      }
      // Operate is the account's one switch: with it on (already, or by this call), this repo is operated too.
      if (operate && seen === "public") throw publicPending();
      if (!before.watch_enabled || operate !== before.operate_enabled) await setEngineBridgeSettings(client, userId, { watch_enabled: true, operate_enabled: operate }, new Map([...othersSeen, [repoId, seen]]));

      await client.query("SELECT audit_write('project.setup_started', $1::jsonb)", [JSON.stringify({ setup_id: setupId, repo_id: repoId, runner_id: runnerId, kind: input.kind })]);
      await emitSetupChanged(client, { accountId, setupId, repoId });
      return { setupId, runnerId, operate };
    });
    void markRunnerWork(accountId);
    return {
      status: 201,
      body: { setup_id: done.setupId, repo_id: repoId, runner_id: done.runnerId, kind: input.kind, phase: input.kind === "existing" ? "survey" : "plan", operate_enabled: done.operate },
      headers: { "cache-control": "no-store" },
    };
  } catch (error) {
    if (error instanceof RunnerHttpError) throw error;
    if (error instanceof EngineOperateRefusal) throw new RunnerHttpError(409, error.code, error.message);
    if (pgCode(error) === "42501") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can place a project");
    // 40P01: two changes to one machine waited on each other and Postgres ended this one, which wrote nothing. Retrying is safe.
    if (pgCode(error) === "40P01") throw new RunnerHttpError(409, "placement_busy", "Another change to this machine is in progress. Try again.");
    throw error;
  }
}
