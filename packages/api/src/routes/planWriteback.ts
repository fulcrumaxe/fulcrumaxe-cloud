import { z } from "zod";
import type { PoolClient } from "pg";
import {
  PLAN_WRITEBACK_DEFAULT_AUTO_MERGE,
  PlanWritebackSettingError,
  appendPlanWritebackVersion,
  getCurrentPlanWritebackSetting,
} from "@fx/db/src/planWritebackSettings.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";
import { idParamsSchema } from "./run-actions.js";

/**
 * D#598 P5c-a: the per-repo switch for merging plan updates automatically. This file is the HTTP face of `plan_writeback_settings` (0967) and
 * adds no rule of its own:
 *
 *  - No stored version means off (`default: true`). `auto_merge` is always a boolean in the answer, never null.
 *  - A PUT appends one version and one audit row naming the previous and the new value, in one transaction. The value already in force writes
 *    nothing and answers the current state. Undo is the other value, which appends a version of its own. There is no delete.
 *  - Reads are any member (session or read token). Writes are owner or admin, session only; the database's insert policy is the second gate.
 */

const settingResponse = z.object({
  auto_merge: z.boolean(),
  /** True when no person ever chose a value for this repo (the default, off, is in force). */
  default: z.boolean(),
});
const putBody = z.object({ auto_merge: z.boolean() }).strict();

async function read(client: PoolClient, repoId: string): Promise<z.infer<typeof settingResponse>> {
  const current = await getCurrentPlanWritebackSetting(client, repoId);
  return current ? { auto_merge: current.autoMerge, default: false } : { auto_merge: PLAN_WRITEBACK_DEFAULT_AUTO_MERGE, default: true };
}

export const planWritebackRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/plan-writeback/setting",
    operationId: "getPlanWritebackSetting",
    summary: "Whether plan updates in this repo are merged automatically (off unless a person turned it on)",
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
        return read(client, repoId);
      });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/repos/{id}/plan-writeback/setting",
    operationId: "setPlanWritebackSetting",
    summary: "Turn automatic merging of plan updates on or off for this repo",
    description:
      "Appends one version and one audit row naming the actor, the previous and the new value. The value already in force writes nothing. " +
      "Turning it off is the undo and applies from the next check; nothing already merged is touched. Owner or admin, session only; `Idempotency-Key` is required.",
    principals: ["session"],
    minRole: "admin",
    idempotency: "required",
    rateClass: "write",
    extraResponses: { "409": "The setting changed while the request was running (`plan_writeback_changed`), or the account is not active." },
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
          await appendPlanWritebackVersion(client, { accountId, repoId, autoMerge: body.auto_merge, changedBy: userId });
          return read(client, repoId);
        });
      } catch (error) {
        if (error instanceof PlanWritebackSettingError && error.code === "plan_writeback_version_conflict") {
          throw new ApiError(409, "plan_writeback_changed", "the setting changed while you saved; reload and try again");
        }
        if ((error as { code?: string } | null)?.code === "42501") throw new ForbiddenError("only an owner or admin can change this");
        throw error;
      }
    },
  },
];
