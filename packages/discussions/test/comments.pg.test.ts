import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedMember, seedUser, seedAgentRun } from "./helpers/seed.js";
import { createDiscussion } from "../src/discussions.js";
import { postComment, editOwnComment, tombstoneComment } from "../src/comments.js";
import { DiscussionsError } from "../src/operations.js";
import { systemPrincipal } from "../src/server.js";
import { MAX_BODY_BYTES, MAX_COMMENTS_PER_RUN, MAX_RUN_COMMENT_BYTES } from "../src/limits.js";
import type { DiscussionsContext, Principal } from "../src/principals.js";
import { NotFoundError, ForbiddenError } from "@fx/core/src/tenancy/errors.js";

describe("comments.ts [pg]", () => {
  const db = pgHarness();

  async function seedTenant(): Promise<{ accountId: string; owner: Principal; member: Principal }> {
    const accountId = randomUUID();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedUser(db.admin, ownerId);
    await seedUser(db.admin, memberId);
    await seedMember(db.admin, accountId, ownerId, "owner");
    await seedMember(db.admin, accountId, memberId, "member");
    return {
      accountId,
      owner: { kind: "session", accountId, userId: ownerId, role: "owner" },
      member: { kind: "session", accountId, userId: memberId, role: "member" },
    };
  }

  function ctxFor(principal: Principal): DiscussionsContext {
    return { pool: db.appUserPool, principal };
  }

  async function seedRun(accountId: string, workItemId: string): Promise<Principal> {
    const runId = randomUUID();
    await seedAgentRun(db.admin, accountId, runId, { workItemId, role: "executor" });
    return { kind: "run", accountId, runId };
  }

  it("a session member may post and read back a top-level comment; discussion.comment_created is emitted", async () => {
    const { accountId, owner, member } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });

    const comment = await postComment(ctxFor(member), { discussionId: discussion.id, body: "hello" });
    expect(comment.authorKind).toBe("user");

    const { rows } = await db.admin.query(`SELECT author_kind, author_user_id, body FROM discussion_comments WHERE id = $1`, [comment.id]);
    expect(rows[0]).toMatchObject({ author_kind: "user", author_user_id: member.kind === "session" ? member.userId : null, body: "hello" });

    const { rows: eventRows } = await db.admin.query(
      `SELECT subject_id, payload FROM domain_events WHERE account_id = $1 AND type = 'discussion.comment_created'`,
      [accountId],
    );
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].subject_id).toBe(discussion.id);
    expect(eventRows[0].payload).toEqual({ commentId: comment.id, authorKind: "user" });
  });

  it("criterion 14: a reply to a comment that already has reply_to_id set is refused with invalid_input", async () => {
    const { owner } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    const top = await postComment(ctxFor(owner), { discussionId: discussion.id, body: "top" });
    const reply = await postComment(ctxFor(owner), { discussionId: discussion.id, body: "reply", replyToId: top.id });
    await expect(
      postComment(ctxFor(owner), { discussionId: discussion.id, body: "too deep", replyToId: reply.id }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a run principal may post only on its own work item's thread; a different thread reads as NotFoundError; an agent's comment can't be edited by anyone", async () => {
    const { accountId, owner } = await seedTenant();
    const ownDiscussion = await createDiscussion(ctxFor(owner), { title: "mine", kind: "feature", body: "b" });
    const otherDiscussion = await createDiscussion(ctxFor(owner), { title: "not mine", kind: "feature", body: "b" });
    const run = await seedRun(accountId, ownDiscussion.rootWorkItemId);

    const comment = await postComment(ctxFor(run), { discussionId: ownDiscussion.id, body: "from the run" });
    const { rows } = await db.admin.query(`SELECT author_kind, role, agent_run_id FROM discussion_comments WHERE id = $1`, [comment.id]);
    expect(rows[0]).toMatchObject({ author_kind: "agent", role: "executor", agent_run_id: run.kind === "run" ? run.runId : null });

    await expect(postComment(ctxFor(run), { discussionId: otherDiscussion.id, body: "wrong thread" })).rejects.toBeInstanceOf(NotFoundError);

    // A run principal is denied at the operation-table gate (comment.edit_own: run = deny).
    await expect(editOwnComment(ctxFor(run), { commentId: comment.id, body: "nope" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("criterion 10: a run's 21st comment, or one over MAX_RUN_COMMENT_BYTES total, is refused with quota_exceeded and writes exactly one discussion_quota_exceeded run_event", async () => {
    const { accountId, owner } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    const run = await seedRun(accountId, discussion.rootWorkItemId);
    const runId = (run as { runId: string }).runId;

    for (let i = 0; i < MAX_COMMENTS_PER_RUN; i++) {
      await postComment(ctxFor(run), { discussionId: discussion.id, body: `comment ${i}` });
    }
    await expect(postComment(ctxFor(run), { discussionId: discussion.id, body: "one too many" })).rejects.toMatchObject({ code: "quota_exceeded" });

    const { rows: countRows } = await db.admin.query(`SELECT count(*) FROM discussion_comments WHERE agent_run_id = $1`, [runId]);
    expect(Number(countRows[0].count)).toBe(MAX_COMMENTS_PER_RUN);
    const { rows: eventRows } = await db.admin.query(`SELECT kind FROM run_events WHERE run_id = $1 AND kind = 'discussion_quota_exceeded'`, [runId]);
    expect(eventRows).toHaveLength(1);
  });

  it("criterion 10: a run's total comment bytes over MAX_RUN_COMMENT_BYTES is refused with quota_exceeded", async () => {
    const { accountId, owner } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    const run = await seedRun(accountId, discussion.rootWorkItemId);

    // Each comment must stay under MAX_BODY_BYTES, so reach the run-total
    // ceiling across several: it's an exact multiple of MAX_BODY_BYTES
    // (262,144 / 65,536 = 4), so 4 max-sized comments land exactly at the
    // ceiling (allowed -- "over", not "at or over"), and a 5th tips it.
    const maxSizedBody = "x".repeat(MAX_BODY_BYTES);
    for (let i = 0; i < MAX_RUN_COMMENT_BYTES / maxSizedBody.length; i++) {
      await postComment(ctxFor(run), { discussionId: discussion.id, body: maxSizedBody });
    }
    await expect(postComment(ctxFor(run), { discussionId: discussion.id, body: "one more byte" })).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  it("criterion 12: a run's comment body is redacted before insert", async () => {
    const { accountId, owner } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    const run = await seedRun(accountId, discussion.rootWorkItemId);
    const fakeKey = "sk-ant-api03-" + "a".repeat(40);
    const comment = await postComment(ctxFor(run), { discussionId: discussion.id, body: `secret: ${fakeKey}` });
    const { rows } = await db.admin.query(`SELECT body FROM discussion_comments WHERE id = $1`, [comment.id]);
    expect(rows[0].body).not.toContain(fakeKey);
  });

  it("criterion 13: comment.edit_own succeeds for the comment's own author while still a member, and fails once removed", async () => {
    const { accountId, owner, member } = await seedTenant();
    const memberId = (member as { userId: string }).userId;
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    const comment = await postComment(ctxFor(member), { discussionId: discussion.id, body: "original" });

    await expect(editOwnComment(ctxFor(owner), { commentId: comment.id, body: "hijack" })).rejects.toBeInstanceOf(ForbiddenError);

    await editOwnComment(ctxFor(member), { commentId: comment.id, body: "edited" });
    const { rows } = await db.admin.query(`SELECT body, edited_at FROM discussion_comments WHERE id = $1`, [comment.id]);
    expect(rows[0].body).toBe("edited");
    expect(rows[0].edited_at).not.toBeNull();

    // Remove the member from the account -- criterion 13's "removed" case.
    await db.admin.query(`DELETE FROM account_members WHERE account_id = $1 AND user_id = $2`, [accountId, memberId]);
    await expect(editOwnComment(ctxFor(member), { commentId: comment.id, body: "again" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a NUL byte in a body is an invalid_input on post and edit, not a database error", async () => {
    const { owner, member } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    await expect(postComment(ctxFor(member), { discussionId: discussion.id, body: "a\u0000b" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    const comment = await postComment(ctxFor(member), { discussionId: discussion.id, body: "ok" });
    await expect(editOwnComment(ctxFor(member), { commentId: comment.id, body: "a\u0000b" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("editOwnComment refuses a tombstoned or erased comment as not found and leaves the body alone", async () => {
    const { owner, member } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    const tomb = await postComment(ctxFor(member), { discussionId: discussion.id, body: "one" });
    await tombstoneComment(ctxFor(owner), { commentId: tomb.id });
    await expect(editOwnComment(ctxFor(member), { commentId: tomb.id, body: "rewrite" })).rejects.toBeInstanceOf(NotFoundError);

    const erased = await postComment(ctxFor(member), { discussionId: discussion.id, body: "two" });
    await db.admin.query(`UPDATE discussion_comments SET body = '[erased]', erased_at = now() WHERE id = $1`, [erased.id]);
    await expect(editOwnComment(ctxFor(member), { commentId: erased.id, body: "rewrite" })).rejects.toBeInstanceOf(NotFoundError);

    const { rows } = await db.admin.query(`SELECT id, body FROM discussion_comments WHERE id = ANY($1)`, [[tomb.id, erased.id]]);
    expect(rows.map((r: { body: string }) => r.body).sort()).toEqual(["[erased]", "one"]);
  });

  it("re-tombstoning is idempotent: deleted_at keeps its first value", async () => {
    const { owner, member } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    const comment = await postComment(ctxFor(member), { discussionId: discussion.id, body: "hi" });
    await tombstoneComment(ctxFor(owner), { commentId: comment.id });
    const first = await db.admin.query(`SELECT deleted_at FROM discussion_comments WHERE id = $1`, [comment.id]);
    await tombstoneComment(ctxFor(owner), { commentId: comment.id });
    const second = await db.admin.query(`SELECT deleted_at FROM discussion_comments WHERE id = $1`, [comment.id]);
    expect(second.rows[0].deleted_at).toEqual(first.rows[0].deleted_at);
  });

  it("comment.tombstone_any: owner/admin may soft-delete any comment, a member may not, and a missing id is NotFoundError", async () => {
    const { owner, member } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    const comment = await postComment(ctxFor(member), { discussionId: discussion.id, body: "hi" });

    await expect(tombstoneComment(ctxFor(member), { commentId: comment.id })).rejects.toBeInstanceOf(ForbiddenError);
    await tombstoneComment(ctxFor(owner), { commentId: comment.id });
    const { rows } = await db.admin.query(`SELECT deleted_at FROM discussion_comments WHERE id = $1`, [comment.id]);
    expect(rows[0].deleted_at).not.toBeNull();

    await expect(tombstoneComment(ctxFor(owner), { commentId: randomUUID() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("criterion 3: an input carrying account_id/accountId is refused with invalid_input and writes no row", async () => {
    const { owner } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    await expect(
      postComment(ctxFor(owner), {
        discussionId: discussion.id,
        body: "b",
        // @ts-expect-error -- deliberately smuggling a forbidden key
        accountId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(DiscussionsError);
    const { rows } = await db.admin.query(`SELECT count(*) FROM discussion_comments WHERE discussion_id = $1`, [discussion.id]);
    expect(Number(rows[0].count)).toBe(0);
  });

  // --- #188 review SHOULD 1 and 2 (permanent regression tests) ---

  it("SHOULD-1: a run principal targeting ANOTHER tenant's discussion is refused as not-found, writes nothing there, and cannot borrow the other tenant by forging its accountId", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const discussionA = await createDiscussion(ctxFor(a.owner), { title: "A's", kind: "feature", body: "b" });
    const discussionB = await createDiscussion(ctxFor(b.owner), { title: "B's", kind: "feature", body: "b" });
    const runA = await seedRun(a.accountId, discussionA.rootWorkItemId);
    const runAId = (runA as { runId: string }).runId;

    // A's real run, aimed at B's discussion (the id it should not be able to see).
    await expect(postComment(ctxFor(runA), { discussionId: discussionB.id, body: "cross-tenant" })).rejects.toBeInstanceOf(NotFoundError);

    // A's run id smuggled under B's account: the agent_runs lookup runs under B's tenant, where the run does not exist.
    const forged: Principal = { kind: "run", accountId: b.accountId, runId: runAId };
    await expect(postComment(ctxFor(forged), { discussionId: discussionB.id, body: "forged tenant" })).rejects.toBeInstanceOf(NotFoundError);

    // B's discussion still has no comment at all, and neither run wrote a quota event.
    const { rows } = await db.admin.query(`SELECT count(*) FROM discussion_comments WHERE discussion_id = $1`, [discussionB.id]);
    expect(Number(rows[0].count)).toBe(0);
    const { rows: ev } = await db.admin.query(`SELECT count(*) FROM run_events WHERE run_id = $1`, [runAId]);
    expect(Number(ev[0].count)).toBe(0);
  });

  it("SHOULD-1: a forged role / agent_run_id / author_kind in postComment input is ignored -- the stored values come from agent_runs and the principal", async () => {
    const { accountId, owner } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    const run = await seedRun(accountId, discussion.rootWorkItemId); // agent_runs.role = 'executor'
    const otherRunId = randomUUID();
    await seedAgentRun(db.admin, accountId, otherRunId, { workItemId: discussion.rootWorkItemId, role: "security-reviewer" });

    const forgedInput = {
      discussionId: discussion.id,
      body: "I am totally the security reviewer",
      role: "security-reviewer",
      agentRunId: otherRunId,
      agent_run_id: otherRunId,
      authorKind: "user",
      author_kind: "user",
      provenance: "external",
    } as unknown as Parameters<typeof postComment>[1];

    const fromRun = await postComment(ctxFor(run), forgedInput);
    const { rows } = await db.admin.query(
      `SELECT author_kind, role, agent_run_id, provenance FROM discussion_comments WHERE id = $1`,
      [fromRun.id],
    );
    expect(rows[0]).toMatchObject({
      author_kind: "agent",
      role: "executor",
      agent_run_id: (run as { runId: string }).runId,
      provenance: "internal",
    });

    // The same forged fields from a human session cannot mint an agent-authored comment either.
    const fromHuman = await postComment(ctxFor(owner), forgedInput);
    const { rows: human } = await db.admin.query(`SELECT author_kind, role, agent_run_id FROM discussion_comments WHERE id = $1`, [
      fromHuman.id,
    ]);
    expect(human[0]).toMatchObject({ author_kind: "user", role: null, agent_run_id: null });
  });

  it("SHOULD-2: a session owner cannot edit an agent-authored (or system-authored) comment directly -- forbidden, body and edited_at untouched", async () => {
    const { accountId, owner } = await seedTenant();
    const discussion = await createDiscussion(ctxFor(owner), { title: "d", kind: "feature", body: "b" });
    const run = await seedRun(accountId, discussion.rootWorkItemId);
    const agentComment = await postComment(ctxFor(run), { discussionId: discussion.id, body: "what the agent wrote" });
    const systemComment = await postComment(ctxFor(systemPrincipal(accountId, "test")), {
      discussionId: discussion.id,
      body: "what the system wrote",
    });

    for (const [comment, original] of [
      [agentComment, "what the agent wrote"],
      [systemComment, "what the system wrote"],
    ] as const) {
      await expect(editOwnComment(ctxFor(owner), { commentId: comment.id, body: "rewritten by a human" })).rejects.toBeInstanceOf(ForbiddenError);
      const { rows } = await db.admin.query(`SELECT body, edited_at FROM discussion_comments WHERE id = $1`, [comment.id]);
      expect(rows[0]).toMatchObject({ body: original, edited_at: null });
    }
  });
});
