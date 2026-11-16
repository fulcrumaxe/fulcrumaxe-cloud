import { VERIFY_START_APPS } from './startApps.js';

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
  'Start every numbered acceptance criterion with a tag: "[ui]" when a person can check it in the running app by opening a page and looking or clicking (a screen, button, picker, option text, label, link, dialog or message), or "[code]" when only code, a test, a database, a build step or an API status can show it (a function\'s return value, a type, a file, SQL, a migration). Example: "1. [ui] The Autonomy picker lists exactly: Ask me, Auto." and "2. [code] `repoLabel({full_name: \\"acme/widgets\\"})` is `\\"acme/widgets\\"`." After the merge only the [ui] criteria are checked in a browser; the [code] ones are covered by the tests and reviews. A [ui] criterion describes what a person finds in the running app with the app\'s own real data, never a test fixture name, seed id or test file; when the thing to look at may be rare or old, say how to reach it (for example "an older run, reached with Show more"). Also put "[start: <app id>]" in a [ui] criterion that is checked in one app, naming the app the screen lives in (one of: ' + Object.keys(VERIFY_START_APPS).join(', ') + '), for example "1. [ui] [start: runs] A verifier run shows its role name in the run line." The post-merge tester opens that app first; without it the tester has only the desktop and may not find the screen. Name the app as it is now, not where the setting used to be.';

/**
 * D#749 VERIFY-RELOAD-ONLY-FOR-PERSISTED: whether a criterion claims a change that must survive a reload.
 *
 * `persisted` (the default) needs reload evidence to pass. `view_only` is a filter, sort, expand or collapse, or a plain reading of what the page shows: that state resets on a
 * reload on purpose, so a reload can never prove it. The closed vocabulary is `PERSISTENCE_KINDS`; any other value, or none, is read as `persisted` (`readPersistence`).
 * Deterministic, no model. A criterion is `view_only` only when it names a view-state word AND no word of a lasting change (save, create, send, delete, update, remain ...).
 */
export const PERSISTENCE_KINDS = ['persisted', 'view_only'] as const;
export type PersistenceKind = (typeof PERSISTENCE_KINDS)[number];

// A criterion is view-only only if it names one of these view actions (a positive requirement) ...
const VIEW_VERB_ROOTS = ['filter', 'sort', 'search', 'expand', 'collaps', 'group', 'narrow'];
// ... and no word of a lasting change or of stored or shared state, read on the WHOLE original text (a word in backticks, quotes or a label counts like any other).
// Words are lowercased, split on anything that is not a letter (and on camelCase), and matched by their root, so every inflection (-s, -es, -ed, -ing, -ion) is caught.
// A root that also starts an unrelated word only makes a criterion persisted, which is the safe direction.
const LASTING_ROOTS = [
  'sav', 'stor', 'persist', 'keep', 'kept', 'rememb', 'default', 'prefer', 'setting', 'config', 'record', 'creat', 'add', 'insert', 'remov', 'delet', 'updat', 'edit', 'chang',
  'set', 'enabl', 'disabl', 'toggl', 'submit', 'send', 'sent', 'appl', 'publish', 'approv', 'merg', 'assign', 'upload', 'refresh', 'sync', 'reset', 'restor', 'renam', 'mov',
  'archiv', 'retain', 'durabl', 'surviv', 'stay', 'still', 'rais', 'lower', 'increas', 'decreas', 'mark', 'make', 'made', 'turn', 'becom', 'pin', 'star', 'reload', 'remain',
  'permanent', 'url', 'link', 'share', 'histor', 'shortcut', 'admin', 'member', 'owner', 'everyone', 'everybody', 'visitor', 'team', 'notif', 'alert', 'email', 'reopen',   'import', 'export', 'copy', 'cache', 'cookie', 'session', 'account', 'profile', 'login', 'logout', 'sign', 'bookmark', 'favorit', 'follow',
  'subscrib', 'pay', 'bill', 'invit', 'grant', 'revok', 'deny', 'block', 'lock', 'tag', 'label', 'comment', 'reply', 'post', 'write', 'wrote', 'written', 'commit', 'push', 'deploy',
  'cancel', 'kill', 'clos', 'stop', 'purg', 'buy', 'bought', 'connect', 'retr', 'resolv', 'complet', 'vote', 'dismiss', 'reorder', 'rank', 'priorit', 'stick', 'held', 'hold', 'visit', 'across', 'hid', 'empt',
];
const LASTING_PHRASE_RE = /\b(?:next\s+time|from\s+now\s+on|come\s+back|came\s+back|every\s+(?:one|visitor|member|user)|for\s+the\s+team|after\s+(?:a\s+)?(?:page\s+)?reload|on\s+reload|the\s+same\s+as\s+before)\b/;

