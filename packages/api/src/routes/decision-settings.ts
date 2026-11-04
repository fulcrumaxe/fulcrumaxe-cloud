import { z } from "zod";
import type { PoolClient } from "pg";
import { CATALOGUE, CATALOGUE_VERSION, PRESETS, decide, getCatalogueEntry, getPreset } from "@fx/decisions";
import type { CatalogueEntry, Disposition, PresetName } from "@fx/decisions";
import { DIAL_DEFAULT_MARKER, appendDialVersion, getCurrentDialSetting, type DecisionSetting } from "@fx/db/src/decisions.js";
import { FIXED_INVARIANTS } from "@fx/db/src/dialInventory.js";
import { PRESET_HELD_SENTENCE, PlanHolderOnlyError, RUNNER_RUN_DECISION_TYPE, isLoosening } from "@fx/db/src/runnerPlanLoosen.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { assertRepoExists } from "@fx/core/src/role-settings/internal.js";
import { assertRepoIdShape } from "@fx/core/src/repos/read.js";
import { ForbiddenError } from "@fx/core/src/tenancy/errors.js";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { ApiError } from "../errors.js";
import { decisionLabel, invariantLabel } from "./decision-labels.js";
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
 * and an audit row of its own; the history keeps both. "Use the default" is the same kind of write: a version holding what no version means
 * (Balanced's value for a dial the runtime overrides, else the catalogue default) and `DIAL_DEFAULT_MARKER`, which the read shows as `source: default`.
 */

const repoIdParamsSchema = z.object({ id: z.string() });
const PRESET_NAMES = PRESETS.map((p) => p.name) as [PresetName, ...PresetName[]];
const DISPOSITIONS = ["ask", "announce", "act"] as const;

const presetBodySchema = z.object({ preset: z.enum(PRESET_NAMES) }).strict();
const resetBodySchema = z.object({ decision_type: z.string().min(1).max(100).optional() }).strict();
const dialBodySchema = z.object({ decision_type: z.string().min(1).max(100), disposition: z.enum(DISPOSITIONS) }).strict();

const dispositionSchema = z.enum(DISPOSITIONS);
const dialSchema = z.object({
  decision_type: z.string(),
  /** The customer-facing name; the id is for code. */
  label: z.string(),
  class: z.string(),
  /** False for class 1 and class 3: shown, never writable. */
  adjustable: z.boolean(),
  disposition: dispositionSchema,
  allowed_dispositions: z.array(dispositionSchema),
  /** `preset` when the current version adopted a preset, `override` for a single-dial change, `default` when no version exists or the last change was "use the default". */
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
  invariants: z.array(z.object({ key: z.string(), layer: z.string(), label: z.string() })),
});
/** A dial the preset left as it is because it would have loosened it (D#7 DW-R7); absent when none. */
const heldSchema = moveSchema.extend({ note: z.string() });
const previewResponseSchema = z.object({
  preset: z.string(),
  label: z.string(),
  customer_role: z.string(),
  active_preset: z.string().nullable(),
  /** Exactly the class 2 dials this preset would change. Empty when the repo already matches. */
  moves: z.array(moveSchema),
  held: z.array(heldSchema).optional(),
});
const applyResponseSchema = settingsResponseSchema.extend({ moved: z.array(moveSchema), held: z.array(heldSchema).optional() });

type SettingsResponse = z.infer<typeof settingsResponseSchema>;
type Move = z.infer<typeof moveSchema>;

const CLASS_2 = "human_over_the_loop";
const classTwo = (): CatalogueEntry[] => CATALOGUE.filter((e) => e.class === CLASS_2);

/** No version, or a "use the default" version: the catalogue's default is in force. */
const isDefault = (row: DecisionSetting | null): boolean => row === null || row.preset === DIAL_DEFAULT_MARKER;

/** What `decide()` resolves for an entry under a preset: the one definition of "what this preset does". */
function presetDisposition(entry: CatalogueEntry, preset: PresetName): Disposition {
  return decide(entry, { preset }, { type: entry.id, options: [], proposed: "", rationale: "" }).disposition;
}

/**
 * The dials the runtime reads a missing row as Balanced for (owner ruling 10-25): the three start dials (`startDecide.presetFor`), the fix-round and child-launch
 * dial (`fixRoundGate.presetOf`), and the two types the executor card declares, which the decision snapshot freezes as Balanced (`decisionSnapshot.dispositionForDial`).
 * Pinned against the start path by `decision-settings-start.test.ts`. "Run on a member's plan" is not here: the runner claim keeps its own rule, the catalogue default,
 * which already equals Balanced's value. Neither is the merge dial (`merge_after_reviews`): the merge gate reads it and reads no row, or a "use the default" row,
 * as the catalogue default `act`, so it keeps that value here too (it merges as Balanced's `announce` does, and the executor-card pin would fail if this list said announce).
 * A dial no runtime path reads keeps its catalogue default.
 */
export const RUNTIME_NO_ROW_BALANCED: ReadonlySet<string> = new Set(["start_work_small", "start_work_bug", "start_work_doc", "launch_sub_item", "nonbreaking_refactor_approach", "test_strategy_choice"]);

/** What a dial with no version means: what the runtime does with it (Balanced), never the catalogue's `ask` for a dial the runtime overrides. */
function noRowDisposition(entry: CatalogueEntry): Disposition {
  return RUNTIME_NO_ROW_BALANCED.has(entry.id) ? presetDisposition(entry, "balanced") : entry.defaultDisposition;
}

/**
 * The start dials. The auto-start sweep (`autoStartSweep.gateOne`) starts a proposal unattended only on a dial row a person WROTE: no row, and a "default"
 * marker row (what Reset writes), start nothing. So a person's explicit choice writes these rows even where the value in force already matches, and
 * skipping the choice writes nothing. Derived from the runtime list above, so a dial added later is not in it until the sweep reads it.
 */
const START_DIALS: ReadonlySet<string> = new Set([...RUNTIME_NO_ROW_BALANCED].filter((id) => id.startsWith("start_work_")));
const needsWritten = (entry: CatalogueEntry, row: DecisionSetting | null): boolean => START_DIALS.has(entry.id) && isDefault(row);

/**
 * The merge dial. With no written row the gate reads `act`, which merges exactly as Balanced's `announce` does, so it counts as matching Balanced. But choosing
 * Balanced writes `announce` for it, so the receipt and the screen say what the person chose. The preview then says what is truly written (act to announce).
 */
const MERGE_DIAL = "merge_after_reviews";
const writesBalancedMerge = (entry: CatalogueEntry, row: DecisionSetting | null, preset: PresetName): boolean => entry.id === MERGE_DIAL && preset === "balanced" && isDefault(row);

/**
 * A dial that is not in the list above and nobody has set keeps its catalogue default and never keeps a repo from reading Balanced: a dial no runtime path reads
 * has no opinion, and the merge dial is read by the gate as `act`, which merges as Balanced does (Balanced is then written for it only by a person's choice, see
 * `writesBalancedMerge`). A dial added to the catalogue later is treated like the first kind until the runtime reads it and it joins the list.
 */
const unreadDefault = (entry: CatalogueEntry, row: DecisionSetting | null): boolean => !RUNTIME_NO_ROW_BALANCED.has(entry.id) && isDefault(row);
/**
 * The dials no preset moves (D#601 MEM-10). Auto-approving memory puts text into later prompts, so a person raises it on purpose, per repository, and
 * choosing Balanced, Autonomous or Cautious neither raises it nor lowers it. Every preset therefore matches it at any value (it never decides which preset
 * is active), and a preset that would have moved it lists it as held with the sentence below, so a raised dial is not mistaken for one Cautious turned
 * off. With no version it reads as the catalogue default (`ask`): it is not in the runtime Balanced list above, because nothing reads a missing row as
 * anything else.
 */
export const PRESET_FIXED: ReadonlySet<string> = new Set(["memory_auto_approve"]);
export const PRESET_FIXED_HELD_SENTENCE = "Left as you set it. No preset changes this setting, so Cautious does not turn it off; change it here to make an agent's suggestions wait for you again.";

const atPreset = (entry: CatalogueEntry, row: DecisionSetting | null, preset: PresetName): boolean =>
  PRESET_FIXED.has(entry.id) || effective(entry, row) === presetDisposition(entry, preset) || (preset === "balanced" && unreadDefault(entry, row));

/** The disposition in force: the current version, else what no version means. A stored value the entry does not allow fails closed to `ask`. */
function effective(entry: CatalogueEntry, row: DecisionSetting | null): Disposition {
  if (row === null) return noRowDisposition(entry);
  const stored = row.disposition as Disposition;
  return entry.allowedDispositions.includes(stored) ? stored : "ask";
}

export function activePreset(rows: Map<string, DecisionSetting | null>): PresetName | null {
  const match = PRESETS.find((p) => classTwo().every((e) => atPreset(e, rows.get(e.id) ?? null, p.name)));
  return match ? match.name : null;
}

export async function currentRows(client: PoolClient, repoId: string): Promise<Map<string, DecisionSetting | null>> {
  const rows = new Map<string, DecisionSetting | null>();
  for (const entry of classTwo()) rows.set(entry.id, await getCurrentDialSetting(client, repoId, entry.id));
  return rows;
}

/** What a preset changes, and (per row) what it holds back: "run on a member's plan" is never loosened by a preset (D#7 DW-R7). */
function movesFor(preset: PresetName, rows: Map<string, DecisionSetting | null>): { moves: Move[]; held: (Move & { note: string })[] } {
  const moves: Move[] = [];
  const held: (Move & { note: string })[] = [];
  for (const entry of classTwo()) {
    const row = rows.get(entry.id) ?? null;
    const from = effective(entry, row);
    // A fixed dial stays where the person put it; a preset that would have moved it (a raised dial under any preset) says so instead.
    if (PRESET_FIXED.has(entry.id)) {
      if (from !== entry.defaultDisposition) held.push({ decision_type: entry.id, from, to: entry.defaultDisposition, note: PRESET_FIXED_HELD_SENTENCE });
      continue;
    }
    const to = presetDisposition(entry, preset);
    // A start dial nobody has written is written by a person's choice even where it already matches: the sweep starts nothing on no row or a marker row.
    if (atPreset(entry, row, preset) && !needsWritten(entry, row) && !writesBalancedMerge(entry, row, preset)) continue;
    if (entry.id === RUNNER_RUN_DECISION_TYPE && isLoosening(from, to)) held.push({ decision_type: entry.id, from, to, note: PRESET_HELD_SENTENCE });
    else moves.push({ decision_type: entry.id, from, to });
  }
  return { moves, held };
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
        label: decisionLabel(entry.id),
        class: entry.class,
        adjustable: entry.class === CLASS_2,
        disposition: entry.class === CLASS_2 ? effective(entry, row) : presetDisposition(entry, "cautious"),
        allowed_dispositions: [...entry.allowedDispositions],
        source: row === null || isDefault(row) ? ("default" as const) : row.preset !== null ? ("preset" as const) : ("override" as const),
        preset: isDefault(row) ? null : (row?.preset ?? null),
        version: row?.version ?? null,
      };
    }),
    invariants: FIXED_INVARIANTS.map((i) => ({ key: i.key, layer: i.layer, label: invariantLabel(i.key) })),
  };
}

