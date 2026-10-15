import { z } from "zod";
import type { PoolClient } from "pg";
import { CATALOGUE, CATALOGUE_VERSION, PRESETS, decide, getCatalogueEntry, getPreset } from "@fx/decisions";
import type { CatalogueEntry, Disposition, PresetName } from "@fx/decisions";
import { appendDialVersion, getCurrentDialSetting, type DecisionSetting } from "@fx/db/src/decisions.js";
import { FIXED_INVARIANTS } from "@fx/db/src/dialInventory.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { ApiError } from "../errors.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#7 DP10a: the API half of the one Autonomy settings surface. A dial is one `decision_settings` key `(repo, decision type)`; a preset is
 * not stored as a thing of its own, it is the set of class 2 dials that move together. Four rules shape every route here:
 *
 *  - Only a class 2 type is a dial (owner decision 5). Class 1 is always acted on and class 3 is always asked, so neither is writable, and
 *    a fixed invariant is not in the catalogue at all, so naming one gets the same refusal as any unknown type (C3).
 *  - The write is append-only and attributed (C8): each change is a new `decision_settings` version through `appendDialVersion`, which
 *    also writes the `audit_log` row naming the previous and the new value. Nothing in this file issues an UPDATE or DELETE.
 *  - What a preset does is whatever `decide()` resolves for that preset, so this surface cannot disagree with enforcement.
 *  - Which preset is active is derived from the dials' effective dispositions, never from a stamp. The `preset` column on a row is only
 *    a label of what the customer picked; a later single-dial change moves the derivation to "custom" without touching it.
 *
 * Undo: there is no delete. A change is undone by writing the earlier value (or re-applying the earlier preset), which appends a version
 * and an audit row of its own; the history keeps both.
 */

const repoIdParamsSchema = z.object({ id: z.string() });
const PRESET_NAMES = PRESETS.map((p) => p.name) as [PresetName, ...PresetName[]];
const DISPOSITIONS = ["ask", "announce", "act"] as const;

const presetBodySchema = z.object({ preset: z.enum(PRESET_NAMES) }).strict();
const dialBodySchema = z.object({ decision_type: z.string().min(1).max(100), disposition: z.enum(DISPOSITIONS) }).strict();

const dispositionSchema = z.enum(DISPOSITIONS);
const dialSchema = z.object({
  decision_type: z.string(),
  class: z.string(),
  /** False for class 1 and class 3: shown, never writable. */
  adjustable: z.boolean(),
  disposition: dispositionSchema,
  allowed_dispositions: z.array(dispositionSchema),
  /** `preset` when the current version adopted a preset, `override` for a single-dial change, `default` when no version exists. */
  source: z.enum(["preset", "override", "default"]),
  preset: z.string().nullable(),
  version: z.number().nullable(),
});
const moveSchema = z.object({ decision_type: z.string(), from: dispositionSchema, to: dispositionSchema });
const settingsResponseSchema = z.object({
  repo_id: z.string(),
  /** Whether the caller may POST (an owner or admin). A plain member reads the page and nothing more. */
  can_change: z.boolean(),
  catalogue_version: z.number(),
  /** The preset every class 2 dial currently matches, or null when they match none (defaults, or a single-dial change). */
  active_preset: z.string().nullable(),
  presets: z.array(z.object({ name: z.string(), label: z.string(), customer_role: z.string() })),
  dials: z.array(dialSchema),
  /** The fixed list, read from the source the DP5 inventory test reads. It has no write route. */
  invariants: z.array(z.object({ key: z.string(), layer: z.string() })),
});
const previewResponseSchema = z.object({
  preset: z.string(),
  label: z.string(),
  customer_role: z.string(),
  active_preset: z.string().nullable(),
  /** Exactly the class 2 dials this preset would change. Empty when the repo already matches. */
  moves: z.array(moveSchema),
});
const applyResponseSchema = settingsResponseSchema.extend({ moved: z.array(moveSchema) });

type SettingsResponse = z.infer<typeof settingsResponseSchema>;
type Move = z.infer<typeof moveSchema>;

