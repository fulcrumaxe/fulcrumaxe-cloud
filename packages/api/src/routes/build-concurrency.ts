import { z } from "zod";
import type { Pool } from "pg";
import {
  PreviewRequiredError,
  PreviewStaleError,
  SettingBusyError,
  SettingChangedError,
  changeConcurrency,
  computeConcurrencyPreview,
  listConcurrencyHistory,
  readAccountConcurrency,
  readRepoConcurrency,
  type ConcurrencyPreview,
  type ConcurrencyScope,
} from "@fx/pipeline";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { assertActiveMembership } from "@fx/core/src/tenancy/scopedAccess.js";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#483 S5-c2: the person's own build-concurrency number, for the account and for one repository, with the cost shown before a raise.
 *
 * Eight routes under `/api/v1/account/build-concurrency` and `/api/v1/repos/{id}/build-concurrency` (a read, a `history` read, a `/preview`, a write each).
 * The account's separate runner-job ceiling (`account/runner-concurrency`, D#605) is a different setting and is not touched here.
 *
 * Who: a read is any member (session or a read token). The preview and the write are an owner or admin on a session; a token gets
 * `session_required`. A raise needs `accept: true` and the `preview_hash` of the preview the person saw; the server recomputes the preview
 * inside the write transaction and refuses (409 `preview_stale`, with the fresh preview) when it differs. A lowering or an equal value needs
 * neither. All of that lives in `@fx/pipeline`'s `changeConcurrency`; this file only maps its refusals to the API's.
 */

/** Input shape only, not a cap: any number from 1 up to what the integer column holds (Q3 as amended). */
export const MAX_BUILDS_COLUMN_MAX = 2_147_483_647;
const maxBuildsSchema = z.number().int().min(1).max(MAX_BUILDS_COLUMN_MAX);

const idParamsSchema = z.object({ id: z.string() });
const previewBodySchema = z.object({ max_builds: maxBuildsSchema }).strict();
const putBodySchema = z
  .object({
    max_builds: maxBuildsSchema,
    accept: z.boolean().optional(),
    preview_hash: z.string().min(1).max(128).optional(),
  })
  .strict();

const noteSchema = z.object({
  code: z.enum(["nothing_waiting", "same_total", "unpriced_items", "cannot_price", "one_build_per_repo_until_d598", "limited_by_repos"]),
  /** The sentence the person reads. */
  text: z.string(),
});
export const concurrencyPreviewSchema = z.object({
  scope: z.enum(["account", "repo"]),
  repo_id: z.string().nullable(),
  kind: z.enum(["raise", "lower", "same"]),
  from: z.number().int(),
  to: z.number().int(),
  /** Items holding a build slot or waiting for one, in this scope. */
  items: z.number().int(),
  /** Waiting items with no estimate: counted in `items`, left out of the price. */
  unpriced_items: z.number().int(),
  /** What the number really allows now, after the one-build-per-repo clamp and the number of repos with work. */
  effective_limit_old: z.number().int(),
  effective_limit_new: z.number().int(),
  clear_minutes_old: z.number().int(),
  clear_minutes_new: z.number().int(),
  /** Absent when `basis` is `none` (nothing to price from). Negative for a lowering. */
  extra_per_hour_cents: z.number().int().optional(),
  extra_per_day_cents: z.number().int().optional(),
  queue_total_cents: z.number().int().optional(),
  basis: z.enum(["history", "seed", "none"]),
  notes: z.array(noteSchema),
  /** Sent back with the accept; the server recomputes the preview and refuses on a mismatch. */
  preview_hash: z.string(),
});

const accountValueSchema = z.object({ value: z.number().int(), start_value: z.number().int(), history_count: z.number().int() });
const historySchema = z.object({
  changes: z.array(
    z.object({
      version: z.number().int(),
      from: z.number().int(),
      to: z.number().int(),
      /** The person's display name; never an id or an email. */
      changed_by_name: z.string(),
      changed_at: z.string(),
      /** The cost preview the person accepted when they raised the number: the figures that were shown. A lowering stores only its kind and values. */
      preview: z.record(z.string(), z.unknown()),
    }),
  ),
});
const accountChangeSchema = accountValueSchema.extend({ changed: z.boolean() });
const repoValueSchema = z.object({
  value: z.number().int(),
  start_value: z.number().int(),
  /** What the build slots apply now: the value, clamped while parallel builds on one repo are not supported. */
  applied_limit: z.number().int(),
  clamp_reason: z.enum(["one_build_per_repo_until_d598"]).nullable(),
});
const repoChangeSchema = repoValueSchema.extend({ changed: z.boolean() });

const WRITE_409 = {
  "409":
    "`preview_required` (a raise without `accept: true` and the preview's hash) or `preview_stale` (what the preview showed has changed): both carry the fresh preview in the body's `data.preview` and write nothing. " +
    "`setting_changed` (another change took the same version), `setting_busy` (builds are starting; try again), or the account is not active.",
};

/** Maps the setting module's refusals to the API's. Everything else is rethrown as it is. */
function mapChangeError(error: unknown): unknown {
  if (error instanceof PreviewRequiredError) return new ApiError(409, "preview_required", error.message, undefined, { preview: error.preview });
  if (error instanceof PreviewStaleError) return new ApiError(409, "preview_stale", error.message, undefined, { preview: error.preview });
  if (error instanceof SettingChangedError) return new ApiError(409, "setting_changed", "the setting changed while you saved; reload and try again");
  if (error instanceof SettingBusyError) return new ApiError(409, "setting_busy", error.message);
  // 42501: the table's own owner-or-admin policy (a route above already checked the role).
  if ((error as { code?: string } | null)?.code === "42501") return new ForbiddenError("only an owner or admin can change the build limit");
  return error;
}

