import type { PoolClient } from "pg";
import { HOST_LOAD_MIN_INTERVAL_SECONDS } from "@fulcrumaxe/runner-protocol";
import { RUNNER_ONLINE_SECONDS, runnerLiveSql } from "@fx/runner";
import { assertMayAddReposToRunner, PlanHolderOnlyError } from "@fx/db/src/runnerPlanLoosen.js";
import { RunnerHttpError, pgCode } from "./http.js";
import { readMachineFactsIn } from "./machineFacts.js";
import { requireMemberRole } from "./memberRole.js";

/**
 * D#845 MC-9: which machine runs a project's engine, and moving it. One engine per machine, on both tiers: the database holds that (`project_placements` has a unique
 * index on the machine), and every function here treats the index as the lock. A write that loses a race hits it, answers 409 `machine_single_project` and changes nothing.
 *
 * The functions take the caller's tenant transaction, so a caller (the project setup) can make the placement one step of a larger all-or-nothing write. Every query names
 * the account itself on top of row security. A machine is judged only on what it reported: a fact it never sent is unknown, and unknown is never eligible. No real runner
 * reports its host load until a build advertises the `project_setup_v1` capability, so today every machine reads `load_unknown` and none is eligible.
 */

/** A machine needs at least this much free memory and free disk (megabytes) to take an engine. */
export const PLACEMENT_MIN_MEM_AVAIL_MB = 4096;
export const PLACEMENT_MIN_DISK_FREE_MB = 10240;
/** The most a carried state directory may weigh. The carry itself is not built yet, so a request for it is refused (see `moveProject`). */
/** A host-load reading older than this many report intervals is as good as none. */
export const LOAD_STALE_AFTER_INTERVALS = 3;
export const STATE_CARRY_MAX_BYTES = 50 * 1024 * 1024;

/** Why a machine cannot take a project, in the order they are checked. `has_project` first, because the screen names the project that holds it. */
export type IneligibleReason = "has_project" | "not_live" | "paused" | "draining" | "claude_not_ready" | "load_unknown" | "low_memory" | "low_disk";

export interface MachineCapacity {
  runner_id: string;
  /** The name the person gave, or "Unnamed machine". Never null. */
  name: string;
  tier: "microvm" | "standard" | null;
  /** The machine's reported KVM fact (`runners.kvm`, the column Onboarding reads); null when it never reported one. */
  kvm: "present" | "absent" | null;
  live: boolean;
  /** Set by a person: the machine takes no new work. */
  paused: boolean;
  draining: boolean;
  /** Seconds since the machine's host load was stored; null when it never was. Shown so a stale figure says how old it is. */
  load_age_s: number | null;
  /** The machine's latest hello said it holds model credentials. A machine that never said is false. */
  claude: boolean;
  mem_avail_mb: number | null;
  disk_free_mb: number | null;
  /** The project placed on it, for the greyed "Runs <owner/name>" line. */
  running: { repo_id: string; name: string } | null;
  eligible: boolean;
  reason: IneligibleReason | null;
}

type MachineFacts = Omit<MachineCapacity, "eligible" | "reason">;

/** Pure. The one eligibility rule: live, Claude ready, nothing placed, and enough free memory and disk. A missing number is unknown, never enough. */
export function assessMachine(m: MachineFacts): MachineCapacity {
  const reason: IneligibleReason | null =
    m.running !== null ? "has_project"
    : !m.live ? "not_live"
    : m.paused ? "paused"
    : m.draining ? "draining"
    : !m.claude ? "claude_not_ready"
    : m.mem_avail_mb === null || m.disk_free_mb === null || m.load_age_s === null || m.load_age_s > LOAD_STALE_AFTER_INTERVALS * HOST_LOAD_MIN_INTERVAL_SECONDS ? "load_unknown"
    : m.mem_avail_mb < PLACEMENT_MIN_MEM_AVAIL_MB ? "low_memory"
    : m.disk_free_mb < PLACEMENT_MIN_DISK_FREE_MB ? "low_disk"
    : null;
  return { ...m, eligible: reason === null, reason };
}

