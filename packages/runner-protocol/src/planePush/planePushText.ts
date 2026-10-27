/**
 * D#598 P1f-2b: the public pull request title and body for a paired repo's change. A PURE function of the work item's title, the run id and the pairing's footer template (with the item's issue number),
 * nothing else, so the runner route and the sandbox publish step (P1f-5) cannot build different text, and nothing an agent wrote can reach either
 * string (R-597-1): the item title is a person's, the run id is ours, and the body does not even read the title.
 *
 * Why the title is cleaned: GitHub turns `@name` into a notification for that person and `#12` into a cross-reference on issue 12, in the title as
 * in the body, and a public title is read by strangers. So `@`, every `#<digits>` and `GH-<digits>`, every URL and every invisible character are removed, whitespace is flattened to one line
 * and the length is capped (GitHub allows 256; ours is at most 100). A title that cleans to nothing, or that the route's own validity rule would
 * refuse, becomes a fixed title built from the run id. No null or undefined is ever returned.
 */

/** The rule the run-end route applies to a title (one line, 1 to 256 characters, no control characters); the route imports this one. */
export const PLANE_TITLE_LINE = /^[^\u0000-\u001f\u007f]{1,256}$/;
export const MAX_PLANE_TITLE_LENGTH = 100;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whitespace-like control characters become a space (so words do not fuse); every other control character is dropped. */
const SPACING = /[\t\n\r\v\f\u0085\u2028\u2029]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
/**
 * Characters a reader cannot see: zero-width space/joiners, bidirectional marks, overrides and isolates, the byte order mark, variation selectors,
 * the soft hyphen and the Unicode tag block (which can carry hidden ASCII). Removed first, so `#` + zero-width + `12` is seen as `#12` and removed,
 * and a title made only of them is seen as empty. U+061C (Arabic letter mark) is listed too in case the runtime's property table predates it.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u061c]/gu;
/** A scheme or `www.` anywhere, even right after a word character: GitHub links `a_https://x` and `1https://x`. */
const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;
/** `GH-12` is an issue reference to GitHub, as `#12` is. */
const GH_REF = /\bgh-[0-9]+/gi;