function wordsOf(text: string): string[] {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter((w) => w !== '');
}

// The action slots: a word ending in -ing, and the word straight after "and" or "then", must start with one of these view or read actions (or open a noun phrase from the closed set below).
// Any other action word there (cancel, close, buy, retry, connect ...) makes the criterion persisted, so an unlisted verb cannot ride along with a filter.
const VIEW_ACTION_ROOTS = ['choos', 'pick', 'select', 'press', 'click', 'tap', 'open', 'filter', 'sort', 'search', 'expand', 'collaps', 'group', 'show', 'narrow', 'scroll', 'typ', 'read', 'view'];
const NOUN_OPENERS = new Set(['the', 'a', 'an', 'every', 'each', 'that', 'this', 'these', 'those', 'no', 'both', 'all', 'only', 'any', 'its', 'their', 'role', 'roles', 'status', 'statuses', 'opaque']);
const startsWithAny = (w: string, roots: readonly string[]): boolean => roots.some((r) => w.startsWith(r));

function actionSlotsAreViewOnly(words: readonly string[]): boolean {
  return words.every((w, i) => {
    const afterJoin = i > 0 && (words[i - 1] === 'and' || words[i - 1] === 'then');
    if (w === 'and' || w === 'then' || !(w.endsWith('ing') || afterJoin)) return true;
    return startsWithAny(w, VIEW_ACTION_ROOTS) || (afterJoin && NOUN_OPENERS.has(w));
  });
}

// The whole-text allow list (the main gate). EVERY word of the criterion must be one of these (matched after dropping a plain inflection: -s, -es, -ies, -ed, -d, -ing, -ing to -e), or a
// word of a label the criterion quotes in backticks, or an opaque quoted label. One unknown word, a verb of any kind included, makes the criterion persisted.
//   1. view and read verbs (all inflections), and the phrase "is replaced by the words" (the only place "replace" counts)
const ALLOWED_VIEW_WORDS = new Set([
  'choose', 'chose', 'chosen', 'pick', 'select', 'press', 'click', 'tap', 'open', 'filter', 'sort', 'search', 'expand', 'collapse', 'group', 'show', 'narrow', 'scroll', 'type', 'read',
  'view', 'list', 'see', 'appear', 'leave', 'left', 'match', 'offer', 'include', 'reveal', 'display',
]);
//   2. function words and display-layout nouns
const ALLOWED_FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'by', 'with', 'as', 'well', 'too', 'that', 'this', 'these', 'those', 'every', 'each', 'both', 'all', 'only', 'no', 'any', 'its', 'their',
  'it', 'is', 'are', 'be', 'has', 'have', 'more', 'further', 'first', 'then', 'also', 'which', 'when', 'where', 'above', 'below', 'right', 'row', 'column', 'page', 'app', 'picker',
  'button', 'chip', 'label', 'heading', 'word', 'combination', 'older', 'newer', 'there', 'two', 'three', 'one',
]);
//   3. domain nouns that are display state
const ALLOWED_DOMAIN_NOUNS = new Set(['role', 'status']);
//      "runs" is a noun; a bare "run" is also a verb, so it counts only after one of these determiners or modifiers ("the run", "no run", "first run").
const RUN_MODIFIERS = new Set(['the', 'a', 'an', 'no', 'each', 'every', 'that', 'this', 'any', 'first', 'these', 'those', 'its', 'their', 'older', 'newer', 'one', 'of', 'which']);
//   4. backticked or quoted text and a "(for example X)" parenthetical are opaque labels, but only after the lasting-change check above has read them, and only when each word of one is
//      an allowed word or a capitalised label word ("Build", "Executor", "Failed").
//   5. numbers (they carry no letters, so they never reach this check).
const stemCandidates = (w: string): string[] => {
  const out = [w];
  for (const suf of ['ies', 'es', 'ed', 'ing', 's', 'd']) {
    if (w.length > suf.length + 1 && w.endsWith(suf)) {
      const base = w.slice(0, -suf.length);
      out.push(base, `${base}e`);
      if (suf === 'ies') out.push(`${base}y`);
      if ((suf === 'ing' || suf === 'ed') && base.length > 2 && base[base.length - 1] === base[base.length - 2]) out.push(base.slice(0, -1));
    }
  }
  return out;
};
const isAllowedWord = (w: string, prev = ''): boolean => {
  if (w === 'runs') return true;
  if (w === 'run') return RUN_MODIFIERS.has(prev);
  if (w === 'running' || w === 'ran') return false;
  return isAllowedStem(w);
};
const isAllowedStem = (w: string): boolean => stemCandidates(w).some((c) => ALLOWED_VIEW_WORDS.has(c) || ALLOWED_FUNCTION_WORDS.has(c) || ALLOWED_DOMAIN_NOUNS.has(c));

