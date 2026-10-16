import { z } from "zod";
import type { PoolClient } from "pg";
import {
  ActionRulesError,
  appendRuleSet,
  listActionRulesHistory,
  resolveActionRules,
  rollbackRuleSet,
} from "@fx/db/src/actionRules.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#7 AAP-a2: the HTTP face of the customer's approval rules (`action_rules`, append-only versions). It adds no rule of its own: the set is
 * validated by `validateRuleSet` (packages/decisions) before anything is written, and the writer appends one version and one audit row in
 * one transaction. There is no delete and no edit: a change is a new version, a rollback is a new version that copies an earlier one, and
 * "delete all rules" is a new empty version where everything asks a person.
 *
 * Two scopes, one set of handlers: the account (`/api/v1/action-rules`) and one repo (`/api/v1/repos/{id}/action-rules`). A repo's own set
 * overrides the account's. Owner or admin, session only: a token gets 403 `session_required` and a member gets 403.
 */

const repoParamsSchema = z.object({ id: z.string() });

/** The whole set. The shape is checked by the rule validator (so a bad one is answered with the validator's own codes), not by this schema. */
const rulesBodySchema = z.object({ rules: z.array(z.unknown()) }).passthrough();
const appendBodySchema = z.object({ rules: rulesBodySchema }).strict();
const rollbackBodySchema = z.object({ to_version: z.number().int().min(1) }).strict();

const historySchema = z.object({
  version: z.number(),
  rule_count: z.number(),
  rules_sha256: z.string(),
  /** The version this one restored, or null when it was a normal save. */
  restored_from_version: z.number().nullable(),
  /** The author's name, never an id. */
  author_name: z.string(),
  created_at: z.string(),
});
const responseSchema = z.object({
  /** Null for the account scope. */
  repo_id: z.string().nullable(),
  /** Where the set that decides came from: the repo's own, the account's, or `none` (no rules written, so everything asks). */
  source: z.enum(["repo", "account", "none"]),
  /** The version of the set that decides; 0 when `source` is `none`. */
  version: z.number(),
  rules: rulesBodySchema,
  /** This scope's own history, newest first. A repo with no set of its own has an empty history even when it inherits the account's. */
  history: z.array(historySchema),
});
type RulesResponse = z.infer<typeof responseSchema>;

const INVALID_MESSAGE = "the rule set is not valid";

async function build(client: PoolClient, repoId: string | null): Promise<RulesResponse> {
  const resolved = await resolveActionRules(client, repoId);
  const history = await listActionRulesHistory(client, repoId);
  return {
    repo_id: repoId,
    source: resolved.scope,
    version: resolved.version,
    rules: resolved.rules as unknown as RulesResponse["rules"],
    history: history.map((h) => ({
      version: h.version,
      rule_count: h.ruleCount,
      rules_sha256: h.rulesSha256,
      restored_from_version: h.restoredFromVersion,
      author_name: h.changedByName,
      created_at: h.createdAt.toISOString(),
    })),
  };
}

/** The writer's named errors as API answers. Who may write is decided before the handler runs (minRole), so the shared insufficient_role and not_found answers cover the rest. */
export function mapWriteError(error: unknown): unknown {
  if (error instanceof ActionRulesError) {
    if (error.code === "action_rules_version_conflict") {
      return new ApiError(409, "action_rules_changed", "the rules changed while you saved; reload and try again");
    }
    if (error.code === "action_rules_version_not_found") return new ApiError(404, "action_rules_version_not_found", "no such version of the rules");
    if (error.code === "action_rules_invalid") {
      return new ApiError(422, "invalid_input", INVALID_MESSAGE, error.errors.map((e) => ({ path: e.path, code: e.code })));
    }
    return error;
  }
  return error;
}

const SCOPE_NOTE = "Owner or admin, session only.";

