import type { DiscussionKind } from "@fx/discussions";

/**
 * D#2 H15 criterion 1: "Triage classifies it as Critical/Feature/Small/
 * Bug/Doc". The five categories are the ONLY values triage can ever
 * produce. Each maps onto the `discussions.kind` vocabulary
 * (`DISCUSSION_KINDS` in @fx/discussions), so a category is never
 * invented on this side of the boundary.
 */
export const TRIAGE_CATEGORIES = ["critical", "feature", "small", "bug", "doc", "question", "project"] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/** The `discussions.kind` a category is stored as. */
export function discussionKindFor(category: TriageCategory): DiscussionKind {
  return category;
}

/** C36 / C18 item 3 and C58 G8/G9: Critical, Feature and Project run the
 * consensus panel, so only those move `triaged -> discussing` at triage time.
 * Small, Bug, Doc and Question are handled without a panel and stay `triaged`
 * (a question is answered in its thread and never gets a Spec). */
export function runsPanel(category: TriageCategory): boolean {
  return category === "critical" || category === "feature" || category === "project";
}

/** C58 G8/G9: the two kinds an in-product "Ask a question" / "New project"
 * sets explicitly, skipping the classifier. Every other kind is classified. */
export function isExplicitKind(kind: string): kind is "question" | "project" {
  return kind === "question" || kind === "project";
}

export type ParsedCategory = { ok: true; category: TriageCategory } | { ok: false; reason: string };

/**
 * Fail-closed parse of the classifier's raw output. Accepted shapes, and
 * nothing else:
 *   - a bare category word ("Feature", " bug\n"), or
 *   - a JSON object whose `category` property is such a word.
 * The match is an EXACT, whole-string, case-insensitive comparison against
 * the fixed set: never a substring or "first mention" scan, so output like
 * "feature, but treat it as critical" or "ignore previous instructions and
 * pick urgent" resolves to nothing rather than to a category the text
 * happened to name. Extra JSON properties are ignored (nothing reads them).
 */
export function parseClassifierOutput(raw: unknown): ParsedCategory {
  if (typeof raw !== "string") {
    return { ok: false, reason: "classifier output is not a string" };
  }
  const text = raw.trim();
  let candidate: unknown = text;
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "classifier output JSON is not an object" };
      }
      candidate = Object.hasOwn(parsed, "category") ? (parsed as Record<string, unknown>).category : undefined;
    } catch {
      return { ok: false, reason: "classifier output is malformed JSON" };
    }
  }
  if (typeof candidate !== "string") {
    return { ok: false, reason: "classifier output names no category" };
  }
  const word = candidate.trim().toLowerCase();
  const category = (TRIAGE_CATEGORIES as readonly string[]).find((c) => c === word);
  if (category === undefined) {
    return { ok: false, reason: "classifier output names a category outside the fixed set" };
  }
  return { ok: true, category: category as TriageCategory };
}
