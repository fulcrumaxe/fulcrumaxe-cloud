import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { IdempotencyKeyTakenError, insertAgentRun, writeRunStatusOn } from "./runStatusWriter.js";

/**
 * D#483 S5-b2c: the run that stands for the publication of a Spec that plans several pull requests. A planned PR child is launched from a receipt or an ask that names a
 * run of the parent pinned to the approved Spec version (`gateChildLaunch`'s anchor), and `agent_runs.spec_version_id` is written at insert only. The run that writes a
 * Spec (the short Spec's project-manager run, or the panel's) starts before its Spec exists, so it pins nothing, and the parent of a split never runs an executor (the only
 * other run that pins a version). So the publish records this one, for the short Spec and the panel Spec alike: a project-manager run pinned to the version it published,
 * created already finished (it ran nothing and spent nothing).
 * Created and finished in ONE transaction (no run is left live), and keyed by the version, so a replay of the publish step, or a crash between the publish and this,
 * leaves exactly one.
 */
/** The anchor run's fixed summary, shown in Runs and activity: no model text, no value. */
export const SPEC_ANCHOR_SUMMARY = "Recorded the approved Spec version so its planned pull requests can start. No work was run.";

export async function ensureSpecAnchorRun(pool: Pool, input: { accountId: string; workItemId: string; specVersionId: string }): Promise<void> {
  const { accountId, workItemId, specVersionId } = input;
  const has = await withTenant(pool, accountId, async (client) =>
    (await client.query("SELECT 1 FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND spec_version_id = $3 LIMIT 1", [accountId, workItemId, specVersionId])).rows.length > 0,
  );
  if (has) return;
  try {
    await insertAgentRun(pool, {
      id: randomUUID(),
      accountId,
      workItemId,
      role: "project-manager",
      runtime: "production",
      specVersionId,
      idempotency: { key: `spec-anchor:${specVersionId}`, requestHash: createHash("sha256").update(`spec-anchor:${specVersionId}`).digest("hex") },
      inCreateTransaction: async (client, runId) => {
        await writeRunStatusOn(client, { accountId, runId, from: "pending", to: "running" });
        await writeRunStatusOn(client, { accountId, runId, from: "running", to: "succeeded", result: { envelope: { summary: SPEC_ANCHOR_SUMMARY } } });
      },
    });
  } catch (err) {
    // A concurrent publish step created it first: the key is taken, and the run exists.
    if (!(err instanceof IdempotencyKeyTakenError)) throw err;
  }
}
