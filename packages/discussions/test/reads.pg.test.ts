import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { NotFoundError, ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedTenant, ctxFor, seedRunOn } from "./helpers/kit.js";
import { snapshotStore } from "./helpers/snapshot.js";
import { createDiscussion, reviseDiscussion } from "../src/discussions.js";
import { postComment, tombstoneComment } from "../src/comments.js";
import { listDiscussions, getDiscussion, listComments } from "../src/reads.js";
import type { Page } from "../src/reads.js";
import type { Principal } from "../src/principals.js";

/** A pool that fails the test if anything reaches it. */
const explodingPool = {
  connect: () => {
    throw new Error("connect() reached");
  },
  query: () => {
    throw new Error("query() reached");
  },
} as unknown as Pool;

describe("reads.ts, no query reached", () => {
  const someId = randomUUID();
  const readToken: Principal = { kind: "token", accountId: randomUUID(), userId: randomUUID(), tokenId: randomUUID(), scopes: ["read"] };
  const writeOnlyToken: Principal = { ...readToken, scopes: ["write"] } as Principal;

  it("a token without read scope is forbidden from all three functions, before any query", async () => {
    const ctx = ctxFor(explodingPool, writeOnlyToken);
    await expect(listDiscussions(ctx, { limit: 10 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDiscussion(ctx, { discussionId: someId })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listComments(ctx, { discussionId: someId, limit: 10 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a malformed discussion id is NotFoundError before any query", async () => {
    const ctx = ctxFor(explodingPool, readToken);
    for (const bad of ["nope", "", "123", `${someId}x`, "'; DROP TABLE discussions; --", 5, null, undefined]) {
      await expect(getDiscussion(ctx, { discussionId: bad as string })).rejects.toBeInstanceOf(NotFoundError);
      await expect(listComments(ctx, { discussionId: bad as string, limit: 10 })).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("bad limits, bad cursors and an account id in the input are invalid_input before any query", async () => {
    const ctx = ctxFor(explodingPool, readToken);
    for (const limit of [0, 201, 1.5, -1, Number.NaN, "10", undefined]) {
      await expect(listDiscussions(ctx, { limit: limit as number })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(listComments(ctx, { discussionId: someId, limit: limit as number })).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const after of [
      { createdAt: new Date("nope"), id: someId },
      { createdAt: "2026-01-01", id: someId },
      { createdAt: new Date(), id: "not-a-uuid" },
      [],
      null,
    ]) {
      await expect(listDiscussions(ctx, { limit: 5, after: after as never })).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(listDiscussions(ctx, { limit: 5, accountId: randomUUID() } as never)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(getDiscussion(ctx, { discussionId: someId, account_id: randomUUID() } as never)).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("reads.ts [pg]", () => {
  const db = pgHarness();
  const ctx = (p: Principal) => ctxFor(db.appUserPool, p);

  async function allPages<T extends { id: string }>(
    fetch: (after?: { createdAt: Date; id: string }) => Promise<Page<T>>,
  ): Promise<{ sizes: number[]; ids: string[]; last: Page<T> }> {
    const sizes: number[] = [];
    const ids: string[] = [];
    let after: { createdAt: Date; id: string } | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await fetch(after);
      sizes.push(page.items.length);
      ids.push(...page.items.map((x) => x.id));
      if (!page.nextCursor) return { sizes, ids, last: page };
      after = page.nextCursor;
    }
    throw new Error("pagination did not terminate");
  }

  it("1. every readable principal kind can list, get and list comments in its own account", async () => {
    const t = await seedTenant(db.admin);
    const d = await createDiscussion(ctx(t.owner), { title: "one", kind: "feature", body: "first body" });
    await postComment(ctx(t.owner), { discussionId: d.id, body: "a comment" });

    for (const p of [t.owner, t.admin, t.member, t.tokenRead, t.tokenWrite, t.system]) {
      const list = await listDiscussions(ctx(p), { limit: 10 });
      expect(list.items.map((x) => x.id)).toEqual([d.id]);
      expect(list.items[0]).not.toHaveProperty("body");
      const got = await getDiscussion(ctx(p), { discussionId: d.id });
      expect(got).toMatchObject({ id: d.id, number: d.number, title: "one", kind: "feature", body: "first body", rev: 1 });
      const comments = await listComments(ctx(p), { discussionId: d.id, limit: 10 });
      expect(comments.items.map((c) => c.body)).toEqual(["a comment"]);
    }

    const writeOnly = { ...t.tokenWrite, scopes: ["write"] } as Principal;
    await expect(listDiscussions(ctx(writeOnly), { limit: 10 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDiscussion(ctx(writeOnly), { discussionId: d.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listComments(ctx(writeOnly), { discussionId: d.id, limit: 10 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("2. not found is uniform, and no read crosses tenants", async () => {
    const a = await seedTenant(db.admin);
    const b = await seedTenant(db.admin);
    const dA = await createDiscussion(ctx(a.owner), { title: "A's", kind: "feature", body: "secret A" });
    await postComment(ctx(a.owner), { discussionId: dA.id, body: "A comment" });
    const dB = await createDiscussion(ctx(b.owner), { title: "B's", kind: "bug", body: "B body" });

    const messages = new Set<string>();
    for (const id of [randomUUID(), "not-a-uuid", dA.id]) {
      const errs = [
        await getDiscussion(ctx(b.owner), { discussionId: id }).catch((e: unknown) => e),
        await listComments(ctx(b.owner), { discussionId: id, limit: 5 }).catch((e: unknown) => e),
      ];
      for (const e of errs) {
        expect(e).toBeInstanceOf(NotFoundError);
        messages.add((e as Error).message.replace(id, "<id>"));
      }
    }
    expect([...messages]).toEqual(["discussion not found: <id>"]);

    for (const p of [b.owner, b.system]) {
      const list = await listDiscussions(ctx(p), { limit: 50 });
      expect(list.items.map((x) => x.id)).toEqual([dB.id]);
    }
    // And A still sees only its own.
    expect((await listDiscussions(ctx(a.owner), { limit: 50 })).items.map((x) => x.id)).toEqual([dA.id]);
  });

  it("3. a run sees exactly its own work item, its ancestors and its direct deps", async () => {
    const t = await seedTenant(db.admin);
    const mk = (title: string) => createDiscussion(ctx(t.owner), { title, kind: "feature", body: `${title} body` });
    const [P, C, D, S] = [await mk("P"), await mk("C"), await mk("D"), await mk("S")];
    await db.admin.query(`UPDATE work_items SET parent_id = $2 WHERE id = $1`, [C.rootWorkItemId, P.rootWorkItemId]);
    await db.admin.query(`INSERT INTO work_item_deps (account_id, work_item_id, depends_on_id) VALUES ($1, $2, $3)`, [
      t.accountId,
      C.rootWorkItemId,
      D.rootWorkItemId,
    ]);
    for (const d of [P, C, D, S]) await postComment(ctx(t.owner), { discussionId: d.id, body: `comment on ${d.id}` });
    const run = await seedRunOn(db.admin, t.accountId, C.rootWorkItemId);

    const list = await listDiscussions(ctx(run), { limit: 50 });
    expect(list.items.map((x) => x.id).sort()).toEqual([P.id, C.id, D.id].sort());
    for (const d of [P, C, D]) {
      expect((await getDiscussion(ctx(run), { discussionId: d.id })).title).toBe(d.title);
      expect((await listComments(ctx(run), { discussionId: d.id, limit: 5 })).items).toHaveLength(1);
    }
    const missing = await getDiscussion(ctx(run), { discussionId: randomUUID() }).catch((e: unknown) => e);
    const sibling = await getDiscussion(ctx(run), { discussionId: S.id }).catch((e: unknown) => e);
    expect(sibling).toBeInstanceOf(NotFoundError);
    expect((sibling as Error).message.replace(S.id, "<id>")).toBe((missing as Error).message.replace(/[0-9a-f-]{36}/, "<id>"));
    await expect(listComments(ctx(run), { discussionId: S.id, limit: 5 })).rejects.toBeInstanceOf(NotFoundError);

    // Paging over the readable set only: 3 readable, page size 2 -> 2 then 1.
    const paged = await allPages((after) => listDiscussions(ctx(run), { limit: 2, after }));
    expect(paged.sizes).toEqual([2, 1]);
    expect(paged.ids).not.toContain(S.id);

    const noItem = await seedRunOn(db.admin, t.accountId, null);
    expect((await listDiscussions(ctx(noItem), { limit: 50 })).items).toEqual([]);
    await expect(getDiscussion(ctx(noItem), { discussionId: P.id })).rejects.toBeInstanceOf(NotFoundError);
    const ghost: Principal = { kind: "run", accountId: t.accountId, runId: randomUUID() };
    expect((await listDiscussions(ctx(ghost), { limit: 50 })).items).toEqual([]);
    await expect(listComments(ctx(ghost), { discussionId: P.id, limit: 5 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("4. keyset pagination: no duplicate or gap across equal timestamps, both orders", async () => {
    const t = await seedTenant(db.admin);
    const ds = [];
    for (let i = 0; i < 5; i++) ds.push(await createDiscussion(ctx(t.owner), { title: `d${i}`, kind: "small", body: "b" }));
    const stamps = ["2026-03-01T00:00:01.123456Z", "2026-03-01T00:00:02Z", "2026-03-01T00:00:03Z", "2026-03-01T00:00:03Z", "2026-03-01T00:00:03Z"];
    for (const [i, d] of ds.entries()) await db.admin.query(`UPDATE discussions SET created_at = $2 WHERE id = $1`, [d.id, stamps[i]]);
    const expectedDesc = (
      await db.admin.query<{ id: string }>(`SELECT id FROM discussions WHERE account_id = $1 ORDER BY created_at DESC, id DESC`, [t.accountId])
    ).rows.map((r) => r.id);

    const dp = await allPages((after) => listDiscussions(ctx(t.owner), { limit: 2, after }));
    expect(dp.sizes).toEqual([2, 2, 1]);
    expect(dp.ids).toEqual(expectedDesc);
    expect(dp.last.nextCursor).toBeNull();

    const d = ds[0]!;
    const cs = [];
    for (let i = 0; i < 5; i++) cs.push(await postComment(ctx(t.owner), { discussionId: d.id, body: `c${i}` }));
    for (const [i, c] of cs.entries()) await db.admin.query(`UPDATE discussion_comments SET created_at = $2 WHERE id = $1`, [c.id, stamps[i]]);
    const expectedAsc = (
      await db.admin.query<{ id: string }>(`SELECT id FROM discussion_comments WHERE discussion_id = $1 ORDER BY created_at ASC, id ASC`, [d.id])
    ).rows.map((r) => r.id);
    const cp = await allPages((after) => listComments(ctx(t.owner), { discussionId: d.id, limit: 2, after }));
    expect(cp.sizes).toEqual([2, 2, 1]);
    expect(cp.ids).toEqual(expectedAsc);
    expect(cp.last.nextCursor).toBeNull();

    // Microsecond tails: rows sharing a millisecond still page without a gap.
    await db.admin.query(`UPDATE discussions SET created_at = '2026-04-01T00:00:00.500900Z' WHERE id = $1`, [ds[1]!.id]);
    await db.admin.query(`UPDATE discussions SET created_at = '2026-04-01T00:00:00.500100Z' WHERE id = $1`, [ds[2]!.id]);
    const again = await allPages((after) => listDiscussions(ctx(t.owner), { limit: 1, after }));
    expect(again.ids.sort()).toEqual(ds.map((x) => x.id).sort());

    await expect(listDiscussions(ctx(t.owner), { limit: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(listDiscussions(ctx(t.owner), { limit: 201 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(listDiscussions(ctx(t.owner), { limit: 1.5 })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await listDiscussions(ctx(t.owner), { limit: 200 })).items).toHaveLength(5);
  });

  it("5. getDiscussion returns the latest revision; a tombstoned comment has a null body and keeps its reply", async () => {
    const t = await seedTenant(db.admin);
    const d = await createDiscussion(ctx(t.owner), { title: "rev", kind: "doc", body: "rev one" });
    await reviseDiscussion(ctx(t.owner), { discussionId: d.id, body: "rev two" });
    const got = await getDiscussion(ctx(t.owner), { discussionId: d.id });
    expect(got).toMatchObject({ body: "rev two", rev: 2 });
    const { rows } = await db.admin.query(`SELECT created_at FROM discussion_revisions WHERE discussion_id = $1 AND rev = 2`, [d.id]);
    expect(got.revisedAt).toEqual(rows[0].created_at);

    const parent = await postComment(ctx(t.member), { discussionId: d.id, body: "to be removed" });
    const reply = await postComment(ctx(t.owner), { discussionId: d.id, body: "a reply", replyToId: parent.id });
    const erased = await postComment(ctx(t.owner), { discussionId: d.id, body: "will be erased" });
    await tombstoneComment(ctx(t.owner), { commentId: parent.id });
    await db.admin.query(`UPDATE discussion_comments SET body = '[erased]', erased_at = now() WHERE id = $1`, [erased.id]);

    const items = (await listComments(ctx(t.owner), { discussionId: d.id, limit: 10 })).items;
    const byId = new Map(items.map((c) => [c.id, c]));
    expect(byId.get(parent.id)).toMatchObject({ body: null, deleted: true, authorKind: "user", replyToId: null });
    expect(byId.get(reply.id)).toMatchObject({ body: "a reply", deleted: false, replyToId: parent.id });
    expect(byId.get(erased.id)).toMatchObject({ body: "[erased]", deleted: false });
  });

  it("6. reads write nothing", async () => {
    const t = await seedTenant(db.admin);
    const d = await createDiscussion(ctx(t.owner), { title: "ro", kind: "feature", body: "b" });
    await postComment(ctx(t.owner), { discussionId: d.id, body: "c" });
    const run = await seedRunOn(db.admin, t.accountId, d.rootWorkItemId);
    const before = await snapshotStore(db.admin, t.accountId);
    for (const p of [t.owner, t.member, t.tokenRead, t.system, run]) {
      await listDiscussions(ctx(p), { limit: 5 });
      await getDiscussion(ctx(p), { discussionId: d.id });
      await listComments(ctx(p), { discussionId: d.id, limit: 5 });
    }
    expect(await snapshotStore(db.admin, t.accountId)).toEqual(before);
  });
});
