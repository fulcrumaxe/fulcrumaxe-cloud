import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOGUE } from "@fx/decisions";
import { createLedgerPort, loadReversalPricePort } from "../src/index.js";
import { pools, seedAccount, seedItem, seedLedger, seedRun, type Pool } from "./pgSeed.js";

const reversible = CATALOGUE.find((e) => e.reversal.availability === "reversible_before_build")!.id;
const T0 = Date.UTC(2026, 9, 1, 12);
const now = () => new Date(T0 + 48 * 3_600_000);
const pastWindow = new Date(T0 + 3_600_000);
const receipt = () => ({ decisionType: reversible, createdAt: new Date(T0), reversalFreeUntil: pastWindow });

describe("the live price against the real ledger (D#7 DP7-2c, criterion 4)", () => {
  let admin: Pool;
  let app: Pool;
  beforeAll(() => ({ admin, app } = pools()));
  afterAll(async () => {
    await admin.end();
    await app.end();
  });

  const estimate = async (accountId: string, itemId: string) => {
    const port = await loadReversalPricePort(createLedgerPort(app), accountId, itemId, now);
    return port.priceFor(receipt());
  };

  it("the estimate is the sum of model spend on the item's executor runs, changes after a new ledger row, and ignores other items, other accounts, compute and other roles", async () => {
    const acct = await seedAccount(admin);
    const item = await seedItem(admin, acct, "pr_opened");
    const other = await seedItem(admin, acct, "pr_opened");
    const build = await seedRun(admin, acct, item);
    const fix = await seedRun(admin, acct, item);
    await seedLedger(admin, acct, build, 1.25);
    await seedLedger(admin, acct, fix, 0.5);

    expect(await estimate(acct, item)).toEqual({ kind: "estimate", usd: 1.75 });

    await seedLedger(admin, acct, fix, 0.25, "compute"); // compute is not model spend
    await seedLedger(admin, acct, await seedRun(admin, acct, item, { role: "code-reviewer" }), 9); // a review is not a build or fix run
    await seedLedger(admin, acct, await seedRun(admin, acct, other), 7); // another item
    const otherAcct = await seedAccount(admin);
    const theirItem = await seedItem(admin, otherAcct, "pr_opened");
    await seedLedger(admin, otherAcct, await seedRun(admin, otherAcct, theirItem), 5); // another account
    await seedLedger(admin, acct, null, 3); // a row with no run
    expect(await estimate(acct, item)).toEqual({ kind: "estimate", usd: 1.75 });

    const fix2 = await seedRun(admin, acct, item);
    await seedLedger(admin, acct, fix2, 2);
    expect(await estimate(acct, item)).toEqual({ kind: "estimate", usd: 3.75 });
  });

  it("an item with no spend is an estimate of zero, and another account's item reads as zero, not as its owner's figure", async () => {
    const acct = await seedAccount(admin);
    const item = await seedItem(admin, acct, "pr_opened");
    expect(await estimate(acct, item)).toEqual({ kind: "estimate", usd: 0 });

    const mine = await seedAccount(admin);
    const theirs = await seedAccount(admin);
    const theirItem = await seedItem(admin, theirs, "pr_opened");
    await seedLedger(admin, theirs, await seedRun(admin, theirs, theirItem), 4);
    expect(await estimate(mine, theirItem)).toEqual({ kind: "estimate", usd: 0 });
  });

  it("a malformed id is rejected before the database is touched", async () => {
    const ledger = createLedgerPort(app);
    await expect(ledger.workItemBuildSpendUsd("not-a-uuid", "22222222-2222-4222-8222-222222222222")).rejects.toThrow(/UUID/);
    await expect(ledger.workItemBuildSpendUsd("22222222-2222-4222-8222-222222222222", "x")).rejects.toThrow(/UUID/);
  });
});
