import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedWorkItemAt, count } from "./helpers/kit.js";
import { snapshotStore } from "./helpers/snapshot.js";
import { createDiscussion } from "../src/discussions.js";
import { postComment, tombstoneComment } from "../src/comments.js";
import { setStage } from "../src/stages.js";
import type { Principal } from "../src/principals.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";

/**
 * DS-2e [pg]: a session principal whose role is not owner/admin/member is
 * refused before any write. Roles are cast in because the type forbids them;
 * the point is that nothing at runtime trusts the type.
 */
describe("session role allowlist [pg]", () => {
  const db = pgHarness();
  const ctx = (p: Principal) => ctxFor(db.appUserPool, p);
  const withRole = (base: Principal, role: unknown): Principal => ({ ...base, role }) as unknown as Principal;
  const BAD_ROLES: unknown[] = ["viewer", "MEMBER", "", undefined];

  it("setStage to a human-only stage change writes nothing for a bad role", async () => {
    const t = await seedTenant(db.admin);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "needs_human");
    const before = await snapshotStore(db.admin, t.accountId);
    const transitionsBefore = await count(db.admin, `SELECT 1 FROM work_item_transitions WHERE work_item_id = $1`, [wi]);
    for (const role of BAD_ROLES) {
      await expect(setStage(ctx(withRole(t.owner, role)), { workItemId: wi, toStage: "in_progress" }), String(role)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    const { rows } = await db.admin.query(`SELECT stage FROM work_items WHERE id = $1`, [wi]);
    expect(rows[0].stage).toBe("needs_human");
    expect(await count(db.admin, `SELECT 1 FROM work_item_transitions WHERE work_item_id = $1`, [wi])).toBe(transitionsBefore);
    expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
  });

  it("tombstoning another author's comment writes nothing for a bad role", async () => {
    const t = await seedTenant(db.admin);
    const discussion = await createDiscussion(ctx(t.owner), { title: "d", kind: "feature", body: "b" });
    const comment = await postComment(ctx(t.member), { discussionId: discussion.id, body: "hi" });
    const before = await snapshotStore(db.admin, t.accountId);
    for (const role of BAD_ROLES) {
      await expect(tombstoneComment(ctx(withRole(t.owner, role)), { commentId: comment.id }), String(role)).rejects.toBeInstanceOf(ForbiddenError);
    }
    const { rows } = await db.admin.query(`SELECT deleted_at, body FROM discussion_comments WHERE id = $1`, [comment.id]);
    expect(rows[0].deleted_at).toBeNull();
    expect(rows[0].body).toBe("hi");
    expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
  });

  it("owner, admin and member keep their access", async () => {
    const t = await seedTenant(db.admin);
    const discussion = await createDiscussion(ctx(t.owner), { title: "d", kind: "feature", body: "b" });
    const c1 = await postComment(ctx(t.member), { discussionId: discussion.id, body: "one" });
    const c2 = await postComment(ctx(t.member), { discussionId: discussion.id, body: "two" });
    await tombstoneComment(ctx(t.owner), { commentId: c1.id });
    await tombstoneComment(ctx(t.admin), { commentId: c2.id });
    await expect(tombstoneComment(ctx(t.member), { commentId: c1.id })).rejects.toBeInstanceOf(ForbiddenError);
    const wi = await seedWorkItemAt(db.admin, t.accountId, "needs_human");
    await expect(setStage(ctx(t.admin), { workItemId: wi, toStage: "in_progress" })).resolves.toMatchObject({ recorded: true });
  });
});
