import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createAppRepoVisibility } from "./repoVisibility";

/** D#6 R3b: the app's repository-visibility wiring: our own `repos` row for the coordinates, the read token for the call. */
const REPO = { accountId: "11111111-1111-4111-8111-111111111111", repoId: "22222222-2222-4222-8222-222222222222" };

function fakePool(row: { gh_owner: string | null; gh_name: string | null } | null) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: async (sql: string, params: unknown[] = []) => (queries.push({ sql, params }), { rows: /FROM repos/.test(sql) && row ? [row] : [] }), release: () => undefined };
  const pool = { connect: async () => client, query: client.query } as unknown as Pool;
  return { pool, queries };
}

describe("createAppRepoVisibility", () => {
  it("asks for the repo by id AND account, opens a read client for that repo, and reads private from GitHub", async () => {
    const f = fakePool({ gh_owner: "acme", gh_name: "widgets" });
    const opened: unknown[] = [];
    const port = createAppRepoVisibility({
      pool: () => f.pool,
      open: async (kind, target) => (opened.push([kind, target]), { request: async () => ({ status: 200, body: { full_name: "acme/widgets", private: true } }) }),
    });
    expect(await port.visibility(REPO)).toBe("private");
    expect(opened).toEqual([["read", { repoId: REPO.repoId, owner: "acme", name: "widgets" }]]);
    const q = f.queries.find((x) => /FROM repos/.test(x.sql))!;
    expect(q.sql).toMatch(/id = \$1 AND account_id = \$2/);
    expect(q.params).toEqual([REPO.repoId, REPO.accountId]);
  });

  it("a repo with no row, no owner or no name, or no installation, is unknown", async () => {
    for (const row of [null, { gh_owner: null, gh_name: "w" }, { gh_owner: "a", gh_name: null }]) {
      const f = fakePool(row);
      const port = createAppRepoVisibility({ pool: () => f.pool, open: async () => ({ request: async () => ({ status: 200, body: { full_name: "a/w", private: true } }) }) });
      expect(await port.visibility(REPO), JSON.stringify(row)).toBe("unknown");
    }
    const f = fakePool({ gh_owner: "acme", gh_name: "widgets" });
    const port = createAppRepoVisibility({ pool: () => f.pool, open: async () => { throw new Error("no_installation"); } });
    expect(await port.visibility(REPO)).toBe("unknown");
  });

  it("a public repository is public, and a database failure is unknown", async () => {
    const f = fakePool({ gh_owner: "acme", gh_name: "widgets" });
    const open = async () => ({ request: async () => ({ status: 200, body: { full_name: "acme/widgets", private: false } }) });
    expect(await createAppRepoVisibility({ pool: () => f.pool, open }).visibility(REPO)).toBe("public");
    const down = { connect: async () => { throw new Error("db down"); } } as unknown as Pool;
    expect(await createAppRepoVisibility({ pool: () => down, open }).visibility(REPO)).toBe("unknown");
  });
});
