import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { PoolClient } from "pg";
import { applyQueueEvent, stopEntry, takeSlot } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { startQueueRepo, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#519 MQ3-b webhook triggers: what a verified delivery does to the queue (`applyQueueEvent`), over real Postgres. The route layer
 * (signature, delivery headers) is the existing webhook handler's; the replay of one delivery is idempotent here by construction.
 */
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("D#519 MQ3-b webhook triggers [pg]", () => {
  const db = pgHarness();
  const setup = async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    return r;
  };
  const apply = (r: QueueRepo, eventName: string, payload: unknown) => withTenant(db.pureAppUserPool, r.accountId, (c: PoolClient) => applyQueueEvent(c, { accountId: r.accountId, repoId: r.repoId, eventName, payload }));
  const reasonOf = async (r: QueueRepo, pr: number) => (await r.entry(pr)).reason;

  it("a pull request merged by a person is settled as merged by a person, once; a replay of the delivery changes nothing", async () => {
    const r = await setup();
    await r.addItem(7);
    expect(await apply(r, "pull_request", { action: "closed", pull_request: { number: 7, merged: true } })).toBe(false);
    expect(await r.entry(7)).toMatchObject({ state: "merged", mergedBy: "person" });
    expect(await apply(r, "pull_request", { action: "closed", pull_request: { number: 7, merged: true } })).toBe(false);
    expect(await r.entry(7)).toMatchObject({ state: "merged", mergedBy: "person" });
  });

  it("a pull request closed unmerged is closed, and its slot (if it held it) is freed", async () => {
    const r = await setup();
    await r.addItem(7);
    await r.addItem(8);
    const taken = await withTenant(db.pureAppUserPool, r.accountId, (c) => takeSlot(c, { accountId: r.accountId, repoId: r.repoId, holder: "t", facts: new Map([[r.items.get(7)!.entryId, { open: true, draft: false }]]) }));
    expect(taken.taken?.prNumber).toBe(7);
    expect(await apply(r, "pull_request", { action: "closed", pull_request: { number: 7, merged: false } })).toBe(true);
    expect(await r.entry(7)).toMatchObject({ state: "closed", slotHolder: null });
  });

  it("a finished check puts a ci_not_green entry back on the queue at its original place; any other stop stays", async () => {
    const r = await setup();
    const red = await r.addItem(7);
    const conflicted = await r.addItem(8);
    await withTenant(db.pureAppUserPool, r.accountId, async (c) => {
      await stopEntry(c, { accountId: r.accountId, entryId: red.entryId, reason: "ci_not_green" });
      await stopEntry(c, { accountId: r.accountId, entryId: conflicted.entryId, reason: "merge_conflict" });
    });
    const before = (await r.entry(7)).approvedAt;
    // By the pull request a check run names.
    expect(await apply(r, "check_run", { action: "completed", check_run: { head_sha: red.head, pull_requests: [{ number: 7 }, { number: 8 }] } })).toBe(true);
    expect(await r.entry(7)).toMatchObject({ state: "queued", reason: null, approvedAt: before });
    expect(await reasonOf(r, 8)).toBe("merge_conflict");
  });

  it("a status finishing on the head requeues it; a pending status, a check still running and a junk sha do nothing", async () => {
    const r = await setup();
    const red = await r.addItem(7);
    const stop = () => withTenant(db.pureAppUserPool, r.accountId, (c) => stopEntry(c, { accountId: r.accountId, entryId: red.entryId, reason: "ci_not_green" }));
    await stop();
    expect(await apply(r, "status", { state: "pending", sha: red.head })).toBe(false);
    expect(await apply(r, "check_run", { action: "created", check_run: { head_sha: red.head } })).toBe(false);
    expect(await apply(r, "status", { state: "success", sha: "not-a-sha" })).toBe(false);
    expect((await r.entry(7)).state).toBe("stopped");
    expect(await apply(r, "status", { state: "success", sha: red.head })).toBe(true);
    expect((await r.entry(7)).state).toBe("queued");
  });

  it("an event that cannot change the queue is ignored, and junk shapes never throw", async () => {
    const r = await setup();
    await r.addItem(7);
    expect(await apply(r, "issues", { action: "opened" })).toBe(false);
    expect(await apply(r, "pull_request", { action: "labeled" })).toBe(false);
    expect(await apply(r, "pull_request", null)).toBe(false);
    // A number that is not a number settles nothing (it is still a pull request event on a repo with a live entry, so the queue is woken).
    expect(await apply(r, "pull_request", { action: "closed", pull_request: { number: "7" } })).toBe(true);
    expect(await apply(r, "check_suite", "completed")).toBe(false);
    expect((await r.entry(7)).state).toBe("queued");
  });

  it("a push, a head push and a retarget wake the queue only when the repo has a live entry", async () => {
    const r = await setup();
    expect(await apply(r, "push", { ref: "refs/heads/main" })).toBe(false);
    await r.addItem(7);
    for (const [name, payload] of [["push", { ref: "refs/heads/main" }], ["pull_request", { action: "synchronize", pull_request: { number: 7 } }], ["pull_request", { action: "edited", pull_request: { number: 7 } }]] as const) {
      expect(await apply(r, name, payload)).toBe(true);
    }
    expect((await r.entry(7)).state).toBe("queued");
  });
});
