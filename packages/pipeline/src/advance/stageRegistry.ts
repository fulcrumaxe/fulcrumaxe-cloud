import { RESERVATION_PAUSE_REASONS, pauseForDenial, type ReservationPause } from "./reservationPauses.js";
import { attemptOfKey } from "./attemptKeys.js";
import { WAITING_STAGES, WAITING_STAGE_POSITIONS, type WaitingStage } from "./waitingStages.js";
import { stageKeyLikes } from "./stageStarts.js";
import { fixKeyLikes, reviewKeyLikes } from "./reviewStarts.js";
import { BUILD_STAGE_GATE } from "@fx/core/src/work-items/stageApprovalGate.js";
import { nextPanelAttempt, panelKeyLikes } from "./panelStarts.js";

/**
 * D#483 S5-k1b: the registry of stages the parked-stage sweep can resume.
 *
 * A start that a spending limit denies waits (up to four hours, asking again) and then PARKS: its workflow ends `<stage>_paused:<pause>`, the item stays
 * where it is, and one sweep (every 15 minutes) restarts the stage when the limit allows it. The sweep knows nothing about any one stage: each stage
 * gives an entry here, saying where its items park, which seat's limits the restart will meet, and how its runs are keyed. A stage with no entry is
 * never parked and keeps the refusal it has today; `UNREGISTERED_STAGES` names those, so a stage cannot be left out by accident (a test fails when a
 * stage is in neither list, or in both). Each of the stage rows that follows this one registers its stage in its own PR and removes it from the list.
 */

export interface ParkedStageEntry {
  stage: WaitingStage;
  /** The item stages at which this stage parks (the sweep lists items there). */
  itemStages: readonly string[];
  /** The pauses that park here: a fact with any other code is a different wait (a build slot) and is not resumed by this sweep. */
  pauses: readonly ReservationPause[];
  /** The role whose seat (and so whose limits and estimate) the restarted start will meet: the headroom check asks for exactly that reservation. */
  role: string;
  /**
   * The person-given approval the restart runs under: its kind, and where it is looked for. `self`: a request that targets the parked item. `origin`: also one
   * that targeted the card this one replaced (the webhook's card is retired when the pipeline makes its own card for the issue, and the approval stays on the
   * retired card). Either way the newest one done and started wins, and its approver must still be an owner or admin.
   */
  approval: { kind: "advance_work_item" | "respec_work_item"; from: "self" | "origin" };
  /** Whether the stage builds on a published Spec: the item must have one, and a Spec written after the approval ends the parking (what runs is what was approved). */
  needsSpec: boolean;
  /** Whether the restarted workflow is a re-spec (it carries `respec: true`). */
  respec: boolean;
  /**
   * The SQL LIKE patterns (`%` and `_` already escaped, used with ESCAPE '\') of the idempotency keys of this stage's runs for one item and approval. A stage that is
   * bound to a head (`headBound`) gets the head its wait was for as the third argument, because its keys name the head, not the approval.
   */
  runKeyLikes(workItemId: string, actionId: string, headSha?: string | null): string[];
  /**
   * D#483 S5-k1d: the stage waits on one head of an open change (a reviewer's start, a fix round). Its waiting facts carry the head they were for; the sweep
   * resumes only while that head is still the head (a newer push ends the parking, and the new head is a new ask), and a stage that has no head in its facts is
   * not resumed at all.
   */
  headBound?: boolean;
  /**
   * D#483 S5-k1d: runs of this stage that really started are expected beside the denied ones (a review starts several reviewers; one may start while another is
   * denied, and the restart finds the started one by its key and asks only for the rest). The sweep then does not read a started run as "the stage already ran".
   */
  startedRunsOk?: boolean;
  /**
   * D#483 S5-k1d: the facts that, written AFTER the latest waiting fact, mean the stage moved on or ended in a refusal that is not a limit, so the sweep leaves the
   * item alone until a new waiting fact or a person's approval. Absent: the build's pair (`build_refused`, `stopped`).
   */
  progressKinds?: readonly string[];
  /**
   * D#483 S5-k1e: the stage's asks do not each leave a run row (the panel's whole-round check denies before any seat starts), so the attempt numbers the workflow wrote
   * on its waiting facts can run ahead of the run keys. The restart then begins above both: a workflow's fact is keyed by its attempt, and a restart that reused a
   * number would find its facts already written and leave the card with no fresh wait. Only the facts the workflow wrote count (not the sweep's own refreshes).
   */
  attemptAfterFacts?: boolean;
  /** The attempt the restart begins at, from the keys that match `runKeyLike`: one more than the highest, or 0 when no run exists. Never the bare key once a run holds it. */
  nextAttempt(keys: readonly string[]): number;
  /** A denial of the spend check as a pause name, or null when it is not one: the mapping the start itself uses. */
  pauseForDenial(denial: string): ReservationPause | null;
}

