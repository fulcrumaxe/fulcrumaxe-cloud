import { z } from "zod";
import { INSTALLATION_APP_KINDS } from "@fx/core/src/repos/appKinds.js";
import { assertRepoIdShape, getRepo, listRepos, type RepoDTO } from "@fx/core/src/repos/read.js";
import { getRepoGuardSettings, isRepoHumanMergeOnly, setRepoGuardSettings } from "@fx/core/src/role-settings/guardSettings.js";
import type { RepoGuardSettings } from "@fx/core/src/role-settings/types.js";
import type { RouteEntry } from "../registry.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";

/** D#31 API-8a: a repo as listed. `install_state` is derived from `repos.installation_id`, not stored. */
export const repoResponseSchema = z.object({
  id: z.string().uuid(),
  product: z.string(),
  gh_repo_id: z.number().int(),
  install_state: z.enum(["installed", "not_installed"]),
  app_kind: z.enum(INSTALLATION_APP_KINDS).nullable(),
  full_name: z.string().nullable(),
});

const listReposResponseSchema = z.object({
  data: z.array(repoResponseSchema),
  next_cursor: z.string().nullable(),
});

const listReposQuerySchema = z.object({
  limit: z.string().optional(),
  cursor: z.string().optional(),
});

const repoIdParamsSchema = z.object({ id: z.string() });

const settingsResponseSchema = z.object({
  auto_merge: z.boolean(),
  block_external_auto_merge: z.boolean(),
  /** D#6 M1G-a: present (true) only when the operator locked this repository to human merges; absent otherwise. */
  human_merge_only: z.literal(true).optional(),
});

/**
 * Strict: an unknown key is a 422, and so is an empty body. Every field
 * must be the literal boolean, so `acknowledge_external_risk` can only be
 * `true` when the client sent `true` (a string "true" or 1 is a 422).
 */
const patchSettingsBodySchema = z
  .object({
    auto_merge: z.boolean().optional(),
    block_external_auto_merge: z.boolean().optional(),
    acknowledge_external_risk: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0);

function toRepoItem(repo: RepoDTO): z.infer<typeof repoResponseSchema> {
  return {
    id: repo.id,
    product: repo.product,
    gh_repo_id: repo.ghRepoId,
    install_state: repo.installState,
    app_kind: repo.appKind,
    full_name: repo.fullName,
  };
}

function toSettingsItem(s: RepoGuardSettings, humanMergeOnly = false): z.infer<typeof settingsResponseSchema> {
  return {
    auto_merge: s.autoMerge,
    block_external_auto_merge: s.blockExternalAutoMerge,
    ...(humanMergeOnly ? { human_merge_only: true as const } : {}),
  };
}

/** "The v1 contract" > route table, API-8a rows: repos and settings reads (S+T(read), member), settings PATCH (S, owner/admin). */
export const repoRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos",
    operationId: "listRepos",
    summary: "The account's repos with their install state, paginated",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    querySchema: listReposQuerySchema,
    responseSchema: listReposResponseSchema,
    async handler(ctx, input) {
      const query = (input.query ?? {}) as z.infer<typeof listReposQuerySchema>;
      const limit = parseLimit(query.limit);
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const result = await listRepos(
        { pool: ctx.pool, principal: ctx.principal },
        { limit, cursor: cursor ? { createdAt: cursor.created_at, id: cursor.id } : undefined },
      );
      return {
        data: result.data.map(toRepoItem),
        next_cursor: result.nextCursor ? encodeCursor(result.nextCursor.createdAt, result.nextCursor.id) : null,
      };
    },
  },
  {
    method: "GET",
    path: "/api/v1/repos/{id}",
    operationId: "getRepo",
    summary: "A single repo the caller's account owns",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoIdParamsSchema,
    responseSchema: repoResponseSchema,
    async handler(ctx, input) {
      return toRepoItem(await getRepo({ pool: ctx.pool, principal: ctx.principal }, input.params.id!));
    },
  },
  {
    method: "GET",
    path: "/api/v1/repos/{id}/settings",
    operationId: "getRepoSettings",
    summary: "A repo's auto-merge and external-PR guard settings",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoIdParamsSchema,
    responseSchema: settingsResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const rctx = { pool: ctx.pool, principal: ctx.principal };
      return toSettingsItem(await getRepoGuardSettings(rctx, repoId), await isRepoHumanMergeOnly(rctx, repoId));
    },
  },
  {
    method: "PATCH",
    path: "/api/v1/repos/{id}/settings",
    operationId: "patchRepoSettings",
    summary: "Change a repo's auto-merge settings (turning the external-PR guard off needs an acknowledgement)",
    // principals omitted -> session-only: a token may never change the guard.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: repoIdParamsSchema,
    bodySchema: patchSettingsBodySchema,
    responseSchema: settingsResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const body = input.body as z.infer<typeof patchSettingsBodySchema>;
      // `confirmed` is passed through as sent and nothing else: the core
      // service treats only the literal `true` as confirmation.
      const after = await setRepoGuardSettings({ pool: ctx.pool, principal: ctx.principal }, repoId, {
        autoMerge: body.auto_merge,
        blockExternalAutoMerge: body.block_external_auto_merge,
        confirmed: body.acknowledge_external_risk,
      });
      return toSettingsItem(after, await isRepoHumanMergeOnly({ pool: ctx.pool, principal: ctx.principal }, repoId));
    },
  },
];
