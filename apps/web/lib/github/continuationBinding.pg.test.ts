import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InstallationHttp } from "@fx/github";
import { runMigrations } from "@fx/db/src/migrate.js";
import { provisionEphemeralPostgres, type EphemeralPostgres } from "@fx/db/test/support/ephemeral-pg.js";
import { guardedPools } from "@fx/db/test/support/pool-teardown.js";
import { createAppContinuationBinding } from "./continuationBinding";

/**
 * [pg] D#599 PL-2b-2: the adapter's DEFAULT stored-repository-id query, on the platform_ops login it really runs as (the stub in continuationBinding.test.ts
 * does not exercise the column grant, the row policy or the bigint-as-string answer). The fork check compares against this id, so it must read the row
 * the repository was stored with and nothing for an unknown repository.
 */
describe("the default storedGhRepoId query [pg]", () => {
  let pg: EphemeralPostgres;
  const pools = guardedPools();
  let adminPool: Pool;
  let opsPool: Pool;
  const GH_ID = 9_007_199_254; // above int4, so node-postgres answers a bigint string
  let repoId: string;

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: "fx_web_binding_test", tmpPrefix: "fx-web-binding-" });
    adminPool = pools.create(pg.url);
    await runMigrations(adminPool);
    opsPool = pools.create(pg.platformOpsUrl);
    const accountId = randomUUID();
    const installationId = randomUUID();
    repoId = randomUUID();
    await adminPool.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await adminPool.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, 5151, 'team')`, [installationId, accountId]);
    await adminPool.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', 'widgets')`, [repoId, accountId, installationId, GH_ID]);
  }, 180_000);
  afterAll(async () => {
    // Pools end and their sockets close before the cluster stops, so no pool is left to hear its 57P01.
    await pools.stop(() => pg?.cleanup());
  });

  const open = async (): Promise<InstallationHttp> => ({
    request: async () => ({ status: 200, body: [{ number: 41, state: "open", head: { ref: "fx/issue-12", repo: { id: GH_ID } } }] }),
  });
  const port = () => createAppContinuationBinding({ open, pool: () => opsPool });

  it("reports OUR stored GitHub repository id (a bigint) as the base, as platform_ops", async () => {
    const out = await port().pullRequestsByHead({ repo: { id: repoId, owner: "acme", name: "widgets", local: false }, branch: "fx/issue-12" });
    expect(out).toEqual({ status: 200, pulls: [{ number: 41, state: "open", headRepoId: GH_ID, baseRepoId: GH_ID, headRef: "fx/issue-12" }] });
  });

  it("answers 404 and asks GitHub nothing for a repository we do not hold", async () => {
    let asked = false;
    const p = createAppContinuationBinding({ open: async () => ((asked = true), open()), pool: () => opsPool });
    expect(await p.pullRequestsByHead({ repo: { id: randomUUID(), owner: "acme", name: "widgets", local: false }, branch: "fx/issue-12" })).toEqual({ status: 404 });
    expect(asked).toBe(false);
  });

  it("a head repository that is not the stored one never matches", async () => {
    const other = createAppContinuationBinding({ open: async () => ({ request: async () => ({ status: 200, body: [{ number: 41, state: "open", head: { ref: "fx/issue-12", repo: { id: 1234 } } }] }) }), pool: () => opsPool });
    const out = await other.pullRequestsByHead({ repo: { id: repoId, owner: "acme", name: "widgets", local: false }, branch: "fx/issue-12" });
    expect(out.pulls?.[0]).toMatchObject({ headRepoId: 1234, baseRepoId: GH_ID });
  });
});
