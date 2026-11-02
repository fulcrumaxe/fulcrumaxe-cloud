import { z } from "zod";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { FOLLOW_UP_CHILD_START_SUPPORTED } from "@fx/pipeline";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";
import { UUID_RE, idParamsSchema, notFound } from "./run-actions.js";

/**
 * D#483 S5-b2d-1: the follow-ups reviewers and executors raise, and the per-repo switch that decides whether one becomes its own item.
 *
 *  - The switch: no stored version means on. A PUT goes through `follow_up_setting_write` (migration 0960), which re-checks owner or admin, appends one
 *    version and one audit row naming the actor and both values, and writes nothing when the value is already in force. Undo is the other value.
 *  - The list: an item's follow-ups, oldest first, as text with a fixed `state` and the role that raised it. The run that raised one is not exposed. A
 *    follow-up that became an item carries that item's id and stage. The state is derived on every read (never stored): `item`, `pending` (a child the
 *    sweep has not made yet), `note`, or `parent_closed` (the parent closed before any child existed). Rows are history: there is no delete.
 *  - "Make it an item" (S5-b2d-2c): owner or admin, session only, through `follow_up_child_create` (0961) in its person mode, which records the actor in the
 *    audit log. A replay answers the child that exists; closing the child is the undo.
 */

const settingResponse = z.object({
  children: z.boolean(),
  /** True when no person ever chose a value for this repo (the default, on, is in force). */
  default: z.boolean(),
});
const putBody = z.object({ children: z.boolean() }).strict();

const SOURCE_LABELS: Record<string, string> = {
  "code-reviewer": "Code reviewer",
  "security-reviewer": "Security reviewer",
  "acceptance-tester": "Acceptance tester",
  executor: "Executor",
};
const followUpSchema = z.object({
  id: z.string(),
  title: z.string(),
  why: z.string(),
  /** `child`: it becomes its own item (S5-b2d-2). `note`: it stays a note on this item, because the repo's switch was off when it was raised. */
  disposition: z.enum(["child", "note"]),
  source_role: z.string(),
  source_label: z.string(),
  created_at: z.string(),
  /** `item`: it is its own item (`child_id`, `child_stage`). `pending`: marked to become one. `note`: kept as a note. `parent_closed`: the parent closed first. */
  state: z.enum(["item", "pending", "note", "parent_closed"]),
  child_id: z.string().optional(),
  child_stage: z.string().optional(),
});
const listResponse = z.object({
  work_item_id: z.string(),
  /** True when the viewer may use "Make it an item" (an owner or admin signed in with a session). */
  can_make_item: z.boolean(),
  /** False while follow-ups cannot yet become items (the button is shown disabled). */
  make_item_available: z.boolean(),
  follow_ups: z.array(followUpSchema),
});
/** C29: "Make it an item" waits on the same flag as the producer (pipeline's `FOLLOW_UP_CHILD_START_SUPPORTED`), so no child is made that cannot start. Tests inject it. */
export const followUpItemDeps: { startSupported: boolean } = { startSupported: FOLLOW_UP_CHILD_START_SUPPORTED };
const ITEMS_UNAVAILABLE = "Follow-ups become items in a later release.";
const makeItemParams = z.object({ id: z.string(), follow_up_id: z.string() });
const makeItemResponse = z.object({ work_item_id: z.string(), follow_up_id: z.string(), child_id: z.string(), created: z.boolean() });

async function readSetting(client: PoolClient, repoId: string): Promise<z.infer<typeof settingResponse>> {
  const { rows } = await client.query<{ children: boolean }>("SELECT children FROM follow_up_settings WHERE repo_id = $1 ORDER BY version DESC LIMIT 1", [repoId]);
  return rows[0] ? { children: rows[0].children === true, default: false } : { children: true, default: true };
}

