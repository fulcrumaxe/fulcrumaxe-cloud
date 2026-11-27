import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPendingHooks } from "@fx/core/src/pendingWork";
import { makeRegion, storeOf, type FakeRegion } from "../test/support/runtimeCacheFake";
import { wakeTwinParity } from "./twinParityWake";

/**
 * D#845 ON-27d1: the webhook's twin mark. Which twins a push concerns (both repos of a twin, the account fence, the sibling twin, the states) is packages/core/test/repos/twinParityDue.pg.test.ts with real rows; here are the payload
 * rules and the promises of this layer: it makes no outbound call, hands the marker exactly the twins found and the account they belong to, and wakes the sweep only when something was marked.
 */
const clock = { value: Date.parse("2026-11-26T12:00:00Z") };
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const REPO = "22222222-2222-4222-8222-222222222222";
const TWIN = "33333333-3333-4333-8333-333333333333";
const push = (over: { ref?: string; default_branch?: string; full_name?: string } = {}) => ({
  ref: over.ref ?? "refs/heads/main",
  repository: { full_name: over.full_name ?? "acme/widgets", default_branch: over.default_branch ?? "main" },
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

function fakePool(twinIds: string[]) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: vi.fn(async (sql: string, params: unknown[] = []) => (statements.push({ sql, params }), { rows: /FROM repo_twins/.test(sql) ? twinIds.map((id) => ({ id })) : [], rowCount: 0 })), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, statements };
}
const event = (payload: unknown, name = "push", repoId = REPO) => ({ accountId: ACCOUNT, repoId, eventName: name as never, payload: payload as never });
const woken = (): boolean => region.entries.has("pending:setup-request-check");

describe("wakeTwinParity", () => {
  it("a default-branch push of either repo hands the marker the twins found and their account, makes no outbound call and wakes the sweep", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no outbound call in the webhook"));
    const { pool, statements } = fakePool([TWIN]);
    const markDue = vi.fn(async () => 1);
    expect(await wakeTwinParity(pool, event(push()), markDue)).toBe(1);
    const lookup = statements.filter((s) => /FROM repo_twins/.test(s.sql));
    expect(lookup).toHaveLength(1);
    expect(lookup[0]!.params.slice(0, 3)).toEqual([ACCOUNT, REPO, "acme/widgets"]);
    expect(markDue).toHaveBeenCalledTimes(1);
    expect(markDue).toHaveBeenCalledWith(expect.anything(), { accountId: ACCOUNT, twinIds: [TWIN] });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(woken()).toBe(true);
  });

  it("a push no twin concerns marks nothing and does not wake the sweep", async () => {
    const { pool } = fakePool([]);
    const markDue = vi.fn(async () => 1);
    expect(await wakeTwinParity(pool, event(push()), markDue)).toBe(0);
    expect(markDue).not.toHaveBeenCalled();
    expect(woken()).toBe(false);
  });

  it("a marker that marked nothing does not wake the sweep either", async () => {
    const { pool } = fakePool([TWIN]);
    expect(await wakeTwinParity(pool, event(push()), async () => 0)).toBe(0);
    expect(woken()).toBe(false);
  });

  it("another branch, a tag, another event and a payload that is not a push do nothing, and the database is not opened", async () => {
    const { pool } = fakePool([TWIN]);
    const markDue = vi.fn(async () => 1);
    for (const e of [event(push({ ref: "refs/heads/feature" })), event(push({ ref: "refs/tags/main" })), event(push(), "pull_request"), event(null), event(push({ full_name: "not a name" }))]) expect(await wakeTwinParity(pool, e, markDue)).toBe(0);
    expect(markDue).not.toHaveBeenCalled();
    expect((pool as unknown as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
  });

  it("a delivery with no repos row still finds twins by the repository's name", async () => {
    const { pool, statements } = fakePool([TWIN]);
    expect(await wakeTwinParity(pool, event(push(), "push", ""), async () => 1)).toBe(1);
    expect(statements.find((s) => /FROM repo_twins/.test(s.sql))!.params.slice(0, 3)).toEqual([ACCOUNT, null, "acme/widgets"]);
  });
});
