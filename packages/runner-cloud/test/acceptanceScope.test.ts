import { describe, expect, it } from "vitest";
import * as core from "@fx/core/src/specs/acceptanceScope.js";
import { widenForCheckFix } from "../src/done.js";
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

describe("widenForCheckFix (D#6 CHECK-FIX-SCOPE): done holds a check-fix round to the Spec's list plus the files its signed job names", () => {
  const spec = core.parseAcceptanceScope(["packages/spend/src/**", "docs/a.md"]);
  const FILE = "packages/example/test/sample.pg.test.ts";
  const job = (over: Record<string, unknown>) => ({ ...over }) as never;
  const entriesOf = (s: { kind: string; entries?: readonly string[] }) => (s.kind === "known" ? s.entries : undefined);
  it("adds the plain files of a check_fix job's scope that the Spec does not already hold", () => {
    const out = widenForCheckFix(spec, job({ fix_round_kind: "check_fix", scope: ["packages/spend/src/**", "docs/a.md", FILE] }));
    expect(entriesOf(out)).toEqual([...entriesOf(spec)!, FILE]);
  });
  it("a job of any other kind, with no scope, or no job, changes nothing", () => {
    expect(widenForCheckFix(spec, job({ fix_round_kind: "review_fix", scope: [FILE] }))).toBe(spec);
    expect(widenForCheckFix(spec, job({ scope: [FILE] }))).toBe(spec);
    expect(widenForCheckFix(spec, job({ fix_round_kind: "check_fix" }))).toBe(spec);
    expect(widenForCheckFix(spec, null)).toBe(spec);
  });
  it("an unread Spec list stays unread", () => {
    const unknown = { kind: "unknown", reason: "absent" } as const;
    expect(widenForCheckFix(unknown, job({ fix_round_kind: "check_fix", scope: [FILE] }))).toBe(unknown);
  });
  it("globs, dot segments and an absolute path in the job are not added, and at most 20 are", () => {
    const out = widenForCheckFix(spec, job({ fix_round_kind: "check_fix", scope: ["other/**", "a/../b.ts", "/x.ts", "a/*.ts", FILE] }));
    expect(entriesOf(out)!.slice(2)).toEqual([FILE]);
    const many = Array.from({ length: 40 }, (_v, n) => `p/test/t${String(n).padStart(2, "0")}.ts`);
    expect(entriesOf(widenForCheckFix(spec, job({ fix_round_kind: "check_fix", scope: many })))!.length).toBe(2 + 20);
  });
});