/** One more than the highest attempt among the keys (0 when there are none). Shared by every entry whose runs are keyed `<base>[:s<n>]`. */
const nextAfterHighest = (keys: readonly string[]): number => (keys.length === 0 ? 0 : Math.max(...keys.map(attemptOfKey)) + 1);

/** The seat of every stage that writes before the build: the project manager. The headroom check of a restart meets that seat's limits. */
const PM_ROLE = "project-manager";

/**
 * D#483 S5-k1d: what a review or a fix round writes once it has moved on. Written after the latest waiting fact, any of these ends the sweep's claim on the item:
 * the reviewers started, a verdict was recorded, a fix round started, ended or was refused for a reason that is not a limit, the gate decided, or the driver stopped.
 */
export const REVIEW_PROGRESS_KINDS: readonly string[] = Object.freeze([
  "review_started",
  "review_verdicts",
  "fix_round_started",
  "fix_round_refused",
  "fix_pushed_nothing",
  "fix_round_failed",
  "escalated",
  "merge_gate",
  "merged_by_gate",
  "stopped",
]);

/**
 * D#483 S5-k1e: the code of the `stopped` fact the workflow writes once a panel that had waited on a limit is no longer held by one (the panel step answered something
 * that is not a pause). It ends the sweep's claim on the panel: what comes of the Spec step after it is the Spec's own outcome, not a reason to restart the panel.
 */
export const PANEL_WHOLE_CODE = "panel_whole";
/** The facts that, after the panel's latest waiting fact, mean the panel is not the sweep's to resume: the panel is whole again (or the driver stopped, or the build refused). */
export const PANEL_PROGRESS_KINDS: readonly string[] = Object.freeze(["build_refused", "stopped"]);

