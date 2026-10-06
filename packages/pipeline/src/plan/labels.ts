import { TRIAGE_CATEGORIES, type TriageCategory } from "./categories.js";

/**
 * D#483 P1 (owner ruling 2026-10-03): triage uses the issue's GitHub labels, but only labels a TRUSTED actor applied.
 *
 *  - A label counts when its newest `labeled` event's actor is the issue's author (the caller passes `authorTrusted`
 *    only when the work item is internal, i.e. the intake already trusted that author) or an actor whose REAL
 *    repository permission, read now from GitHub, is admin or maintain. Anything else (an unknown actor, a write
 *    collaborator, a stranger) is ignored. Fail closed: no actor, no permission, no count.
 *  - An unambiguous trusted label DECIDES the category with no classify run (the fixed table below; matched
 *    case-insensitively on the whole name).
 *  - Any other trusted label is a HINT passed to the classifier, which still decides. A trusted label that asks for
 *    urgency (`critical`, `urgent`, ...) also stops a decisive label from deciding alone: the classifier sees both.
 *  - Two decisive labels that disagree (bug + documentation) fall back to the classifier with both as hints.
 */
export const DECISIVE_LABELS: Readonly<Record<string, TriageCategory>> = Object.freeze({
  bug: "bug",
  documentation: "doc",
  docs: "doc",
  question: "question",
});

/** Trusted labels that make a decisive label undecided: the classifier must weigh them. */
export const ESCALATING_LABELS: readonly string[] = ["critical", "urgent", "blocker", "security"];

/** How many hint labels reach the prompt, and how long each may be. Label names are third-party text. */
export const MAX_HINT_LABELS = 8;
export const MAX_HINT_LABEL_CHARS = 50;

/** What the GitHub reader reports for one current label. */
export interface LabelFact {
  name: string;
  actorLogin: string | null;
  actorPermission: string | null;
}

export interface LabelDecision {
  /** Set when a decisive trusted label decided the category: no classify run. */
  decided: TriageCategory | null;
  /** The label (as written on the issue) that decided it. */
  because: string | null;
  /** Trusted labels the classifier should weigh, capped and cut. Empty when the label decided. */
  hints: string[];
}

export function isTrustedLabel(label: LabelFact, issueAuthor: string, authorTrusted: boolean): boolean {
  if (label.actorLogin === null || label.actorLogin.length === 0) return false;
  if (authorTrusted && issueAuthor.length > 0 && label.actorLogin.toLowerCase() === issueAuthor.toLowerCase()) return true;
  return label.actorPermission === "admin" || label.actorPermission === "maintain";
}

export function decideFromLabels(labels: readonly LabelFact[], issueAuthor: string, authorTrusted: boolean): LabelDecision {
  const trusted = labels.filter((l) => isTrustedLabel(l, issueAuthor, authorTrusted));
  const decisive = trusted.filter((l) => Object.hasOwn(DECISIVE_LABELS, l.name.toLowerCase()));
  const categories = new Set(decisive.map((l) => DECISIVE_LABELS[l.name.toLowerCase()]!));
  const escalating = trusted.some((l) => ESCALATING_LABELS.includes(l.name.toLowerCase()));
  if (categories.size === 1 && !escalating) {
    return { decided: [...categories][0]!, because: decisive[0]!.name, hints: [] };
  }
  return { decided: null, because: null, hints: trusted.slice(0, MAX_HINT_LABELS).map((l) => l.name.slice(0, MAX_HINT_LABEL_CHARS)) };
}

/** Every category a label can decide is a real category (a test pins it). */
export const DECIDABLE_CATEGORIES: readonly string[] = [...new Set(Object.values(DECISIVE_LABELS))].filter((c) => (TRIAGE_CATEGORIES as readonly string[]).includes(c));
