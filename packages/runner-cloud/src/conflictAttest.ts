import { CONFLICT_FACTS_CAPABILITY, SignedJobSchema, type ConflictAttestation } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { insertRunEvent } from "@fx/runner";
import { RunnerHttpError, type RunnerCloudDeps } from "./http.js";
import type { TenantQueryable } from "./acceptanceScope.js";

/** The run event that holds a conflict round's attestation, once per run. Nothing reads it yet (D#519 MQ4-e2-c1); the judge that will is MQ4-e2-c2. */
export const CONFLICT_ATTESTATION_EVENT = "conflict.attestation";

const refuse = (): never => {
  throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
};

/** The same value, field for field (the attestation is closed, so a canonical string of its keys in a fixed order is enough). */
const same = (a: unknown, b: ConflictAttestation): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/**
 * D#519 MQ4-e2-c1 (C18, C19): decides whether a `done` may carry a conflict attestation, from the cloud's own rows and never from the message. All must hold, or the answer is a 400
 * `invalid_message` and nothing is written: the run is this runner's, under this lease; its signed job carries `conflict_round`; a `merge_conflict_rounds` row names this run and its
 * `from_sha`, `base_sha` and `base_ref` equal the signed key's; the attestation echoes both shas; the runner's latest hello kept `conflict_facts_v1`; and a value stored earlier for the
 * run is the same one. Returns whether the value still has to be stored (false for a repeat of the stored value).
 */
export async function checkConflictAttestation(
  deps: RunnerCloudDeps,
  i: { accountId: string; runnerId: string; runId: string; leaseGeneration: number },
  attest: ConflictAttestation,
): Promise<{ store: boolean }> {
  return withTenant(deps.appUserPool, i.accountId, async (client: TenantQueryable) => {
    const run = await client.query<{ job_signed: unknown }>("SELECT job_signed FROM agent_runs WHERE account_id = $1 AND id = $2 AND runner_id = $3 AND lease_generation = $4", [i.accountId, i.runId, i.runnerId, i.leaseGeneration]);
    if (run.rows.length !== 1) return refuse();
    const job = SignedJobSchema.safeParse(run.rows[0]!.job_signed);
    const key = job.success ? job.data.job.conflict_round : undefined;
    if (key === undefined) return refuse();
    const round = await client.query<{ from_sha: string; base_sha: string; base_ref: string }>("SELECT from_sha, base_sha, base_ref FROM merge_conflict_rounds WHERE account_id = $1 AND run_id = $2", [i.accountId, i.runId]);
    const row = round.rows[0];
    if (round.rows.length !== 1 || row === undefined || row.from_sha !== key.from_sha || row.base_sha !== key.base_sha || row.base_ref !== key.base_ref) return refuse();
    if (attest.from_sha !== key.from_sha || attest.base_sha !== key.base_sha) return refuse();
    const capable = await client.query("SELECT 1 FROM runner_capabilities WHERE account_id = $1 AND runner_id = $2 AND $3::text = ANY(capabilities)", [i.accountId, i.runnerId, CONFLICT_FACTS_CAPABILITY]);
    if (capable.rows.length === 0) return refuse();
    const stored = await client.query<{ payload: unknown }>("SELECT payload FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 ORDER BY seq LIMIT 1", [i.accountId, i.runId, CONFLICT_ATTESTATION_EVENT]);
    if (stored.rows.length === 0) return { store: true };
    return same(stored.rows[0]!.payload, attest) ? { store: false } : refuse();
  });
}

/** Stores the attestation as the run's one `conflict.attestation` event (the `plane.round_tip` pattern). Called only after `checkConflictAttestation` and the lease fence. */
export async function storeConflictAttestation(deps: RunnerCloudDeps, i: { accountId: string; runId: string }, attest: ConflictAttestation): Promise<void> {
  await withTenant(deps.appUserPool, i.accountId, async (client) => {
    const existing = await client.query("SELECT 1 FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 LIMIT 1", [i.accountId, i.runId, CONFLICT_ATTESTATION_EVENT]);
    if (existing.rows.length === 0) await insertRunEvent(client, i.accountId, i.runId, CONFLICT_ATTESTATION_EVENT, { ...attest });
  });
}
