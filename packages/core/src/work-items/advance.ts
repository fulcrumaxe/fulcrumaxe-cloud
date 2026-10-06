/**
 * D#483: the ONE table of the stages the stage driver can advance from, what advancing does there, and what must be true
 * of the item first. The approve route (@fx/api), the worker's perform and the workflow's load (apps/web) all ask this
 * file; none keeps a list of its own. Reviews and the merge gate (P3) are rows of this table too.
 *
 * Pure: facts in, a verdict out. The callers read the facts from the database (the route and the worker in SQL, the
 * workflow through the worker's `advanceLoadItem`).
 *
 * A stage listed here is necessary, not sufficient: `advanceActionFor` also looks at the facts.
 */

/**
 * What advancing does. `triage`: classify and triage. `spec`: the panel and the Spec, for an item the pipeline already
 * discussed. `light_spec`: the project manager's short Spec for a small, bug or doc item (no panel). `build`: the executor on the published Spec. `rebuild`: the same build, started again for an item
 * that stopped at Needs a person (a person pressed Build again; a fresh run, and a pull request still open for the branch is never replaced). `review`: the reviewers on the pull request's head, fix rounds
 * and the merge gate. `check_build`: a build that finished while nobody was driving it; look for its pull request (found: the
 * review; none: Needs human).
 */
export type AdvanceAction = 'triage' | 'light_spec' | 'spec' | 'build' | 'rebuild' | 'check_build' | 'review';

/** Discussion kinds that have a panel and a Spec written by it. Mirrors the pipeline's runSpecStep (a test in packages/pipeline pins it). */
export const ADVANCE_PANEL_KINDS = ['critical', 'feature'] as const;

/** Discussion kinds that run no panel: the project manager writes a short Spec from the issue. Mirrors the pipeline's LIGHT_SPEC_CATEGORIES (a test in packages/pipeline pins it). */
export const ADVANCE_LIGHT_KINDS = ['small', 'bug', 'doc'] as const;

/** Discussion kinds whose Spec is never built (a question is answered, a project is planned). Mirrors @fx/discussions' isBuildableKind (a test in packages/api pins it). */
export const ADVANCE_NON_BUILDABLE_KINDS = ['question', 'project'] as const;

/** What the table needs to know about an item. */
export interface AdvanceFacts {
  stage: string;
  /** The item's discussion, or null when the pipeline has not discussed it. */
  discussion_id: string | null;
  /** The discussion's kind, or null. */
  kind: string | null;
  /** A published (not erased) Spec exists. */
  has_spec: boolean;
}

interface StageRule {
  /** What advancing does; may depend on the facts (a triaged item the pipeline already discussed is a different job from one it has not). */
  action: AdvanceAction | ((facts: AdvanceFacts) => AdvanceAction);
  /** Null when the item is in the state this stage needs; otherwise why not (a fixed phrase). */
  unmet(facts: AdvanceFacts): string | null;
}

const isLight = (f: AdvanceFacts): boolean => f.kind !== null && (ADVANCE_LIGHT_KINDS as readonly string[]).includes(f.kind) && !f.has_spec;

/** The stages at which a pull request exists and the reviewers, the fix rounds or the merge gate come next. */
const reviewRule: StageRule = { action: 'review', unmet: (f) => (f.has_spec ? null : 'work item has no published Spec to review against') };

/** What a build needs: a published Spec of a kind that is built, behind a discussion. Shared by the Spec ready build and the Needs-a-person build again. */
const buildUnmet = (f: AdvanceFacts): string | null => {
  if (f.discussion_id === null || !f.has_spec) return 'work item has no published Spec';
  if (f.kind === null || (ADVANCE_NON_BUILDABLE_KINDS as readonly string[]).includes(f.kind)) return `a ${f.kind ?? 'work item'} Spec is not built`;
  return null;
};

const RULES: Readonly<Record<string, StageRule>> = Object.freeze({
  // The pipeline has not discussed it yet: the driver triages it (and, for a panel kind, discusses and writes the Spec).
  // Or, when it already did and the kind has no panel (small, bug, doc) and there is no Spec yet: the short Spec again. That is how
  // a request the project manager judged not feasible, or a short-Spec step that failed, is tried again after the issue was edited.
  triaged: {
    action: (f) => (f.discussion_id !== null && isLight(f) ? 'light_spec' : 'triage'),
    unmet: (f) => (f.discussion_id === null || isLight(f) ? null : 'work item is already triaged'),
  },
  // Discussed by the pipeline but no Spec yet: a panel or a Spec step that failed (or was cut short) leaves the item
  // here, and approving it again runs the panel and the Spec once more. Only a kind with a panel qualifies. An item
  // CAN also be here with a Spec: "Back to discussion" moves a Needs-a-person item here on purpose, for a new panel and
  // a new Spec version that supersedes the old one. So a Spec already existing is not a reason to refuse.
  discussing: {
    action: 'spec',
    unmet: (f) => {
      if (f.discussion_id === null) return 'work item has no discussion';
      if (f.kind === null || !(ADVANCE_PANEL_KINDS as readonly string[]).includes(f.kind)) return `a ${f.kind ?? 'work item'} has no panel`;
      return null;
    },
  },
  // A published Spec of a kind that is built: the driver builds it.
  spec_ready: { action: 'build', unmet: buildUnmet },
  // In progress with no run live: the build ended (or its workflow was lost) and nobody recorded what came of it. The driver
  // looks for the executor's pull request: found, the review follows; none, the item goes to Needs human. The route and the
  // worker refuse it while a run is live, so this never races a build that is still going.
  in_progress: { action: 'check_build', unmet: (f) => (f.has_spec ? null : 'work item has no published Spec to review against') },
  // A pull request is open: reviews, fix rounds and the merge gate. Re-approving after a stop re-enters at the PR's
  // current head, and the keyed reviewer runs make that free when they already exist.
  pr_opened: reviewRule,
  changes_requested: reviewRule,
  review_passed: reviewRule,
  // Stopped at Needs a person (the build ended without a pull request, or the review handed it over) and the Spec is
  // still published: "Build again" starts a fresh build from the same Spec, like a spec_ready build.
  needs_human: { action: 'rebuild', unmet: buildUnmet },
});

/** The stages the driver can advance from, in pipeline order. Derived from the table, so there is no second list. */
export const ADVANCEABLE_STAGES: readonly string[] = Object.freeze(Object.keys(RULES));

export type AdvanceVerdict = { ok: true; action: AdvanceAction } | { ok: false; reason: 'stage' | 'state'; message: string };

/** Whether the item can be advanced now, and by what action; or why not. */
export function advanceActionFor(facts: AdvanceFacts): AdvanceVerdict {
  const rule = Object.hasOwn(RULES, facts.stage) ? RULES[facts.stage] : undefined;
  if (!rule) return { ok: false, reason: 'stage', message: `work item is ${facts.stage}` };
  const unmet = rule.unmet(facts);
  return unmet === null ? { ok: true, action: typeof rule.action === 'function' ? rule.action(facts) : rule.action } : { ok: false, reason: 'state', message: unmet };
}
