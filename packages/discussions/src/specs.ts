import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { NotFoundError } from "@fx/core/src/tenancy/errors.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { WorkItemHaltedError } from "@fx/core/src/work-items/stages.js";
import type { DiscussionsContext } from "./principals.js";
import { accountIdOf, actorForWrite, kindOf, redactIfNeeded, runIdOf } from "./principals.js";
import { assertAllowed, assertUuidOrNotFound, rejectAccountIdInInput, DiscussionsError } from "./operations.js";
import { requireBodyWithinLimit, utf8ByteLength, chargeStorage } from "./limits.js";
import { emitDiscussionsEvent } from "./events.js";
import { effectiveProvenance } from "./provenance.js";

/** Criterion 6: a Spec can be (re)published only while the work item is
 * still being specified. */
const SPEC_PUBLISH_STAGES = ["triaged", "discussing", "spec_ready"] as const;

export interface SpecVersion {
  id: string;
  workItemId: string;
  version: number;
  body: string;
  bodySha256: string;
  createdAt: Date;
}

export interface SpecCorrection {
  id: string;
  specVersionId: string;
  code: string;
  body: string;
  appliesTo: string[];
  createdAt: Date;
}

interface WorkItemRow {
  stage: string;
  halted: boolean;
}

/** Locks (`FOR UPDATE`) the work item. Serializes concurrent publishers
 * and correctors of the same work item, so `version` and the `C<n>`
 * code below can be computed as MAX + 1 with no gap or duplicate. RLS
 * confines it to the caller's tenant, so another tenant's id is
 * NotFoundError, same as a missing one. */
async function lockWorkItem(client: PoolClient, workItemId: string): Promise<WorkItemRow> {
  const { rows } = await client.query<WorkItemRow>(
    `SELECT stage, halted_at IS NOT NULL AS halted FROM work_items WHERE id = $1 FOR UPDATE`,
    [workItemId],
  );
  if (rows.length === 0) {
    throw new NotFoundError(`work item not found: ${workItemId}`);
  }
  return rows[0]!;
}

export interface PublishSpecInput {
  workItemId: string;
  body: string;
}

/** `spec.publish`. Inserts the next `spec_versions` row (previous
 * maximum + 1) and, from `triaged` or `discussing`, moves the work item
 * to `spec_ready` through D#45's `recordStage` in the same transaction;
 * from `spec_ready` the stage is left alone. Any other stage is
 * `spec_frozen`. The system principal's cell is 'internal provenance
 * only': on an external work item it is refused with
 * `external_requires_human` whatever the stage (HT-3), where "external" is
 * the item's effective provenance (its own or any ancestor's). */
