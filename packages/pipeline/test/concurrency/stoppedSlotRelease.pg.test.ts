import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { readFreeBuildSlots, takeBuildSlot } from "../../src/advance/buildSlots.js";
import { seedAccount } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * [pg] A pull request stopped for a person holds no build slot. The case that started it: a `runner_local` repository held to one build, one item stopped at
 * `pr_opened` because a reviewer could not run the tests, and every other build on the repository waiting behind it while the runner sat idle.
 */
const h = pgHarness();

async function account(): Promise<string> {
  const id = randomUUID();
  await seedAccount(h.admin, id);
  return id;
}
/** An unpaired runner_local repository: the clamp to one build applies. */
async function clampedRepo(accountId: string, mode = "runner_local"): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', $4, 'acme', $5)`, [id, accountId, Math.floor(Math.random() * 1_000_000_000), mode, `s${id.slice(0, 8)}`]);
  return id;
}
async function item(accountId: string, repoId: string, stage: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage) VALUES ($1, $2, $3, 'small', 'running', 'internal', $4, $5)`, [id, accountId, repoId, Math.floor(Math.random() * 1_000_000) + 1, stage]);
  return id;
}
async function fact(accountId: string, workItemId: string, kind: string, code: string | null): Promise<void> {
  await h.admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, $3, $4, $5)`, [accountId, workItemId, kind, code, randomUUID()]);
}
const claim = (accountId: string, id: string) =>
  takeBuildSlot(h.runWriterPool, accountId, id, (client: PoolClient) => recordStage(client, { workItemId: id, toStage: "in_progress", at: new Date(), source: "control_plane", sourceRef: `release-test:${randomUUID()}` }));

/** A waiting item can start exactly when a repository wait is not the answer; each case uses a fresh item so a claim never changes the next one. */
async function canStart(a: string, r: string): Promise<boolean> {
  const id = await item(a, r, "spec_ready");
  const got = await takeBuildSlot(h.runWriterPool, a, id, async () => "probe");
  return got.granted;
}

describe("a stopped pull request releases its build slot", () => {
  it("control: an item at pr_opened with no stop holds the repository's only slot, and the next build waits", async () => {
    const a = await account();
    const r = await clampedRepo(a);
    const holder = await item(a, r, "pr_opened");
    await fact(a, holder, "review_started", null);
    const next = await item(a, r, "spec_ready");
    expect(await claim(a, next)).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
    expect(await readFreeBuildSlots(h.runWriterPool, a, next)).toBe(0);
  });

  it("a reviewer environment stop frees the slot: the waiting build starts, and the stopped item keeps its stage", async () => {
    const a = await account();
    const r = await clampedRepo(a);
    const stopped = await item(a, r, "pr_opened");
    await fact(a, stopped, "review_started", null);
    await fact(a, stopped, "stopped", "reviewer_environment");
    const next = await item(a, r, "spec_ready");
    expect(await readFreeBuildSlots(h.runWriterPool, a, next)).toBe(1);
    expect((await claim(a, next)).granted).toBe(true);
    expect((await h.admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [stopped])).rows[0]!.stage).toBe("pr_opened");
    // The clamp still holds: the build that took the slot is the repository's one.
    expect(await claim(a, await item(a, r, "spec_ready"))).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
  });

  it("resuming the stopped item counts it again: it does not wait, and the next build waits until the count is back under the limit", async () => {
    const a = await account();
    const r = await clampedRepo(a);
    const stopped = await item(a, r, "pr_opened");
    await fact(a, stopped, "stopped", "reviewer_environment");
    const running = await item(a, r, "spec_ready");
    expect((await claim(a, running)).granted).toBe(true);
    // Review again: the reviewers start, which is a later fact. Two items now count against a limit of one; nothing is cancelled.
    await fact(a, stopped, "review_started", null);
    expect(await claim(a, await item(a, r, "spec_ready"))).toEqual({ granted: false, reason: "waiting_for_build_slot_repo" });
    expect((await h.admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [stopped])).rows[0]!.stage).toBe("pr_opened");
    // The running build finishes: the resumed item is the one that holds the slot.
    await h.admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [running]);
    expect(await canStart(a, r)).toBe(false);
  });

  it("only a stop that needs a person releases: other codes, other kinds and other stages keep the slot", async () => {
    const cases: Array<[string, string, string | null, boolean]> = [
      ["pr_opened", "stopped", "reviewer_environment", true],
      ["changes_requested", "escalated", "reviewer_fail", true],
      ["review_passed", "stopped", "review_key_missing", true],
      ["review_passed", "stopped", "merge_gate", false],
      ["pr_opened", "stopped", "review", false],
      ["pr_opened", "stopped", "not_started_no_model", true],
      ["pr_opened", "stopped", "build_wait_timeout", false],
      ["pr_opened", "build_refused", "reviewer_environment", false],
      ["in_progress", "stopped", "reviewer_environment", false],
    ];
    for (const [stage, kind, code, released] of cases) {
      const a = await account();
      const r = await clampedRepo(a);
      const holder = await item(a, r, stage);
      await fact(a, holder, kind, code);
      expect(await canStart(a, r), `${stage} ${kind} ${code}`).toBe(released);
    }
  });

  it("a sweep note written after the stop does not bring the slot back; a later driver fact does", async () => {
    const a = await account();
    const r = await clampedRepo(a);
    const stopped = await item(a, r, "pr_opened");
    await fact(a, stopped, "stopped", "reviewer_environment");
    await fact(a, stopped, "platform_check", "no_activity");
    expect(await canStart(a, r)).toBe(true);
    await fact(a, stopped, "pr_head_pushed", null);
    expect(await canStart(a, r)).toBe(false);
  });

  it("the clamp is untouched: a hosted repository with a limit of 2 still counts a running review, and the release frees exactly one", async () => {
    const a = await account();
    const r = await clampedRepo(a, "sandbox");
    const stopped = await item(a, r, "pr_opened");
    await fact(a, stopped, "stopped", "reviewer_environment");
    await item(a, r, "pr_opened");
    expect(await canStart(a, r)).toBe(true);
    await item(a, r, "review_passed");
    expect(await canStart(a, r)).toBe(false);
  });
});
