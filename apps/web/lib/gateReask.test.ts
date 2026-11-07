import { describe, expect, it, vi } from "vitest";

vi.mock("./worker", () => ({ getWorker: async () => null }));

import { readGateWake, wakeGateReask } from "./gateReask";

const SHA = "a".repeat(40);
const repository = { full_name: "Acme/widgets-public" };

describe("readGateWake: which deliveries can clear a gate stop", () => {
  it("a pull request opened, reopened or made ready names its number and head", () => {
    for (const action of ["opened", "reopened", "ready_for_review"]) {
      expect(readGateWake("pull_request", { action, repository, pull_request: { number: 501, head: { sha: SHA } } })).toEqual({ repoFullName: "Acme/widgets-public", prNumbers: [501], headSha: SHA });
    }
  });
  it("C12-e1b-1: a pull request taken out of GitHub's merge queue names its number and head, marked as a removal; the reason in the payload is not read", () => {
    expect(readGateWake("pull_request", { action: "dequeued", reason: "MERGE_CONFLICT", repository, pull_request: { number: 501, head: { sha: SHA } } })).toEqual({ repoFullName: "Acme/widgets-public", prNumbers: [501], headSha: SHA, dequeued: true });
    expect(readGateWake("pull_request", { action: "enqueued", repository, pull_request: { number: 501 } })).toBeNull();
  });
  it("a pull request closed, pushed to, edited or drafted wakes nothing", () => {
    for (const action of ["closed", "synchronize", "edited", "converted_to_draft", "labeled"]) expect(readGateWake("pull_request", { action, repository, pull_request: { number: 501 } })).toBeNull();
  });
  it("a check that finished green wakes; red, cancelled, neutral and a check still running do not", () => {
    for (const event of ["check_run", "check_suite"] as const) {
      const body = (action: string, conclusion: unknown) => ({ action, repository, [event]: { head_sha: SHA, conclusion, pull_requests: [{ number: 501 }, { number: "x" }, { number: -3 }] } });
      expect(readGateWake(event, body("completed", "success"))).toEqual({ repoFullName: "Acme/widgets-public", prNumbers: [501], headSha: SHA });
      for (const conclusion of ["failure", "cancelled", "neutral", "timed_out", null]) expect(readGateWake(event, body("completed", conclusion))).toBeNull();
      expect(readGateWake(event, body("created", null))).toBeNull();
      expect(readGateWake(event, body("requested", "success"))).toBeNull();
    }
  });
  it("a commit status wakes only on success", () => {
    expect(readGateWake("status", { state: "success", sha: SHA, repository })).toEqual({ repoFullName: "Acme/widgets-public", prNumbers: [], headSha: SHA });
    for (const state of ["pending", "failure", "error"]) expect(readGateWake("status", { state, sha: SHA, repository })).toBeNull();
  });
  it("every other event, a malformed repository name and a non-object payload wake nothing", () => {
    expect(readGateWake("push", { repository })).toBeNull();
    expect(readGateWake("issues", { action: "opened", repository })).toBeNull();
    expect(readGateWake("pull_request", { action: "opened", repository: { full_name: "no slash" }, pull_request: { number: 1 } })).toBeNull();
    expect(readGateWake("status", { state: "success", sha: "not-a-sha", repository })).toEqual({ repoFullName: "Acme/widgets-public", prNumbers: [], headSha: null });
    expect(readGateWake("check_run", null)).toBeNull();
  });
});

describe("wakeGateReask", () => {
  const asked: unknown[] = [];
  const worker = { wakeMergeGate: async (input: unknown) => (asked.push(input), 2) };
  const event = (payload: unknown) => ({ accountId: "acc", repoId: "repo", eventName: "pull_request" as const, payload: payload as never });
  const opened = { action: "opened", repository, pull_request: { number: 501, head: { sha: SHA } } };

  it("hands the worker the account, the repository and what the delivery names, and answers its count", async () => {
    asked.length = 0;
    expect(await wakeGateReask({} as never, event(opened), { worker })).toBe(2);
    expect(asked).toEqual([{ accountId: "acc", repoId: "repo", wake: { repoFullName: "Acme/widgets-public", prNumbers: [501], headSha: SHA } }]);
  });
  it("an event that wakes nothing asks nothing, and no worker means nothing to ask", async () => {
    asked.length = 0;
    expect(await wakeGateReask({} as never, event({ action: "closed", repository, pull_request: { number: 501 } }), { worker })).toBe(0);
    expect(await wakeGateReask({} as never, event(opened), { worker: null })).toBe(0);
    expect(asked).toEqual([]);
  });
  it("D#6 CLOUD-POSTS-FX-GATE1 PR 1d: every delivery also goes to the queue entry's fx-gate1 wake with the same pool; both run, and either one's failure is thrown", async () => {
    asked.length = 0;
    const pool = { tag: "pool" } as never;
    const seen: unknown[] = [];
    expect(await wakeGateReask(pool, event(opened), { worker, queueEntry: async (p, e) => (seen.push([p, e.eventName]), null) })).toBe(2);
    expect(seen).toEqual([[pool, "pull_request"]]);
    await expect(wakeGateReask(pool, event(opened), { worker, queueEntry: async () => Promise.reject(new Error("entry read failed")) })).rejects.toThrow("entry read failed");
    expect(asked).toHaveLength(2);
    await expect(wakeGateReask(pool, event(opened), { worker: { wakeMergeGate: async () => Promise.reject(new Error("gate failed")) }, queueEntry: async () => (seen.push("ran"), null) })).rejects.toThrow("gate failed");
    expect(seen).toContain("ran");
  });
});