// Nouns that name a single thing a picker could be applied to ("run" only in the singular: "runs" is the list).
const TARGET_ROOTS = ['row', 'chip', 'item', 'open', 'card', 'entry', 'entries', 'member', 'user', 'cell', 'line'];
const OPTION_VERBS =new Set(['choose', 'chose', 'chosen', 'pick', 'select']);

/** The nearest view verb before a span, as its base form ("" when none). */
function nearestViewVerb(before: string): string {
  // Only the current clause counts: a comma, semicolon, full stop, "and", "or" or "then" ends it.
  const clause = before.split(/[,;.]|\b(?:and|or|then)\b/i).pop() ?? '';
  const ws = wordsOf(clause);
  for (let i = ws.length - 1; i >= 0; i--) {
    const c = stemCandidates(ws[i]!).find((x) => ALLOWED_VIEW_WORDS.has(x));
    if (c !== undefined) return c;
  }
  return '';
}

/**
 * Splits out the opaque spans (backticks, double quotes, a "(for example ...)" parenthetical). Returns the text with each span replaced by `opaque` and the words of the spans that
 * name a picker option. A capitalised word is a label only in a span that names a picker option or a message: its nearest preceding view verb is choose, chose, pick or select, or the
 * span follows "the words". In any other span (after press, click, tap and so on) every word must be an allowed word on its own, so an action label ("Rerun", "Destroy") never passes.
 */
