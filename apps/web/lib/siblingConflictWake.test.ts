import { describe, expect, it, vi } from "vitest";

vi.mock("./worker", () => ({ getWorker: async () => null }));

import { readPullConflicting, readSiblingMerge, wakeSiblingConflicts, type PullReadHttp } from "./siblingConflictWake";

const repository = { full_name: "Acme/widgets-public", default_branch: "main" };
const closedMerged = (over: Record<string, unknown> = {}) => ({ action: "closed", repository, pull_request: { number: 826, merged: true, base: { ref: "main" }, ...over } });

describe("readSiblingMerge: which deliveries are a merge into the default branch", () => {
  it("a pull request closed as merged into the default branch names its repository and number", () => {
    expect(readSiblingMerge("pull_request", closedMerged())).toEqual({ repoFullName: "Acme/widgets-public", prNumber: 826 });
  });
  it("closed without merging, opened, pushed to and every other event wake nothing", () => {
    expect(readSiblingMerge("pull_request", closedMerged({ merged: false }))).toBeNull();
    expect(readSiblingMerge("pull_request", { ...closedMerged(), action: "opened" })).toBeNull();
    expect(readSiblingMerge("pull_request", { ...closedMerged(), action: "synchronize" })).toBeNull();
    expect(readSiblingMerge("push", closedMerged())).toBeNull();
    expect(readSiblingMerge("check_run", closedMerged())).toBeNull();
  });
  it("a merge into another branch (a stacked parent) moves nobody's base and wakes nothing", () => {
    expect(readSiblingMerge("pull_request", closedMerged({ base: { ref: "fx/parent-branch" } }))).toBeNull();
  });
  it("a delivery that does not name the base branch or the default branch is not known to be a default-branch merge and wakes nothing", () => {
    expect(readSiblingMerge("pull_request", closedMerged({ base: {} }))).toBeNull();
    expect(readSiblingMerge("pull_request", closedMerged({ base: undefined }))).toBeNull();
    expect(readSiblingMerge("pull_request", closedMerged({ base: { ref: "" } }))).toBeNull();
    expect(readSiblingMerge("pull_request", { ...closedMerged(), repository: { full_name: "Acme/widgets-public" } })).toBeNull();
    expect(readSiblingMerge("pull_request", { ...closedMerged(), repository: { full_name: "Acme/widgets-public", default_branch: 7 } })).toBeNull();
  });
  it("a malformed repository name, number or payload wakes nothing", () => {
    expect(readSiblingMerge("pull_request", { ...closedMerged(), repository: { full_name: "no slash", default_branch: "main" } })).toBeNull();
    for (const number of [0, -1, 1.5, "826", null, 3_000_000_000]) expect(readSiblingMerge("pull_request", closedMerged({ number })), String(number)).toBeNull();
    expect(readSiblingMerge("pull_request", null)).toBeNull();
    expect(readSiblingMerge("pull_request", "text")).toBeNull();
  });
});

/** A GitHub that answers `GET /repos/<owner>/<name>/pulls/<n>` as the real one does: only that path and method, 404 for an unknown number, `mergeable: null` while it computes. */
function github(pulls: Record<number, Array<Record<string, unknown>> | number>) {
  const reads: string[] = [];
  const http: PullReadHttp = {
    async request(req) {
      expect(req.method).toBe("GET");
      const m = /^\/repos\/acme\/widgets-public\/pulls\/(\d+)$/.exec(req.path);
      if (!m) return { status: 404, body: { message: "Not Found" } };
      reads.push(req.path);
      const entry = pulls[Number(m[1])];
      if (entry === undefined) return { status: 404, body: { message: "Not Found" } };
      if (typeof entry === "number") return { status: entry, body: { message: "error" } };
      const seen = reads.filter((r) => r === req.path).length;
      return { status: 200, body: entry[Math.min(seen, entry.length) - 1] };
    },
  };
  return { http, reads };
}
const repo = { owner: "acme", name: "widgets-public" };
const open = { state: "open", merged: false };
const noWait = { sleep: async () => undefined };

