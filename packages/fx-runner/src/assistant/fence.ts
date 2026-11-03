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
const ZERO_WIDTH = /[\p{Cf}͏᠎]/gu;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const TOKEN_A = /SPAWN_REQUEST[^\n]*(\n?)/gi;
const TOKEN_B = /TERMINATE_REQUEST[^\n]*(\n?)/gi;
const STATUS = /^STATUS:[A-Za-z_]+[^\n]*(\n?)/gim;

export function stripControlTokens(text: string): string {
  let s = text.normalize("NFKC").replace(ZERO_WIDTH, "");
  s = s.replace(COMMENT, MARKER).replace(TOKEN_A, `${MARKER}$1`).replace(TOKEN_B, `${MARKER}$1`);
  return s.replace(STATUS, `${MARKER}$1`);
}

export function sanitize(text: string): string {
  let cut = text.length > MAX_INPUT ? MAX_INPUT : text.length;
  const last = text.charCodeAt(cut - 1);
  if (cut < text.length && last >= 0xd800 && last <= 0xdbff) cut -= 1;
  let s = stripControlTokens(text.slice(0, cut));
  if (cut < text.length) s = `${s}\n${MARKER} input truncated at ${MAX_INPUT} characters`;
  s = s.split(END).join("<<END UNTRUSTED (neutralized)>>").split(START).join("<<UNTRUSTED EXTERNAL CONTENT (neutralized)>>");
  return `${START}\n${s}\n${END}`;
}

const IDENTIFIER = /^[A-Za-z0-9_.:+-]{1,64}$/;
/** The only keys that reach the model, at any depth: a key can be repo text (a milestone key in a plan's counts), so anything else is renamed. */
const PLAIN_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CURSOR = /^[A-Za-z0-9_=.-]{1,512}$/;
const STRUCTURAL = new Set(["id", "work_item_id", "parent_run_id", "repo_id", "run_id", "created_at", "updated_at", "started_at", "finished_at", "at", "status", "stage", "kind", "role", "runtime", "provenance", "state", "origin", "approval", "decision_type", "class", "credential_mode"]);
const CURSOR_KEYS = new Set(["next_cursor", "cursor"]);

/** The value with every free-text string fenced; numbers, booleans and null pass, and lists and depth are bounded. */
export function fenceJson(value: unknown, key = "", inPayload = false, depth = 0): unknown {
  if (typeof value === "string") {
    if (!inPayload && ((STRUCTURAL.has(key) && IDENTIFIER.test(value)) || (CURSOR_KEYS.has(key) && CURSOR.test(value)))) return value;
    return sanitize(Array.from(value).slice(0, FIELD_MAX).join(""));
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= DEPTH_MAX) return sanitize("(not shown: nested too deep)");
  if (Array.isArray(value)) return value.slice(0, ITEMS_MAX).map((v) => fenceJson(v, key, inPayload, depth + 1));
  if (typeof value !== "object") return sanitize("(not shown)");
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    const nested = inPayload || k === "payload";
    const name = PLAIN_KEY.test(k) ? k : `field_${n}`;
    n += 1;
    out[name] = fenceJson(v, name, nested, depth + 1);
  }
  return out;
}
