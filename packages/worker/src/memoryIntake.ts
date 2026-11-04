import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ingestMemoryProposals, type IngestMemoryProposalsResult } from "@fx/core/src/memory/intake.js";
import { TERMINAL_WORK_ITEM_STAGES } from "@fx/core/src/work-items/stages.js";
import { setDeferredRoleErrorSink, setDeferredRoleLiveSecrets } from "@fx/core/src/memory/deferredRole.js";
import { repoScopeRef, type LiveSecretsSource } from "@fx/core/src/memory/index.js";
import type { PoolClient } from "pg";
import { liveInstallationTokens } from "@fx/github";
import { reportError } from "@fx/telemetry";
import { recordMemoryProposalsEvent } from "@fx/runner";

/**
 * D#601 MEM-2: where a finished run's `memory_proposals` become pending entries. The stage driver reads each run it follows through
 * `advanceRunOutcome`; when a run has ended with an envelope that carries the field, this runs the intake once (the intake is idempotent per run).
 *
 * Two runs are left alone here:
 *   - A run on a person's machine (`runtime = 'runner'`). Its envelope reached the cloud inside `done`, but the transcript of a runner run leaves
 *     the machine only after the person says yes to the exact text (MEM-6's prompt). Reading proposals out of the stored envelope would be a way
 *     around that yes, so those runs are never ingested from here; MEM-6's own message is the only path in.
 *   - A run that did not end `succeeded` or `failed` (cancelled, timed out): there is no finished answer to take proposals from.
 *
 * The tenant's live token values are this process's installation tokens (the ones a run's git and API calls carried). A repo-scope proposal is
 * refused `scope_unresolved` unless the repository's GitHub node id is stored (the repo sync writes it, MEM-3w). The entry's scope is the node
 * id plus the installation (MEM-1), the key MEM-3's retriever reads, so nothing here makes up a different key.
 */
export interface RunMemoryIntakeInput {
  pool: Pool;
  accountId: string;
  runId: string;
  envelope: Record<string, unknown> | null;
  /** Tests inject; the default is this process's live installation tokens. */
  liveSecrets?: LiveSecretsSource;
}

interface RunFacts {
  role: string;
  work_item_id: string | null;
  runtime: string;
  status: string;
  stage: string | null;
}

const defaultLiveSecrets: LiveSecretsSource = () => liveInstallationTokens();
// MEM-9: the deferred role pass (run by `recordStage` when an item reaches a terminal stage) scans against this process's live tokens too.
setDeferredRoleLiveSecrets(defaultLiveSecrets);
setDeferredRoleErrorSink((err, stage) => reportError(err, { stage }));

/**
 * The run's repository key, built exactly as the retriever builds it (`repoScopeRef(gh_node_id, gh_installation_id)`), or null when the run has
 * no repository, the repository has no stored node id, or it is not attached to an installation. Null refuses the proposal `scope_unresolved`:
 * there is no fallback key.
 */
export async function resolveRunRepoScopeRef(client: PoolClient, accountId: string, runId: string): Promise<string | null> {
  const { rows } = await client.query<{ gh_node_id: string | null; gh_installation_id: string | null }>(
    `SELECT r.gh_node_id, i.gh_installation_id::text AS gh_installation_id
       FROM agent_runs ar
       LEFT JOIN work_items w ON w.account_id = ar.account_id AND w.id = ar.work_item_id
       JOIN repos r ON r.account_id = ar.account_id AND r.id = COALESCE(w.repo_id, ar.dispatch_repo_id)
       LEFT JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id
      WHERE ar.id = $1 AND ar.account_id = $2`,
    [runId, accountId],
  );
  const row = rows[0];
  return row?.gh_node_id && row.gh_installation_id ? repoScopeRef(row.gh_node_id, row.gh_installation_id) : null;
}

/** MEM-9: whether the run's work item has reached a terminal stage, asked on the intake's own client (inside its lock). */
const itemTerminalOf = (accountId: string, workItemId: string | null) => async (client: PoolClient): Promise<boolean> => {
  if (workItemId === null) return false;
  const { rows } = await client.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1 AND account_id = $2", [workItemId, accountId]);
  return rows[0] !== undefined && (TERMINAL_WORK_ITEM_STAGES as readonly string[]).includes(rows[0].stage);
};