describe("readPullConflicting: GitHub's own words, nothing guessed", () => {
  it("mergeable false, or the state dirty, is a conflict; mergeable true is not", async () => {
    const g = github({ 1: [{ ...open, mergeable: false, mergeable_state: "dirty" }], 2: [{ ...open, mergeable: null, mergeable_state: "dirty" }], 3: [{ ...open, mergeable: true, mergeable_state: "clean" }], 4: [{ ...open, mergeable: true, mergeable_state: "blocked" }] });
    expect(await readPullConflicting(g.http, repo, 1, noWait)).toBe(true);
    expect(await readPullConflicting(g.http, repo, 2, noWait)).toBe(true);
    expect(await readPullConflicting(g.http, repo, 3, noWait)).toBe(false);
    // Blocked by a rule or a check is not a conflict: that is the gate's own business.
    expect(await readPullConflicting(g.http, repo, 4, noWait)).toBe(false);
  });
  it("GitHub still computing right after a merge (mergeable null) is read again, and the answer that follows is used", async () => {
    const g = github({ 5: [{ ...open, mergeable: null, mergeable_state: "unknown" }, { ...open, mergeable: null, mergeable_state: "unknown" }, { ...open, mergeable: false, mergeable_state: "dirty" }] });
    const sleep = vi.fn(async () => undefined);
    expect(await readPullConflicting(g.http, repo, 5, { sleep })).toBe(true);
    expect(g.reads).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
  it("still computing after the bounded reads is null (not a conflict): the item is left alone", async () => {
    const g = github({ 6: [{ ...open, mergeable: null, mergeable_state: "unknown" }] });
    expect(await readPullConflicting(g.http, repo, 6, { ...noWait, reads: 2 })).toBeNull();
    expect(g.reads).toHaveLength(2);
  });
  it("a pull request that is closed or merged, one that is not found, and a response of the wrong shape are null", async () => {
    const g = github({ 7: [{ state: "closed", merged: true, mergeable: null, mergeable_state: "unknown" }], 8: [{ state: "closed", merged: false, mergeable: false }], 9: [{ state: "weird" }], 10: [{ ...open, mergeable: "yes" }] });
    for (const n of [7, 8, 9, 10, 99]) expect(await readPullConflicting(g.http, repo, n, noWait), String(n)).toBeNull();
  });
  it("a failed read (a status that is not 200) throws; it is never taken for clean or for conflicting", async () => {
    const g = github({ 11: 500, 12: 403 });
    await expect(readPullConflicting(g.http, repo, 11, noWait)).rejects.toThrow("500");
    await expect(readPullConflicting(g.http, repo, 12, noWait)).rejects.toThrow("403");
  });
});

describe("wakeSiblingConflicts", () => {
  const event = (payload: unknown) => ({ accountId: "acc", repoId: "repo", eventName: "pull_request" as const, payload: payload as never });

  it("hands the worker the account, the repository, what merged, and a read bound to the delivery's repository; answers its count", async () => {
    const calls: Array<{ accountId: string; repoId: string; merged: unknown }> = [];
    const read = vi.fn(async () => true);
    const worker = {
      wakeConflictingSiblings: async (input: { accountId: string; repoId: string; merged: unknown; isConflicting(pr: number): Promise<boolean | null> }) => {
        calls.push({ accountId: input.accountId, repoId: input.repoId, merged: input.merged });
        expect(await input.isConflicting(827)).toBe(true);
        return 2;
      },
    };
    expect(await wakeSiblingConflicts({} as never, event(closedMerged()), { worker, readConflicting: read })).toBe(2);
    expect(calls).toEqual([{ accountId: "acc", repoId: "repo", merged: { repoFullName: "Acme/widgets-public", prNumber: 826 } }]);
    expect(read).toHaveBeenCalledWith({}, { accountId: "acc", repoId: "repo" }, 827);
  });

  it("an event that is not a merge asks nothing, and no worker means nothing to ask", async () => {
    const worker = { wakeConflictingSiblings: vi.fn(async () => 1) };
    expect(await wakeSiblingConflicts({} as never, event({ ...closedMerged(), action: "opened" }), { worker })).toBe(0);
    expect(await wakeSiblingConflicts({} as never, event(closedMerged()), { worker: null })).toBe(0);
    expect(worker.wakeConflictingSiblings).not.toHaveBeenCalled();
  });
});
