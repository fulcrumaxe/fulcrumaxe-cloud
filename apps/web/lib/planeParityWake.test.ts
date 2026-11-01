import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPendingHooks } from "@fx/core/src/pendingWork";
import { makeRegion, storeOf, type FakeRegion } from "../test/support/runtimeCacheFake";
import { readDefaultBranchPush, wakePlaneParity } from "./planeParityWake";

/**
 * D#598 P1d-3: the webhook's parity mark. The SQL itself (pairing lookup, the 60 second time, keeping the earlier one) is packages/core/test/repos/planeParityChecks.pg.test.ts;
 * here are the payload rules and the two promises of this layer: it makes no outbound call, and it wakes the sweep only when a pairing was marked.
 */
const clock = { value: Date.parse("2026-11-01T12:00:00Z") };
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const REPO = "22222222-2222-4222-8222-222222222222";
const push = (over: { ref?: string; default_branch?: string; full_name?: unknown } = {}) => ({
  ref: over.ref ?? "refs/heads/main",
  repository: { full_name: "acme/widgets", default_branch: over.default_branch ?? "main", ...(over.full_name === undefined ? {} : { full_name: over.full_name }) },
  commits: [],
});

let region: FakeRegion;
beforeEach(() => {
  region = makeRegion(clock);
  setPendingHooks({ store: storeOf(region) });
});
afterEach(() => {
  setPendingHooks(null);
  vi.restoreAllMocks();
});

function fakePool(rowCount: number) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: vi.fn(async (sql: string, params: unknown[] = []) => (statements.push({ sql, params }), { rows: [], rowCount: /plane_parity_checks/.test(sql) ? rowCount : 0 })), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, statements };
}
const event = (payload: unknown, name = "push") => ({ accountId: ACCOUNT, repoId: REPO, eventName: name as never, payload: payload as never });

describe("readDefaultBranchPush", () => {
  it("reads the full name of a push to the default branch, whatever that branch is called", () => {
    expect(readDefaultBranchPush("push", push())).toBe("acme/widgets");
    expect(readDefaultBranchPush("push", push({ ref: "refs/heads/trunk", default_branch: "trunk" }))).toBe("acme/widgets");
  });
  it("reads nothing from another branch, a tag, another event, or a payload that is not shaped like a push", () => {
    expect(readDefaultBranchPush("push", push({ ref: "refs/heads/feature" }))).toBeNull();
    expect(readDefaultBranchPush("push", push({ ref: "refs/tags/main" }))).toBeNull();
    expect(readDefaultBranchPush("pull_request", push())).toBeNull();
    expect(readDefaultBranchPush("push", push({ full_name: "not a name" }))).toBeNull();
    expect(readDefaultBranchPush("push", push({ default_branch: "" , ref: "refs/heads/" }))).toBeNull();
    for (const bad of [null, "x", 3, {}, { ref: "refs/heads/main" }, { ref: 1, repository: {} }]) expect(readDefaultBranchPush("push", bad)).toBeNull();
  });
});

describe("wakePlaneParity", () => {
  it("a default-branch push marks the pairing and wakes the sweep, with no outbound call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no outbound call in the webhook"));
    const { pool, statements } = fakePool(1);
    expect(await wakePlaneParity(pool, event(push()))).toBe(1);
    const mark = statements.filter((s) => /INSERT INTO plane_parity_checks/.test(s.sql));
    expect(mark).toHaveLength(1);
    expect(mark[0]!.params.slice(0, 3)).toEqual([ACCOUNT, REPO, "acme/widgets"]);
    expect(region.entries.has("pending:setup-request-check")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an unpaired repo (nothing marked) does not wake the sweep", async () => {
    const { pool } = fakePool(0);
    expect(await wakePlaneParity(pool, event(push()))).toBe(0);
    expect(region.entries.has("pending:setup-request-check")).toBe(false);
  });

  it("another branch or another event opens no connection at all", async () => {
    const { pool } = fakePool(1);
    expect(await wakePlaneParity(pool, event(push({ ref: "refs/heads/feature" })))).toBe(0);
    expect(await wakePlaneParity(pool, event(push(), "pull_request"))).toBe(0);
    expect((pool as unknown as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
  });

  it("a delivery with no repository row of its own (the public repo of a pairing) marks by the pushed full name alone", async () => {
    const { pool, statements } = fakePool(1);
    await wakePlaneParity(pool, { ...event(push()), repoId: "" });
    expect(statements.find((s) => /INSERT INTO plane_parity_checks/.test(s.sql))!.params.slice(0, 3)).toEqual([ACCOUNT, null, "acme/widgets"]);
  });
});
