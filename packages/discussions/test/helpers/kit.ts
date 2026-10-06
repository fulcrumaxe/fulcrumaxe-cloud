import { randomUUID, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { seedAccount, seedMember, seedUser, seedWorkItem, seedAgentRun } from "./seed.js";
import { systemPrincipal } from "../../src/server.js";
import type { DiscussionsContext, Principal } from "../../src/principals.js";

export interface Tenant {
  accountId: string;
  owner: Principal;
  admin: Principal;
  member: Principal;
  tokenWrite: Principal;
  tokenRead: Principal;
  system: Principal;
}

/** One seeded tenant with every non-run principal kind this package's
 * operation table distinguishes. Shared by PR-b's [pg] test files. */
export async function seedTenant(admin: PoolClient): Promise<Tenant> {
  const accountId = randomUUID();
  const [ownerId, adminId, memberId] = [randomUUID(), randomUUID(), randomUUID()];
  await seedAccount(admin, accountId);
  for (const [id, role] of [
    [ownerId, "owner"],
    [adminId, "admin"],
    [memberId, "member"],
  ] as const) {
    await seedUser(admin, id);
    await seedMember(admin, accountId, id, role);
  }
  return {
    accountId,
    owner: { kind: "session", accountId, userId: ownerId, role: "owner" },
    admin: { kind: "session", accountId, userId: adminId, role: "admin" },
    member: { kind: "session", accountId, userId: memberId, role: "member" },
    tokenWrite: { kind: "token", accountId, userId: memberId, tokenId: randomUUID(), scopes: ["read", "write"] },
    tokenRead: { kind: "token", accountId, userId: memberId, tokenId: randomUUID(), scopes: ["read"] },
    system: systemPrincipal(accountId, "test"),
  };
}

export function ctxFor(pool: Pool, principal: Principal): DiscussionsContext {
  return { pool, principal };
}

/** A work item at `stage`, seeded with the admin connection (no
 * transition row), for tests that need a starting stage. */
export async function seedWorkItemAt(
  admin: PoolClient,
  accountId: string,
  stage: string,
  opts: { provenance?: "internal" | "external"; parentId?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await seedWorkItem(admin, accountId, id, { provenance: opts.provenance });
  await admin.query(`UPDATE work_items SET stage = $2, parent_id = $3 WHERE id = $1`, [
    id,
    stage,
    opts.parentId ?? null,
  ]);
  return id;
}

export async function seedRunOn(
  admin: PoolClient,
  accountId: string,
  workItemId: string | null,
  opts: { specVersionId?: string | null; role?: string } = {},
): Promise<Principal & { kind: "run" }> {
  const runId = randomUUID();
  if (opts.specVersionId) {
    // spec_version_id is set at INSERT: 0642 froze it after insert (for
    // every role, superuser included), so the old INSERT-then-UPDATE
    // shape is refused. Same row the seedAgentRun call below produces.
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, spec_version_id)
       VALUES ($1, $2, $3, $4, 'production', 'running', $5)`,
      [runId, accountId, workItemId, opts.role ?? "executor", opts.specVersionId],
    );
  } else {
    await seedAgentRun(admin, accountId, runId, { workItemId, role: opts.role });
  }
  return { kind: "run", accountId, runId };
}

export async function count(admin: PoolClient, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) q`, params);
  return Number(rows[0]!.n);
}

/** A Spec version inserted with the admin connection (no stage change, no
 * event), for fixtures that need an item to already have a Spec. */
export async function seedSpecVersion(
  admin: PoolClient,
  accountId: string,
  workItemId: string,
  version = 1,
  body = `fixture spec v${version}`,
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind)
     VALUES ($1, $2, $3, $4, $5, 'system') RETURNING id`,
    [accountId, workItemId, version, body, createHash("sha256").update(body, "utf8").digest("hex")],
  );
  return rows[0]!.id;
}

/** Points `child.parent_id` at `parentId`, bypassing the FK triggers, so a
 * fixture can name a parent row that does not exist (superuser only). */
export async function forceParentId(admin: PoolClient, childId: string, parentId: string): Promise<void> {
  await admin.query("BEGIN");
  try {
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(`UPDATE work_items SET parent_id = $2 WHERE id = $1`, [childId, parentId]);
    await admin.query("COMMIT");
  } catch (err) {
    await admin.query("ROLLBACK");
    throw err;
  }
}
