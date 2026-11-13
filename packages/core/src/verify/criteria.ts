/**
 * D#749: which acceptance criteria the post-merge check puts in front of a browser.
 *
 * A browser tester can only act on what a person can see. A criterion such as "`repoLabel({full_name:...})` is `"acme/widgets"`" has no page to open, so the
 * tester could only mark it `blocked`, and a correct change could never be verified. Those criteria are already covered by the check, the reviewers and the
 * acceptance tester; the verify stage keeps the browser for the visible ones.
 *
 * The rule is deterministic and uses no model (R-597-1). In order, the first that applies decides:
 *   1. A tag at the start of the criterion: `[ui]` (also `[visible]`, `[browser]`) is visible and overrides everything below. `[code]` is code when it holds a backticked identifier and the prose
 *      around the backticks names no person acting (rule 2); otherwise only where rules 2 to 4 would not find the criterion visible (a person acting, a screen
 *      element or a display verb keep it visible). The Spec writer emits the tags.
 *   2. A person acting: "a person / the user / someone ... sees | clicks | opens | selects | types ..." is visible, whatever else it names.
 *   3. A code lead: the sentence opens on a backticked identifier (optionally "the `x` function") followed by returns / is / throws / equals ... is code, UNLESS it names a
 *      visible surface (page, screen, button, picker, option, label ...). "`pickRepoId` returns the id of the picker's selected option" therefore stays code only when it
 *      names no surface; when it does it is visible.
 *   4. A visible surface word (page, screen, button, card, picker, option, label, link, dialog, toast, select, heading ...) is visible.
 *   5. A code-only subject (a file path, function, type, SQL, migration, test, status code, endpoint) is code.
 *   6. Anything else is VISIBLE. The cost of a wrong guess is not symmetric: calling a visible criterion `code` silently skips a UI check, while calling a code criterion
 *      `visible` only lets the tester answer `blocked` (the row then ends `unverified`, and a person looks).
 */
export const CRITERION_KINDS = ['visible', 'code'] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

export interface ClassifiedCriterion {
  /** 1-based position in the Spec, which is also the number the journey id carries (`c<n>`). */
  n: number;
  kind: CriterionKind;
  /** The criterion with a leading tag removed. */
  text: string;
  /** What decided: the tag, or which rule. For tests and for reading; never shown as free text. */
  by: 'tag' | 'person' | 'code_lead' | 'surface' | 'code_subject' | 'default';
}

const TAG_RE = /^\s*(?:\*\*|__)?\[\s*(ui|visible|browser|code)\s*\](?:\*\*|__)?[\s:.\-–—]*/i;

const VISIBLE_SURFACES = [
  'page', 'pages', 'screen', 'screens', 'button', 'buttons', 'card', 'cards', 'picker', 'pickers', 'option', 'options', 'label', 'labels', 'link', 'links',
  'dialog', 'dialogs', 'modal', 'toast', 'banner', 'menu', 'tab', 'tabs', 'form', 'dropdown', 'select', 'checkbox', 'toggle', 'heading', 'headline', 'tooltip',
  'sidebar', 'navigation', 'panel', 'badge', 'placeholder', 'visible', 'displayed', 'shown', 'onscreen', 'on-screen', 'ui', 'dashboard',
  'text reads', 'wording', 'shows?', 'appears?', 'displays?', 'lists', 'reads',
];
const SURFACE_RE = new RegExp(`\\b(?:${VISIBLE_SURFACES.map((w) => w.replace(/[-\s]/g, '[-\\s]')).join('|')})\\b`, 'i');
const PERSON_RE = /\b(?:a|the|any)?\s*(?:person|people|user|users|member|owner|admin|customer|visitor|someone|one)\s+(?:\w+\s+){0,2}?(?:sees?|clicks?|opens?|selects?|types?|taps?|navigates?|reads?|chooses?|picks?|presses?|views?|visits?|enters?)\b|\b(?:on\s+reload|after\s+a\s+reload|after\s+reloading)\b/i;