function scopeRoutes(scope: "account" | "repo"): RouteEntry[] {
  const base = scope === "account" ? "/api/v1/action-rules" : "/api/v1/repos/{id}/action-rules";
  const suffix = scope === "account" ? "Account" : "Repo";
  const paramsSchema = scope === "repo" ? repoParamsSchema : undefined;
  const target = scope === "repo" ? "the repo's" : "the account's";
  /** Resolves the scope's repo id (null for the account) and checks that the repo exists in this account. */
  const scopeRepo = async (client: PoolClient, id: string | undefined): Promise<string | null> => {
    if (scope === "account") return null;
    assertRepoIdShape(id!);
    await assertRepoExists(client, id!);
    return id!;
  };
  return [
    {
      method: "GET",
      path: base,
      operationId: `getAction${suffix}Rules`,
      summary: `The approval rules that decide tool calls for ${scope === "account" ? "the account" : "a repo"}, with the version history`,
      description:
        `Returns the set that decides (${scope === "repo" ? "the repo's own, else the account's, else none" : "the account's, else none"}) and ${target} history. ` +
        `With no rules written every tool call asks a person. ${SCOPE_NOTE}`,
      minRole: "admin",
      idempotency: "never",
      rateClass: "read",
      ...(paramsSchema ? { paramsSchema } : {}),
      responseSchema,
      async handler(ctx, input) {
        const { accountId, userId } = ctx.principal;
        return withTenant(ctx.pool, accountId, userId, async (client) => build(client, await scopeRepo(client, input.params.id)));
      },
    },
    {
      method: "POST",
      path: base,
      operationId: `appendAction${suffix}Rules`,
      summary: `Save ${target} rule set as the next version`,
      description:
        "Validates the whole set and appends it as the next version, with one audit row naming the previous and new versions and both hashes. " +
        `An empty set is a valid version (everything asks). A set that fails validation is refused with the validator's codes and nothing is saved. ${SCOPE_NOTE}`,
      // principals omitted -> session-only.
      minRole: "admin",
      idempotency: "never",
      rateClass: "write",
      extraResponses: { "409": "The rules changed while the request was running (`action_rules_changed`), or the account is not active." },
      ...(paramsSchema ? { paramsSchema } : {}),
      bodySchema: appendBodySchema,
      responseSchema,
      async handler(ctx, input) {
        const body = input.body as z.infer<typeof appendBodySchema>;
        const { accountId, userId } = ctx.principal;
        try {
          return await withTenant(ctx.pool, accountId, userId, async (client) => {
            const repoId = await scopeRepo(client, input.params.id);
            await appendRuleSet(client, { accountId, repoId, rules: body.rules, changedBy: userId });
            return build(client, repoId);
          });
        } catch (error) {
          throw mapWriteError(error);
        }
      },
    },
    {
      method: "POST",
      path: `${base}/rollback`,
      operationId: `rollbackAction${suffix}Rules`,
      summary: `Restore an earlier version of ${target} rules as a new version`,
      description:
        "Inserts a new version holding the earlier version's rules and naming it as restored. Older versions are not changed. " +
        `The restored rules are validated again. ${SCOPE_NOTE}`,
      minRole: "admin",
      idempotency: "never",
      rateClass: "write",
      extraResponses: { "404": "No such version in this scope.", "409": "The rules changed while the request was running (`action_rules_changed`), or the account is not active." },
      ...(paramsSchema ? { paramsSchema } : {}),
      bodySchema: rollbackBodySchema,
      responseSchema,
      async handler(ctx, input) {
        const body = input.body as z.infer<typeof rollbackBodySchema>;
        const { accountId, userId } = ctx.principal;
        try {
          return await withTenant(ctx.pool, accountId, userId, async (client) => {
            const repoId = await scopeRepo(client, input.params.id);
            await rollbackRuleSet(client, { accountId, repoId, toVersion: body.to_version, changedBy: userId });
            return build(client, repoId);
          });
        } catch (error) {
          throw mapWriteError(error);
        }
      },
    },
  ];
}

export const actionRuleRoutes: RouteEntry[] = [...scopeRoutes("account"), ...scopeRoutes("repo")];
