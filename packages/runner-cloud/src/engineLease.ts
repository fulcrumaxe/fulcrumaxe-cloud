import type { PoolClient } from "pg";
import { reportError } from "@fx/telemetry";
import { ENGINE_LEASE_HELLO_CAPABILITY, ENGINE_LEASE_RETRY_AFTER_MAX_SECONDS, type EngineLease } from "@fulcrumaxe/runner-protocol";
import type { RunnerCloudDeps } from "./http.js";

/**
 * D#845 ON-13c3: the engine session lease, as the claim and heartbeat routes use it. A runner that reports its `fx-engine-<gh_id>` sandbox running renews a 15 minute lease through `engine_lease_renew` (migration 1092), which
 * writes only while the cloud's own rows still allow the session. The answer is the runner's live lease, said to it only when its latest hello listed `engine_lease_v1` and this database has the function: any other runner is
 * neither renewed nor told anything, so an older runner or an older cloud never sees the field and never self-stops.
 */

/** True when migration 1092 is applied. Read from the catalog, never assumed from the code's version; a failed read says no, so the capability is not listed. */
export async function runnersTakeEngineLease(deps: RunnerCloudDeps): Promise<boolean> {
  try {
    const { rows } = await deps.appUserPool.query<{ ok: boolean }>("SELECT to_regproc('public.engine_lease_renew') IS NOT NULL AS ok");
    return rows[0]?.ok === true;
  } catch {
    // fx-swallow-ok: a catalog read that fails says nothing about the function: the capability is simply not listed
    return false;
  }
}

/** The shortest `retry_after` that keeps a runner within reach of its next renewal while it holds a lease. */
export const clampRetryAfter = (seconds: number, lease: EngineLease | null): number => (lease === null ? seconds : Math.min(seconds, ENGINE_LEASE_RETRY_AFTER_MAX_SECONDS));

/**
 * Renews what the runner reports running and answers the lease it holds now (the one that ends last when two are live), or null: not declared, no migration, or none held. Runs in the runner's own session.
 * `sandboxes` is the inventory this request carried (undefined: none, so nothing is renewed and the held lease is only read back).
 */
export async function engineLeaseFor(client: PoolClient, runnerId: string, sandboxes: ReadonlyArray<{ name: string; state: string }> | undefined): Promise<EngineLease | null> {
  // A savepoint, so a failure here costs the lease answer and never the claim or heartbeat whose transaction this is.
  await client.query("SAVEPOINT engine_lease");
  try {
    const on = await client.query<{ on: boolean }>("SELECT to_regproc('public.engine_lease_renew') IS NOT NULL AND COALESCE((SELECT $2::text = ANY (capabilities) FROM runner_capabilities WHERE runner_id = $1), false) AS on", [runnerId, ENGINE_LEASE_HELLO_CAPABILITY]);
    if (on.rows[0]?.on !== true) return await released(client, null);
    const names = (sandboxes ?? []).filter((s) => s.state === "running").map((s) => s.name);
    const held = await client.query<{ o_repo_gh_id: string; o_epoch: number; o_until: Date }>("SELECT o_repo_gh_id, o_epoch, o_until FROM engine_lease_renew($1::text[]) ORDER BY o_until DESC LIMIT 1", [names]);
    const row = held.rows[0];
    return await released(client, row === undefined ? null : { repo_gh_id: Number(row.o_repo_gh_id), operate_epoch: row.o_epoch, until: row.o_until.toISOString() });
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT engine_lease");
    reportError(error, { stage: "runner.engine_lease", route: "engine_lease" });
    return null;
  }
}

async function released<T>(client: PoolClient, value: T): Promise<T> {
  await client.query("RELEASE SAVEPOINT engine_lease");
  return value;
}
