import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@fx/spend";
import { readPersonManaged } from "../src/index.js";
import { pools, seedAccount, seedItem, type Pool } from "./pgSeed.js";

/**
 * D#7 DP7-2d criterion 3, the takeover read: the item's NEWEST push record, a takeover stamp or the takeover state, as the branch sweep reads it,
 * on the app role under the item's own tenant (RLS). An item with no record has not been taken over.
 */
describe("readPersonManaged against real rows", () => {
  let admin: Pool;
  let app: Pool;
  beforeAll(() => ({ admin, app } = pools()));
  afterAll(async () => {
    await admin.end();
    await app.end();
  });

  async function push(acct: string, item: string, repo: string, o: { state?: string; managed?: boolean; ageMinutes?: number; codeRepo?: string }) {
    await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, managed_by_person_at, created_at)
       VALUES ($1, $2, $3, $8, $4, $5, $6, now() - ($7::int * interval '1 minute'))`,
      [acct, item, repo, "c".repeat(64), o.state ?? "building", o.managed ? new Date() : null, o.ageMinutes ?? 0, o.codeRepo ?? "acme/widgets-public"],
    );
  }
  async function world() {
    const acct = await seedAccount(admin);
    const repo = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'widgets', '{}'::jsonb)`, [repo, acct, Math.floor(Math.random() * 1e9)]);
    const item = await seedItem(admin, acct, "pr_opened");
    return { acct, repo, item };
  }
  const read = (acct: string, item: string, asAccount = acct) => withTenant(app, asAccount, (c) => readPersonManaged(c, acct, item));

  it("no push record: not taken over", async () => {
    const { acct, item } = await world();
    expect(await read(acct, item)).toBe(false);
  });

  it("a takeover stamp, or the managed_by_person state, is a takeover", async () => {
    const a = await world();
    await push(a.acct, a.item, a.repo, { managed: true });
    expect(await read(a.acct, a.item)).toBe(true);
    const b = await world();
    await push(b.acct, b.item, b.repo, { state: "managed_by_person" });
    expect(await read(b.acct, b.item)).toBe(true);
  });

  it("only the newest record counts", async () => {
    const { acct, repo, item } = await world();
    // One record per public repository: the older one is for a pairing the item had before.
    await push(acct, item, repo, { managed: true, ageMinutes: 30, codeRepo: "acme/old-public" });
    await push(acct, item, repo, { state: "building", ageMinutes: 1 });
    expect(await read(acct, item)).toBe(false);
  });

  it("another account's takeover is invisible under this tenant", async () => {
    const theirs = await world();
    await push(theirs.acct, theirs.item, theirs.repo, { managed: true });
    const mine = await world();
    expect(await read(theirs.acct, theirs.item, mine.acct)).toBe(false);
  });
});