export async function ingestRunMemoryProposals(input: RunMemoryIntakeInput): Promise<IngestRunResult> {
  if (input.envelope === null || input.envelope.memory_proposals === undefined) return { status: "none" };
  const facts = await withTenant(input.pool, input.accountId, async (client) => {
    const { rows } = await client.query<RunFacts>("SELECT ar.role, ar.work_item_id, ar.runtime, ar.status, w.stage FROM agent_runs ar LEFT JOIN work_items w ON w.account_id = ar.account_id AND w.id = ar.work_item_id WHERE ar.id = $1 AND ar.account_id = $2", [input.runId, input.accountId]);
    return rows[0] ?? null;
  });
  if (facts === null) return { status: "none" };
  if (facts.runtime === "runner") return { status: "skipped_runner" };
  if (facts.status !== "succeeded" && facts.status !== "failed") return { status: "none" };
  return ingestMemoryProposals({
    pool: input.pool,
    accountId: input.accountId,
    runId: input.runId,
    workItemId: facts.work_item_id,
    role: facts.role,
    source: "agent",
    // MEM-9: agent-proposed role lessons are accepted (as pending entries only) once the run's work item is done.
    allowRoleScope: true,
    // Read inside the intake lock, in the intake's own transaction, so a merge landing between this call and the lock is not missed.
    itemTerminal: itemTerminalOf(input.accountId, facts.work_item_id),
    envelope: input.envelope,
    liveSecrets: input.liveSecrets ?? defaultLiveSecrets,
    resolveRepoScopeRef: (client) => resolveRunRepoScopeRef(client, input.accountId, input.runId),
    recordEvent: (client, event) => recordMemoryProposalsEvent(client, { accountId: input.accountId, runId: input.runId, payload: { ...event } }),
  });
}

export type IngestRunResult = IngestMemoryProposalsResult | { status: "skipped_runner" };

export const MEM_PROPOSAL_CAPABILITY = "mem_proposal_v1";

export interface RunnerMemoryInput {
  pool: Pool;
  accountId: string;
  runnerId: string;
  runId: string;
  /** Scope, kind and body only: what the person read and said yes to. Nothing else of a proposal crosses. */
  proposals: ReadonlyArray<{ scope: string; kind: string; body: string }>;
  liveSecrets?: LiveSecretsSource;
}

export type RunnerMemoryResult =
  | { kind: "run_not_yours" | "run_not_finished" | "capability_missing" }
  | { kind: "ingested" | "already_ingested"; stored: number; refused: number };

/**
 * D#601 MEM-6: the proposals a person said yes to on their own machine, after a run of that runner ended. This is the only path a runner run's memory takes into
 * the intake (`ingestRunMemoryProposals` above still skips every runner run). The run must be this runner's own row in this account (the repository, the item and the
 * role are read from our rows, never from the message), must have ended, and the runner's latest hello must have listed `mem_proposal_v1`. Then the same intake runs
 * (secret scan against live tokens, size cap, duplicate and pending-cap checks, three per run) with the author kind `runner_agent`, and nothing is auto-approved.
 */
export async function ingestRunnerMemoryProposals(input: RunnerMemoryInput): Promise<RunnerMemoryResult> {
  const facts = await withTenant(input.pool, input.accountId, async (client) => {
    const { rows } = await client.query<RunFacts>("SELECT ar.role, ar.work_item_id, ar.runtime, ar.status, w.stage FROM agent_runs ar LEFT JOIN work_items w ON w.account_id = ar.account_id AND w.id = ar.work_item_id WHERE ar.id = $1 AND ar.account_id = $2 AND ar.runner_id = $3 AND ar.runtime = 'runner'", [input.runId, input.accountId, input.runnerId]);
    if (rows[0] === undefined) return null;
    const capable = await client.query("SELECT 1 FROM runner_capabilities WHERE account_id = $1 AND runner_id = $2 AND $3::text = ANY(capabilities)", [input.accountId, input.runnerId, MEM_PROPOSAL_CAPABILITY]);
    return { run: rows[0], capable: capable.rows.length > 0 };
  });
  if (facts === null) return { kind: "run_not_yours" };
  if (!facts.capable) return { kind: "capability_missing" };
  if (facts.run.status !== "succeeded" && facts.run.status !== "failed") return { kind: "run_not_finished" };
  const done = await ingestMemoryProposals({
    pool: input.pool,
    accountId: input.accountId,
    runId: input.runId,
    workItemId: facts.run.work_item_id,
    role: facts.run.role,
    source: "runner_agent",
    allowRoleScope: true,
    itemTerminal: itemTerminalOf(input.accountId, facts.run.work_item_id),
    envelope: { memory_proposals: input.proposals.map(({ scope, kind, body }) => ({ scope, kind, body })) },
    liveSecrets: input.liveSecrets ?? defaultLiveSecrets,
    resolveRepoScopeRef: (client) => resolveRunRepoScopeRef(client, input.accountId, input.runId),
    recordEvent: (client, event) => recordMemoryProposalsEvent(client, { accountId: input.accountId, runId: input.runId, payload: { ...event } }),
  });
  if (done.status === "ingested") return { kind: "ingested", stored: done.stored.length, refused: done.refused.length };
  return { kind: "already_ingested", stored: 0, refused: 0 };
}
