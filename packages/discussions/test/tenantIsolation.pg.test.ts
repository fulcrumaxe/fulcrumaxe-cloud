import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedMember, seedUser } from "./helpers/seed.js";
import { createDiscussion, reviseDiscussion, setSecurity } from "../src/discussions.js";
import { postComment, editOwnComment, tombstoneComment } from "../src/comments.js";
import { STORAGE_QUOTA_BYTES } from "../src/limits.js";
import type { DiscussionsContext, Principal } from "../src/principals.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";

/** SECURITY (spawn brief): "Prove cross-tenant isolation LIVE with two
 * tenants." Two real, separately-seeded accounts, both talking to the
 * same app_user pool -- everything below relies solely on RLS to keep
 * them apart, never on any check in this package's own code. */
describe("cross-tenant isolation [pg]", () => {
  const db = pgHarness();

  async function seedTenant(): Promise<Principal> {
    const accountId = randomUUID();
    const ownerId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedUser(db.admin, ownerId);
    await seedMember(db.admin, accountId, ownerId, "owner");
    return { kind: "session", accountId, userId: ownerId, role: "owner" };
  }

  function ctxFor(principal: Principal): DiscussionsContext {
    return { pool: db.appUserPool, principal };
  }

  it("tenant B cannot revise, comment on, secure, or tombstone tenant A's discussion or comment -- each reads as NotFoundError, and A's data is untouched", async () => {
    const ownerA = await seedTenant();
    const ownerB = await seedTenant();
    const discussionA = await createDiscussion(ctxFor(ownerA), { title: "A's discussion", kind: "feature", body: "A's body" });
    const commentA = await postComment(ctxFor(ownerA), { discussionId: discussionA.id, body: "A's comment" });

    await expect(reviseDiscussion(ctxFor(ownerB), { discussionId: discussionA.id, body: "hijacked" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(postComment(ctxFor(ownerB), { discussionId: discussionA.id, body: "not A's thread" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setSecurity(ctxFor(ownerB), { discussionId: discussionA.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(tombstoneComment(ctxFor(ownerB), { commentId: commentA.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(editOwnComment(ctxFor(ownerB), { commentId: commentA.id, body: "hijacked" })).rejects.toBeInstanceOf(NotFoundError);

    const { rows: revRows } = await db.admin.query(`SELECT rev, body FROM discussion_revisions WHERE discussion_id = $1`, [discussionA.id]);
    expect(revRows).toHaveLength(1);
    expect(revRows[0].body).toBe("A's body");

    const { rows: discRows } = await db.admin.query(`SELECT security FROM discussions WHERE id = $1`, [discussionA.id]);
    expect(discRows[0].security).toBe(false);

    const { rows: commentRows } = await db.admin.query(
      `SELECT body, deleted_at, edited_at FROM discussion_comments WHERE id = $1`,
      [commentA.id],
    );
    expect(commentRows[0]).toMatchObject({ body: "A's comment", deleted_at: null, edited_at: null });
  });

  it("both tenants number their own discussions independently, starting at 1", async () => {
    const ownerA = await seedTenant();
    const ownerB = await seedTenant();
    const a1 = await createDiscussion(ctxFor(ownerA), { title: "A1", kind: "feature", body: "b" });
    const b1 = await createDiscussion(ctxFor(ownerB), { title: "B1", kind: "feature", body: "b" });
    const a2 = await createDiscussion(ctxFor(ownerA), { title: "A2", kind: "feature", body: "b" });
    expect([a1.number, b1.number, a2.number]).toEqual([1, 1, 2]);
  });

  it("each tenant's storage quota is charged independently -- filling A's does not affect B", async () => {
    const ownerA = await seedTenant();
    const ownerB = await seedTenant();

    await db.admin.query(`INSERT INTO discussion_counters (account_id) VALUES ($1)`, [ownerA.accountId]);
    await db.admin.query(`UPDATE discussion_counters SET bytes_used = $2 WHERE account_id = $1`, [
      ownerA.accountId,
      STORAGE_QUOTA_BYTES.starter - 10,
    ]);

    await expect(
      createDiscussion(ctxFor(ownerA), { title: "over A's quota", kind: "feature", body: "x".repeat(1000) }),
    ).rejects.toMatchObject({ code: "storage_quota_exceeded" });

    // B is nowhere near its own quota and is unaffected by A's.
    await expect(
      createDiscussion(ctxFor(ownerB), { title: "fine for B", kind: "feature", body: "x".repeat(1000) }),
    ).resolves.toMatchObject({ number: 1 });
  });
});
