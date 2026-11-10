import { z } from "zod";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { VerifyInputError } from "@fx/core/src/verify/journeys.js";
import { saveVerifySettings } from "@fx/core/src/verify/rows.js";
import { readVerifySettings, type VerifySettings, type VerifySettingsPatch } from "@fx/core/src/verify/settings.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#749 V4a: a repository's verify settings (the post-merge check on the deployed app), read and written by an owner or admin.
 *
 * Two routes under `/api/v1/repos/{id}/verify-settings`. Both are owner or admin and session only: the base URL and the account label are not for a member's
 * eyes or a token's reach. The database repeats the rule (the table's insert and update policies join `account_members` on the session's user, migration 1003), so a
 * handler that forgot the role check would still be refused (42501, mapped to 403 below). A repository nobody configured reads as off with no URL.
 *
 * The PUT is a patch: only the keys sent change. Every value is checked by `@fx/core`'s `applySettingsPatch` (the same function the writer uses); a refusal is a 422 with
 * the closed `verify_*` code and writes nothing. A save that creates the row or changes a value leaves one `verify_settings.changed` audit row in the same transaction
 * (migration 1008). Turning the setting off ends the rows that had not started (`unverified: verify_disabled`) in that transaction and the stage takes no new row.
 */

const idParamsSchema = z.object({ id: z.string() });

const journeySchema = z.object({ id: z.string().max(64), text: z.string().max(2000) }).strict();

const settingsSchema = z.object({
  repo_id: z.string(),
  /** False when nobody saved settings for this repository: everything below is the default (off). */
  configured: z.boolean(),
  enabled: z.boolean(),
  /** The deployed app's https origin, or null before one is set. */
  base_url: z.string().nullable(),
  browser_driver: z.enum(["playwright", "chrome"]),
  /** The account name the check must be signed in as; null until set. */
  test_account_label: z.string().nullable(),
  standing_journeys: z.array(journeySchema),
  eligibility: z.enum(["all", "ui_paths"]),
  eligibility_paths: z.array(z.string()),
});

const putResultSchema = settingsSchema.extend({
  /** Whether this save changed anything (a repeat of the saved values writes no audit row). */
  changed: z.boolean(),
  /** How many rows that had not started were ended because this save turned the setting off. */
  ended_rows: z.number().int(),
});

const putBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    base_url: z.string().max(300).nullable().optional(),
    browser_driver: z.enum(["playwright", "chrome"]).optional(),
    test_account_label: z.string().max(200).nullable().optional(),
    standing_journeys: z.array(z.unknown()).max(50).optional(),
    eligibility: z.enum(["all", "ui_paths"]).optional(),
    eligibility_paths: z.array(z.unknown()).max(50).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "send at least one setting" });

function view(s: VerifySettings) {
  return {
    repo_id: s.repoId,
    configured: s.configured,
    enabled: s.enabled,
    base_url: s.baseUrl,
    browser_driver: s.browserDriver,
    test_account_label: s.testAccountLabel,
    standing_journeys: s.standingJourneys,
    eligibility: s.eligibility,
    eligibility_paths: s.eligibilityPaths,
  };
}

function toPatch(body: z.infer<typeof putBodySchema>): VerifySettingsPatch {
  const patch: VerifySettingsPatch = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.base_url !== undefined) patch.baseUrl = body.base_url;
  if (body.browser_driver !== undefined) patch.browserDriver = body.browser_driver;
  if (body.test_account_label !== undefined) patch.testAccountLabel = body.test_account_label;
  if (body.standing_journeys !== undefined) patch.standingJourneys = body.standing_journeys;
  if (body.eligibility !== undefined) patch.eligibility = body.eligibility;
  if (body.eligibility_paths !== undefined) patch.eligibilityPaths = body.eligibility_paths;
  return patch;
}

/** The module's closed refusals become a 422 with their own code; the table's owner-or-admin policy (42501) becomes a 403. Everything else is rethrown. */
function mapError(error: unknown): unknown {
  if (error instanceof VerifyInputError) return new ApiError(422, error.code, error.message);
  if ((error as { code?: string } | null)?.code === "42501") return new ForbiddenError("only an owner or admin can change the verify settings");
  return error;
}

export const verifySettingsRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/verify-settings",
    operationId: "getRepoVerifySettings",
    summary: "A repository's verify settings: whether the post-merge check is on, the app's address, the browser driver and the standing journeys",
    description: "Off, with no address, for a repository nobody configured (`configured: false`). Owner or admin, session only.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: idParamsSchema,
    responseSchema: settingsSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertRepoExists(client, repoId);
        return view(await readVerifySettings(client, repoId));
      });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/repos/{id}/verify-settings",
    operationId: "putRepoVerifySettings",
    summary: "Change a repository's verify settings. Only the keys sent change; one audit row per real change; turning it off ends the rows that had not started",
    description:
      "`base_url` is an https origin: a plain host, no port, no credentials, path, query or fragment; an empty or other value is refused (422 `verify_base_url_invalid`). " +
      "A repository without a `base_url` cannot be switched on (422 `verify_base_url_required`). `browser_driver` is `playwright` or `chrome`. " +
      "Turning `enabled` off stops the stage taking new rows for the repository and ends the rows that had not started as unverified (`ended_rows`); a row already running finishes. Owner or admin, session only.",
    extraResponses: { "422": "`verify_base_url_invalid`, `verify_base_url_required` or `verify_setting_invalid` (nothing was written), or a body that does not validate." },
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    paramsSchema: idParamsSchema,
    bodySchema: putBodySchema,
    responseSchema: putResultSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId } = ctx.principal;
      const patch = toPatch(input.body as z.infer<typeof putBodySchema>);
      try {
        return await withTenant(ctx.pool, accountId, userId, async (client) => {
          await assertRepoExists(client, repoId);
          const before = await readVerifySettings(client, repoId);
          const { settings, endedRows } = await saveVerifySettings(client, accountId, repoId, userId, patch);
          const changed = !before.configured || JSON.stringify(view(before)) !== JSON.stringify(view(settings));
          return { ...view(settings), changed, ended_rows: endedRows.length };
        });
      } catch (error) {
        throw mapError(error);
      }
    },
  },
];