function clean(raw: string): string {
  let text = raw;
  // Removing one thing can join the pieces around it into another (`#@12` becomes `#12`), so repeat until nothing changes. Each pass only shortens the text.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = text
      .replace(SPACING, " ")
      .replace(CONTROL, "")
      .replace(INVISIBLE, "")
      .replace(/@/g, "")
      .replace(URL_LIKE, " ")
      .replace(/#[0-9]+/g, "")
      .replace(GH_REF, "")
      .replace(/\s+/g, " ")
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

/** The first `max` UTF-16 units, cut on a character boundary so a surrogate pair is never split. */
function truncate(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

export interface PlanePushText {
  title: string;
  body: string;
}

/**
 * The per-pairing pull request footer. A template an owner sets in the pairing settings (empty means none, the default): one line of plain text with
 * at most two placeholders, `{issue_number}` (the work item's issue number) and `{run_id}` (the executor run id). A literal footer with no placeholder
 * works too. The check below is what the pairing write applies; the same placeholder set is what the render accepts.
 */
export const PR_FOOTER_MAX_LENGTH = 200;
export const PR_FOOTER_PLACEHOLDERS = ["issue_number", "run_id"] as const;
const PLACEHOLDER = /\{([^{}]*)\}/g;
/** Any scheme, `www.`, or a bare `name.tld` (with whatever follows it up to a space): all counted as a link. */
const FOOTER_LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b\S*/gi;

function placeholdersOk(template: string): boolean {
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (!(PR_FOOTER_PLACEHOLDERS as readonly string[]).includes(m[1]!)) return false;
  }
  return !/[{}]/.test(template.replace(PLACEHOLDER, ""));
}

/**
 * Why a footer template is refused, or null when it is acceptable. `codeRepo` is the paired public repo: a link to it is the only link allowed
 * (a link to the private repo would publish its name; any other link would send strangers off-site from a pull request we open).
 */
export function checkPrFooter(template: unknown, codeRepo: string): string | null {
  if (typeof template !== "string") return "the footer must be text";
  if (template.length === 0 || template.length > PR_FOOTER_MAX_LENGTH) return `the footer must be 1 to ${PR_FOOTER_MAX_LENGTH} characters`;
  if (template.trim() !== template) return "the footer may not start or end with a space";
  if (template.search(CONTROL) >= 0 || template.search(SPACING) >= 0) return "the footer must be one line without control characters";
  if (template.search(INVISIBLE) >= 0) return "the footer has an invisible character";
  if (template.includes("@")) return "the footer may not contain @ (it would notify a person)";
  // Markdown and HTML make links and hidden markup from these, in forms no URL pattern sees (a backslash-escaped host, an entity, an anchor tag, a comment, a details block).
  if (/[[\]<>\\&`]/.test(template)) return "the footer may not contain any of [ ] < > \\ & or a backtick";
  // A reference to an issue (another repo's owner/repo#1, GH-1, or a bare #1) makes GitHub add a backlink under our identity. D#6 (a letter before the #) is not one.
  if (/[\w.-]+\/[\w.-]+#/.test(template) || /\bgh-\d/i.test(template) || /(?:^|[^\w])#(?:\d|\{)/.test(template)) return "the footer may not reference an issue (write it like D#6, with a letter before the #)";
  if (!placeholdersOk(template)) return `the footer may use only these placeholders: ${PR_FOOTER_PLACEHOLDERS.map((n) => `{${n}}`).join(", ")}`;
  const own = new RegExp(`^https://github\\.com/${codeRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[/?#]\\S*)?$`, "i");
  for (const link of template.matchAll(FOOTER_LINK)) {
    if (link[0].includes("..") || !own.test(link[0].replace(/[.,;:!)]+$/, ""))) return "the footer may link only to the paired public repository";
  }
  return null;
}

/**
 * A GitHub closing keyword (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved, any case) followed by an issue reference (`#12`, or `owner/repo#12`). GitHub closes the
 * referenced issue when a pull request whose description holds one merges, which a planned PR child must never do to its parent's issue.
 */
const CLOSING_KEYWORD_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]*(?:(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d|(?:[\w.-]+\/[\w.-]+)?#\d|gh-\d)/i;

/**
 * True when `text` holds a closing keyword followed by an issue reference: `#12`, `owner/repo#12`, `GH-12`, or a link to an issue or pull request (with or without the scheme and `www.`; any case; a colon
 * or spaces between). The ONE pattern for the whole planned PR child path: the prompt's title guard, both pull request texts and the final body guard all use it.
 */
export const hasClosingKeywordReference = (text: string): boolean => CLOSING_KEYWORD_REFERENCE.test(text);

/** The fixed code a child's text is refused with when its finished body still closes an issue. */
export const CHILD_BODY_CLOSING_CODE = "child_body_closing_keyword";

/** The final guard on a planned PR child's finished body: throws `child_body_closing_keyword` when it still closes an issue. */
export function assertChildBodySafe(body: string): void {
  if (hasClosingKeywordReference(body)) throw new Error(CHILD_BODY_CLOSING_CODE);
}

/**
 * Why a stored footer is left off this pull request, or null when it renders (or there is none). `no_issue_number`: it needs an issue number the item lacks. For a planned PR child (`child: true`), whose
 * `issueNumber` is its PARENT's number in the private repository, which means nothing on the public one: `child_issue_placeholder` (the footer has the `{issue_number}` placeholder, whatever else it says,
 * checked before rendering) and `child_closing_keyword` (the footer as it renders holds a closing keyword followed by an issue reference).
 */
export function prFooterSkipReason(template: string | null | undefined, issueNumber: number | null | undefined, options: { child?: boolean } = {}): "no_issue_number" | "child_issue_placeholder" | "child_closing_keyword" | null {
  if (!template) return null;
  if (options.child === true && template.includes("{issue_number}")) return "child_issue_placeholder";
  if (template.includes("{issue_number}") && (issueNumber === null || issueNumber === undefined)) return "no_issue_number";
  if (options.child === true && placeholdersOk(template) && hasClosingKeywordReference(template.replace(PLACEHOLDER, (_all, name: string) => (name === "run_id" ? "run" : String(issueNumber))))) return "child_closing_keyword";
  return null;
}

/** The footer line for this run, or null (no template, a placeholder without a value, a template with a placeholder this build does not know, or, for a child, a closing keyword). */
export function renderPrFooter(template: string | null | undefined, vars: { issueNumber?: number | null; runId: string; child?: boolean }): string | null {
  if (!template || !placeholdersOk(template) || prFooterSkipReason(template, vars.issueNumber, { child: vars.child === true }) !== null) return null;
  return template.replace(PLACEHOLDER, (_all, name: string) => (name === "run_id" ? vars.runId : String(vars.issueNumber)));
}

/**
 * The item's title and the run id build the text; the optional footer (the pairing's template and the item's issue number) is appended to the body
 * after a blank line. Both are ours, never an agent's.
 */
export function buildPlanePushText(input: { itemTitle: string; runId: string; prFooter?: string | null; issueNumber?: number | null; child?: boolean }): PlanePushText {
  if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) throw new Error("buildPlanePushText: the run id must be a lowercase uuid");
  const item = typeof input.itemTitle === "string" ? input.itemTitle : "";
  // Clean, cut, clean again: a cut can leave a trailing space, and the second pass is a no-op on anything else.
  const cut = clean(truncate(clean(item), MAX_PLANE_TITLE_LENGTH));
  const fallback = `Change from fulcrumaxe run ${input.runId.slice(0, 8)}`;
  const title = cut.length > 0 && PLANE_TITLE_LINE.test(cut) && cut.trim() === cut ? cut : fallback;
  const lines = ["This change was prepared by a fulcrumaxe run and checked against the paired repository's rules before it was sent.", "", `Run: ${input.runId}`, ""];
  // A planned PR child's `issueNumber` is its PARENT's, a number of the private repository. On the public repository the same number is an unrelated issue, so the public body carries no `#<number>` line
  // for it; the child maps by its binding and push row. The footer (if it does not close anything) is the owner's own text.
  const footer = renderPrFooter(input.prFooter, { issueNumber: input.issueNumber, runId: input.runId, child: input.child === true });
  if (footer !== null) lines.push(footer, "");
  const body = lines.join("\n");
  // Final guard: a child's finished body that still closes an issue is never handed out.
  if (input.child === true) assertChildBodySafe(body);
  return { title, body };
}
