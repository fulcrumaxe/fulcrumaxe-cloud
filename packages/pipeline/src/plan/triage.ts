import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { createDiscussion, setStage, type Discussion, type DiscussionsContext } from "@fx/discussions";
import { systemPrincipal } from "@fx/discussions/server";
import { TRIAGE_CATEGORIES, discussionKindFor, isExplicitKind, runsPanel, type TriageCategory } from "./categories.js";
import { classifyWorkItem, type TriageClassifier } from "./classifier.js";
import { ownData } from "./ownData.js";
import { isWellFormedString } from "./unicode.js";

/**
 * D#2 H15a: original H15 criterion 1 (classify) plus C20's new criterion 6
 * (create the discussion and its root work item with `discussion.create`,
 * and move `triaged -> discussing` through `setStage` when the panel
 * starts), as split out by C36.
 *
 * Every write here is made through `@fx/discussions` under the SYSTEM
 * principal (C20 item 2), from server code, never as GitHub Discussion
 * text. This file makes no GitHub call of any kind.
 */

/** The single stage transition H15a ever requests. It is a literal, not a
 * parameter: nothing in this file can request `in_progress`, `spec_ready`
 * or any other target (the open HT-3 question is the PM's to rule; H15a
 * stays clear of it by construction). */
export const TRIAGE_TARGET_STAGE = "discussing" as const;

export interface TriageDeps {
  /** An app_user pool: every read and write below runs under `withTenant`. */
  pool: Pool;
  accountId: string;
  classifier: TriageClassifier;
}

/**
 * What triage is asked to do.
 *
 * `new`: a newly arrived item that has no discussion yet. Only an item the
 * H07 gate trusted (`trusted: true`, i.e. `canCreateWork` said yes) may take
 * this path. `discussion.create` always produces an INTERNAL root work item
 * (its own contract: external rows arrive only through DS-7/DS-8), so
 * creating one for untrusted text would launder external provenance into an
 * internal root and defeat HT-3. An untrusted `new` item is refused before
 * any classification or write.
 *
 * `existing`: the root work item of a discussion that already exists (for
 * example one written by the inbound path, with whatever provenance that
 * path assigned). Triage classifies it and, for Critical/Feature, moves it
 * to `discussing`. Its provenance is never read to decide anything except
 * that it is left untouched.
 */
export type TriageIntake =
  | { mode: "new"; trusted: boolean; title: string; body: string; repoId?: string | null; sourceEventId: string }
  | { mode: "existing"; workItemId: string; title: string; body: string };

export type TriageRefusal =
  | "invalid_mode"
  | "untrusted_intake"
  | "invalid_source_event"
  | "not_found"
  | "no_discussion"
  | "not_triaged";

export type TriageOutcome =
  | {
      status: "triaged";
      category: TriageCategory;
      workItemId: string;
      discussionId: string;
      /** `new` mode only. */
      discussionNumber?: number;
      /** `discussing` for Critical/Feature, `triaged` otherwise. Read from
       * what the stage move actually did, never assumed. */
      stage: "triaged" | typeof TRIAGE_TARGET_STAGE;
      /** Set when this call wrote nothing new because an earlier run of this
       * same triage had already done it (an idempotent retry): in `new`
       * mode the discussion already existed for the source event, and/or
       * the stage move had already been made. */
      replayed?: true;
    }
  | {
      /**
       * `new` mode only: `createDiscussion` committed, then the stage move
       * failed or its acknowledgement was lost. The discussion and its root
       * work item exist. The item is normally still at `triaged`, but after
       * a lost acknowledgement (the move committed, then the call threw) it
       * is already at `discussing`. Retry by replaying the `new` intake with
       * the SAME `sourceEventId` (the database returns the existing
       * discussion, D#2 H15b-IDEM) or through `mode: "existing"` with
       * `workItemId`; both are safe.
       */
      status: "created_not_staged";
      category: TriageCategory;
      workItemId: string;
      discussionId: string;
      discussionNumber: number;
      reason: string;
    }
  | { status: "unclassified"; reason: string }
  | { status: "refused"; reason: TriageRefusal };

interface ExistingRow {
  stage: string;
  discussion_id: string | null;
  /** Id of the latest transition INTO `triaged`, or null when the item has
   * been at `triaged` since it was created. */
  triaged_entry: string | null;
  /** `source_ref` of the latest stage move THIS triage made for the item. */
  triage_ref: string | null;
  /** The kind to take WITHOUT the classifier (C58 G8/G9 item 5): the stored
   * `question` or `project` kind of an internal discussion a signed-in member
   * created. Null for everything else, which is classified as before. */
  explicit_kind: string | null;
}

const ENTRY_INITIAL = "initial";