async function previewFor(pool: Pool, accountId: string, userId: string, scope: ConcurrencyScope, maxBuilds: number): Promise<ConcurrencyPreview> {
  return withTenant(pool, accountId, userId, async (client) => {
    if (scope.kind === "repo") await assertRepoExists(client, scope.repoId);
    return computeConcurrencyPreview(client, accountId, scope, maxBuilds);
  });
}

async function change(pool: Pool, accountId: string, userId: string, scope: ConcurrencyScope, body: z.infer<typeof putBodySchema>) {
  if (scope.kind === "repo") await withTenant(pool, accountId, userId, (client) => assertRepoExists(client, scope.repoId));
  try {
    return await changeConcurrency(pool, { accountId, userId, scope, maxBuilds: body.max_builds, accept: body.accept, previewHash: body.preview_hash });
  } catch (error) {
    throw mapChangeError(error);
  }
}

export const buildConcurrencyRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/account/build-concurrency",
    operationId: "getAccountBuildConcurrency",
    summary: "How many items the account builds at once (the person's own number), and the starting value",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    responseSchema: accountValueSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertActiveMembership(client, accountId, userId);
        return readAccountConcurrency(client, accountId);
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/account/build-concurrency/history",
    operationId: "getAccountBuildConcurrencyHistory",
    summary: "The last 20 changes to the account's build limit: old value, new value, who and when",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    responseSchema: historySchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertActiveMembership(client, accountId, userId);
        return { changes: await listConcurrencyHistory(client, accountId, null) };
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/account/build-concurrency/preview",
    operationId: "previewAccountBuildConcurrency",
    summary: "What setting the account's build limit to a number would do: how fast the queue clears and what it adds to spend. Changes nothing",
    description:
      "Prices the account's hosted items (holding a build slot or waiting for one) from the pipeline estimate. The figures are absent, and `basis` is `none`, when nothing can be priced yet. " +
      "Send the returned `preview_hash` with `accept: true` to the matching PUT. Owner or admin, session only.",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "read",
    bodySchema: previewBodySchema,
    responseSchema: concurrencyPreviewSchema,
    async handler(ctx, input) {
      const { accountId, userId } = ctx.principal;
      const body = input.body as z.infer<typeof previewBodySchema>;
      return previewFor(ctx.pool, accountId, userId, { kind: "account" }, body.max_builds);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/account/build-concurrency",
    operationId: "putAccountBuildConcurrency",
    summary: "Set the account's build limit. A raise needs the cost preview accepted; one new version and one audit row per real change",
    description:
      "A raise needs `accept: true` and the `preview_hash` of the preview the person saw; without them it answers 409 `preview_required` with a fresh preview. " +
      "The server recomputes the preview inside the write transaction and answers 409 `preview_stale` (with the fresh preview, writing nothing) when it differs. " +
      "A lowering or an equal value needs neither, and an equal value writes nothing. Owner or admin, session only.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: WRITE_409,
    bodySchema: putBodySchema,
    responseSchema: accountChangeSchema,
    async handler(ctx, input) {
      const { accountId, userId } = ctx.principal;
      const body = input.body as z.infer<typeof putBodySchema>;
      const result = await change(ctx.pool, accountId, userId, { kind: "account" }, body);
      const value = await withTenant(ctx.pool, accountId, userId, (client) => readAccountConcurrency(client, accountId));
      return { ...value, changed: result.written };
    },
  },
  {
    method: "GET",
    path: "/api/v1/repos/{id}/build-concurrency",
    operationId: "getRepoBuildConcurrency",
    summary: "How many items one repo builds at once (the person's own number), what is applied now, and the starting value",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: repoValueSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertRepoExists(client, repoId);
        return readRepoConcurrency(client, accountId, repoId);
      });
    },
  },
  {
    method: "GET",
    path: "/api/v1/repos/{id}/build-concurrency/history",
    operationId: "getRepoBuildConcurrencyHistory",
    summary: "The last 20 changes to one repo's build limit: old value, new value, who and when",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: historySchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertRepoExists(client, repoId);
        return { changes: await listConcurrencyHistory(client, accountId, repoId) };
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/repos/{id}/build-concurrency/preview",
    operationId: "previewRepoBuildConcurrency",
    summary: "What setting a repo's build limit to a number would do. Changes nothing",
    description:
      "While one build per repo is the rule, a higher repo number shows no speed-up and no extra spend, with the reason. " +
      "Send the returned `preview_hash` with `accept: true` to the matching PUT. Owner or admin, session only.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    bodySchema: previewBodySchema,
    responseSchema: concurrencyPreviewSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      const body = input.body as z.infer<typeof previewBodySchema>;
      return previewFor(ctx.pool, accountId, userId, { kind: "repo", repoId }, body.max_builds);
    },
  },
  {
    method: "PUT",
    path: "/api/v1/repos/{id}/build-concurrency",
    operationId: "putRepoBuildConcurrency",
    summary: "Set a repo's build limit. A raise needs the cost preview accepted; one new version and one audit row per real change",
    description:
      "Same rules as the account's PUT: a raise needs `accept: true` and the `preview_hash`, the server recomputes inside the write transaction, a lowering or equal value needs neither. Owner or admin, session only.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: WRITE_409,
    paramsSchema: idParamsSchema,
    bodySchema: putBodySchema,
    responseSchema: repoChangeSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      const body = input.body as z.infer<typeof putBodySchema>;
      const result = await change(ctx.pool, accountId, userId, { kind: "repo", repoId }, body);
      const value = await withTenant(ctx.pool, accountId, userId, (client) => readRepoConcurrency(client, accountId, repoId));
      return { ...value, changed: result.written };
    },
  },
];