const CODE_VERBS = 'returns?|is|are|throws?|equals?|resolves|rejects|yields|gives|refuses|keeps|maps|parses|accepts|has|have|does|do|never|always|calls?|reads?|writes?|takes?|produces?|uses?|rejects|passes|fails|exports?|lists?|handles?|treats?|counts?';
const CODE_LEAD_RE = new RegExp(
  `^(?:the\\s+|a\\s+|an\\s+)?(?:\\w+\\s+)?\`[^\`]+\`(?:\\s+(?:function|helper|method|type|column|table|endpoint|route|module|file|constant|field|value|query|migration))?(?:\\s+\\w+){0,2}?\\s+(?:${CODE_VERBS})\\b`,
  'i',
);
const CODE_SUBJECT_RE = /(?:\b[\w./-]+\.(?:ts|tsx|js|mjs|json|sql|md|yml|yaml|sh|css)\b|\b(?:function|helper|method|type|interface|sql|migration|column|table|index|constraint|trigger|schema|endpoint|route|api|status\s+(?:code\s+)?\d{3}|http\s+\d{3}|\d{3}\s+(?:response|status)|typecheck|type-check|lint|unit\s+tests?|tests?|vitest|pnpm|script|payload|json|header|env(?:ironment)?\s+var(?:iable)?|constant|export|import|module|package|openapi|error\s+code|code\s+path|query|transaction|rls|policy|grant)\b)/i;

/** Classifies one criterion's text (already cleaned by `parseSpecCriteria`). */
export function classifyCriterion(raw: string): { kind: CriterionKind; text: string; by: ClassifiedCriterion['by'] } {
  const tag = TAG_RE.exec(raw);
  if (tag === null) return untagged(raw.trim());
  const text = raw.slice(tag[0].length).trim();
  if (tag[1]!.toLowerCase() !== 'code') return { kind: 'visible', text, by: 'tag' };
  // `[code]` is a claim that no page is involved, so it never hides a criterion the rule finds visible (a person acting, a screen element or a display verb).
  // A `[code]` criterion that names a backticked identifier is about the code, whatever screen word its prose also uses ("the Roles tab labels come from
  // `repoLabel`"); a browser can only answer `blocked` for it, so it stays code. A person acting in the prose still makes it visible.
  if (/`[^`]+`/.test(text) && !PERSON_RE.test(text.replace(/`[^`]*`/g, ' '))) return { kind: 'code', text, by: 'tag' };
  const rule = untagged(text);
  return rule.kind === 'visible' && rule.by !== 'default' ? rule : { kind: 'code', text, by: 'tag' };
}

function untagged(text: string): { kind: CriterionKind; text: string; by: ClassifiedCriterion['by'] } {
  // Backticked spans are code, whatever words they hold: only the prose around them counts as naming a surface.
  const prose = text.replace(/`[^`]*`/g, ' ');
  if (PERSON_RE.test(prose)) return { kind: 'visible', text, by: 'person' };
  if (CODE_LEAD_RE.test(text)) {
    return SURFACE_RE.test(prose) ? { kind: 'visible', text, by: 'surface' } : { kind: 'code', text, by: 'code_lead' };
  }
  if (SURFACE_RE.test(prose)) return { kind: 'visible', text, by: 'surface' };
  if (CODE_SUBJECT_RE.test(text)) return { kind: 'code', text, by: 'code_subject' };
  return { kind: 'visible', text, by: 'default' };
}

/** Every criterion, in order, with its 1-based number. */
export function classifyCriteria(criteria: readonly string[]): ClassifiedCriterion[] {
  return criteria.map((c, i) => ({ n: i + 1, ...classifyCriterion(c) }));
}

/** The instruction the Spec writers' prompts carry so each numbered criterion says who checks it. A criterion with no tag is sorted by the rule above. */
export const CRITERION_TAG_RULES =
  'Start every numbered acceptance criterion with a tag: "[ui]" when a person can check it in the running app by opening a page and looking or clicking (a screen, button, picker, option text, label, link, dialog or message), or "[code]" when only code, a test, a database, a build step or an API status can show it (a function\'s return value, a type, a file, SQL, a migration). Example: "1. [ui] The Autonomy picker lists exactly: Ask me, Auto." and "2. [code] `repoLabel({full_name: \\"acme/widgets\\"})` is `\\"acme/widgets\\"`." After the merge only the [ui] criteria are checked in a browser; the [code] ones are covered by the tests and reviews.';