async function readExisting(deps: TriageDeps, workItemId: string): Promise<ExistingRow | null> {
  if (typeof workItemId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workItemId)) {
    return null;
  }
  return withTenant(deps.pool, deps.accountId, async (client) => {
    const { rows } = await client.query<ExistingRow>(
      `SELECT w.stage, w.discussion_id,
              (SELECT t.id FROM work_item_transitions t
                WHERE t.work_item_id = w.id AND t.to_stage = 'triaged'
                ORDER BY t.at DESC, t.id DESC LIMIT 1) AS triaged_entry,
              (SELECT t.source_ref FROM work_item_transitions t
                WHERE t.work_item_id = w.id AND t.to_stage = $2 AND t.source_ref LIKE $3
                ORDER BY t.at DESC, t.id DESC LIMIT 1) AS triage_ref,
              (SELECT d.kind FROM discussions d
                WHERE d.id = w.discussion_id AND d.kind IN ('question', 'project')
                  AND d.created_by_kind = 'user' AND w.provenance = 'internal') AS explicit_kind
         FROM work_items w WHERE w.id = $1`,
      [workItemId, TRIAGE_TARGET_STAGE, `triage:${TRIAGE_TARGET_STAGE}:${workItemId}:%`],
    );
    return rows[0] ?? null;
  });
}

/**
 * The stage-move idempotency key: `triage:discussing:<item>:<category>:<entry>`.
 * `entry` names which entry into `triaged` this move leaves, so a retry of
 * the same attempt repeats the key (a harmless duplicate) while a
 * re-triage after a human reopen (`closed -> triaged`) gets a new one and
 * genuinely moves the item. The category rides in the key: it is the
 * classification record a later retry reuses, with no storage of its own.
 */
function stageRef(workItemId: string, category: TriageCategory, entry: string | null): string {
  return `triage:${TRIAGE_TARGET_STAGE}:${workItemId}:${category}:${entry ?? ENTRY_INITIAL}`;
}

/** Reads back a `stageRef`: the category it recorded, if the key is ours,
 * names this item, and belongs to the item's CURRENT entry into `triaged`. */
function recordedCategory(ref: string | null, workItemId: string, entry: string | null): TriageCategory | null {
  if (ref === null) return null;
  const parts = ref.split(":");
  if (parts.length !== 5 || parts[0] !== "triage" || parts[1] !== TRIAGE_TARGET_STAGE || parts[2] !== workItemId) return null;
  if (parts[4] !== (entry ?? ENTRY_INITIAL)) return null;
  return (TRIAGE_CATEGORIES as readonly string[]).includes(parts[3]!) ? (parts[3] as TriageCategory) : null;
}

/** Requests `triaged -> discussing` and nothing else. Returns what the
 * store actually did: a transition recorded, or a duplicate of this same
 * attempt's earlier move. */
async function moveToDiscussing(
  ctx: DiscussionsContext,
  workItemId: string,
  category: TriageCategory,
  entry: string | null,
): Promise<{ replayed: boolean }> {
  const result = await setStage(ctx, {
    workItemId,
    toStage: TRIAGE_TARGET_STAGE,
    sourceRef: stageRef(workItemId, category, entry),
  });
  return { replayed: !result.recorded };
}

/** The category a stored discussion kind stands for, or null when the kind
 * is not one triage produces. */
function categoryOfKind(kind: string): TriageCategory | null {
  return (TRIAGE_CATEGORIES as readonly string[]).includes(kind) ? (kind as TriageCategory) : null;
}

/** The discussion an earlier run of this intake already created, by the
 * database's own key. A read only: the uniqueness is the store's index. */
async function findBySourceEvent(
  deps: TriageDeps,
  sourceEventId: string,
): Promise<Pick<Discussion, "id" | "number" | "rootWorkItemId" | "kind"> | null> {
  return withTenant(deps.pool, deps.accountId, async (client) => {
    const { rows } = await client.query<{ id: string; number: string; root_work_item_id: string; kind: Discussion["kind"] }>(
      `SELECT id, number, root_work_item_id, kind FROM discussions WHERE source_event_id = $1`,
      [sourceEventId],
    );
    const r = rows[0];
    return r ? { id: r.id, number: Number(r.number), rootWorkItemId: r.root_work_item_id, kind: r.kind } : null;
  });
}

/**
 * Exactly what the store accepts for a source event key (createDiscussion:
 * a string of 1 to 200 characters, well-formed Unicode, no NUL), checked
 * BEFORE the lookup so a key the store would reject never reaches Postgres
 * as a query parameter (C41 H15c-HARD-2, CWE-20).
 */
export function isValidSourceEventId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 200 && !v.includes("\u0000") && isWellFormedString(v);
}

