import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ingestMemoryProposals, type IngestMemoryProposalsResult } from "@fx/core/src/memory/intake.js";
import { repoScopeRef, type LiveSecretsSource } from "@fx/core/src/memory/index.js";
import type { PoolClient } from "pg";
import { liveInstallationTokens } from "@fx/github";
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
}

const defaultLiveSecrets: LiveSecretsSource = () => liveInstallationTokens();

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

export async function ingestRunMemoryProposals(input: RunMemoryIntakeInput): Promise<IngestRunResult> {
  if (input.envelope === null || input.envelope.memory_proposals === undefined) return { status: "none" };
  const facts = await withTenant(input.pool, input.accountId, async (client) => {
    const { rows } = await client.query<RunFacts>("SELECT role, work_item_id, runtime, status FROM agent_runs WHERE id = $1 AND account_id = $2", [input.runId, input.accountId]);
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
    envelope: input.envelope,
    liveSecrets: input.liveSecrets ?? defaultLiveSecrets,
    resolveRepoScopeRef: (client) => resolveRunRepoScopeRef(client, input.accountId, input.runId),
    recordEvent: (client, event) => recordMemoryProposalsEvent(client, { accountId: input.accountId, runId: input.runId, payload: { ...event } }),
  });
}

export type IngestRunResult = IngestMemoryProposalsResult | { status: "skipped_runner" };
