import type { RepoPermission } from "@fx/trust";

/**
 * D#483 S3, M0 rule E6: which process owns an item, product (fulcrumaxe) or internal_loop (the repo's own development
 * loop). One function, so every place that assigns an owner gives the same answer. An item is never both.
 *
 * The default is the repo's: when its default branch holds `.autonomous-team/project.json` (the engine loop is installed),
 * every item is `internal_loop`. The one exception is an issue carrying the label `fulcrumaxe:product`, and only when the
 * label was applied by an actor whose real repository permission is maintain or admin (the reader's labelled-event check
 * establishes who applied it; a label applied by anyone with less, or by someone unknown, is ignored). In S3, Discussions and
 * tasks always follow the repo default. Without the engine loop, everything is `product`.
 */
export const PRODUCT_LABEL = "fulcrumaxe:product";

export type OwnerProcess = "product" | "internal_loop";

export interface OwnerInput {
  /** The default branch holds `.autonomous-team/project.json`. */
  repoHasEngineLoop: boolean;
  kind: "task" | "discussion" | "issue";
  /** For an issue: its labels, each with who applied it and that actor's permission now (null when not established). */
  labels?: ReadonlyArray<{ name: string; actorPermission: RepoPermission | null }>;
}

export function decideOwnerProcess(input: OwnerInput): OwnerProcess {
  if (!input.repoHasEngineLoop) return "product";
  if (input.kind !== "issue") return "internal_loop";
  const trusted = (input.labels ?? []).some((l) => l.name === PRODUCT_LABEL && (l.actorPermission === "maintain" || l.actorPermission === "admin"));
  return trusted ? "product" : "internal_loop";
}
