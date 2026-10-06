import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import type { DiscussionsContext } from "./principals.js";
import { accountIdOf } from "./principals.js";
import { assertAllowed, assertUuidOrNotFound, rejectAccountIdInInput, DiscussionsError } from "./operations.js";

export interface DependencyInput {
  workItemId: string;
  dependsOnId: string;
}

/** Both ends must be work items of the caller's tenant; RLS makes
 * another tenant's id read as missing, same as a nonexistent one. */
async function requireBothWorkItems(client: PoolClient, a: string, b: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM work_items WHERE id = ANY($1::uuid[])`, [[a, b]]);
  if (rows.length !== 2) {
    throw new NotFoundError("work item not found");
  }
}

/** `deps.add`: refuses a self-dependency and any cycle (2-cycle or
 * longer) with `dependency_cycle`, and writes no row when it does. A
 * per-account advisory lock serializes concurrent adds, so two calls
 * that would close a cycle between them can't both pass the check. A
 * repeat of an existing dependency is a no-op. */
export async function addDependency(ctx: DiscussionsContext, input: DependencyInput): Promise<void> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "deps.add");
  const workItemId = assertUuidOrNotFound(input.workItemId, "work item");
  const dependsOnId = assertUuidOrNotFound(input.dependsOnId, "work item");
  if (workItemId.toLowerCase() === dependsOnId.toLowerCase()) {
    throw new DiscussionsError("dependency_cycle", "a work item cannot depend on itself");
  }

  await withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `work_item_deps:${accountIdOf(ctx.principal)}`,
    ]);
    await requireBothWorkItems(client, workItemId, dependsOnId);

    // Adding workItem -> dependsOn closes a cycle iff workItem is already
    // reachable by following dependencies out of dependsOn.
    const { rows } = await client.query(
      `WITH RECURSIVE reach(id) AS (
         SELECT depends_on_id FROM work_item_deps WHERE work_item_id = $1
         UNION
         SELECT d.depends_on_id FROM work_item_deps d JOIN reach r ON d.work_item_id = r.id
       )
       SELECT 1 FROM reach WHERE id = $2`,
      [dependsOnId, workItemId],
    );
    if (rows.length > 0) {
      throw new DiscussionsError("dependency_cycle", "this dependency would create a cycle");
    }

    await client.query(
      `INSERT INTO work_item_deps (account_id, work_item_id, depends_on_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [accountIdOf(ctx.principal), workItemId, dependsOnId],
    );
  });
}

/** `deps.remove`. A dependency that isn't there reads as NotFoundError. */
export async function removeDependency(ctx: DiscussionsContext, input: DependencyInput): Promise<void> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "deps.remove");
  const workItemId = assertUuidOrNotFound(input.workItemId, "work item");
  const dependsOnId = assertUuidOrNotFound(input.dependsOnId, "work item");

  await withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM work_item_deps WHERE work_item_id = $1 AND depends_on_id = $2`,
      [workItemId, dependsOnId],
    );
    if (!rowCount) {
      throw new NotFoundError("dependency not found");
    }
  });
}