/** Pure. The eligible machines in the order auto-placement tries them: microVM first, then the most free memory, then the name, then the id. */
export function placementOrder(machines: readonly MachineCapacity[]): MachineCapacity[] {
  const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return machines
    .filter((m) => m.eligible)
    .sort((a, b) => Number(b.tier === "microvm") - Number(a.tier === "microvm") || (b.mem_avail_mb ?? 0) - (a.mem_avail_mb ?? 0) || byText(a.name, b.name) || byText(a.runner_id, b.runner_id));
}

interface MachineRow {
  runner_id: string;
  name: string | null;
  sandbox_engine: string | null;
  kvm: string | null;
  live: boolean;
  paused: boolean;
  draining: boolean;
  repo_id: string | null;
  repo_name: string | null;
}

/**
 * Every machine (not removed) of the account with its capacity, eligibility and, when one is placed on it, the project that holds it. A machine is live by the rule every
 * runner-presence test shares; `wakeEnabled` is the deployment's wake gate (off: the plain 120-second window, the stricter reading).
 */
export async function readMachineCapacity(client: PoolClient, accountId: string, o: { now?: Date; wakeEnabled?: boolean } = {}): Promise<MachineCapacity[]> {
  const now = o.now ?? new Date();
  const live = runnerLiveSql({ runner: "rn", now: "$2", onlineSeconds: "$3", wakeEnabled: o.wakeEnabled === true });
  const { rows } = await client.query<MachineRow>(
    `SELECT rn.id AS runner_id, st.name, f.sandbox_engine, rn.kvm, COALESCE(${live}, false) AS live, (st.paused_at IS NOT NULL) AS paused, COALESCE(st.draining, false) AS draining, p.repo_id,
            COALESCE(NULLIF(g.gh_owner || '/' || g.gh_name, ''), 'a repository') AS repo_name
       FROM runners rn
            LEFT JOIN runner_settings st ON st.account_id = rn.account_id AND st.runner_id = rn.id
            LEFT JOIN runner_facts f ON f.account_id = rn.account_id AND f.runner_id = rn.id
            LEFT JOIN project_placements p ON p.account_id = rn.account_id AND p.runner_id = rn.id
            LEFT JOIN repos g ON g.account_id = p.account_id AND g.id = p.repo_id
      WHERE rn.account_id = $1 AND rn.revoked_at IS NULL
      ORDER BY rn.id`,
    [accountId, now, RUNNER_ONLINE_SECONDS],
  );
  const facts = await readMachineFactsIn(client, accountId);
  return rows.map((r) => {
    const f = facts.get(r.runner_id);
    return assessMachine({
      runner_id: r.runner_id,
      name: r.name ?? "Unnamed machine",
      tier: r.sandbox_engine === "microvm" ? "microvm" : r.sandbox_engine === "os_sandbox" ? "standard" : null,
      kvm: r.kvm === "present" || r.kvm === "absent" ? r.kvm : null,
      live: r.live,
      paused: r.paused,
      draining: r.draining,
      load_age_s: f?.host_load ? Math.max(0, Math.floor((now.getTime() - Date.parse(f.host_load.seen_at)) / 1000)) : null,
      claude: f?.model_auth_present === true,
      mem_avail_mb: f?.host_load?.mem_avail_mb ?? null,
      disk_free_mb: f?.host_load?.disk_free_mb ?? null,
      running: r.repo_id === null ? null : { repo_id: r.repo_id, name: r.repo_name ?? "a repository" },
    });
  });
}

/** Called before a placement is written; throws (402 `engine_quantity`, from the plan's coverage check) to refuse it. The caller supplies it, so this file never reads billing. */
export type EngineCoverageCheck = (client: PoolClient, input: { accountId: string; repoId: string }) => Promise<void>;

interface Actor {
  accountId: string;
  userId: string;
}

const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);

