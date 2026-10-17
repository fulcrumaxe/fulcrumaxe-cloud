import { z } from "zod";
import type { PoolClient } from "pg";
import {
  ASK_NOTIFY_DEFAULT,
  ASK_NOTIFY_VALUES,
  ASK_WINDOW_DEFAULT_MINUTES,
  ASK_WINDOW_MAX_MINUTES,
  ASK_WINDOW_MIN_MINUTES,
  CATALOGUE,
  TIMEOUT_OUTCOMES,
  resolveAskPolicy,
} from "@fx/decisions";
import type { AskNotify, CatalogueEntry, PresetName, TimeoutOutcome } from "@fx/decisions";
import { AskSettingError, appendAskSettingVersion, listCurrentAskSettings, toAskSettingRows } from "@fx/db/src/decisionAskSettings.js";
import type { AskSettingVersion } from "@fx/db/src/decisionAskSettings.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";
import { activePreset, currentRows } from "./decision-settings.js";
import { decisionLabel } from "./decision-labels.js";

/**
 * D#7 DP10b: the ask settings half of the one Autonomy surface (DP-C5 R3 and R5): how long a customer has to answer an agent's question,
 * what happens when the window ends unanswered, and whether to notify. DP12a-1 owns the storage (`decision_ask_settings`, append-only
 * versions, owner/admin INSERT only); this file is the HTTP face of it and adds no rule of its own:
 *
 *  - Every value shown as "in effect" comes from `resolveAskPolicy`, the function a new ask is raised with, so the page cannot disagree
 *    with what an ask will freeze. The preset it assumes is the one the repo's dials match, else Cautious (what `raiseAsk` uses when its
 *    caller names none).
 *  - Only a choice the catalogue entry permits is offered (`allowed_outcomes`), and the writer refuses anything else.
 *  - A write appends one version and one audit row in one transaction (the writer does both). There is no delete: undo is a new version
 *    with the values set again, or all three null to hand the key back to its parent.
 *  - Owner or admin session only (a token gets 403, like every settings write).
 */

const repoIdParamsSchema = z.object({ id: z.string() });
const OUTCOME_VALUES = TIMEOUT_OUTCOMES as readonly [TimeoutOutcome, ...TimeoutOutcome[]];
const NOTIFY_VALUES = ASK_NOTIFY_VALUES as readonly [AskNotify, ...AskNotify[]];

const writeBodySchema = z
  .object({
    /** `account` is every repo; `repo` is only the repo in the path. */
    scope: z.enum(["account", "repo"]),
    /** A class 2 or 3 catalogue id, or `*` for every decision type. */
    decision_type: z.string().min(1).max(100),
    /** Whole minutes, or null to inherit. */
    answer_window_minutes: z.number().nullable(),
    timeout_outcome: z.enum(OUTCOME_VALUES).nullable(),
    notify: z.enum(NOTIFY_VALUES).nullable(),
  })
  .strict();

const storedSchema = z.object({
  answer_window_minutes: z.number().nullable(),
  timeout_outcome: z.string().nullable(),
  notify: z.string().nullable(),
  version: z.number(),
});
const effectiveSchema = z.object({
  answer_window_minutes: z.number(),
  /** The same window in words, formatted here so the page computes nothing. */
  answer_window_text: z.string(),
  timeout_outcome: z.string(),
  notify: z.string(),
});
const rowSchema = z.object({
  decision_type: z.string(),
  label: z.string(),
  /** Null for the `*` row, which covers every type. */
  class: z.string().nullable(),
  allowed_outcomes: z.array(z.string()),
  /** What was stored at the account level and for this repo, or null when nothing is set there (it inherits). */
  account: storedSchema.nullable(),
  repo: storedSchema.nullable(),
  /** What a new ask of this type on this repo would freeze right now. Null on the `*` row. */
  effective: effectiveSchema.nullable(),
});
const responseSchema = z.object({
  repo_id: z.string(),
  can_change: z.boolean(),
  /** The preset the "in effect" values assume, so the page can say so. */
  preset_basis: z.string(),
  bounds: z.object({ min_minutes: z.number(), max_minutes: z.number(), default_minutes: z.number() }),
  notify_values: z.array(z.string()),
  /** What notify is when nothing is set. */
  notify_default: z.string(),
  rows: z.array(rowSchema),
});

type AskSettingsResponse = z.infer<typeof responseSchema>;
type Stored = z.infer<typeof storedSchema>;

const WRITE_CODES: Record<string, { path: string; message: string }> = {
  ask_setting_window_out_of_range: {
    path: "answer_window_minutes",
    message: `the answer window must be a whole number of minutes from ${ASK_WINDOW_MIN_MINUTES} to ${ASK_WINDOW_MAX_MINUTES}`,
  },
  ask_setting_outcome_invalid: { path: "timeout_outcome", message: "that is not a choice for what happens when nobody answers" },
  ask_setting_outcome_not_allowed: { path: "timeout_outcome", message: "that decision type cannot go ahead without an answer" },
  ask_setting_notify_invalid: { path: "notify", message: "notify must be email or none" },
  ask_setting_unknown_decision_type: { path: "decision_type", message: "no such decision type" },
  ask_setting_class1_never_asks: { path: "decision_type", message: "that decision type is never asked, so it has no answer settings" },
  ask_setting_repo_invalid: { path: "repo_id", message: "not a repo id" },
};