export const followUpRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/follow-ups/setting",
    operationId: "getFollowUpSetting",
    summary: "Whether follow-ups raised on this repo's items become their own items (on unless a person switched it off)",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: settingResponse,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertRepoExists(client, repoId);
        return readSetting(client, repoId);
      });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/repos/{id}/follow-ups/setting",
    operationId: "setFollowUpSetting",
    summary: "Switch whether follow-ups on this repo become their own items",
    description:
      "Appends one version and one audit row naming the actor, the previous and the new value. The value already in force writes nothing. " +
      "Follow-ups already recorded keep the disposition they were given. Owner or admin, session only; `Idempotency-Key` is required.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "required",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: putBody,
    responseSchema: settingResponse,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const body = input.body as z.infer<typeof putBody>;
      const { accountId, userId } = ctx.principal;
      try {
        return await withTenant(ctx.pool, accountId, userId, async (client) => {
          await assertRepoExists(client, repoId);
          await client.query("SELECT * FROM follow_up_setting_write($1, $2)", [repoId, body.children]);
          return readSetting(client, repoId);
        });
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code === "42501") throw new ForbiddenError("only an owner or admin can change this");
        if (code === "P0002") throw notFound();
        throw error;
      }
    },
  },
  {
    method: "GET",
    path: "/api/v1/work-items/{id}/follow-ups",
    operationId: "listWorkItemFollowUps",
    summary: "The follow-ups raised on a work item, oldest first",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: listResponse,
    async handler(ctx, input) {
      const id = input.params.id!;
      if (!UUID_RE.test(id)) throw notFound();
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        const item = await client.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id]);
        if (item.rowCount !== 1) throw notFound();
        const parentClosed = item.rows[0]!.stage === "closed";
        const { rows } = await client.query<{ id: string; title: string; why: string; disposition: "child" | "note"; source_role: string; created_at: Date; child_id: string | null; child_stage: string | null }>(
          "SELECT f.id, f.title, f.why, f.disposition, f.source_role, f.created_at, f.child_id, c.stage AS child_stage FROM work_item_follow_ups f LEFT JOIN work_items c ON c.id = f.child_id WHERE f.work_item_id = $1 ORDER BY f.created_at, f.id",
          [id],
        );
        return {
          work_item_id: id,
          can_make_item: ctx.principal.kind === "session" && (ctx.principal.role === "owner" || ctx.principal.role === "admin"),
          make_item_available: followUpItemDeps.startSupported,
          follow_ups: rows.map((r) => ({
            id: r.id,
            title: r.title,
            why: r.why,
            disposition: r.disposition,
            source_role: r.source_role,
            source_label: SOURCE_LABELS[r.source_role] ?? "Reviewer",
            created_at: r.created_at.toISOString(),
            state: r.child_id !== null ? ("item" as const) : parentClosed ? ("parent_closed" as const) : r.disposition === "child" ? ("pending" as const) : ("note" as const),
            ...(r.child_id !== null ? { child_id: r.child_id, child_stage: r.child_stage ?? "closed" } : {}),
          })),
        };
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/work-items/{id}/follow-ups/{follow_up_id}/make-item",
    operationId: "makeFollowUpItem",
    summary: "Make a follow-up its own work item",
    description:
      "Owner or admin, session only; a token is refused. `Idempotency-Key` is required. Takes no request body. Creates one child work item for the follow-up (kind `small`, the parent's repo and provenance) and records the signed-in person in the audit log. " +
      "A follow-up that already has its item answers that item with `created: false`. Closing the child is the undo. 404 for an unknown work item or follow-up; 409 `follow_up_items_unavailable` while follow-ups cannot become items yet (nothing is written), 409 `parent_closed`.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "required",
    rateClass: "write",
    paramsSchema: makeItemParams,
    responseSchema: makeItemResponse,
    extraResponses: {
      "403": "Error `session_required` or `insufficient_role` (owner or admin only).",
      "404": "No such work item or follow-up in this account.",
      "409": "Error `follow_up_items_unavailable` (follow-ups cannot become items yet) or `parent_closed` (the work item closed, so it gets no new item).",
    },
    async handler(ctx, input) {
      const { id, follow_up_id: followUpId } = input.params as { id: string; follow_up_id: string };
      if (!UUID_RE.test(id) || !UUID_RE.test(followUpId)) throw notFound();
      if (!followUpItemDeps.startSupported) throw new ApiError(409, "follow_up_items_unavailable", ITEMS_UNAVAILABLE);
      const { accountId, userId } = ctx.principal;
      try {
        const row = await withTenant(ctx.pool, accountId, userId, async (client) => {
          const own = await client.query("SELECT 1 FROM work_item_follow_ups WHERE id = $1 AND work_item_id = $2", [followUpId, id]);
          if (own.rowCount !== 1) throw notFound();
          return (await client.query<{ o_child_id: string; o_created: boolean }>("SELECT * FROM follow_up_child_create($1::uuid)", [followUpId])).rows[0]!;
        });
        if (!row.o_created) ctx.markReplayed?.();
        return { work_item_id: id, follow_up_id: followUpId, child_id: row.o_child_id, created: row.o_created };
      } catch (error) {
        const e = error as { code?: string; message?: string } | null;
        if (e?.code === "42501") throw new ForbiddenError("only an owner or admin can do this");
        if (e?.code === "P0002") throw notFound();
        if (e?.code === "55000" && e.message === "parent_closed") throw new ApiError(409, "parent_closed", "the work item closed, so this follow-up cannot become an item");
        throw error;
      }
    },
  },
];
