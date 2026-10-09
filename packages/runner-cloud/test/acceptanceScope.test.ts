import { describe, expect, it } from "vitest";
import * as core from "@fx/core/src/specs/acceptanceScope.js";
import { loadAcceptanceScope, parseAcceptanceScope, pathInScope, pathsOutsideScope, type TenantQueryable } from "../src/acceptanceScope.js";

/** D#6 R2b-3e (C21 section 5): the loader. The matcher's own cases moved to packages/core with the parser (R4d-5a, C34 section 1.4). */
const UNKNOWN = { kind: "unknown" };

describe("the re-export", () => {
  it("is the core parser and matcher themselves, not a copy", () => {
    expect(parseAcceptanceScope).toBe(core.parseAcceptanceScope);
    expect(pathInScope).toBe(core.pathInScope);
    expect(pathsOutsideScope).toBe(core.pathsOutsideScope);
  });
});

describe("loadAcceptanceScope", () => {
  const ids = { accountId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222" };
  const queryable = (rows: Array<{ acceptance_files: unknown }>) => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const client: TenantQueryable = { query: async (sql, params) => (seen.push({ sql, params }), { rows: rows as never[] }) };
    return { client, seen };
  };

  it("reads the list from the run's own spec version, by account and run, and parses it", async () => {
    const q = queryable([{ acceptance_files: ["src/**"] }]);
    expect(await loadAcceptanceScope(q.client, ids)).toEqual({ kind: "known", entries: ["src/**"] });
    expect(q.seen[0]!.params).toEqual([ids.accountId, ids.runId]);
    expect(q.seen[0]!.sql).toMatch(/ar\.account_id = \$1 AND ar\.id = \$2/);
    expect(q.seen[0]!.sql).toMatch(/sv\.id = ar\.spec_version_id/);
    expect(q.seen[0]!.sql).toMatch(/sv\.erased_at IS NULL/);
  });

  it("no row (no spec version, an erased one, another account's run), a null list and a bad list are unknown, with the reason", async () => {
    expect(await loadAcceptanceScope(queryable([]).client, ids)).toEqual({ ...UNKNOWN, reason: "unreadable" });
    expect(await loadAcceptanceScope(queryable([{ acceptance_files: null }]).client, ids)).toEqual({ ...UNKNOWN, reason: "absent" });
    expect(await loadAcceptanceScope(queryable([{ acceptance_files: [] }]).client, ids)).toEqual({ ...UNKNOWN, reason: "absent" });
    expect(await loadAcceptanceScope(queryable([{ acceptance_files: ["a/{b}"] }]).client, ids)).toEqual({ ...UNKNOWN, reason: "unreadable" });
    expect(await loadAcceptanceScope(queryable([{ acceptance_files: "src/a.ts" }]).client, ids)).toEqual({ ...UNKNOWN, reason: "unreadable" });
    expect(await loadAcceptanceScope(queryable([{ acceptance_files: ["a.ts"] }, { acceptance_files: ["b.ts"] }]).client, ids)).toEqual({ ...UNKNOWN, reason: "unreadable" });
  });
});
