import { z } from "zod";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import type { RouteEntry } from "../registry.js";
import { UUID_RE, idParamsSchema, notFound } from "./run-actions.js";

/**
 * D#483 S5-b2d-1: the follow-ups reviewers and executors raise, and the per-repo switch that decides whether one becomes its own item.
 *
 *  - The switch: no stored version means on. A PUT goes through `follow_up_setting_write` (migration 0960), which re-checks owner or admin, appends one
 *    version and one audit row naming the actor and both values, and writes nothing when the value is already in force. Undo is the other value.
 *  - The list: an item's follow-ups, oldest first, as text with a fixed disposition and the role that raised it. The run that raised one is not exposed,
 *    and there is no child link until S5-b2d-2 creates children. Rows are history: there is no delete.
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
  title: z.string(),
  why: z.string(),
  /** `child`: it becomes its own item (S5-b2d-2). `note`: it stays a note on this item, because the repo's switch was off when it was raised. */
  disposition: z.enum(["child", "note"]),
  source_role: z.string(),
  source_label: z.string(),
  created_at: z.string(),
});
const listResponse = z.object({ work_item_id: z.string(), follow_ups: z.array(followUpSchema) });

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
        const item = await client.query("SELECT 1 FROM work_items WHERE id = $1", [id]);
        if (item.rowCount !== 1) throw notFound();
        const { rows } = await client.query<{ title: string; why: string; disposition: "child" | "note"; source_role: string; created_at: Date }>(
          "SELECT title, why, disposition, source_role, created_at FROM work_item_follow_ups WHERE work_item_id = $1 ORDER BY created_at, id",
          [id],
        );
        return {
          work_item_id: id,
          follow_ups: rows.map((r) => ({
            title: r.title,
            why: r.why,
            disposition: r.disposition,
            source_role: r.source_role,
            source_label: SOURCE_LABELS[r.source_role] ?? "Reviewer",
            created_at: r.created_at.toISOString(),
          })),
        };
      });
    },
  },
];