export const PARKED_STAGE_REGISTRY: Readonly<Partial<Record<WaitingStage, ParkedStageEntry>>> = Object.freeze({
  // The gate part (stages, approval, Spec, run keys) is @fx/core's BUILD_STAGE_GATE: the build card's "starts by itself" sentence reads the same one.
  build: {
    stage: "build",
    ...BUILD_STAGE_GATE,
    pauses: RESERVATION_PAUSE_REASONS,
    role: "executor",
    respec: false,
    nextAttempt: nextAfterHighest,
    pauseForDenial,
  },
  // D#483 S5-k1c: the starts before the build. Each parks at the item stages the position table lists for it, under the approval that started the workflow.
  classify: {
    stage: "classify",
    itemStages: WAITING_STAGE_POSITIONS.classify,
    pauses: RESERVATION_PAUSE_REASONS,
    role: PM_ROLE,
    approval: { kind: "advance_work_item", from: "self" },
    needsSpec: false,
    respec: false,
    runKeyLikes: (workItemId, actionId) => stageKeyLikes("classify", workItemId, actionId),
    nextAttempt: nextAfterHighest,
    pauseForDenial,
  },
  // The first Spec: the panel's Spec PM (the item is Discussing) or the short Spec for a small, bug or doc item (Triaged, discussed, no Spec yet).
  spec: {
    stage: "spec",
    itemStages: WAITING_STAGE_POSITIONS.spec,
    pauses: RESERVATION_PAUSE_REASONS,
    role: PM_ROLE,
    approval: { kind: "advance_work_item", from: "origin" },
    needsSpec: false,
    respec: false,
    runKeyLikes: (workItemId, actionId) => stageKeyLikes("spec", workItemId, actionId),
    nextAttempt: nextAfterHighest,
    pauseForDenial,
  },
  respec: {
    stage: "respec",
    itemStages: WAITING_STAGE_POSITIONS.respec,
    pauses: RESERVATION_PAUSE_REASONS,
    role: PM_ROLE,
    approval: { kind: "respec_work_item", from: "self" },
    needsSpec: true,
    respec: true,
    runKeyLikes: (workItemId, actionId) => stageKeyLikes("respec", workItemId, actionId),
    nextAttempt: nextAfterHighest,
    pauseForDenial,
  },
  // D#483 S5-k1d: the reviewers and the fix round of an open change. Both park at the item stages the position table lists, under the approval that started the
  // workflow, and only for the head the wait was for. The restart is the same workflow again: it finds the reviewer runs that started by their keys and asks for the rest.
  review: {
    stage: "review",
    itemStages: WAITING_STAGE_POSITIONS.review,
    pauses: RESERVATION_PAUSE_REASONS,
    role: "code-reviewer",
    approval: { kind: "advance_work_item", from: "self" },
    needsSpec: true,
    respec: false,
    headBound: true,
    startedRunsOk: true,
    progressKinds: REVIEW_PROGRESS_KINDS,
    runKeyLikes: (workItemId, _actionId, headSha) => reviewKeyLikes(workItemId, headSha ?? null),
    nextAttempt: nextAfterHighest,
    pauseForDenial,
  },
  fix_round: {
    stage: "fix_round",
    itemStages: WAITING_STAGE_POSITIONS.fix_round,
    pauses: RESERVATION_PAUSE_REASONS,
    role: "executor",
    approval: { kind: "advance_work_item", from: "self" },
    needsSpec: true,
    respec: false,
    headBound: true,
    progressKinds: REVIEW_PROGRESS_KINDS,
    runKeyLikes: (workItemId, actionId, headSha) => fixKeyLikes(workItemId, headSha ?? null, actionId),
    nextAttempt: nextAfterHighest,
    pauseForDenial,
  },
  // D#483 S5-k1e: the panel's seats. The item parks at Discussing under the approval that started the workflow (which may sit on the card the pipeline's own card replaced,
  // as the first Spec's does). Seats that posted have finished runs beside the denied ones, so runs that really started are expected; the restart is the same workflow
  // again, which follows the posted seats by their keys and asks again only for the seats a limit denied. The seat the sweep's headroom check meets is the technical
  // architect's, which sits on every panel; the workflow's own whole-round check then covers the rest.
  panel: {
    stage: "panel",
    itemStages: WAITING_STAGE_POSITIONS.panel,
    pauses: RESERVATION_PAUSE_REASONS,
    role: "technical-architect",
    approval: { kind: "advance_work_item", from: "origin" },
    needsSpec: false,
    respec: false,
    startedRunsOk: true,
    attemptAfterFacts: true,
    progressKinds: PANEL_PROGRESS_KINDS,
    runKeyLikes: (workItemId) => panelKeyLikes(workItemId),
    nextAttempt: nextPanelAttempt,
    pauseForDenial,
  },
});

/** The stages that wait on a limit but are not parked yet: they keep today's refusal after the wait. Every stage is registered now, so the list is empty (a test holds it so). */
export const UNREGISTERED_STAGES: readonly WaitingStage[] = Object.freeze([] as WaitingStage[]);

/** The registered stages, in the order of the closed list. */
export const registeredStages = (registry: Readonly<Partial<Record<WaitingStage, ParkedStageEntry>>> = PARKED_STAGE_REGISTRY): ParkedStageEntry[] =>
  WAITING_STAGES.flatMap((s) => (registry[s] ? [registry[s] as ParkedStageEntry] : []));