/** "1 day", "90 minutes", "2 hours 30 minutes": whole units only, largest first. */
export function formatWindow(minutes: number): string {
  const parts: string[] = [];
  let left = minutes;
  for (const [size, one] of [[1440, "day"], [60, "hour"], [1, "minute"]] as const) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (n > 0) parts.push(`${n} ${one}${n === 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}

/**
 * A key whose current version holds all three values null overrides nothing, so it reads as no override (`null`), exactly as a key never
 * written does. The version rows stay (append-only); this is derived on every read, never stamped. The next write for the key still
 * takes the next version number, so the version and conflict checks are unchanged.
 */
const stored = (v: AskSettingVersion | undefined): Stored | null =>
  v === undefined || (v.answerWindowMinutes === null && v.timeoutOutcome === null && v.notify === null) ? null : { answer_window_minutes: v.answerWindowMinutes, timeout_outcome: v.timeoutOutcome, notify: v.notify, version: v.version };

/** The entries a customer can be asked about: everything that lists a timeout outcome (class 1 lists none). */
const askedEntries = (): CatalogueEntry[] => CATALOGUE.filter((e) => e.timeoutOutcomes.length > 0);

async function build(client: PoolClient, repoId: string, canChange: boolean): Promise<AskSettingsResponse> {
  const current = await listCurrentAskSettings(client);
  const settings = toAskSettingRows(current);
  const preset: PresetName = activePreset(await currentRows(client, repoId)) ?? "cautious";
  const at = (repo: string | null, type: string) => current.find((v) => v.repoId === repo && v.decisionType === type);
  const line = (
    type: string,
    label: string,
    cls: string | null,
    allowed: readonly string[],
    effective: AskSettingsResponse["rows"][number]["effective"],
  ) => ({
    decision_type: type,
    label,
    class: cls,
    allowed_outcomes: [...allowed],
    account: stored(at(null, type)),
    repo: stored(at(repoId, type)),
    effective,
  });
  return {
    repo_id: repoId,
    can_change: canChange,
    preset_basis: preset,
    bounds: { min_minutes: ASK_WINDOW_MIN_MINUTES, max_minutes: ASK_WINDOW_MAX_MINUTES, default_minutes: ASK_WINDOW_DEFAULT_MINUTES },
    notify_values: [...ASK_NOTIFY_VALUES],
    notify_default: ASK_NOTIFY_DEFAULT,
    rows: [
      line("*", "Every decision type", null, TIMEOUT_OUTCOMES, null),
      ...askedEntries().map((e) => {
        const p = resolveAskPolicy(e, preset, settings, repoId);
        return line(e.id, decisionLabel(e.id), e.class, e.timeoutOutcomes, {
          answer_window_minutes: p.answerWindowMinutes,
          answer_window_text: formatWindow(p.answerWindowMinutes),
          timeout_outcome: p.timeoutOutcome,
          notify: p.notify ?? ASK_NOTIFY_DEFAULT,
        });
      }),
    ],
  };
}

/** The writer's named errors and the database's own gate (owner/admin INSERT policy), as API answers. */
function mapWriteError(error: unknown): unknown {
  if (error instanceof AskSettingError) {
    if (error.code === "ask_setting_version_conflict") {
      return new ApiError(409, "ask_setting_changed", "a setting changed while you saved; reload and try again");
    }
    const known = WRITE_CODES[error.code];
    if (known) return new ApiError(422, "invalid_input", known.message, [{ path: known.path, code: error.code }]);
    return error;
  }
  if ((error as { code?: string } | null)?.code === "42501") return new ForbiddenError("only an owner or admin can change these settings");
  return error;
}

export const askSettingRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/ask-settings",
    operationId: "getAskSettings",
    summary: "How long a customer has to answer an agent's question, what happens if nobody does, and who is notified",
    minRole: "member",
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
    method: "POST",
    path: "/api/v1/repos/{id}/ask-settings",
    operationId: "setAskSetting",
    summary: "Set the answer window, the outcome when nobody answers, or notify for one key",
    description:
      "Appends one `decision_ask_settings` version for the key (scope, decision type) holding all three values, and one audit row naming the previous and new values. " +
      "A null value means inherit. Setting all three null hands the key back to its parent: the override is gone and `GET` shows `null` for that scope again (the version rows stay as history). Owner or admin, session only.",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: { "409": "A setting changed while the request was running (`ask_setting_changed`), or the account is not active." },
    paramsSchema: repoIdParamsSchema,
    bodySchema: writeBodySchema,
    responseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const body = input.body as z.infer<typeof writeBodySchema>;
      const { accountId, userId, role } = ctx.principal;
      try {
        return await withTenant(ctx.pool, accountId, userId, async (client) => {
          await assertRepoExists(client, repoId);
          await appendAskSettingVersion(client, {
            accountId,
            repoId: body.scope === "repo" ? repoId : null,
            decisionType: body.decision_type,
            answerWindowMinutes: body.answer_window_minutes,
            timeoutOutcome: body.timeout_outcome,
            notify: body.notify,
            changedBy: userId,
          });
          return build(client, repoId, role === "owner" || role === "admin");
        });
      } catch (error) {
        throw mapWriteError(error);
      }
    },
  },
];