export async function triageIntake(deps: TriageDeps, intake: TriageIntake): Promise<TriageOutcome> {
  // `intake` is a runtime value from a caller that may not be typed, and it
  // may carry accessors (CWE-367). Read every field this function branches
  // on exactly ONCE, here, and never touch `intake` again: the validated
  // locals below are the only thing later code sees.
  const raw: Record<string, unknown> | null = intake !== null && typeof intake === "object" ? (intake as unknown as Record<string, unknown>) : null;
  const mode: unknown = raw === null ? undefined : raw.mode;
  if (mode !== "new" && mode !== "existing") {
    return { status: "refused", reason: "invalid_mode" };
  }
  const trusted = mode === "new" && raw!.trusted === true;
  const workItemIdIn = mode === "existing" ? (raw!.workItemId as string) : "";
  const title = raw!.title as string;
  const body = raw!.body as string;
  const repoId = mode === "new" ? ((raw!.repoId as string | null | undefined) ?? null) : null;
  // An OWN data property only (C41 H15c-HARD-1, CWE-1321): a key inherited
  // through Object.prototype must not become the replay key of an intake that
  // has none, or that intake would merge into someone else's discussion.
  const sourceEventId: unknown = mode === "new" ? ownData(raw!, "sourceEventId") : undefined;

  const ctx: DiscussionsContext = {
    pool: deps.pool,
    principal: systemPrincipal(deps.accountId, "pipeline.triage"),
  };

  if (mode === "new" && !trusted) {
    return { status: "refused", reason: "untrusted_intake" };
  }

  if (mode === "existing") {
    const workItemId = workItemIdIn;
    const existing = await readExisting(deps, workItemId);
    if (existing === null) return { status: "refused", reason: "not_found" };
    if (existing.discussion_id === null) return { status: "refused", reason: "no_discussion" };
    const discussionId = existing.discussion_id;

    // A retry of a triage that already moved this item: the outcome was lost,
    // not the write. Report the recorded classification; classify nothing.
    if (existing.stage === TRIAGE_TARGET_STAGE) {
      const recorded = recordedCategory(existing.triage_ref, workItemId, existing.triaged_entry);
      if (recorded === null) return { status: "refused", reason: "not_triaged" };
      return {
        status: "triaged",
        category: recorded,
        workItemId,
        discussionId,
        stage: TRIAGE_TARGET_STAGE,
        replayed: true,
      };
    }
    if (existing.stage !== "triaged") return { status: "refused", reason: "not_triaged" };

    // Classify before any write: an unclassifiable item leaves no trace. A
    // crashed `new` attempt left no record of its category, so it is
    // classified afresh here.
    // A member's in-product "Ask a question" / "New project" already chose its
    // kind: no model call. Anything else, external intake included, is classified.
    let category: TriageCategory;
    if (existing.explicit_kind !== null && isExplicitKind(existing.explicit_kind)) {
      category = existing.explicit_kind;
    } else {
      const classified = await classifyWorkItem(deps.classifier, { title, body });
      if (!classified.ok) return { status: "unclassified", reason: classified.reason };
      category = classified.category;
    }

    let moved: { replayed: boolean } | null = null;
    if (runsPanel(category)) {
      moved = await moveToDiscussing(ctx, workItemId, category, existing.triaged_entry);
    }
    return {
      status: "triaged",
      category,
      workItemId,
      discussionId,
      stage: moved === null ? "triaged" : TRIAGE_TARGET_STAGE,
      ...(moved?.replayed ? { replayed: true as const } : {}),
    };
  }

  // mode === "new" (and trusted)
  // The replay key is required: without it a replayed intake would create a
  // second discussion. Refuse before any model call rather than fail in the store.
  if (!isValidSourceEventId(sourceEventId)) {
    return { status: "refused", reason: "invalid_source_event" };
  }

  // A replay must not re-decide the category: the model is not deterministic,
  // and a different answer would name a different stage-move key. The
  // discussion for this source event is looked up first, and its stored kind
  // (which IS the category, `discussionKindFor`) is what a replay uses; a
  // replay also costs no model call. Two racing first attempts both miss the
  // lookup; `createDiscussion` then lets the database pick one winner and
  // tells the loser (`replayed`), which takes the winner's kind the same way.
  let created: Pick<Discussion, "id" | "number" | "rootWorkItemId" | "kind"> | null = await findBySourceEvent(deps, sourceEventId);
  let replayedCreate = created !== null;
  if (created === null) {
    const classified = await classifyWorkItem(deps.classifier, { title, body });
    if (!classified.ok) return { status: "unclassified", reason: classified.reason };
    const made = await createDiscussion(ctx, {
      title,
      kind: discussionKindFor(classified.category),
      body,
      repoId,
      sourceEventId,
    });
    created = made;
    replayedCreate = made.replayed === true;
  }
  const workItemId = created.rootWorkItemId;
  const category = categoryOfKind(created.kind);
  if (category === null) return { status: "unclassified", reason: "stored discussion kind is not a triage category" };

  if (!runsPanel(category)) {
    return {
      status: "triaged",
      category,
      workItemId,
      discussionId: created.id,
      discussionNumber: created.number,
      stage: "triaged",
      ...(replayedCreate ? { replayed: true as const } : {}),
    };
  }

  try {
    const moved = await moveToDiscussing(ctx, workItemId, category, null);
    return {
      status: "triaged",
      category,
      workItemId,
      discussionId: created.id,
      discussionNumber: created.number,
      stage: TRIAGE_TARGET_STAGE,
      ...(moved.replayed || replayedCreate ? { replayed: true as const } : {}),
    };
  } catch (err) {
    // fx-swallow-ok: the message goes back in `reason`; the discussion is committed, so do not lose its ids to the exception.
    return {
      status: "created_not_staged",
      category,
      workItemId,
      discussionId: created.id,
      discussionNumber: created.number,
      reason: err instanceof Error ? err.message : "stage move failed",
    };
  }
}
