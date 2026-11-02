import https from "node:https";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { readStackedWait } from "@fx/core/src/work-items/mergeReadiness.js";
import { cancelWorkItemEntry, enqueueEntry, finishWork, hasEntryForPr, requeueCiStopped, runQueueTick, settlePullRequest, startConflictWork, stopEntry } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { T0, startQueueRepo, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#598 P3c: a stacked child waits in the merge queue behind its parent's entry; once the parent merged, the tick moves the child's pull request onto the
 * default branch (one base change, before any compare, refresh or merge) and then runs the ordinary path. Real Postgres (a plain `app_user` pool) and the
 * strict GitHub fake over real TLS. Not faked faithfully: what GitHub does to the child's diff and mergeable state when its base changes (the fake leaves
 * both alone unless a scenario says otherwise through `onPatch`).
 */
const MIN = 60_000;
let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("D#598 P3c stacked child in the merge queue [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(r: QueueRepo, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);
  /** Parent #7 and its stacked child #8 (the child's base is the parent's branch, and it is behind the default branch once the parent merged). */
  const start = async (child: NonNullable<Parameters<QueueRepo["addItem"]>[1]>["world"] = {}) => {
    const r = await startQueueRepo(db);
    repos.push(r);
    const parent = await r.addItem(7, { approvedAt: T0 });
    const kid = await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN), dependsOnPrNumber: 7, world: { baseRef: "fx/parent", behindBy: 1, ...child } });
    return { r, parent, kid };
  };
  const callsOf = (r: QueueRepo, pr: number) => r.calls.filter((c) => c.pr === pr);
  const patches = (r: QueueRepo, pr: number) => callsOf(r, pr).filter((c) => c.method === "PATCH");

  it("P3c-1: while the parent's entry is not merged the child is not eligible, takes no slot and gets no merge or base call", async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    const parent = await r.addItem(7, { approvedAt: T0, world: { neverComputes: true } }); // the parent cannot be read yet, so it does not merge
    await r.addItem(8, { approvedAt: new Date(T0.getTime() + MIN), dependsOnPrNumber: 7, world: { baseRef: "fx/parent" } });
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps.map((s) => s.step)).toEqual(["idle"]);
    expect(r.mergeCalls()).toEqual([]);
    expect(patches(r, 8)).toEqual([]);
    expect((await r.entry(8)).state).toBe("queued");
    expect((await r.entry(7)).entryKind).toBe("work_item");
    expect(parent.g.world.merges).toEqual([]);
    // The child's entry is found by the parent's number whatever its state (the check enqueueBody makes), and a number nobody queued is not.
    expect(await tenant(r, (c) => hasEntryForPr(c, r.accountId, r.repoId, 7))).toBe(true);
    expect(await tenant(r, (c) => hasEntryForPr(c, r.accountId, r.repoId, 99))).toBe(false);
  });

  it("P3c-3: after the parent merged the child gets exactly one base change to the default branch, before any compare, refresh or merge, and no commit is rewritten", async () => {
    const { r, kid } = await start();
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps.map((s) => s.step)).toEqual(["merged", "merged", "idle"]);
    expect(r.mergeCalls()).toEqual([7, 8]);
    expect(kid.g.world.baseChanges).toEqual(["main"]);
    expect(kid.g.world.baseRef).toBe("main");
    const mine = callsOf(r, 8);
    const at = mine.findIndex((c) => c.method === "PATCH");
    expect(mine.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(mine.filter((c, i) => i < at && (c.path.includes("/compare/") || c.path.endsWith("/update-branch") || c.path.endsWith("/merge")))).toEqual([]);
    expect(mine.slice(at + 1).some((c) => c.path.endsWith("/update-branch"))).toBe(true);
    // The refresh is the platform's ordinary merge commit on top of the old head: the old head is its first parent; nothing was force-pushed.
    expect(kid.g.world.commits[kid.fresh]?.parents[0]).toBe(kid.head);
    expect(r.calls.filter((c) => c.method === "PATCH").map((c) => c.pr)).toEqual([8]);
    expect(r.calls.filter((c) => c.path.includes("/git/refs"))).toEqual([]);
    // Idempotent: a later pass has nothing to move.
    await runQueueTick(r.deps(), r);
    expect(kid.g.world.baseChanges).toEqual(["main"]);
  });

  it("P3c-3: a child whose base GitHub already moved gets no base change", async () => {
    const { r, kid } = await start({ baseRef: "main" });
    await runQueueTick(r.deps(), r);
    expect(r.mergeCalls()).toEqual([7, 8]);
    expect(patches(r, 8)).toEqual([]);
    expect(kid.g.world.baseChanges).toEqual([]);
  });

  it("P3c-4 (C24): a failed base change stops the entry with retarget_failed at once, with no merge, no refresh and no counter; the person's Check the merge tries again and goes on", async () => {
    const { r, kid } = await start({ patchAnswer: 500 });
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps.map((s) => s.step)).toEqual(["merged", "released", "idle"]);
    const e = await r.entry(8);
    expect(e).toMatchObject({ state: "stopped", reason: "retarget_failed", slotHolder: null, refreshCount: 0 });
    expect(r.mergeCalls()).toEqual([7]);
    expect(patches(r, 8)).toHaveLength(1);
    expect(callsOf(r, 8).filter((c) => c.path.endsWith("/update-branch") || c.path.endsWith("/merge"))).toEqual([]);
    // A later tick, and the automatic re-queue of a CI stop (a finished check on the head), do nothing with it: only a person ends this stop.
    await runQueueTick(r.deps(), r);
    expect(await tenant(r, (c) => requeueCiStopped(c, { accountId: r.accountId, repoId: r.repoId, prNumbers: [8], headSha: kid.head }))).toEqual([]);
    await runQueueTick(r.deps(), r);
    expect(patches(r, 8)).toHaveLength(1);
    expect((await r.entry(8)).state).toBe("stopped");
    // The cause is fixed; the person's Check the merge (the Review-passed advance) runs the workflow's enqueue step again, which files the entry afresh for the same head.
    delete kid.g.world.patchAnswer;
    const again = await tenant(r, (c) => enqueueEntry(c, { accountId: r.accountId, repoId: r.repoId, workItemId: kid.workItemId, prNumber: 8, headSha: kid.head, dependsOnPrNumber: 7, approvedAt: new Date() }));
    expect(again.outcome).toBe("requeued");
    await runQueueTick(r.deps(), r);
    expect(kid.g.world.baseChanges).toEqual(["main"]);
    expect(r.mergeCalls()).toEqual([7, 8]);
  });

  it("P3c-4: a refusal (403, the token cannot write the pull request) stops it with retarget_failed too, and nothing merges", async () => {
    const { r } = await start({ patchForbidden: true });
    await runQueueTick(r.deps(), r);
    expect(await r.entry(8)).toMatchObject({ state: "stopped", reason: "retarget_failed" });
    expect(r.mergeCalls()).toEqual([7]);
  });

  it("P3c-5: a conflicting refresh after the base change starts a conflict round on the ordinary path, and the base stays on the default branch", async () => {
    const { r, kid } = await start({ onPatch: (w) => void (w.conflict = true) });
    const seen: Array<{ pr: number; bases: string[]; merges: number }> = [];
    const onConflict = async (entry: { id: string; prNumber: number; headSha: string }, holder?: string) => {
      seen.push({ pr: entry.prNumber, bases: [...kid.g.world.baseChanges], merges: r.mergeCalls().length });
      const s = await tenant(r, (c) => startConflictWork(c, { accountId: r.accountId, entryId: entry.id, ...(holder ? { holder } : {}), fromSha: entry.headSha, baseSha: "c".repeat(40), baseRef: "main", conflictFiles: ["src/a.ts"] }));
      return s.ok;
    };
    await runQueueTick(r.deps({ onConflict }), r);
    expect(seen).toEqual([{ pr: 8, bases: ["main"], merges: 1 }]);
    expect(await r.entry(8)).toMatchObject({ state: "awaiting_work", workKind: "conflict" });
    // The round ends, the conflict is resolved: the entry is queued again on the same base; there is no second base change.
    kid.g.world.conflict = false;
    await tenant(r, (c) => finishWork(c, { accountId: r.accountId, entryId: r.items.get(8)!.entryId, headSha: kid.head }));
    await runQueueTick(r.deps({ onConflict }), r);
    expect(kid.g.world.baseChanges).toEqual(["main"]);
    expect(kid.g.world.baseRef).toBe("main");
    expect(r.mergeCalls()).toEqual([7, 8]);
  });

  it("P3c-6: a parent whose entry ends cancelled stops the child with merge_dependency_closed; it is not moved and not merged", async () => {
    const { r, parent, kid } = await start();
    await tenant(r, (c) => cancelWorkItemEntry(c, { accountId: r.accountId, workItemId: parent.workItemId }));
    await runQueueTick(r.deps(), r);
    expect(await r.entry(8)).toMatchObject({ state: "stopped", reason: "merge_dependency_closed" });
    expect(r.mergeCalls()).toEqual([]);
    expect(patches(r, 8)).toEqual([]);
    expect(kid.g.world.baseChanges).toEqual([]);
  });

  it("P3c-6: a parent whose entry ends closed (its pull request closed unmerged) stops the child the same way", async () => {
    const { r, kid } = await start();
    await tenant(r, (c) => settlePullRequest(c, { accountId: r.accountId, repoId: r.repoId, prNumber: 7, merged: false }));
    expect((await r.entry(7)).state).toBe("closed");
    await runQueueTick(r.deps(), r);
    expect(await r.entry(8)).toMatchObject({ state: "stopped", reason: "merge_dependency_closed" });
    expect(r.mergeCalls()).toEqual([]);
    expect(patches(r, 8)).toEqual([]);
    expect(kid.g.world.baseChanges).toEqual([]);
  });

  it("C25: a parent whose entry is stopped keeps the child waiting (visible, with the waiting sentence), and the child recovers when the parent later merges", async () => {
    const { r, parent, kid } = await start();
    await tenant(r, (c) => stopEntry(c, { accountId: r.accountId, entryId: parent.entryId, reason: "merge_conflict" }));
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps.map((s) => s.step)).toEqual(["idle"]);
    expect(await r.entry(8)).toMatchObject({ state: "queued", reason: null });
    expect(r.mergeCalls()).toEqual([]);
    expect(patches(r, 8)).toEqual([]);
    expect(await tenant(r, (c) => readStackedWait(c, r.accountId, kid.workItemId))).toEqual({ state: "waiting", parent_pr: 7 }); // the page reads "Waiting for #7 to merge."
    // A person resumes the parent; once it merges the child goes on.
    await tenant(r, (c) => enqueueEntry(c, { accountId: r.accountId, repoId: r.repoId, workItemId: parent.workItemId, prNumber: 7, headSha: parent.head, approvedAt: T0 }));
    await tenant(r, (c) => settlePullRequest(c, { accountId: r.accountId, repoId: r.repoId, prNumber: 7, merged: true }));
    await runQueueTick(r.deps(), r);
    expect(r.mergeCalls()).toEqual([8]);
    expect(kid.g.world.baseChanges).toEqual(["main"]);
  });

  it("C25: the parent's entry is looked up in the child's own repository: the same pull request number in another repository of the account does not count", async () => {
    const { r } = await start();
    const other = randomUUID();
    expect(await tenant(r, (c) => hasEntryForPr(c, r.accountId, other, 7))).toBe(false);
    expect(await tenant(r, (c) => hasEntryForPr(c, r.accountId, r.repoId, 7))).toBe(true);
  });

  it("C25: a parent with a pull request number and no queue entry: nothing is queued behind it, and the direct gate stops the child with stacked_on_open_pr", async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    const kid = await r.addItem(8, { world: { baseRef: "fx/parent" } }); // the child, filed as the direct path files it: no dependency recorded
    expect(await tenant(r, (c) => hasEntryForPr(c, r.accountId, r.repoId, 7))).toBe(false);
    expect((await r.queue()).filter((e) => e.dependsOnPrNumber !== null)).toEqual([]);
    const out = await r.deps().gate({ entry: await r.entry(8), headSha: kid.head, expectedSignals: [] });
    expect(out).toMatchObject({ outcome: "ready_human_merges", reasons: expect.arrayContaining(["stacked_on_open_pr"]) });
    expect(r.mergeCalls()).toEqual([]);
  });

  it("P3c-2 and P3c-9: a child with no entry behind it goes to the direct gate, which stops it with stacked_on_open_pr (the base is not the default branch)", async () => {
    const r = await startQueueRepo(db);
    repos.push(r);
    const kid = await r.addItem(8, { world: { baseRef: "fx/parent" } });
    const entry = await r.entry(8);
    const out = await r.deps().gate({ entry, headSha: kid.head, expectedSignals: [] });
    expect(out).toMatchObject({ outcome: "ready_human_merges", reasons: expect.arrayContaining(["stacked_on_open_pr"]) });
    expect(r.mergeCalls()).toEqual([]);
  });

  it("P3c-7 (server side): the item view's state is derived from the child's entry and the parent's on each read, with the number the entry records", async () => {
    const { r, parent, kid } = await start({ neverComputes: true });
    const view = (item: { workItemId: string }) => tenant(r, (c) => readStackedWait(c, r.accountId, item.workItemId));
    expect(await view(kid)).toEqual({ state: "waiting", parent_pr: 7 });
    expect(await view(parent)).toBeNull(); // not a stacked child: nothing to say
    // The parent merges; the child cannot be read yet, so it stays queued: its base is about to move.
    await runQueueTick(r.deps(), r);
    expect(r.mergeCalls()).toEqual([7]);
    expect(await view(kid)).toEqual({ state: "moving", parent_pr: 7 });
    // A conflict round after the parent merged.
    const entry = await r.entry(8);
    await tenant(r, (c) => startConflictWork(c, { accountId: r.accountId, entryId: entry.id, fromSha: kid.head, baseSha: "c".repeat(40), baseRef: "main", conflictFiles: ["src/a.ts"] }));
    expect(await view(kid)).toEqual({ state: "conflict", parent_pr: 7 });
  });

  it("P3c-7 (server side): a parent that ended unmerged, and a failed base change, each have their own state; a merged child has none", async () => {
    const a = await start();
    await tenant(a.r, (c) => cancelWorkItemEntry(c, { accountId: a.r.accountId, workItemId: a.parent.workItemId }));
    await runQueueTick(a.r.deps(), a.r);
    expect(await tenant(a.r, (c) => readStackedWait(c, a.r.accountId, a.kid.workItemId))).toEqual({ state: "parent_closed", parent_pr: 7 });
    const b = await start({ patchAnswer: 500 });
    await runQueueTick(b.r.deps(), b.r);
    expect(await tenant(b.r, (c) => readStackedWait(c, b.r.accountId, b.kid.workItemId))).toEqual({ state: "retarget_failed", parent_pr: 7 });
    const ok = await start();
    await runQueueTick(ok.r.deps(), ok.r);
    expect(await tenant(ok.r, (c) => readStackedWait(c, ok.r.accountId, ok.kid.workItemId))).toBeNull();
  });

  describe("P3c-8: the fake enforces GitHub's real contract for a base change", () => {
    const patch = (g: Awaited<ReturnType<QueueRepo["addItem"]>>["g"], auth: boolean, body: unknown) =>
      new Promise<number>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "fulcrumaxe-cloud", "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) };
        if (auth) headers.authorization = `Bearer ${"t".repeat(20)}`;
        const req = https.request({ host: "api.github.com", port: g.server.port, method: "PATCH", path: "/repos/acme/widgets/pulls/8", headers, ca: g.server.ca, servername: "api.github.com", lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end(payload);
      });

    it("needs the installation token, and refuses a base that is not an existing branch", async () => {
      const { r, kid } = await start();
      expect(await patch(kid.g, false, { base: "main" })).toBe(401);
      expect(await patch(kid.g, true, { base: "no-such-branch" })).toBe(422);
      expect(await patch(kid.g, true, { base: "" })).toBe(422);
      expect(kid.g.world.baseChanges).toEqual([]);
      expect(await patch(kid.g, true, { base: "main" })).toBe(200);
      expect(kid.g.world.baseRef).toBe("main");
      // Through the port: a refused change is `moved: false`, never a throw and never a guess.
      kid.g.world.baseRef = "fx/parent";
      const port = r.deps().github;
      expect(await port.retargetPullRequest!({ repoId: r.repoId, prNumber: 8 }, { base: "no-such-branch" })).toEqual({ moved: false });
      expect(await port.retargetPullRequest!({ repoId: r.repoId, prNumber: 8 }, { base: "main" })).toEqual({ moved: true });
    });
  });
});
