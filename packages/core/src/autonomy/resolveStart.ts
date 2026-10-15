import { PRESETS, decide, getCatalogueEntry } from "@fx/decisions";
import type { DecisionClass, PresetName } from "@fx/decisions";

/**
 * D#483 S5-a: whether a proposal may start work without a person's click, as a pure function.
 *
 * Pure and total: no clock, no I/O, no database, HTTP or model client. This module imports `@fx/decisions` and its own siblings and
 * nothing else (`test/autonomy-imports.test.ts` pins that). Callers read the facts (owner process, provenance, verification,
 * category, preset, install state) and pass them in; this file only applies the rules, in order, and then asks D#7's `decide()`.
 *
 * The hard rules come first and no dial can move them. A person's own Approve click is not an input here: it bypasses this
 * resolver entirely, because the click is the trust boundary.
 */

/** The seven values triage can produce (`TRIAGE_CATEGORIES` in `@fx/pipeline`; `test/autonomy-start.test.ts` pins the two lists together). */
export const START_CATEGORIES = ["critical", "feature", "small", "bug", "doc", "question", "project"] as const;
export type StartCategory = (typeof START_CATEGORIES)[number];

export type StartProvenance = "internal" | "external";
export type StartOwnerProcess = "product" | "internal_loop";
/** The proposal's verifier state (D#483 S4-a). Only `verified` and `partly_verified` count as checked. */
export type StartVerification = "pending" | "verified" | "partly_verified" | "refuted" | "not_checked" | "check_failed";

export type StartOutcomeKind = "act" | "announce" | "ask" | "refused";

/**
 * Why the resolver answered as it did. `dial` is the answer of the person's own D#7 dial; `parent_first_start` is the
 * always-asked first start of a feature, project or critical item; every other value is a hard rule.
 *
 * `free_preview` is new: S3 names `no_write_install` for the missing write App, and main has no reason for an account that is
 * still on the free preview, so this module names it.
 */
export const START_REASONS = [
  "owned_by_internal_loop",
  "engine_loop_repo",
  "external_needs_approval",
  "not_checked",
  "category_unknown",
  "free_preview",
  "no_write_install",
  "parent_first_start",
  "dial",
] as const;
export type StartReason = (typeof START_REASONS)[number];

export interface StartInput {
  preset: PresetName;
  ownerProcess: StartOwnerProcess;
  /** The repo's default branch holds the engine loop's project file (the same fact `decideOwnerProcess` reads). */
  engineLoopRepo: boolean;
  provenance: StartProvenance;
  verification: StartVerification;
  /** The classifier's category, or null when the item has none yet. */
  category: StartCategory | null;
  /** The account is on the free preview. */
  freePreview: boolean;
  /** The repo has an active write (`team`) App install. */
  hasWriteInstall: boolean;
}

export interface StartDecision {
  outcome: StartOutcomeKind;
  reason: StartReason;
  /** The catalogue entry the outcome came from; null when a hard rule answered before the catalogue was read. */
  decisionType: string | null;
  /** The entry's class, for the receipt; null when `decisionType` is null. */
  decisionClass: DecisionClass | null;
}

const hardRule = (outcome: "ask" | "refused", reason: StartReason): StartDecision => ({ outcome, reason, decisionType: null, decisionClass: null });

const SMALL_KINDS = new Set<string>(["small", "bug", "doc"]);
const PARENT_KINDS = new Set<string>(["feature", "project", "critical"]);
const PRESET_NAMES: readonly string[] = PRESETS.map((p) => p.name);

/** True for the two verifier states that count as checked. */
export function isCheckedVerification(verification: string): boolean {
  return verification === "verified" || verification === "partly_verified";
}

/**
 * The hard rules 1 to 3, shared with `resolveSubItemLaunch`, which applies them to the parent. Null when none applies.
 * A provenance other than `internal` is treated as external (fail closed).
 */
export function checkOwnershipAndTrust(input: Pick<StartInput, "ownerProcess" | "engineLoopRepo" | "provenance">): StartDecision | null {
  if (input.ownerProcess !== "product") return hardRule("refused", "owned_by_internal_loop");
  if (input.engineLoopRepo !== false) return hardRule("ask", "engine_loop_repo");
  if (input.provenance !== "internal") return hardRule("ask", "external_needs_approval");
  return null;
}

/** Resolves one dial: the catalogue entry named `decisionType` under the preset. An unknown preset or entry asks. */
export function resolveDial(decisionType: string, preset: PresetName, reason: StartReason): StartDecision {
  const entry = getCatalogueEntry(decisionType);
  if (entry === undefined || !PRESET_NAMES.includes(preset)) {
    return { outcome: "ask", reason, decisionType: null, decisionClass: null };
  }
  const resolved = decide(entry, { preset }, { type: decisionType, options: ["start", "wait"], proposed: "start", rationale: "start gate" });
  return { outcome: resolved.disposition, reason, decisionType, decisionClass: resolved.class };
}

/** Rules 1 to 7 of D#483 S5-a, in this order. */
export function resolveStart(input: StartInput): StartDecision {
  const trust = checkOwnershipAndTrust(input);
  if (trust !== null) return trust;
  if (!isCheckedVerification(input.verification)) return hardRule("ask", "not_checked");
  const category = input.category;
  if (category === null || category === "question" || !(START_CATEGORIES as readonly string[]).includes(category)) {
    return hardRule("ask", "category_unknown");
  }
  if (input.freePreview !== false) return hardRule("refused", "free_preview");
  if (input.hasWriteInstall !== true) return hardRule("refused", "no_write_install");
  if (SMALL_KINDS.has(category)) return resolveDial(`start_work_${category}`, input.preset, "dial");
  if (PARENT_KINDS.has(category)) return resolveDial("start_parent_item", input.preset, "parent_first_start");
  return hardRule("ask", "category_unknown");
}