const CLASS_2 = "human_over_the_loop";
const classTwo = (): CatalogueEntry[] => CATALOGUE.filter((e) => e.class === CLASS_2);

/** What `decide()` resolves for an entry under a preset: the one definition of "what this preset does". */
function presetDisposition(entry: CatalogueEntry, preset: PresetName): Disposition {
  return decide(entry, { preset }, { type: entry.id, options: [], proposed: "", rationale: "" }).disposition;
}

/** The disposition in force: the current version, else the catalogue default. A stored value the entry does not allow fails closed to `ask`. */
function effective(entry: CatalogueEntry, row: DecisionSetting | null): Disposition {
  if (row === null) return entry.defaultDisposition;
  const stored = row.disposition as Disposition;
  return entry.allowedDispositions.includes(stored) ? stored : "ask";
}

function activePreset(rows: Map<string, DecisionSetting | null>): PresetName | null {
  const match = PRESETS.find((p) => classTwo().every((e) => effective(e, rows.get(e.id) ?? null) === presetDisposition(e, p.name)));
  return match ? match.name : null;
}

async function currentRows(client: PoolClient, repoId: string): Promise<Map<string, DecisionSetting | null>> {
  const rows = new Map<string, DecisionSetting | null>();
  for (const entry of classTwo()) rows.set(entry.id, await getCurrentDialSetting(client, repoId, entry.id));
  return rows;
}

function movesFor(preset: PresetName, rows: Map<string, DecisionSetting | null>): Move[] {
  const moves: Move[] = [];
  for (const entry of classTwo()) {
    const from = effective(entry, rows.get(entry.id) ?? null);
    const to = presetDisposition(entry, preset);
    if (from !== to) moves.push({ decision_type: entry.id, from, to });
  }
  return moves;
}

function view(repoId: string, canChange: boolean, rows: Map<string, DecisionSetting | null>): SettingsResponse {
  return {
    repo_id: repoId,
    can_change: canChange,
    catalogue_version: CATALOGUE_VERSION,
    active_preset: activePreset(rows),
    presets: PRESETS.map((p) => ({ name: p.name, label: p.label, customer_role: p.customerRoleDescription })),
    dials: CATALOGUE.map((entry) => {
      const row = entry.class === CLASS_2 ? (rows.get(entry.id) ?? null) : null;
      return {
        decision_type: entry.id,
        class: entry.class,
        adjustable: entry.class === CLASS_2,
        disposition: entry.class === CLASS_2 ? effective(entry, row) : presetDisposition(entry, "cautious"),
        allowed_dispositions: [...entry.allowedDispositions],
        source: row === null ? ("default" as const) : row.preset !== null ? ("preset" as const) : ("override" as const),
        preset: row?.preset ?? null,
        version: row?.version ?? null,
      };
    }),
    invariants: FIXED_INVARIANTS.map((i) => ({ key: i.key, layer: i.layer })),
  };
}

function invalid(path: string, code: string, message: string): ApiError {
  return new ApiError(422, "invalid_input", message, [{ path, code }]);
}

/** The database's own gate (owner/admin INSERT policy, unique version) answering for the route's pre-checks. */
function mapWriteError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42501") return new ForbiddenError("only an owner or admin can change a dial");
  // 23514: the next-version trigger (check_violation) fires when a concurrent writer committed first; same answer as the unique violation.
  if (code === "23505" || code === "23514") return new ApiError(409, "dial_changed", "a dial changed while you saved; reload and try again");
  return error;
}

