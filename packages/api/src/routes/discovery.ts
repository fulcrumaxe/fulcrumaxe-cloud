import { z } from "zod";
import type { PoolClient } from "pg";
import {
  DISCOVERY_FREQUENCIES,
  DiscoverySettingError,
  appendDiscoveryVersion,
  effectiveDiscoveryFrequency,
  listDiscoverySettingHistory,
  type DiscoveryFrequency,
} from "@fx/db/src/discoverySettings.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#483 S5-g1: how often a repo is re-discovered. The daily sweep (S5-g2) and the Autonomy section (S5-h) read and write it here; this
 * file is the HTTP face of `discovery_settings` and adds no rule of its own:
 *
 *  - No version means `daily`. The three choices are `daily`, `weekly` and `off`, each with a name a person can read, formatted here so
 *    the page shows no id.
 *  - A write appends one version and one audit row naming the previous and the new value, in one transaction. Choosing the value already
 *    in force writes nothing. There is no delete: undo is choosing the earlier value, which appends a version of its own.
 *  - Reads are any member (session or read token). Writes are owner or admin, session only: a token gets 403.
 */

const repoIdParamsSchema = z.object({ id: z.string() });
const FREQUENCY_VALUES = DISCOVERY_FREQUENCIES as unknown as readonly [DiscoveryFrequency, ...DiscoveryFrequency[]];

const putBodySchema = z.object({ frequency: z.enum(FREQUENCY_VALUES) }).strict();

const FREQUENCY_LABELS: Record<DiscoveryFrequency, string> = {
  daily: "Every day",
  weekly: "Every week",
  off: "Off",
};

/** How many past changes the response lists (newest first). The table keeps all of them. */
const HISTORY_LIMIT = 20;

const changeSchema = z.object({
  version: z.number().int(),
  frequency: z.string(),
  label: z.string(),
  /** What it was before this change (the default for the first one). */
  previous_frequency: z.string(),
  previous_label: z.string(),
  /** The user who made the change. */
  changed_by: z.string(),
  changed_at: z.string(),
});
const responseSchema = z.object({
  repo_id: z.string(),
  /** Whether the caller may PUT (an owner or admin). A plain member reads the page and nothing more. */
  can_change: z.boolean(),
  frequency: z.string(),
  label: z.string(),
  /** `default` when no version was ever written, `set` when a person chose it. */
  source: z.enum(["default", "set"]),
  version: z.number().int().nullable(),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
  changes: z.array(changeSchema),
});

type DiscoveryResponse = z.infer<typeof responseSchema>;

async function build(client: PoolClient, repoId: string, canChange: boolean): Promise<DiscoveryResponse> {
  // One extra row so the oldest listed change still knows what it replaced.
  const rows = await listDiscoverySettingHistory(client, repoId, HISTORY_LIMIT + 1);
  const current = rows[0] ?? null;
  const frequency = effectiveDiscoveryFrequency(current);
  return {
    repo_id: repoId,
    can_change: canChange,
    frequency,
    label: FREQUENCY_LABELS[frequency],
    source: current === null ? "default" : "set",
    version: current?.version ?? null,
    options: DISCOVERY_FREQUENCIES.map((value) => ({ value, label: FREQUENCY_LABELS[value] })),
    changes: rows.slice(0, HISTORY_LIMIT).map((row, i) => {
      const previous = effectiveDiscoveryFrequency(rows[i + 1] ?? null);
      return {
        version: row.version,
        frequency: row.frequency,
        label: FREQUENCY_LABELS[row.frequency] ?? FREQUENCY_LABELS.off,
        previous_frequency: previous,
        previous_label: FREQUENCY_LABELS[previous],
        changed_by: row.changedBy,
        changed_at: row.createdAt.toISOString(),
      };
    }),
  };
}

/** The writer's named errors and the database's own gate (owner/admin INSERT policy), as API answers. */
function mapWriteError(error: unknown): unknown {
  if (error instanceof DiscoverySettingError) {
    if (error.code === "discovery_version_conflict") {
      return new ApiError(409, "discovery_changed", "the setting changed while you saved; reload and try again");
    }
    if (error.code === "discovery_frequency_invalid") {
      return new ApiError(422, "invalid_input", "choose daily, weekly or off", [{ path: "frequency", code: error.code }]);
    }
    return error;
  }
  if ((error as { code?: string } | null)?.code === "42501") return new ForbiddenError("only an owner or admin can change how often a repo is discovered");
  return error;
}

export const discoveryRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/discovery",
    operationId: "getDiscoverySetting",
    summary: "How often this repo is re-discovered (daily, weekly or off), the choices, and the recent changes",
    principals: ["session", "token"],
    minRole: "member",
    scope: "read",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoIdParamsSchema,
    responseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId, role } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertRepoExists(client, repoId);
        return build(client, repoId, role === "owner" || role === "admin");
      });
    },
  },
  {
    method: "PUT",
    path: "/api/v1/repos/{id}/discovery",
    operationId: "setDiscoverySetting",
    summary: "Set how often this repo is re-discovered: daily, weekly or off",
    description:
      "Appends one `discovery_settings` version and one audit row naming the previous and new value. Choosing the value already in force writes nothing. " +
      "Undo is choosing the earlier value. Owner or admin, session only.",
    // principals omitted -> session-only: an API token can never change it.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: { "409": "The setting changed while the request was running (`discovery_changed`), or the account is not active." },
    paramsSchema: repoIdParamsSchema,
    bodySchema: putBodySchema,
    responseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const body = input.body as z.infer<typeof putBodySchema>;
      const { accountId, userId, role } = ctx.principal;
      try {
        return await withTenant(ctx.pool, accountId, userId, async (client) => {
          await assertRepoExists(client, repoId);
          await appendDiscoveryVersion(client, { accountId, repoId, frequency: body.frequency, changedBy: userId });
          return build(client, repoId, role === "owner" || role === "admin");
        });
      } catch (error) {
        throw mapWriteError(error);
      }
    },
  },
];
