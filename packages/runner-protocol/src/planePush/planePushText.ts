/**
 * D#598 P1f-2b: the public pull request title and body for a paired repo's change. A PURE function of the work item's title and the run id and
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

/** The only inputs are the item's title and the run id. Do not add a third. */
export function buildPlanePushText(input: { itemTitle: string; runId: string }): PlanePushText {
  if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) throw new Error("buildPlanePushText: the run id must be a lowercase uuid");
  const item = typeof input.itemTitle === "string" ? input.itemTitle : "";
  // Clean, cut, clean again: a cut can leave a trailing space, and the second pass is a no-op on anything else.
  const cut = clean(truncate(clean(item), MAX_PLANE_TITLE_LENGTH));
  const fallback = `Change from fulcrumaxe run ${input.runId.slice(0, 8)}`;
  const title = cut.length > 0 && PLANE_TITLE_LINE.test(cut) && cut.trim() === cut ? cut : fallback;
  const body = ["This change was prepared by a fulcrumaxe run and checked against the paired repository's rules before it was sent.", "", `Run: ${input.runId}`, ""].join("\n");
  return { title, body };
}