async function requireOwnerOrAdmin(client: PoolClient): Promise<void> {
  if ((await requireMemberRole(client)) === "member") throw refuse(403, "forbidden", "only an owner or admin may place or move a project");
}

async function requireRepo(client: PoolClient, accountId: string, repoId: string): Promise<void> {
  const { rows } = await client.query("SELECT 1 FROM repos WHERE account_id = $1 AND id = $2", [accountId, repoId]);
  if (rows.length === 0) throw refuse(404, "not_found", "no such repository");
}

const notEligible = (m: MachineCapacity): RunnerHttpError =>
  m.reason === "has_project" ? refuse(409, "machine_single_project", "this machine already runs a project") : refuse(409, "machine_not_eligible", "this machine cannot take a project right now");

/**
 * Inside a savepoint, so a lost race leaves the transaction usable: `true` when the row was written, `false` when the machine was taken. A repo that already has a placement is 409.
 * The unique index is the arbiter: a concurrent writer on the same machine waits for the first one to finish, then fails here or succeeds if the first rolled back.
 */
async function insertPlacement(client: PoolClient, a: Actor, repoId: string, runnerId: string, placedBy: "auto" | "person"): Promise<boolean> {
  await client.query("SAVEPOINT mc9_place");
  try {
    await client.query("INSERT INTO project_placements (account_id, repo_id, runner_id, placed_by) VALUES ($1, $2, $3, $4)", [a.accountId, repoId, runnerId, placedBy]);
    await client.query("RELEASE SAVEPOINT mc9_place");
    return true;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT mc9_place");
    if (pgCode(error) !== "23505") throw error;
    const constraint = (error as { constraint?: string }).constraint;
    if (constraint === "project_placements_one_per_runner") return false;
    throw refuse(409, "project_already_placed", "this project already has a machine");
  }
}

/**
 * Puts a project on one machine the person picked (`placed_by = person`). The machine must be eligible now (404 when it is not the account's, 409 `machine_single_project` when it
 * runs a project, 409 `machine_not_eligible` otherwise). `engineCoverage` is the plan's check that one more engine is covered (402 `engine_quantity`); ON-7 passes it.
 */
export async function placeProject(client: PoolClient, a: Actor, input: { repoId: string; runnerId: string; engineCoverage?: EngineCoverageCheck; now?: Date; wakeEnabled?: boolean }): Promise<void> {
  await requireOwnerOrAdmin(client);
  await requireRepo(client, a.accountId, input.repoId);
  const machine = (await readMachineCapacity(client, a.accountId, input)).find((m) => m.runner_id === input.runnerId);
  if (!machine) throw refuse(404, "not_found", "no such machine");
  if (!machine.eligible) throw notEligible(machine);
  await input.engineCoverage?.(client, { accountId: a.accountId, repoId: input.repoId });
  if (!(await insertPlacement(client, a, input.repoId, input.runnerId, "person"))) throw refuse(409, "machine_single_project", "this machine already runs a project");
}

/**
 * Puts a project on the best eligible machine (`placed_by = auto`): see `placementOrder`. A machine another writer takes first is skipped and the next is tried. 409
 * `no_eligible_machine` when none is left. Returns the machine's id.
 */
export async function autoPlaceProject(client: PoolClient, a: Actor, input: { repoId: string; engineCoverage?: EngineCoverageCheck; now?: Date; wakeEnabled?: boolean }): Promise<string> {
  await requireOwnerOrAdmin(client);
  await requireRepo(client, a.accountId, input.repoId);
  const order = placementOrder(await readMachineCapacity(client, a.accountId, input));
  if (order.length === 0) throw refuse(409, "no_eligible_machine", "no machine can take a project right now");
  await input.engineCoverage?.(client, { accountId: a.accountId, repoId: input.repoId });
  for (const m of order) if (await insertPlacement(client, a, input.repoId, m.runner_id, "auto")) return m.runner_id;
  throw refuse(409, "no_eligible_machine", "no machine can take a project right now");
}

