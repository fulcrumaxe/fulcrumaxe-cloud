import type { PoolClient } from "pg";
import { ENGINE_CARRY_CAPABILITY } from "@fulcrumaxe/runner-protocol";
import { RunnerHttpError, type RunnerCloudDeps } from "./http.js";

/**
 * D#845 MC-9b2d: what a move that carries the team's memory checks and writes (the storage is migration 1123). A tick that cannot be honoured is refused, never dropped: 409 `state_carry_unavailable` with one closed `reason`
 * (a body field beside the error), in this order: `source_removed` (the old machine was removed, so it can hand nothing over), `no_session` (it never ran this engine), `runner_update_needed` (either machine's last hello
 * lacks `engine_carry_v1`) and `machine_kek_unset` (the cloud cannot seal; probed with a one-byte seal, nothing stored). Every query names the account, on top of row security.
 */
export type CarryRefusalReason = "source_removed" | "no_session" | "runner_update_needed" | "machine_kek_unset";

const NO_CARRY = "00000000-0000-4000-8000-000000000000";
const unavailable = (reason: CarryRefusalReason): RunnerHttpError =>
  new RunnerHttpError(409, "state_carry_unavailable", "carrying the team's memory to the new machine is not available for this move", { reason });

/** The repo's open carry (open until it is imported, abandoned, retried or cancelled, failed or not), if any. */
export async function openCarry(client: PoolClient, accountId: string, repoId: string): Promise<{ id: string } | null> {
  return (await client.query<{ id: string }>("SELECT id FROM state_carries WHERE account_id = $1 AND repo_id = $2 AND closed_at IS NULL", [accountId, repoId])).rows[0] ?? null;
}

/** Whether every one of these machines' last hello lists the carry capability, and the cloud can seal. */
export async function requireCarryReady(client: PoolClient, deps: RunnerCloudDeps, accountId: string, runnerIds: readonly string[]): Promise<void> {
  const capable = (await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM runner_capabilities WHERE account_id = $1 AND runner_id = ANY ($2::uuid[]) AND $3::text = ANY (capabilities)", [accountId, runnerIds, ENGINE_CARRY_CAPABILITY],
  )).rows[0]!.n;
  if (capable !== new Set(runnerIds).size) throw unavailable("runner_update_needed");
  try {
    if (!deps.stateCarrySealer) throw new Error("no sealer");
    deps.stateCarrySealer.seal({ accountId, carryId: NO_CARRY, index: 0 }, new Uint8Array(1));
  } catch {
    // fx-swallow-ok: any failure of a one-byte seal is the unset key (the cipher's error names key material and is never kept)
    throw unavailable("machine_kek_unset");
  }
}

/** The gates of a first carry move: the old machine must exist and have run this engine, then both machines and the cloud must be able. */
export async function requireCarryMove(client: PoolClient, deps: RunnerCloudDeps, accountId: string, m: { removed: boolean; ran: boolean; from: string; to: string }): Promise<void> {
  if (m.removed) throw unavailable("source_removed");
  if (!m.ran) throw unavailable("no_session");
  await requireCarryReady(client, deps, accountId, [m.from, m.to]);
}

export const carryPending = (): RunnerHttpError => new RunnerHttpError(409, "carry_pending", "the team's memory is still being moved; wait for it, or start without it");