function takeOpaqueSpans(text: string): { rest: string; optionWords: Set<string>; spansOk: boolean } {
  const optionWords = new Set<string>();
  let spansOk = true;
  const rest = text.replace(/\(\s*for example([^)]*)\)|`([^`]*)`|["“]([^"”]*)["”]/gi, (...m: unknown[]) => {
    const inner = String(m[1] ?? m[2] ?? m[3] ?? '');
    const offset = m[m.length - 2] as number;
    const before = text.slice(0, offset);
    const after = text.slice(offset + String(m[0]).length);
    const optionVerb = OPTION_VERBS.has(nearestViewVerb(before));
    // A capitalised label word is accepted in exactly three shapes: an option span followed by "in Role", "in Status" or "in the ... picker"; a "(for example ...)" straight after
    // "a Role" or "a Status" that an option verb chose; or the words of a message, after "replaced by", "shows", "reads" or "displays" "the words" with no press, click or tap anywhere.
    const isParen = String(m[0]).startsWith('(');
    const isOption = isParen
      ? optionVerb && /\ba\s+(?:Role|Status)(?:\s+as\s+well)?\s*$/.test(before)
      : (optionVerb && /^\s*in\s+(?:Role\b|Status\b|the\s+(?:Role|Status)\s+picker\b)/i.test(after))
        || (/\b(?:replaced\s+by|shows?|reads?|displays?)\s+the\s+words\s*$/i.test(before) && !/\b(?:press|click|tap)\w*/i.test(text));
    // Positional rule: for a picker-option span, a target noun anywhere from the start of the criterion to the first view verb after the span means the picker is
    // applied to one thing, not to the list ("With the first row open, choosing `Viewer` ...", "... in each row"). A comma does not end the stretch.
    if (isOption && !/the\s+words\s*$/i.test(before)) {
      const afterWords = wordsOf(after);
      const stop = afterWords.findIndex((w) => stemCandidates(w).some((c) => ALLOWED_VIEW_WORDS.has(c)));
      const stretch = [...wordsOf(before), ...(stop < 0 ? afterWords : afterWords.slice(0, stop))];
      if (stretch.some((w) => w === 'run' || w === 'runs' || TARGET_ROOTS.some((r) => w.startsWith(r)))) spansOk = false;
    }
    const raw = inner.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z]+/).filter((w) => w !== '');
    raw.forEach((w, i) => {
      const lower = w.toLowerCase();
      if (isAllowedWord(lower, i > 0 ? raw[i - 1]!.toLowerCase() : '') || (isOption && /^[A-Z]/.test(w))) {
        if (isOption && !/the\s+words\s*$/i.test(before)) optionWords.add(lower);
      } else spansOk = false;
    });
    return ' opaque ';
  });
  return { rest, optionWords, spansOk };
}

/**
 * Classifies one journey's text (never reads the model's words). `view_only` needs ALL of: a view verb (or "leaves only" or "show more"); no lasting-change or stored-state root or
 * phrase anywhere in the original text, backticks and quotes included; EVERY word an allowed word (see the allow list above) or a word of a quoted label; and the action-slot check
 * (every -ing word and every word after "and" / "then" a view or read action or a noun opener). Anything else, an unknown word above all, is `persisted`.
 * Softenings: "show more adds|reveals|loads older" reads as "show more", and "is replaced by the words" is dropped (the empty-state message wording).
 */
export function classifyPersistence(text: string): PersistenceKind {
  // A letter outside A-Z would be dropped by the word split, so it hides a word: such text is never view-only.
  if (/(?![A-Za-z])\p{L}/u.test(text)) return 'persisted';
  const whole = wordsOf(text.replace(/show more (?:adds|reveals|loads) older/gi, 'show more'));
  const wholeFlat = whole.join(' ');
  if (LASTING_PHRASE_RE.test(wholeFlat)) return 'persisted';
  // A picker used "on" or "of" one row or run sets that row's value; it does not filter the list.
  if (/\b(?:on|of|in)\s+(?:[a-z]+\s+){0,3}?(?:rows?|runs?)\b/.test(wholeFlat)) return 'persisted';
  // A view verb straight onto one row or run ("narrows the first row") also applies the change to a single thing.
  if (/\b(?:filter|sort|search|expand|collaps|group|show|narrow|leave|match|offer|display|reveal)\w*\s+(?:the|a|an|each|every|that)\s+(?:[a-z]+\s+)?(?:rows?|runs?)\b/.test(wholeFlat)) return 'persisted';
  if (whole.some((w) => startsWithAny(w, LASTING_ROOTS))) return 'persisted';
  const { rest, optionWords, spansOk } = takeOpaqueSpans(text.replace(/show more (?:adds|reveals|loads) older/gi, 'show more'));
  if (!spansOk) return 'persisted';
  const flat = wordsOf(rest).join(' ').replace(/\bshow more (?:adds|reveals|loads) older\b/g, 'show more').replace(/\bis replaced by the words\b/g, ' ');
  const words = flat.split(' ').filter((w) => w !== '');
  const viewVerb = words.some((w) => startsWithAny(w, VIEW_VERB_ROOTS)) || /\bshow more\b|\bshow less\b|\bleaves only\b/.test(flat);
  if (!viewVerb) return 'persisted';
  // A word of a picker-option label may also stand outside its span, but only as a modifier of a display noun ("executor runs").
  const modifierOk = (w: string, prev: string, next: string): boolean => optionWords.has(w) && ['only', 'all', 'no', 'the', 'every', 'each'].includes(prev) && ['run', 'runs', 'role', 'roles', 'status', 'row', 'rows'].includes(next);
  if (!words.every((w, i) => w === 'opaque' || isAllowedWord(w, i > 0 ? words[i - 1]! : '') || modifierOk(w, i > 0 ? words[i - 1]! : '', words[i + 1] ?? ''))) return 'persisted';
  return actionSlotsAreViewOnly(words) ? 'view_only' : 'persisted';
}

/** A stored or received classification as a closed value: anything outside the vocabulary (or missing) is `persisted`, the strict reading. */
export function readPersistence(raw: unknown): PersistenceKind {
  return raw === 'view_only' ? 'view_only' : 'persisted';
}