export async function publishSpec(ctx: DiscussionsContext, input: PublishSpecInput): Promise<SpecVersion> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  const access = assertAllowed(ctx.principal, "spec.publish");
  const workItemId = assertUuidOrNotFound(input.workItemId, "work item");
  const body = redactIfNeeded(ctx.principal, requireBodyWithinLimit(input.body));
  const actor = actorForWrite(ctx.principal);

  return withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const workItem = await lockWorkItem(client, workItemId);
    // A halted item gets no Spec from the pipeline (a person may still write one). Checked here and not only in recordStage:
    // an item already at spec_ready is not moved, so recordStage would never see it. Nothing is written.
    if (workItem.halted && actor.kind === "system") throw new WorkItemHaltedError(workItemId);

    // D#2 C58 G8: a question is answered in its thread and never gets a Spec,
    // so it can never reach `spec_ready`. Read from the discussion, not the input.
    const { rows: kindRows } = await client.query<{ kind: string }>(
      `SELECT d.kind FROM work_items w JOIN discussions d ON d.id = w.discussion_id WHERE w.id = $1`,
      [workItemId],
    );
    if (kindRows[0]?.kind === "question") {
      throw new DiscussionsError("kind_not_buildable", "a question is answered in its thread and never gets a Spec");
    }

    // Effective provenance, failing closed (see provenance.ts).
    if (access === "internal_only" && (await effectiveProvenance(client, workItemId)) !== "internal") {
      throw new DiscussionsError(
        "external_requires_human",
        "a Spec on an external work item may be published only by a signed-in owner or admin",
      );
    }
    if (!(SPEC_PUBLISH_STAGES as readonly string[]).includes(workItem.stage)) {
      throw new DiscussionsError("spec_frozen", `the Spec is frozen while the work item is "${workItem.stage}"`);
    }

    await chargeStorage(client, accountIdOf(ctx.principal), utf8ByteLength(body));

    const { rows: versionRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM spec_versions WHERE work_item_id = $1`,
      [workItemId],
    );
    const version = versionRows[0]!.next;
    const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");

    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO spec_versions
         (account_id, work_item_id, version, body, body_sha256, created_by_kind, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [accountIdOf(ctx.principal), workItemId, version, body, bodySha256, actor.kind, actor.userId],
    );
    const specVersionId = rows[0]!.id;

    let stage = workItem.stage;
    if (workItem.stage !== "spec_ready") {
      await recordStage(client, {
        workItemId,
        toStage: "spec_ready",
        at: new Date(),
        source: "control_plane",
        sourceRef: `spec_version:${specVersionId}`,
        actor: actor.kind === "user" ? "person" : "automatic",
      });
      stage = "spec_ready";
    }

    await emitDiscussionsEvent(client, "spec.published", accountIdOf(ctx.principal), specVersionId, {
      workItemId,
      specVersionId,
      version,
      stage,
    });

    return { id: specVersionId, workItemId, version, body, bodySha256, createdAt: rows[0]!.created_at };
  });
}

export interface AddCorrectionInput {
  workItemId: string;
  body: string;
  /** Work items this correction applies to; each must be the Spec's own
   * work item or have it in its `parent_id` chain. */
  appliesTo?: string[];
}

/** `spec.correct`. Attaches to the work item's latest Spec version. The
 * service assigns the code: `C` + (highest correction number across all
 * versions of the work item + 1). Callers can't supply one (an input
 * carrying `code` is refused). */
export async function addCorrection(ctx: DiscussionsContext, input: AddCorrectionInput): Promise<SpecCorrection> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  if (Object.hasOwn(input, "code")) {
    throw new DiscussionsError("invalid_input", "the correction code is assigned by the service");
  }
  const access = assertAllowed(ctx.principal, "spec.correct");
  const workItemId = assertUuidOrNotFound(input.workItemId, "work item");
  const body = redactIfNeeded(ctx.principal, requireBodyWithinLimit(input.body));
  const appliesTo = normaliseAppliesTo(input.appliesTo);
  const actor = actorForWrite(ctx.principal);

  return withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    await lockWorkItem(client, workItemId);

    if (access === "internal_only" && (await effectiveProvenance(client, workItemId)) !== "internal") {
      throw new DiscussionsError(
        "external_requires_human",
        "a correction on an external work item may be added only by a signed-in owner or admin",
      );
    }

    const { rows: specRows } = await client.query<{ id: string }>(
      `SELECT id FROM spec_versions WHERE work_item_id = $1 ORDER BY version DESC LIMIT 1`,
      [workItemId],
    );
    if (specRows.length === 0) {
      throw new DiscussionsError("no_spec_version", "this work item has no Spec version to correct");
    }
    const specVersionId = specRows[0]!.id;

    if (appliesTo.length > 0) {
      // Walk each target's parent_id chain up; the target qualifies when the
      // walk reaches the Spec's own work item (a target that IS the Spec's
      // work item qualifies at step zero). UNION (not UNION ALL) so a
      // parent_id cycle terminates. RLS scopes work_items to this tenant,
      // so another tenant's id can never qualify.
      const { rows: okRows } = await client.query<{ start_id: string }>(
        `WITH RECURSIVE chain(start_id, id, parent_id) AS (
           SELECT w.id, w.id, w.parent_id FROM work_items w WHERE w.id = ANY($1::uuid[])
           UNION
           SELECT c.start_id, w.id, w.parent_id FROM chain c JOIN work_items w ON w.id = c.parent_id
         )
         SELECT DISTINCT start_id FROM chain WHERE id = $2`,
        [appliesTo, workItemId],
      );
      if (okRows.length !== appliesTo.length) {
        throw new DiscussionsError(
          "invalid_input",
          "every appliesTo id must be the Spec's work item or one of its descendants in this account",
        );
      }
    }

    await chargeStorage(client, accountIdOf(ctx.principal), utf8ByteLength(body));

    const { rows: codeRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(substring(c.code from 2)::int), 0) + 1 AS next
         FROM spec_corrections c
         JOIN spec_versions v ON v.account_id = c.account_id AND v.id = c.spec_version_id
        WHERE v.work_item_id = $1`,
      [workItemId],
    );
    const code = `C${codeRows[0]!.next}`;

    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO spec_corrections
         (account_id, spec_version_id, code, body, applies_to, created_by_kind, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7)
       RETURNING id, created_at`,
      [accountIdOf(ctx.principal), specVersionId, code, body, appliesTo, actor.kind, actor.userId],
    );
    const correctionId = rows[0]!.id;

    await emitDiscussionsEvent(client, "spec.corrected", accountIdOf(ctx.principal), correctionId, {
      workItemId,
      specVersionId,
      code,
    });

    return { id: correctionId, specVersionId, code, body, appliesTo, createdAt: rows[0]!.created_at };
  });
}

function normaliseAppliesTo(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DiscussionsError("invalid_input", "appliesTo must be an array of work item ids");
  }
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new DiscussionsError("invalid_input", "appliesTo must be an array of work item ids");
    }
    seen.add(id.toLowerCase());
  }
  return [...seen];
}

export interface RunIdInput {
  runId: string;
}

export interface SpecAsOfResult {
  specVersion: SpecVersion;
  corrections: SpecCorrection[];
}

interface RunSpecPin {
  workItemId: string | null;
  specVersionId: string;
  specWorkItemId: string;
}

/** Resolves a run to its pinned Spec version. The run row, and the Spec
 * row it points at, are both read under the caller's tenant (RLS), so a
 * foreign or missing run is NotFoundError. A `run` principal may only
 * read for runs on its own work item, its parent chain or its direct
 * dependencies, and only Specs of those same work items (the `read`
 * cell: "own work item's thread, its parent chain and its deps only");
 * anything else is the same NotFoundError as a missing row. */
async function resolveRunSpec(
  client: PoolClient,
  ctx: DiscussionsContext,
  runId: string,
): Promise<RunSpecPin> {
  const { rows } = await client.query<{
    work_item_id: string | null;
    spec_version_id: string | null;
    spec_work_item_id: string | null;
  }>(
    `SELECT r.work_item_id, r.spec_version_id, v.work_item_id AS spec_work_item_id
       FROM agent_runs r LEFT JOIN spec_versions v ON v.account_id = r.account_id AND v.id = r.spec_version_id
      WHERE r.id = $1`,
    [runId],
  );
  if (rows.length === 0) {
    throw new NotFoundError(`agent run not found: ${runId}`);
  }
  const row = rows[0]!;

  if (kindOf(ctx.principal) === "run") {
    const { rows: own } = await client.query<{ work_item_id: string | null }>(
      `SELECT work_item_id FROM agent_runs WHERE id = $1`,
      [runIdOf(ctx.principal)],
    );
    const ownWorkItemId = own[0]?.work_item_id ?? null;
    if (!ownWorkItemId) {
      throw new NotFoundError(`agent run not found: ${runId}`);
    }
    const { rows: readable } = await client.query<{ id: string }>(
      `WITH RECURSIVE ancestors(id, parent_id) AS (
         SELECT w.id, w.parent_id FROM work_items w WHERE w.id = $1
         UNION
         SELECT w.id, w.parent_id FROM ancestors a JOIN work_items w ON w.id = a.parent_id
       )
       SELECT id FROM ancestors
       UNION
       SELECT depends_on_id FROM work_item_deps WHERE work_item_id = $1`,
      [ownWorkItemId],
    );
    const ids = new Set(readable.map((r) => r.id));
    if (!row.work_item_id || !ids.has(row.work_item_id) || (row.spec_work_item_id && !ids.has(row.spec_work_item_id))) {
      throw new NotFoundError(`agent run not found: ${runId}`);
    }
  }

  if (!row.spec_version_id || !row.spec_work_item_id) {
    throw new DiscussionsError("no_spec_version", "this run has no pinned Spec version");
  }
  return { workItemId: row.work_item_id, specVersionId: row.spec_version_id, specWorkItemId: row.spec_work_item_id };
}

const CORRECTION_COLUMNS = `c.id, c.spec_version_id, c.code, c.body, c.applies_to, c.created_at`;

interface CorrectionRow {
  id: string;
  spec_version_id: string;
  code: string;
  body: string;
  applies_to: string[];
  created_at: Date;
}

function toCorrection(r: CorrectionRow): SpecCorrection {
  return { id: r.id, specVersionId: r.spec_version_id, code: r.code, body: r.body, appliesTo: r.applies_to, createdAt: r.created_at };
}

/** Corrections across every version of the Spec's work item, split in two
 * that never overlap and together cover all of them (C7 R4). A run's own
 * corrections ("as of") are those attached to the pinned version or an
 * earlier one AND created at or before the run's `created_at`; everything
 * else is "since". The timestamps are compared inside SQL, so there is no
 * JS millisecond truncation of the database's microsecond values. */
async function correctionsForRun(
  client: PoolClient,
  runId: string,
  pin: RunSpecPin,
  side: "as_of" | "since",
): Promise<SpecCorrection[]> {
  const asOf = `(v.version <= (SELECT version FROM spec_versions WHERE id = $3)
                 AND c.created_at <= (SELECT created_at FROM agent_runs WHERE id = $2))`;
  const { rows } = await client.query<CorrectionRow>(
    `SELECT ${CORRECTION_COLUMNS}
       FROM spec_corrections c
       JOIN spec_versions v ON v.account_id = c.account_id AND v.id = c.spec_version_id
      WHERE v.work_item_id = $1
        AND ${side === "as_of" ? asOf : `NOT ${asOf}`}
      ORDER BY substring(c.code from 2)::int`,
    [pin.specWorkItemId, runId, pin.specVersionId],
  );
  return rows.map(toCorrection);
}

/** `specAsOf(runId)`: the run's pinned Spec version plus its corrections:
 * those on the pinned version or an earlier one, created at or before the
 * run's `created_at`. A run with a null
 * `spec_version_id` gets `no_spec_version`. Read-only. */
export async function specAsOf(ctx: DiscussionsContext, input: RunIdInput): Promise<SpecAsOfResult> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "read");
  const runId = assertUuidOrNotFound(input.runId, "agent run");

  return withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const pin = await resolveRunSpec(client, ctx, runId);
    const { rows } = await client.query<{
      id: string;
      work_item_id: string;
      version: number;
      body: string;
      body_sha256: string;
      created_at: Date;
    }>(`SELECT id, work_item_id, version, body, body_sha256, created_at FROM spec_versions WHERE id = $1`, [
      pin.specVersionId,
    ]);
    const v = rows[0]!;
    return {
      specVersion: {
        id: v.id,
        workItemId: v.work_item_id,
        version: v.version,
        body: v.body,
        bodySha256: v.body_sha256,
        createdAt: v.created_at,
      },
      corrections: await correctionsForRun(client, runId, pin, "as_of"),
    };
  });
}

/** `correctionsSince(runId)`: every other correction on the work item --
 * created after the run's `created_at`, or attached to a newer version
 * than the run's pinned one. Same access rules and errors as `specAsOf`. */
export async function correctionsSince(ctx: DiscussionsContext, input: RunIdInput): Promise<SpecCorrection[]> {
  rejectAccountIdInInput(input as unknown as Record<string, unknown>);
  assertAllowed(ctx.principal, "read");
  const runId = assertUuidOrNotFound(input.runId, "agent run");

  return withTenant(ctx.pool, accountIdOf(ctx.principal), async (client) => {
    const pin = await resolveRunSpec(client, ctx, runId);
    return correctionsForRun(client, runId, pin, "since");
  });
}