export const lockRunners = async (client: PoolClient, ids: readonly string[]): Promise<void> => {
  // The lock the fleet's repository edit takes, in a fixed order, so a move and an edit of the same machine's list never interleave and two moves never deadlock.
  for (const id of [...ids].sort()) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`runner_repos:${id.toLowerCase()}`]);
};

/**
 * Moves a placed project to another eligible machine, all in the caller's transaction: the placement row, both machines' repository lists (so the old machine's session
 * is no longer accepted by ingest and only the new machine's is), and the `project.moved` audit row (ids and an enum only). Any refusal changes nothing.
 *
 * Not here: stopping the session on the old machine and starting it on the new one, and removing the old copy. Those are ON-13a's stop and start paths and follow it.
 * The state-directory carry (cap `STATE_CARRY_MAX_BYTES`) has no transport yet either: `carryState: true` is refused with 409 `state_carry_unavailable`, so asking for the
 * team's memory is never silently dropped. The default, false, starts the new machine fresh.
 */
export async function moveProject(client: PoolClient, a: Actor, input: { repoId: string; toRunnerId: string; carryState?: boolean; now?: Date; wakeEnabled?: boolean }): Promise<{ from_runner_id: string; to_runner_id: string }> {
  await requireOwnerOrAdmin(client);
  if (input.carryState === true) throw refuse(409, "state_carry_unavailable", "carrying the team's memory to the new machine is not available yet");
  await requireRepo(client, a.accountId, input.repoId);
  // The placement row is held to the end: a second move of this repo waits, then reads the committed machine.
  const cur = await client.query<{ runner_id: string }>("SELECT runner_id FROM project_placements WHERE account_id = $1 AND repo_id = $2 FOR UPDATE", [a.accountId, input.repoId]);
  const from = cur.rows[0]?.runner_id;
  if (!from) throw refuse(409, "project_not_placed", "this project has no machine yet");
  if (from === input.toRunnerId) throw refuse(400, "invalid_message", "the project is already on that machine");
  await lockRunners(client, [from, input.toRunnerId]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`runner_register:${a.accountId}`]);
  const to = (await readMachineCapacity(client, a.accountId, input)).find((m) => m.runner_id === input.toRunnerId);
  if (!to) throw refuse(404, "not_found", "no such machine");
  if (!to.eligible) throw notEligible(to);
  try {
    await assertMayAddReposToRunner(client, a.userId, input.toRunnerId, [input.repoId]);
  } catch (error) {
    if (error instanceof PlanHolderOnlyError) throw refuse(403, error.code, error.message);
    throw error;
  }
  try {
    const moved = await client.query("UPDATE project_placements SET runner_id = $3, placed_by = 'person', placed_at = now() WHERE account_id = $1 AND repo_id = $2", [a.accountId, input.repoId, input.toRunnerId]);
    if (moved.rowCount !== 1) throw new Error("the placement row vanished under its own lock");
    // A machine that is already removed has no list to edit and is refused by ingest anyway.
    const lists = await client.query<{ id: string; revoked: boolean; allowed: string[] }>("SELECT id, revoked_at IS NOT NULL AS revoked, allowed_repo_ids AS allowed FROM runners WHERE account_id = $1 AND id = ANY ($2::uuid[])", [a.accountId, [from, input.toRunnerId]]);
    for (const r of lists.rows) {
      if (r.revoked) continue;
      const next = r.id === from ? r.allowed.filter((id) => id !== input.repoId) : [...new Set([...r.allowed, input.repoId])];
      await client.query("SELECT runner_repos_set($1, $2::uuid[])", [r.id, next]);
    }
    await client.query("SELECT audit_write('project.moved', $1::jsonb)", [JSON.stringify({ repo_id: input.repoId, from_runner_id: from, to_runner_id: input.toRunnerId, carry: "off" })]);
  } catch (error) {
    if (pgCode(error) === "23505") throw refuse(409, "machine_single_project", "this machine already runs a project");
    throw error;
  }
  return { from_runner_id: from, to_runner_id: input.toRunnerId };
}
