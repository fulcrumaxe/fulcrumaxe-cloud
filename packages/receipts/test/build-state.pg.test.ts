import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBuildStatePort } from "../src/index.js";
import { pools, seedAccount, seedItem, seedRun, type Pool } from "./pgSeed.js";

const HEAD = "b".repeat(40);
const publish = (n: number | null, head: string | null) => ({ ...(n === null ? {} : { pr_number: String(n) }), ...(head === null ? {} : { publish: { private_head: head } }) });

describe("BuildStatePort against real rows (D#7 DP7-2c, criterion 5)", () => {
  let admin: Pool;
  let app: Pool;
  beforeAll(() => ({ admin, app } = pools()));
  afterAll(async () => {
    await admin.end();
    await app.end();
  });

  const state = (acct: string, item: string) => createBuildStatePort(app).stateOf(acct, item);

  it.each([
    ["triaged", false, "not_started"],
    ["discussing", false, "not_started"],
    ["spec_ready", false, "not_started"],
    ["in_progress", false, "building"],
    ["pr_opened", true, "built"],
    ["changes_requested", true, "built"],
    ["review_passed", true, "built"],
    ["merged", true, "merged"],
  ] as const)("stage %s (pull request recorded: %s) reads as %s", async (stage, withPr, expected) => {
    const acct = await seedAccount(admin);
    const item = await seedItem(admin, acct, stage);
    if (withPr) await seedRun(admin, acct, item, { envelope: publish(41, HEAD) });
    const got = await state(acct, item);
    expect(got.stage).toBe(expected);
    expect(got.pr).toEqual(withPr ? { number: 41, headSha: HEAD } : null);
  });

  it("an item that merged after being built reads as merged with the same pull request, and the newest run's number wins", async () => {
    const acct = await seedAccount(admin);
    const item = await seedItem(admin, acct, "pr_opened");
    await seedRun(admin, acct, item, { envelope: publish(40, "c".repeat(40)), ageMinutes: 30 });
    await seedRun(admin, acct, item, { envelope: publish(41, HEAD), ageMinutes: 5 });
    expect(await state(acct, item)).toEqual({ stage: "built", pr: { number: 41, headSha: HEAD } });
    await admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [item]);
    expect(await state(acct, item)).toEqual({ stage: "merged", pr: { number: 41, headSha: HEAD } });
  });

  it("a runner run's recorded pull request and head come from its done event, ahead of the envelope", async () => {
    const acct = await seedAccount(admin);
    const item = await seedItem(admin, acct, "pr_opened");
    const run = await seedRun(admin, acct, item, { envelope: publish(1, "c".repeat(40)) });
    await admin.query(
      `INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`,
      [acct, run, JSON.stringify({ viaRunnerDone: "true", prNumber: "52", headOid: HEAD })],
    );
    expect(await state(acct, item)).toEqual({ stage: "built", pr: { number: 52, headSha: HEAD } });
  });

  it("needs_human, closed_unmerged and closed read the runs: a pull request means built, a run without one building, no run not started", async () => {
    for (const stage of ["needs_human", "closed_unmerged", "closed"]) {
      const acct = await seedAccount(admin);
      const none = await seedItem(admin, acct, stage);
      expect(await state(acct, none), stage).toEqual({ stage: "not_started", pr: null });
      const running = await seedItem(admin, acct, stage);
      await seedRun(admin, acct, running, { envelope: {} });
      expect(await state(acct, running), stage).toEqual({ stage: "building", pr: null });
      const built = await seedItem(admin, acct, stage);
      await seedRun(admin, acct, built, { envelope: publish(9, HEAD) });
      expect(await state(acct, built), stage).toEqual({ stage: "built", pr: { number: 9, headSha: HEAD } });
    }
  });

  it("refuses rather than guesses: an unknown item, another account's item, a built item with no pull request, a pull request with no head, a malformed id", async () => {
    const acct = await seedAccount(admin);
    const other = await seedAccount(admin);
    const item = await seedItem(admin, acct, "pr_opened");
    await expect(state(acct, randomUUID())).rejects.toThrow(/not found/);
    await expect(state(other, item)).rejects.toThrow(/not found/);
    await expect(state(acct, item)).rejects.toThrow(/no pull request is recorded/);
    await seedRun(admin, acct, item, { envelope: publish(5, null) });
    await expect(state(acct, item)).rejects.toThrow(/no recorded head/);
    await expect(state("nope", item)).rejects.toThrow(/UUID/);
  });
});
