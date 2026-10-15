import type { PresetName } from "@fx/decisions";
import { checkOwnershipAndTrust, resolveDial, resolveStart } from "./resolveStart.js";
import type { StartCategory, StartDecision, StartInput, StartOwnerProcess, StartProvenance } from "./resolveStart.js";

/**
 * D#483 S5-a (owner ruling OQ-2): whether a sub-item of an approved parent may launch without a click, as a pure function.
 *
 * Same rules as `resolveStart`: no clock, no I/O, and only `@fx/decisions` and sibling imports. The guardrails come first and no
 * dial can move them; only then does the class-2 `launch_sub_item` dial decide. A sub-item never widens scope, never passes the
 * parent's envelope, and never launches under a Spec version a person has not approved.
 */

/** What is being launched. A planned PR or task has a key in the parent's approved Spec; a fix round and a follow-up child have none. */
export const SUB_ITEM_KINDS = ["planned_pr", "task", "fix_round", "follow_up_child"] as const;
export type SubItemKind = (typeof SUB_ITEM_KINDS)[number];

export const SUB_ITEM_REASONS = [
  "parent_not_approved",
  "respec_needs_approval",
  "spec_version_unknown",
  "spec_keys_unknown",
  "sub_item_kind_unknown",
  "sub_item_widens_scope",
  "parent_envelope_reached",
  "owned_by_internal_loop",
  "engine_loop_repo",
  "external_needs_approval",
  "dial",
] as const;
export type SubItemReason = (typeof SUB_ITEM_REASONS)[number];

/**
 * `ask`, `announce` and `act` come from the guardrails or the dial. `wait` is the envelope guardrail: not a question for the
 * person, a stop until the envelope has room. `new_item` means the sub-item is not a sub-item at all: handle it as a new item,
 * and `asNewItem` is the answer `resolveStart` gives for it, so a caller never decides that itself.
 */
export type SubItemOutcomeKind = "act" | "announce" | "ask" | "wait" | "refused" | "new_item";

export interface SubItemDecision {
  outcome: SubItemOutcomeKind;
  reason: SubItemReason;
  decisionType: string | null;
  decisionClass: StartDecision["decisionClass"];
  /** Set only when `outcome` is `new_item`. */
  asNewItem: StartDecision | null;
}

export interface SubItemInput {
  preset: PresetName;
  parent: {
    ownerProcess: StartOwnerProcess;
    engineLoopRepo: boolean;
    provenance: StartProvenance;
    /** A person's approval record exists for the parent (`work_item_approvals`). */
    hasPersonApproval: boolean;
    /** The Spec version the parent's latest approval names, or null. */
    approvedSpecVersion: number | null;
    /** The parent's current Spec version, or null when it has none. */
    currentSpecVersion: number | null;
    /** What is left of the parent's envelope, in USD. */
    envelopeRemainingUsd: number;
  };
  sub: {
    kind: SubItemKind;
    /** The planned PR or task key. Null for a fix round or a follow-up child. */
    key: string | null;
    /** The triage category of a follow-up child; null before triage. */
    category: StartCategory | null;
  };
  /** The planned PR and task keys listed in the approved Spec version. */
  approvedSpecKeys: readonly string[];
  /** The reservation the sub-item's first run would make, in USD. */
  firstRunReservationUsd: number;
  /** What `resolveStart` needs to describe the sub-item as a new item, when it turns out to be one. */
  asNewItem: Pick<StartInput, "verification" | "freePreview" | "hasWriteInstall">;
}

const stop = (outcome: "ask" | "wait" | "refused", reason: SubItemReason): SubItemDecision => ({
  outcome,
  reason,
  decisionType: null,
  decisionClass: null,
  asNewItem: null,
});

const SMALL_CHILD_CATEGORIES = new Set<string>(["small", "bug", "doc"]);
const isVersion = (v: number | null): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function widensScope(input: SubItemInput): boolean {
  const { sub } = input;
  if (sub.kind === "fix_round") return false;
  if (sub.kind === "follow_up_child") return sub.category === null || !SMALL_CHILD_CATEGORIES.has(sub.category);
  return sub.key === null || sub.key === "" || !input.approvedSpecKeys.includes(sub.key);
}

/** The guardrails and then the dial, in the order D#483 S5-a states them. */
export function resolveSubItemLaunch(input: SubItemInput): SubItemDecision {
  const { parent } = input;
  if (parent.hasPersonApproval !== true) return stop("ask", "parent_not_approved");
  if (!isVersion(parent.approvedSpecVersion) || !isVersion(parent.currentSpecVersion)) return stop("ask", "spec_version_unknown");
  if (parent.approvedSpecVersion !== parent.currentSpecVersion) return stop("ask", "respec_needs_approval");
  if (!(SUB_ITEM_KINDS as readonly string[]).includes(input.sub?.kind)) return stop("ask", "sub_item_kind_unknown");
  if (!Array.isArray(input.approvedSpecKeys)) return stop("ask", "spec_keys_unknown");

  if (widensScope(input)) {
    const asNewItem = resolveStart({
      preset: input.preset,
      ownerProcess: parent.ownerProcess,
      engineLoopRepo: parent.engineLoopRepo,
      provenance: parent.provenance,
      verification: input.asNewItem.verification,
      category: input.sub.category,
      freePreview: input.asNewItem.freePreview,
      hasWriteInstall: input.asNewItem.hasWriteInstall,
    });
    return { outcome: "new_item", reason: "sub_item_widens_scope", decisionType: null, decisionClass: null, asNewItem };
  }

  const remaining = parent.envelopeRemainingUsd;
  const need = input.firstRunReservationUsd;
  if (!Number.isFinite(remaining) || !Number.isFinite(need) || need < 0 || remaining < need) {
    return stop("wait", "parent_envelope_reached");
  }

  const trust = checkOwnershipAndTrust(parent);
  if (trust !== null) return stop(trust.outcome === "refused" ? "refused" : "ask", trust.reason as SubItemReason);

  const dial = resolveDial("launch_sub_item", input.preset, "dial");
  return { outcome: dial.outcome === "refused" ? "ask" : dial.outcome, reason: "dial", decisionType: dial.decisionType, decisionClass: dial.decisionClass, asNewItem: null };
}
