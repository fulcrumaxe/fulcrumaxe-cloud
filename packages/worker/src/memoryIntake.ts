import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { ingestMemoryProposals, type IngestMemoryProposalsResult } from "@fx/core/src/memory/intake.js";
import type { LiveSecretsSource } from "@fx/core/src/memory/index.js";
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
 * refused `scope_unresolved` until the repository's GitHub node id is stored: `repos` keeps only the numeric id, and the entry's scope is the
 * node id plus the installation (MEM-1), so nothing here makes up a different key.
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
    recordEvent: (client, event) => recordMemoryProposalsEvent(client, { accountId: input.accountId, runId: input.runId, payload: { ...event } }),
  });
}

export type IngestRunResult = IngestMemoryProposalsResult | { status: "skipped_runner" };
