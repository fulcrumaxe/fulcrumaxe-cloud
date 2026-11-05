/**
 * D#597 CC-7a-2: repo, issue and GitHub text in a cloud reply is fenced as data before the model sees it (the D#1588 rule). This is a minimal copy
 * of `sanitize` from the hosted `@fx/trust` package: that package is not in fx-runner's dependency graph (the runner ships on its own), and a test
 * pins this copy to it on hostile inputs. A string leaves raw only when its key names a structural field and it is a plain identifier; everything
 * else, including every string under a `payload`, is defanged (control tokens replaced) and wrapped in the untrusted-content fence.
 */
const MARKER = "[removed]";
const START = "<<UNTRUSTED EXTERNAL CONTENT>>";
const END = "<<END UNTRUSTED>>";
const MAX_INPUT = 200_000;
const FIELD_MAX = 3000;
const ITEMS_MAX = 50;
const DEPTH_MAX = 8;
/** Copy of `INVISIBLE_PATTERN` and its callback in `@fx/trust` (what draws as nothing is removed; a text/emoji selector straight after a pictograph, and the keycap one, stay). A test walks every default-ignorable code point through both. */
const INVISIBLE = /(?<=\p{Extended_Pictographic})([︎️])|(?<=[0-9#*])(️)(?=⃣)|[\p{Cf}\p{Default_Ignorable_Code_Point}͏᠎⠀]/gu;
const stripInvisible = (text: string): string => text.replace(INVISIBLE, (_m, pict: string | undefined, keycap: string | undefined) => pict ?? keycap ?? "");
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const TOKEN_A = /SPAWN_REQUEST[^\n]*(\n?)/gi;
const TOKEN_B = /TERMINATE_REQUEST[^\n]*(\n?)/gi;
const STATUS = /^STATUS:[A-Za-z_]+[^\n]*(\n?)/gim;

export function stripControlTokens(text: string): string {
  let s = stripInvisible(text.normalize("NFKC"));
  s = s.replace(COMMENT, MARKER).replace(TOKEN_A, `${MARKER}$1`).replace(TOKEN_B, `${MARKER}$1`);
  return s.replace(STATUS, `${MARKER}$1`);
}

const FENCE_LOOKALIKES: Readonly<Record<string, string>> = {
  "\u2215": "/", "\u2044": "/", "\u2571": "/", "\u29f8": "/", "\u226a": "<<", "\u226b": ">>",
  "\u2039": "<", "\u27e8": "<", "\u3008": "<", "\u00ab": "<", "\u203a": ">", "\u27e9": ">", "\u3009": ">", "\u00bb": ">",
  "\u0443": "u", "\u03c5": "u", "\u057d": "u", "\u0578": "n", "\u043f": "n", "\u0442": "t", "\u0433": "r", "\u0455": "s", "\u0435": "e", "\u0501": "d",
  "\u0423": "u", "\u03a5": "u", "\u054d": "u", "\u0548": "n", "\u041f": "n", "\u0422": "t", "\u0413": "r", "\u0405": "s", "\u0415": "e", "\u0500": "d",
  "\u0395": "e", "\u039d": "n", "\u03a4": "t", "\u039f": "o", "\u03a7": "x", "\u0391": "a", "\u043e": "o", "\u041e": "o", "\u03bf": "o", "\u0441": "c", "\u0421": "c", "\u0445": "x", "\u0425": "x", "\u0430": "a", "\u0410": "a", "\u04cf": "l",
};
const classOf = (ch: string): string => `[${ch}${Object.entries(FENCE_LOOKALIKES).filter(([, v]) => v === ch).map(([k]) => k).join("")}]`;
/** Whitespace and combining marks may sit between any two characters of a marker. */
const GAP = "[\\s\\p{Mn}]*";
const word = (w: string): string => [...w].map(classOf).join(GAP);
/** `<<`, `>>` or the single characters U+226A and U+226B, with space and lookalike brackets allowed. Group 1 is set for the closing marker. */
const OPEN = `(?:\u226a|${classOf("<")}${GAP}${classOf("<")})`;
const CLOSE = `(?:\u226b|${classOf(">")}${GAP}${classOf(">")})`;
const FENCE_MARKER = new RegExp(`${OPEN}${GAP}(${word("end")}${GAP})?${word("untrusted")}(?:${GAP}${word("external")}${GAP}${word("content")})?[^<>\u226a\u226b]{0,40}${CLOSE}`, "giu");

export function sanitize(text: string): string {
  let cut = text.length > MAX_INPUT ? MAX_INPUT : text.length;
  const last = text.charCodeAt(cut - 1);
  if (cut < text.length && last >= 0xd800 && last <= 0xdbff) cut -= 1;
  let s = stripControlTokens(text.slice(0, cut));
  if (cut < text.length) s = `${s}\n${MARKER} input truncated at ${MAX_INPUT} characters`;
  const decomposed = s.normalize("NFD");
  const neutral = decomposed.replace(FENCE_MARKER, (_m, end: string | undefined) => (end === undefined ? "<<UNTRUSTED EXTERNAL CONTENT (neutralized)>>" : "<<END UNTRUSTED (neutralized)>>"));
  if (neutral !== decomposed) s = neutral.normalize("NFC");
  return `${START}\n${s}\n${END}`;
}

export const IDENTIFIER = /^(?!status:)(?!.*(?:spawn_request|terminate_request))[A-Za-z0-9_.:+-]{1,64}$/i;
/** The only keys that reach the model, at any depth: a key can be repo text (a milestone key in a plan's counts), so anything else is renamed. */
const PLAIN_KEY = /^(?!.*(?:spawn_request|terminate_request))[A-Za-z][A-Za-z0-9_]{0,63}$/i;
/** D#597 CC-6a-1: record-typed fields (maps from repo or GitHub text to a value). Their keys are data, so every one is fenced, plain-looking or not. Pinned to `@fx/trust`. */
export const RECORD_FIELDS: ReadonlySet<string> = new Set(["per_milestone", "token_permissions"]);
export function plainKey(key: string, position: number): string {
  return PLAIN_KEY.test(key) ? key : `field_${position}`;
}
export const STRUCTURAL: ReadonlySet<string> = new Set(["id", "work_item_id", "parent_run_id", "repo_id", "run_id", "created_at", "updated_at", "started_at", "finished_at", "at", "status", "stage", "kind", "role", "runtime", "provenance", "state", "origin", "approval", "decision_type", "class", "credential_mode"]);
const words = (list: string): ReadonlySet<string> => new Set(list.split(" "));
/**
 * What a structural key may carry raw. A key with a closed vocabulary (a stage, a role, a status) shows a value raw only when it is one of its words, so a
 * 64-character identifier from outside the list is fenced and a snake_case sentence cannot ride a structural key. An id is raw only as a UUID and a time only
 * as an ISO date. `kind` is the one open vocabulary (run events add dotted kinds as the pipeline grows), so it is held to the shape of those names and the
 * control-token rule; text in that shape can only come from server code. A word the list lacks shows fenced, which is still readable: add it here and in the
 * `@fx/trust` copy (this is that copy; a test pins the two).
 */
export const STRUCTURAL_VOCAB: Readonly<Record<string, ReadonlySet<string>>> = {
  stage: words("triaged discussing spec_ready in_progress pr_opened changes_requested review_passed needs_human merged closed_unmerged closed"),
  provenance: words("internal external"),
  credential_mode: words("subscription api_key"),
  origin: words("person agent"),
  state: words("pending awaiting_confirm running done failed queued succeeded"),
  status: words("pending refused_spend running succeeded failed timed_out killed_spend paused cancelled done partial open not_started pending_spec proposed accepted rejected applied superseded"),
  role: words("executor code-reviewer security-reviewer acceptance-tester debater project-manager technical-architect product-owner cost-analyst performance-expert security-expert researcher feedback-scanner incident-commander browser-tester tui-tester docs-writer release-manager runbook-writer accessibility-reviewer ux-designer mission-analyst run-analyst analytics-engineer visual-verifier quality-sweep fix plane_publish proposal-verifier discovery-analyst"),
  runtime: words("local production runner sandbox hosted"),
  approval: words("auto manual pending approved denied expired cancelled"),
  decision_type: words("start_work_small start_work_bug start_work_doc start_parent_item start_after_reclassify"),
};
const UUID_KEYS = words("id work_item_id parent_run_id repo_id run_id");
const TIME_KEYS = words("created_at updated_at started_at finished_at at");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const KIND = /^(?!.*(?:spawn_request|terminate_request))[a-z][a-z_]{0,31}(?:\.[a-z_]{1,31}){0,3}$/;

/** True when a value under a structural key may reach the model unfenced. */
function structuralRaw(key: string, value: string): boolean {
  const vocab = Object.hasOwn(STRUCTURAL_VOCAB, key) ? STRUCTURAL_VOCAB[key] : undefined;
  if (vocab !== undefined) return vocab.has(value);
  if (UUID_KEYS.has(key)) return UUID.test(value);
  if (TIME_KEYS.has(key)) return ISO.test(value);
  return key === "kind" ? KIND.test(value) : IDENTIFIER.test(value);
}
const CURSOR_KEYS = new Set(["next_cursor", "cursor"]);
/** What a cursor becomes: the model has no tool argument that takes one (a cursor can be a repo's own key), so it learns only that more exist. */
export const MORE_EXIST = "more results exist; narrow the request";

/** The value with every free-text string fenced; numbers, booleans and null pass, and lists and depth are bounded. */
export function fenceJson(value: unknown, key = "", inPayload = false, depth = 0): unknown {
  if (typeof value === "string") {
    if (!inPayload && CURSOR_KEYS.has(key)) return MORE_EXIST;
    if (!inPayload && STRUCTURAL.has(key) && structuralRaw(key, value)) return value;
    return sanitize(Array.from(value).slice(0, FIELD_MAX).join(""));
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= DEPTH_MAX) return sanitize("(not shown: nested too deep)");
  if (Array.isArray(value)) return value.slice(0, ITEMS_MAX).map((v) => fenceJson(v, key, inPayload, depth + 1));
  if (typeof value !== "object") return sanitize("(not shown)");
  if (RECORD_FIELDS.has(key)) {
    // A record's keys never reach the model as keys: each entry is a fenced key beside its fenced value.
    return Object.entries(value).slice(0, ITEMS_MAX).map(([k, v]) => ({ key: sanitize(Array.from(k).slice(0, FIELD_MAX).join("")), value: fenceJson(v, "entry", inPayload, depth + 1) }));
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    const nested = inPayload || k === "payload";
    const name = plainKey(k, n);
    n += 1;
    out[name] = fenceJson(v, name, nested, depth + 1);
  }
  return out;
}
