import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPendingHooks } from "@fx/core/src/pendingWork";
import { makeRegion, storeOf, type FakeRegion } from "../test/support/runtimeCacheFake";
import { instructionFilesChangedByPush, wakeRepoInstructionImport, wakeRepoInstructionImportOnConnect } from "./repoInstructionWake";

/**
 * D#601 MEM-5b: the webhook's and the connect path's mark for the repo instruction file import. The SQL is packages/core/test/memory-repo-file-sweep.pg.test.ts; here are the
 * payload rules and the promises of this layer: no outbound call, and the sweep is woken only when a row was marked.
 */
const clock = { value: Date.parse("2026-11-06T12:00:00Z") };
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const REPO = "22222222-2222-4222-8222-222222222222";
const push = (commits: unknown, over: { ref?: string } = {}) => ({ ref: over.ref ?? "refs/heads/main", repository: { full_name: "acme/widgets", default_branch: "main" }, commits });
const commit = (c: { added?: string[]; modified?: string[]; removed?: string[] }) => ({ added: [], modified: [], removed: [], ...c });

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
  const client = { query: vi.fn(async (sql: string, params: unknown[] = []) => (statements.push({ sql, params }), { rows: [], rowCount: /repo_instruction_files/.test(sql) ? rowCount : 0 })), release: vi.fn() };
  return { pool: { connect: vi.fn(async () => client) } as unknown as Pool, statements };
}
const event = (payload: unknown, name = "push", repoId = REPO) => ({ accountId: ACCOUNT, repoId, eventName: name as never, payload: payload as never });
const marks = (s: Array<{ sql: string; params: unknown[] }>) => s.filter((x) => /INSERT INTO repo_instruction_files/.test(x.sql));

describe("instructionFilesChangedByPush", () => {
  it("names the root instruction files a default-branch push added, modified or removed, once each", () => {
    expect(instructionFilesChangedByPush("push", push([commit({ modified: ["CLAUDE.md"] })]))).toEqual(["CLAUDE.md"]);
    expect(instructionFilesChangedByPush("push", push([commit({ added: ["AGENTS.md"] }), commit({ removed: ["CLAUDE.md"] }), commit({ modified: ["AGENTS.md"] })]))).toEqual(["CLAUDE.md", "AGENTS.md"]);
  });
  it("names nothing for other paths (a nested file, another case), another branch, another event, or a payload that is not a push", () => {
    expect(instructionFilesChangedByPush("push", push([commit({ modified: ["docs/CLAUDE.md", "claude.md", "README.md", "CLAUDE.md.bak"] })]))).toEqual([]);
    expect(instructionFilesChangedByPush("push", push([commit({ modified: ["CLAUDE.md"] })], { ref: "refs/heads/feature" }))).toEqual([]);
    expect(instructionFilesChangedByPush("pull_request", push([commit({ modified: ["CLAUDE.md"] })]))).toEqual([]);
    for (const bad of [null, "x", {}, push(undefined), push("CLAUDE.md"), push([null, 3, { added: "CLAUDE.md" }])]) expect(instructionFilesChangedByPush("push", bad)).toEqual([]);
  });
  it("a push listing as many commits as GitHub shows at most may have hidden some, so both files are marked", () => {
    expect(instructionFilesChangedByPush("push", push(Array.from({ length: 20 }, () => commit({}))))).toEqual(["CLAUDE.md", "AGENTS.md"]);
    expect(instructionFilesChangedByPush("push", push(Array.from({ length: 19 }, () => commit({}))))).toEqual([]);
  });
});

describe("wakeRepoInstructionImport", () => {
  it("marks the changed file and wakes the sweep, with no outbound call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no outbound call in the webhook"));
    const { pool, statements } = fakePool(1);
    expect(await wakeRepoInstructionImport(pool, event(push([commit({ modified: ["AGENTS.md"] })])))).toBe(1);
    expect(marks(statements)).toHaveLength(1);
    expect(marks(statements)[0]!.params).toEqual([ACCOUNT, [REPO], ["AGENTS.md"], 60]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(region.entries.has("pending:setup-request-check")).toBe(true);
  });
  it("does nothing, and wakes nothing, for a push that changed neither file, a delivery with no repository, or a mark that matched no row", async () => {
    const a = fakePool(1);
    expect(await wakeRepoInstructionImport(a.pool, event(push([commit({ modified: ["src/a.ts"] })])))).toBe(0);
    expect(await wakeRepoInstructionImport(a.pool, event(push([commit({ modified: ["CLAUDE.md"] })]), "push", ""))).toBe(0);
    expect(a.statements).toEqual([]);
    const b = fakePool(0);
    expect(await wakeRepoInstructionImport(b.pool, event(push([commit({ modified: ["CLAUDE.md"] })])))).toBe(0);
    expect(region.entries.has("pending:setup-request-check")).toBe(false);
  });
});

describe("wakeRepoInstructionImportOnConnect", () => {
  it("marks both files of every connected repository, and never throws into the connect path", async () => {
    const { pool, statements } = fakePool(2);
    await wakeRepoInstructionImportOnConnect(pool, ACCOUNT, [REPO]);
    expect(marks(statements)[0]!.params).toEqual([ACCOUNT, [REPO], ["CLAUDE.md", "AGENTS.md"], 60]);
    const warn = vi.fn();
    const broken = { connect: vi.fn(async () => { throw new TypeError("boom with https://secret"); }) } as unknown as Pool;
    await expect(wakeRepoInstructionImportOnConnect(broken, ACCOUNT, [REPO], warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("repo instruction wake failed: TypeError");
  });
  it("marks nothing for an empty connect", async () => {
    const { pool, statements } = fakePool(0);
    await wakeRepoInstructionImportOnConnect(pool, ACCOUNT, []);
    expect(marks(statements)).toHaveLength(0);
    expect(region.entries.has("pending:setup-request-check")).toBe(false);
  });
});