function invalid(path: string, code: string, message: string): ApiError {
  return new ApiError(422, "invalid_input", message, [{ path, code }]);
}

/** The database's own gate (owner/admin INSERT policy, unique version) answering for the route's pre-checks. */
function mapWriteError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  if (error instanceof PlanHolderOnlyError) return new ApiError(403, error.code, error.message);
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
        const { moves, held } = movesFor(name, rows);
        return {
          preset: preset.name,
          label: preset.label,
          customer_role: preset.customerRoleDescription,
          active_preset: activePreset(rows),
          moves,
          ...(held.length > 0 ? { held } : {}),
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
      "A repo that already matches writes nothing, except that a start dial with no written row (or only a \"use the default\" version) is written, because the auto-start sweep starts work only on a written row; a repo nobody chose for reads as Balanced and starts nothing unattended. A preset never loosens \"run on a member's plan\": that dial is left as it is and listed in `held` with a sentence. Class 1 and class 3 are never touched. Owner or admin, session only.",
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
        const out = await withTenant(ctx.pool, accountId, userId, async (client) => {
          await assertRepoExists(client, repoId);
          const before = await currentRows(client, repoId);
          const { moves: moved, held } = movesFor(name, before);
          for (const move of moved) {
            await appendDialVersion(client, { accountId, repoId, decisionType: move.decision_type, disposition: move.to, preset: name, changedBy: userId, noVersionDisposition: noRowDisposition(getCatalogueEntry(move.decision_type)!) });
          }
          return { ...view(repoId, role === "owner" || role === "admin", await currentRows(client, repoId)), moved, ...(held.length > 0 ? { held } : {}) };
        });
        // D#483 S5-b1a-2: a looser dial can let a waiting proposal start; the auto-start pass wakes now instead of at the backstop.
        if (out.moved.length > 0) void markWorkPending("proposal-verify-sweep");
        return out;
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
      "anything else, including a fixed invariant, is a 422 and writes nothing. Setting the value already in force is a no-op, except on a start dial with no written row (or only a \"use the default\" version): naming a value there writes it, because the auto-start sweep starts work only on a written row. Owner or admin, session only.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: { "403": "Not an owner or admin, or (`plan_holder_only`) a looser \"run on a member's plan\" dial on a repo with a live subscription runner, which only that runner's holder may set. Nothing is written.", "409": "A dial changed while the request was running (`dial_changed`), or the account is not active." },
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
        const out = await withTenant(ctx.pool, accountId, userId, async (client) => {
          await assertRepoExists(client, repoId);
          const current = await getCurrentDialSetting(client, repoId, entry.id);
          // The value already in force is the request satisfied: no version, no audit row. A start dial with no written row is the exception: naming a value is a
          // person's choice, and the auto-start sweep reads only a written row.
          if (effective(entry, current) !== body.disposition || needsWritten(entry, current)) {
            await appendDialVersion(client, { accountId, repoId, decisionType: entry.id, disposition: body.disposition, preset: null, changedBy: userId, noVersionDisposition: noRowDisposition(entry) });
          }
          return view(repoId, role === "owner" || role === "admin", await currentRows(client, repoId));
        });
        if (body.disposition !== "ask") void markWorkPending("proposal-verify-sweep");
        return out;
      } catch (error) {
        throw mapWriteError(error);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v1/repos/{id}/decision-settings/reset",
    operationId: "resetDecisionDials",
    summary: "Use the default again for one class 2 dial, or for every class 2 dial on the repo",
    description:
      "Body `{ decision_type? }`. With a decision type, that dial goes back to what a dial with no version means; without one, every class 2 dial on the repo does. " +
      "That is Balanced's value for a dial the runtime reads as Balanced with no row, else the catalogue default. A dial that has a version appends one new version holding it (its `source` then reads `default`) and one audit row; a dial with no version, " +
      "or already on it, writes nothing. A \"use the default\" version does not start work unattended, as no version does not. Class 1 and class 3 are never touched. Owner or admin, session only.",
    minRole: "admin",
    idempotency: "never",
    rateClass: "write",
    extraResponses: { "403": "Not an owner or admin, or (`plan_holder_only`) a looser \"run on a member's plan\" dial on a repo with a live subscription runner, which only that runner's holder may set. Nothing is written.", "409": "A dial changed while the request was running (`dial_changed`), or the account is not active." },
    paramsSchema: repoIdParamsSchema,
    bodySchema: resetBodySchema,
    responseSchema: settingsResponseSchema,
    async handler(ctx, input) {
      const repoId = input.params.id!;
      assertRepoIdShape(repoId);
      const body = input.body as z.infer<typeof resetBodySchema>;
      let targets = classTwo();
      if (body.decision_type !== undefined) {
        const entry = getCatalogueEntry(body.decision_type);
        if (entry === undefined) throw invalid("decision_type", "unknown_decision_type", "no such decision type");
        if (entry.class !== CLASS_2) throw invalid("decision_type", "not_adjustable", "only a class 2 decision type has a dial");
        targets = [entry];
      }
      const { accountId, userId, role } = ctx.principal;
      try {
        return await withTenant(ctx.pool, accountId, userId, async (client) => {
          await assertRepoExists(client, repoId);
          for (const entry of targets) {
            const current = await getCurrentDialSetting(client, repoId, entry.id);
            // Back to what no version means. A "default" version an earlier reset wrote with the catalogue's `ask` is a row the runtime reads as Cautious, so it is replaced.
            const target = noRowDisposition(entry);
            if (current === null || (current.preset === DIAL_DEFAULT_MARKER && current.disposition === target)) continue;
            await appendDialVersion(client, { accountId, repoId, decisionType: entry.id, disposition: target, preset: DIAL_DEFAULT_MARKER, changedBy: userId });
          }
          return view(repoId, role === "owner" || role === "admin", await currentRows(client, repoId));
        });
      } catch (error) {
        throw mapWriteError(error);
      }
    },
  },
];