/** "The v1 contract" rows for D#7 DP10a: reads are any member (session); writes are owner or admin, session only, no token. */
export const decisionSettingRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/repos/{id}/decision-settings",
    operationId: "getDecisionSettings",
    summary: "The Autonomy settings of a repo: each decision type's dial, the active preset and the fixed invariant list",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoIdParamsSchema,
    responseSchema: settingsResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const { accountId, userId, role } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertRepoExists(client, repoId);
        return view(repoId, role === "owner" || role === "admin", await currentRows(client, repoId));
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/repos/{id}/decision-settings/preset/preview",
    operationId: "previewDecisionPreset",
    summary: "Which class 2 dials a preset would change on this repo, without changing any",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    paramsSchema: repoIdParamsSchema,
    bodySchema: presetBodySchema,
    responseSchema: previewResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const name = (input.body as z.infer<typeof presetBodySchema>).preset;
      const preset = getPreset(name);
      const { accountId, userId } = ctx.principal;
      return withTenant(ctx.pool, accountId, userId, async (client) => {
        await assertRepoExists(client, repoId);
        const rows = await currentRows(client, repoId);
        return {
          preset: preset.name,
          label: preset.label,
          customer_role: preset.customerRoleDescription,
          active_preset: activePreset(rows),
          moves: movesFor(name, rows),
        };
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/repos/{id}/decision-settings/preset",
    operationId: "applyDecisionPreset",
    summary: "Adopt a preset: one new dial version per class 2 dial it changes, in one transaction",
    description:
      "Appends a `decision_settings` version for each class 2 dial the preset changes, and an audit row naming the previous and new value for each. " +
      "A repo that already matches writes nothing. Class 1 and class 3 are never touched. Owner or admin, session only.",
    // principals omitted -> session-only.
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: { "409": "A dial changed while the request was running (`dial_changed`), or the account is not active." },
    paramsSchema: repoIdParamsSchema,
    bodySchema: presetBodySchema,
    responseSchema: applyResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const name = (input.body as z.infer<typeof presetBodySchema>).preset;
      const { accountId, userId, role } = ctx.principal;
      try {
        return await withTenant(ctx.pool, accountId, userId, async (client) => {
          await assertRepoExists(client, repoId);
          const before = await currentRows(client, repoId);
          const moved = movesFor(name, before);
          for (const move of moved) {
            await appendDialVersion(client, { accountId, repoId, decisionType: move.decision_type, disposition: move.to, preset: name, changedBy: userId });
          }
          return { ...view(repoId, role === "owner" || role === "admin", await currentRows(client, repoId)), moved };
        });
      } catch (error) {
        throw mapWriteError(error);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/repos/{id}/decision-settings/dial",
    operationId: "setDecisionDial",
    summary: "Set one class 2 dial to ask, announce or act",
    description:
      "Appends one `decision_settings` version and one audit row. The decision type must be a class 2 entry in the catalogue and the disposition one that entry allows; " +
      "anything else, including a fixed invariant, is a 422 and writes nothing. Setting the value already in force is a no-op. Owner or admin, session only.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: { "409": "A dial changed while the request was running (`dial_changed`), or the account is not active." },
    paramsSchema: repoIdParamsSchema,
    bodySchema: dialBodySchema,
    responseSchema: settingsResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const body = input.body as z.infer<typeof dialBodySchema>;
      const entry = getCatalogueEntry(body.decision_type);
      if (entry === undefined) throw invalid("decision_type", "unknown_decision_type", "no such decision type");
      if (entry.class !== CLASS_2) throw invalid("decision_type", "not_adjustable", "only a class 2 decision type has a dial");
      if (!entry.allowedDispositions.includes(body.disposition)) {
        throw invalid("disposition", "not_allowed", `this decision type allows only: ${entry.allowedDispositions.join(", ")}`);
      }
      const { accountId, userId, role } = ctx.principal;
      try {
        return await withTenant(ctx.pool, accountId, userId, async (client) => {
          await assertRepoExists(client, repoId);
          const current = await getCurrentDialSetting(client, repoId, entry.id);
          // The value already in force (a version, else the catalogue default) is the request satisfied: no version, no audit row.
          // With no version yet, the catalogue default is what is in force, so naming it is also the request satisfied (as the preset path does).
          if (effective(entry, current) !== body.disposition) {
            await appendDialVersion(client, { accountId, repoId, decisionType: entry.id, disposition: body.disposition, preset: null, changedBy: userId });
          }
          return view(repoId, role === "owner" || role === "admin", await currentRows(client, repoId));
        });
      } catch (error) {
        throw mapWriteError(error);
      }
    },
  },
];
